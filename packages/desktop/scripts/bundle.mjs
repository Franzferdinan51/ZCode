#!/usr/bin/env node

/* eslint-disable max-lines */
// This script aggregates the packaging entrypoint, retry policy, timing, and
// artifact verification. Splitting it soon would destabilize CI, so keep the
// centralized implementation and split by "arg parsing/build/verification" later.

import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectRuntimeModuleClosureEntries } from "./runtime-dependency-closure.mjs";
import { resolveDesktopProductIdentity } from "./desktop-product-identity.mjs";
import {
  findDesktopNativePackageViolations,
  parseAsarListWithPackState,
} from "./desktop-native-package-policy.mjs";
import {
  resolveSpawnRuntimeOptions,
  runCommand,
  runCommandAndReadStdout,
} from "../../../scripts/spawn-command.mjs";
import { resolveIntranetDepsBaseUrl } from "../../../scripts/intranetDefaults.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(desktopRoot, "../..");
const requireFromBundle = createRequire(import.meta.url);
const asarCliPath = resolve(
  dirname(requireFromBundle.resolve("@electron/asar/package.json")),
  "bin",
  "asar.js",
);
const runtimeModuleLookupRoots = [
  desktopRoot,
  workspaceRoot,
  resolve(desktopRoot, "node_modules", ".pnpm", "node_modules"),
  resolve(workspaceRoot, "node_modules", ".pnpm", "node_modules"),
];
const pnpmCommand = "pnpm";
const DEFAULT_TARGET_OS = "mac";
const DEFAULT_TARGET_ARCH = "arm64";
const desktopDistDir = process.env.ZCODE_DESKTOP_DIST_DIR || "dist";
const desktopDistRoot = resolve(desktopRoot, desktopDistDir);
const desktopProductIdentity = resolveDesktopProductIdentity(process.env);

const osAliasMap = new Map([
  ["mac", "mac"],
  ["macos", "mac"],
  ["darwin", "mac"],
  ["osx", "mac"],
  ["win", "win"],
  ["windows", "win"],
  ["win32", "win"],
  ["linux", "linux"],
]);

const archAliasMap = new Map([
  ["x64", "x64"],
  ["amd64", "x64"],
  ["x86_64", "x64"],
  ["arm64", "arm64"],
  ["aarch64", "arm64"],
]);

const osBuilderFlagMap = {
  mac: "--mac",
  win: "--win",
  linux: "--linux",
};

const archBuilderFlagMap = {
  x64: "--x64",
  arm64: "--arm64",
};

const artifactExtensionsByOs = {
  mac: [".dmg", ".zip"],
  win: [".exe"],
  linux: [".AppImage", ".deb", ".rpm", ".pkg.tar.zst"],
};
const artifactArchHintsByArch = {
  x64: ["x64", "x86_64", "amd64"],
  arm64: ["arm64", "aarch64"],
};
const commandStdoutMaxBuffer = 64 * 1024 * 1024;
const requiredRuntimeModules = [
  "module-details-from-path",
  "pngjs",
  // Bugfix: telemetry's OTLP exporter depends on sdk-metrics at startup; dev-mode
  // hoisting hides electron-builder dropping it. The final artifact must
  // mechanically verify this closure — installers that build but cannot start
  // must never ship.
  "@opentelemetry/sdk-metrics",
  // Same scope as the injected closure: verify the OTLP proto export chain
  // (exporter -> otlp-transformer -> protobufjs) is fully packaged.
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/exporter-metrics-otlp-proto",
  // @arms/rum-core keeps requiring '@babel/runtime/helpers/*' from its CJS entry
  // at runtime. It declares @babel/runtime in peerDependencies, which pnpm
  // workspace dev mode usually resolves — but if the production package does
  // not carry that peer into app.asar, the installed app crashes in the main
  // process at startup. Verify @babel/runtime mechanically after bundling so
  // broken packages stop shipping.
  "@babel/runtime",
  // The proxy probe in services requires("undici") at runtime. Verifying only
  // pngjs/ssh2 here would let through packages that build fine but crash the
  // main process at startup for missing undici. Verify undici mechanically so
  // the bundle stage catches it.
  "undici",
  // App self-signed CA generation uses node-forge, whose internal dynamic
  // require("crypto") crashes when inlined into the ESM main bundle, so it
  // stays an external dependency. Production packages must explicitly verify
  // it exists in app.asar so a packaging miss never causes a startup crash.
  "node-forge",
  // Aligned with tsup externals: preserve the ZIP unpacker's CommonJS runtime boundary.
  "yauzl",
  // If ssh2's key dependency chain (asn1/bcrypt-pbkdf/tweetnacl) is missing,
  // connecting to a remote workspace throws MODULE_NOT_FOUND in keyParser.
  // Verify the ssh2 key chain mechanically so broken packages never ship.
  "asn1",
  "bcrypt-pbkdf",
  "tweetnacl",
  // manifestUpdateProvider imports builder-util-runtime directly (CommonJS with
  // an internal require("events")); tsup keeps it as an external dependency.
  // Production packages must verify it exists in app.asar, otherwise the main
  // process crashes at startup with Dynamic require or MODULE_NOT_FOUND.
  "builder-util-runtime",
];
const electronBuilderRetryCount = 3;
const electronBuilderRetryDelayMs = 5_000;
const electronBuilderHeartbeatIntervalMs = 30_000;
export const DEFAULT_ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/";
export const NPMMIRROR_ELECTRON_BUILDER_BINARIES_MIRROR =
  "https://registry.npmmirror.com/-/binary/electron-builder-binaries/";
export const OFFICIAL_ELECTRON_BUILDER_BINARIES_MIRROR =
  "https://github.com/electron-userland/electron-builder-binaries/releases/download/";

function isMisconfiguredNpmMirrorElectronRuntimeMirror(mirror) {
  return mirror
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase()
    .includes("npmmirror.com/binaries/electron");
}

export function resolveElectronMirror(env = process.env) {
  const existingMirror =
    env.NPM_CONFIG_ELECTRON_MIRROR ||
    env.npm_config_electron_mirror ||
    env.npm_package_config_electron_mirror ||
    env.ELECTRON_MIRROR;
  if (existingMirror?.trim()) {
    return existingMirror.trim();
  }

  return DEFAULT_ELECTRON_MIRROR;
}

export function createElectronRuntimeMirrorEnv(mirror) {
  return {
    ZCODE_ELECTRON_RUNTIME_MIRROR: mirror,
    // @electron/get reads the Electron runtime env vars globally. Passing them
    // to the electron-builder main process would override mirrorOptions for
    // generic artifacts like dmg-builder.
    ELECTRON_MIRROR: "",
    NPM_CONFIG_ELECTRON_MIRROR: "",
    npm_config_electron_mirror: "",
    npm_package_config_electron_mirror: "",
  };
}

function resolveDefaultElectronBuilderBinariesMirror(env = process.env) {
  return env.ZCODE_DEPS_BASE_URL?.trim() || env.INTRANET_MACHINE_HOST?.trim()
    ? `${resolveIntranetDepsBaseUrl(env)}/electron-builder-binaries/`
    : NPMMIRROR_ELECTRON_BUILDER_BINARIES_MIRROR;
}

export function resolveElectronBuilderBinariesMirror(env = process.env) {
  const existingMirror =
    env.NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR ||
    env.npm_config_electron_builder_binaries_mirror ||
    env.npm_package_config_electron_builder_binaries_mirror ||
    env.ELECTRON_BUILDER_BINARIES_MIRROR;
  if (existingMirror?.trim()) {
    if (isMisconfiguredNpmMirrorElectronRuntimeMirror(existingMirror)) {
      // If the electron-builder binaries mirror is pointed at an Electron runtime
      // mirror, the two resource trees differ and dmg-builder resolves under
      // the runtime directory, producing 404s.
      return NPMMIRROR_ELECTRON_BUILDER_BINARIES_MIRROR;
    }

    return existingMirror.trim();
  }

  return resolveDefaultElectronBuilderBinariesMirror(env);
}

export function createElectronBuilderBinariesMirrorEnv(mirror) {
  return {
    // electron-builder's DOWNLOAD_OVERRIDE_URL outranks mirror. If CI mispoints
    // it at the Electron runtime directory, mirror fallback is bypassed
    // entirely and 404s continue.
    ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL: "",
    ELECTRON_BUILDER_BINARIES_MIRROR: mirror,
    NPM_CONFIG_ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL: "",
    NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR: mirror,
    npm_config_electron_builder_binaries_download_override_url: "",
    npm_config_electron_builder_binaries_mirror: mirror,
    npm_package_config_electron_builder_binaries_download_override_url: "",
    npm_package_config_electron_builder_binaries_mirror: mirror,
  };
}

export function shouldFallbackElectronBuilderBinariesMirror(output, mirror, env = process.env) {
  const normalizedOutput = output.toLowerCase();
  const normalizedMirror = mirror.trim().replace(/\/+$/, "");
  const normalizedDefaultMirror = resolveDefaultElectronBuilderBinariesMirror(env).replace(
    /\/+$/,
    "",
  );
  const isMissingBuilderBinary =
    normalizedOutput.includes("status code 404") || normalizedOutput.includes("response code 404");
  const isDefaultDepsMirrorMissing =
    normalizedMirror === normalizedDefaultMirror &&
    normalizedOutput.includes("electron-builder-binaries/");
  const isMisconfiguredNpmMirrorElectronRuntime =
    normalizedOutput.includes("npmmirror.com/binaries/electron/") &&
    !normalizedOutput.includes("electron-builder-binaries/");

  return (
    isMissingBuilderBinary &&
    (isDefaultDepsMirrorMissing || isMisconfiguredNpmMirrorElectronRuntime)
  );
}

export function resolveElectronBuilderBinariesFallbackMirror(output, mirror, env = process.env) {
  if (!shouldFallbackElectronBuilderBinariesMirror(output, mirror, env)) {
    return null;
  }

  // CI once mispointed ELECTRON_BUILDER_BINARIES_MIRROR at the Electron runtime
  // mirror directory, which lacks builder helpers like dmg-builder/appimage/nsis.
  // registry.npmmirror's binary electron-builder-binaries path carries them;
  // prefer it to avoid macOS packaging cache misses.
  return NPMMIRROR_ELECTRON_BUILDER_BINARIES_MIRROR;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function artifactNameMatchesArch(fileName, archHint) {
  // Some environments append a suffix after the arch (e.g. mac-arm64_TEST.dmg).
  // Size audit must accept "_" as a post-arch separator, otherwise it falsely
  // reports the artifact missing after it was built.
  return new RegExp(`-${escapeRegExp(archHint.toLowerCase())}(?:[._-])`, "i").test(fileName);
}

function printHelp() {
  console.log(`Desktop packaging script

Usage:
  pnpm bundle:desktop
  pnpm bundle:desktop -- --os mac --arch x64
  pnpm bundle:desktop -- linux arm64

Options:
  --os, -o <mac|win|linux>     Target OS, default mac
  --arch, -a <x64|arm64>       Target CPU arch, default arm64
  --skip-prepare               Skip prepare:runtime-assets
  --skip-build                 Skip pnpm build
  --dry-run                    Print the final command without packaging
  -h, --help                   Show help

Environment:
  ZCODE_TARGET_OS              Same as --os
  ZCODE_TARGET_ARCH            Same as --arch
`);
}

function normalizeOs(rawOs) {
  const normalizedOs = osAliasMap.get(rawOs.toLowerCase());
  if (!normalizedOs) {
    throw new Error(`Unsupported target OS: ${rawOs}`);
  }
  return normalizedOs;
}

function normalizeArch(rawArch) {
  const normalizedArch = archAliasMap.get(rawArch.toLowerCase());
  if (!normalizedArch) {
    throw new Error(`Unsupported target CPU arch: ${rawArch}`);
  }
  return normalizedArch;
}

function parseArgs(argv) {
  const options = {
    os: process.env.ZCODE_TARGET_OS ?? null,
    arch: process.env.ZCODE_TARGET_ARCH ?? null,
    skipPrepare: process.env.ZCODE_SKIP_PREPARE === "1",
    skipBuild: process.env.ZCODE_SKIP_BUILD === "1",
    dryRun: false,
    positionals: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--skip-prepare") {
      options.skipPrepare = true;
      continue;
    }

    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }

    if (arg === "-o" || arg === "--os") {
      options.os = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg.startsWith("--os=")) {
      options.os = arg.slice("--os=".length);
      continue;
    }

    if (arg === "-a" || arg === "--arch") {
      options.arch = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg.startsWith("--arch=")) {
      options.arch = arg.slice("--arch=".length);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unsupported argument: ${arg}`);
    }

    options.positionals.push(arg);
  }

  const positionalOs = options.positionals[0];
  const positionalArch = options.positionals[1];

  if (options.positionals.length > 2) {
    throw new Error(`Too many arguments: ${options.positionals.join(" ")}`);
  }

  const resolvedOs = normalizeOs(options.os ?? positionalOs ?? DEFAULT_TARGET_OS);
  const resolvedArch = normalizeArch(options.arch ?? positionalArch ?? DEFAULT_TARGET_ARCH);

  return {
    os: resolvedOs,
    arch: resolvedArch,
    skipPrepare: options.skipPrepare,
    skipBuild: options.skipBuild,
    dryRun: options.dryRun,
  };
}

function run(command, args, envPatch = {}) {
  console.log(`[bundle] > ${command} ${args.join(" ")}`);

  runCommand(command, args, {
    cwd: desktopRoot,
    env: {
      ...process.env,
      ...envPatch,
    },
  });
}

function findBuiltArtifact(os, arch) {
  const distRoot = desktopDistRoot;
  const extensions = artifactExtensionsByOs[os] ?? [];
  const candidates = [];

  const archHints = artifactArchHintsByArch[arch] ?? [arch];

  for (const entry of readdirSync(distRoot, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }

    const fullPath = join(distRoot, entry.name);
    const lowerName = entry.name.toLowerCase();
    const matchesExtension = extensions.some((extension) =>
      lowerName.endsWith(extension.toLowerCase()),
    );
    const matchesArch = archHints.some((archHint) => artifactNameMatchesArch(lowerName, archHint));

    if (!matchesExtension || !matchesArch) {
      continue;
    }

    candidates.push({
      path: fullPath,
      mtimeMs: statSync(fullPath).mtimeMs,
    });
  }

  if (candidates.length === 0) {
    throw new Error(`No packaged artifact found for ${os}/${arch}; cannot run size audit`);
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0].path;
}
function runAndReadStdout(command, args) {
  return runCommandAndReadStdout(command, args, {
    cwd: desktopRoot,
    env: process.env,
    // `asar list app.asar` prints a huge file list for the current desktop package;
    // Node.js spawnSync's default 1MiB stdout buffer overflows with ENOBUFS.
    // Enlarge the buffer explicitly so a healthy package is never failed by
    // the verifier's own output read.
    maxBuffer: commandStdoutMaxBuffer,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function runTimedSync(label, fn) {
  const startMs = Date.now();
  console.log(`[ci][timer] ${label} start`);
  try {
    return fn();
  } finally {
    console.log(`[ci][timer] ${label} end duration_ms=${Date.now() - startMs}`);
  }
}

async function runTimedAsync(label, fn) {
  const startMs = Date.now();
  console.log(`[ci][timer] ${label} start`);
  try {
    return await fn();
  } finally {
    console.log(`[ci][timer] ${label} end duration_ms=${Date.now() - startMs}`);
  }
}

function shouldRetryElectronBuilderFailure(output) {
  const normalizedOutput = output.toLowerCase();
  const transientSignals = [
    "github.com/electron-userland/electron-builder-binaries/releases/download",
    "electron-builder-binaries/",
    "nsis-resources-",
    'get "https://',
    " eof",
    "read: connection reset by peer",
    "connection reset by peer",
    "connectex",
    "timed out",
    "timeout",
    "socket hang up",
    "unexpected end of file",
    "err_electron_builder_cannot_execute",
  ];

  return transientSignals.some((signal) => normalizedOutput.includes(signal));
}

async function runElectronBuilderWithRetry(args, envPatch) {
  const retryEnvPatch = { ...envPatch };
  let didFallbackElectronBuilderMirror = false;

  for (let attempt = 1; attempt <= electronBuilderRetryCount; attempt += 1) {
    console.log(
      `[bundle] > ${pnpmCommand} ${args.join(" ")} ${attempt > 1 ? `(retry ${attempt}/${electronBuilderRetryCount})` : ""}`.trim(),
    );

    const mergedEnv = {
      ...process.env,
      ...retryEnvPatch,
    };
    const result = await new Promise((resolvePromise) => {
      const child = spawn(pnpmCommand, args, {
        cwd: desktopRoot,
        env: mergedEnv,
        stdio: ["inherit", "pipe", "pipe"],
        // spawn-command no longer exports resolveSpawnCommand, and pnpm must not be
        // rewritten to *.cmd here. Reuse the same runtime options so Windows
        // still resolves the shim through the shell, keeping CI dry-run and
        // real packaging from crashing at module load.
        ...resolveSpawnRuntimeOptions(pnpmCommand),
      });

      let outputBuffer = "";
      const startedAt = Date.now();
      let lastOutputAt = startedAt;
      const heartbeatTimer = setInterval(() => {
        const now = Date.now();
        // The macOS codesign phase stays silent on stdout/stderr for a long time,
        // which looks like a hang in CI. Periodic heartbeat logs confirm the
        // process is alive and report total elapsed and silent time.
        console.log(
          `[bundle][heartbeat] electron-builder running elapsed_ms=${now - startedAt} idle_ms=${now - lastOutputAt}`,
        );
      }, electronBuilderHeartbeatIntervalMs);
      const appendOutput = (chunk, writeFn) => {
        const text = chunk.toString();
        outputBuffer += text;
        lastOutputAt = Date.now();
        writeFn(text);
      };

      child.stdout?.on("data", (chunk) =>
        appendOutput(chunk, (text) => process.stdout.write(text)),
      );
      child.stderr?.on("data", (chunk) =>
        appendOutput(chunk, (text) => process.stderr.write(text)),
      );

      child.on("error", (error) => {
        clearInterval(heartbeatTimer);
        resolvePromise({
          status: null,
          error,
          combinedOutput: `${outputBuffer}\n${error.message}`,
        });
      });

      child.on("close", (status) => {
        clearInterval(heartbeatTimer);
        resolvePromise({
          status,
          error: null,
          combinedOutput: outputBuffer,
        });
      });
    });

    if (!result.error && result.status === 0) {
      return;
    }

    const failureOutput = [
      result.combinedOutput,
      result.error?.message,
      typeof result.status === "number"
        ? `${pnpmCommand} ${args.join(" ")} failed with code ${result.status}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    const currentElectronBuilderMirror = retryEnvPatch.ELECTRON_BUILDER_BINARIES_MIRROR ?? "";
    const fallbackElectronBuilderMirror = resolveElectronBuilderBinariesFallbackMirror(
      failureOutput,
      currentElectronBuilderMirror,
      process.env,
    );
    if (
      attempt < electronBuilderRetryCount &&
      !didFallbackElectronBuilderMirror &&
      fallbackElectronBuilderMirror
    ) {
      // Self-hosted mirrors may miss newly synced arch resources, or CI may have
      // mispointed the builder mirror at the Electron runtime mirror directory.
      // A 404 is not a build-code error: only switch known-missing-file /
      // mispointed-mirror cases to registry.npmmirror and keep other explicit
      // mirrors as the user configured.
      Object.assign(
        retryEnvPatch,
        createElectronBuilderBinariesMirrorEnv(fallbackElectronBuilderMirror),
      );
      didFallbackElectronBuilderMirror = true;
      console.warn(
        `[bundle] electron-builder binaries mirror is missing files, retrying on registry.npmmirror (${attempt}/${electronBuilderRetryCount})`,
      );
      await sleep(electronBuilderRetryDelayMs);
      continue;
    }

    const shouldRetry =
      attempt < electronBuilderRetryCount && shouldRetryElectronBuilderFailure(failureOutput);
    if (!shouldRetry) {
      if (result.error) {
        throw result.error;
      }

      throw new Error(
        `${pnpmCommand} ${args.join(" ")} failed with code ${result.status ?? "unknown"}`,
      );
    }

    // Windows packagers occasionally get their NSIS download interrupted by
    // GitHub; electron-builder folds such transient network errors into
    // ERR_ELECTRON_BUILDER_CANNOT_EXECUTE, so the pipeline mistakes recoverable
    // jitter for a config failure. Retry download-class signals a bounded
    // number of times: steadier first-round cache misses without swallowing
    // real build errors forever.
    console.warn(
      `[bundle] electron-builder resource download failed, retrying in ${electronBuilderRetryDelayMs}ms (${attempt}/${electronBuilderRetryCount})`,
    );
    await sleep(electronBuilderRetryDelayMs);
  }
}

function resolveAppAsarPath(os, arch) {
  if (os === "mac") {
    return resolve(
      desktopRoot,
      desktopDistDir,
      arch === "arm64" ? "mac-arm64" : "mac",
      `${desktopProductIdentity.productName}.app`,
      "Contents",
      "Resources",
      "app.asar",
    );
  }

  if (os === "win") {
    return resolve(
      desktopRoot,
      desktopDistDir,
      arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked",
      "resources",
      "app.asar",
    );
  }

  if (os === "linux") {
    return resolve(
      desktopRoot,
      desktopDistDir,
      arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked",
      "resources",
      "app.asar",
    );
  }

  throw new Error(`Unsupported target OS: ${os}`);
}

function verifyPackagedRuntimeDependencies(os, arch) {
  const appAsarPath = resolveAppAsarPath(os, arch);
  if (!existsSync(appAsarPath)) {
    throw new Error(`Packaged artifact is missing app.asar: ${appAsarPath}`);
  }

  // Under pnpm's hoisted layout, electron-builder may pack a runtime module's own
  // code into app.asar while dropping child deps it still resolves from the
  // root node_modules. module-details-from-path was missed here before, and now
  // @fiahfy/icns misses pngjs — both produce installers that build fine and
  // then crash the main process with Cannot find module after launch. Verify
  // mechanically after bundling so broken packages stop shipping.
  const asarEntriesWithPackState = parseAsarListWithPackState(
    // pnpm exec mixes workspace engine warnings into stdout, which strict asar
    // line parsing would misread as failure. Execute the pinned CLI directly so
    // stdout carries only asar pack state instead of loosening the parser to
    // swallow unknown output.
    runAndReadStdout(process.execPath, [asarCliPath, "list", "--is-pack", appAsarPath]),
  );
  const asarEntries = asarEntriesWithPackState.map((entry) => entry.path);

  const targetPlatformKey = `${os === "mac" ? "darwin" : os === "win" ? "win32" : os}-${arch}`;
  const nativePackageViolations = findDesktopNativePackageViolations(
    asarEntriesWithPackState,
    targetPlatformKey,
  );
  if (nativePackageViolations.length > 0) {
    // Beyond afterPack, mechanically verify the final unpacked output once more so
    // later hooks or the builder cannot reintroduce other-platform natives or
    // write unpacked files back into the app.asar payload.
    throw new Error(`Packaged artifact contains out-of-scope native resources:\n- ${nativePackageViolations.join("\n- ")}`);
  }

  const runtimeModules = collectRuntimeModuleClosureEntries(
    requiredRuntimeModules,
    runtimeModuleLookupRoots,
  );
  const resolvableRuntimeModules = runtimeModules.filter((entry) => {
    if (!entry.sourceModulePath) {
      // afterPack injects whatever actually resolves on the current platform;
      // bundle verification must use the same scope, otherwise some CI install
      // layouts report "injection skipped but verification hard-failed".
      console.warn(
        `[bundle] runtime module not found in workspace, skip verify: ${entry.moduleName}; searched=${runtimeModuleLookupRoots
          .map((lookupRoot) => resolve(lookupRoot, "node_modules", entry.moduleName))
          .join(", ")}`,
      );
      return false;
    }
    return true;
  });

  for (const { moduleName } of resolvableRuntimeModules) {
    const moduleRoot = `/node_modules/${moduleName}`;
    // @electron/asar emits backslash paths via path.join when listing directories
    // on Windows. Exact POSIX matching used to false-report modules missing
    // even though they were packed into app.asar. Normalize to forward
    // slashes first so Windows packagers are not hurt by this check.
    const hasModule = asarEntries.some(
      (entry) => entry === moduleRoot || entry.startsWith(`${moduleRoot}/`),
    );

    if (!hasModule) {
      // Expand verification by dependency closure too, so a child dep missed by
      // the afterPack injection logic fails fast at the bundle stage.
      throw new Error(`Packaged artifact is missing runtime dependency ${moduleName}: ${appAsarPath}`);
    }
  }
}

async function main() {
  const { os, arch, skipPrepare, skipBuild, dryRun } = parseArgs(process.argv.slice(2));
  const buildArgs = [
    "exec",
    "electron-builder",
    "--config",
    "electron-builder.config.js",
    osBuilderFlagMap[os],
    archBuilderFlagMap[arch],
  ];

  console.log(`[bundle] target=${os}/${arch}`);
  console.log(`[bundle] skipPrepare=${skipPrepare} skipBuild=${skipBuild}`);

  const buildEnv = {
    ZCODE_TARGET_OS: os,
    ZCODE_TARGET_ARCH: arch,
    ...createElectronRuntimeMirrorEnv(resolveElectronMirror()),
    ...createElectronBuilderBinariesMirrorEnv(resolveElectronBuilderBinariesMirror()),
  };

  if (dryRun) {
    console.log(`[bundle] dry-run: ${pnpmCommand} ${buildArgs.join(" ")}`);
    process.exit(0);
  }

  if (!skipPrepare) {
    run(pnpmCommand, ["prepare:runtime-assets"], buildEnv);
  }

  if (!skipBuild) {
    run(pnpmCommand, ["build"], buildEnv);
  }

  await runTimedAsync("bundle:electron-builder", () =>
    runElectronBuilderWithRetry(buildArgs, buildEnv),
  );

  runTimedSync("bundle:verify-runtime-dependencies", () =>
    verifyPackagedRuntimeDependencies(os, arch),
  );

  const artifactPath = findBuiltArtifact(os, arch);
  runTimedSync("bundle:audit-bundle-size", () =>
    run(process.execPath, [
      resolve(desktopRoot, "scripts", "audit-bundle-size.mjs"),
      "--artifact-path",
      artifactPath,
    ]),
  );
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(`[bundle] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
