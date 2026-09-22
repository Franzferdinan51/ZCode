/* eslint-disable max-lines -- Electron Builder config keeps related packaging hooks together so build order stays explicit. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { runCommand, runCommandAndReadStdout } from "../../scripts/spawn-command.mjs";
import { loadBuiltinProviderConfig } from "../../scripts/builtin-provider-config.mjs";
import { noticesFileName, stageElectronNotices } from "../../scripts/third-party-notices.mjs";
import { resolveNativeSearchReleasePlan } from "../../scripts/native-search-tools-config.mjs";
import { getBuildMetadata } from "./scripts/build-metadata.mjs";
import { collectRuntimeModuleClosureEntries } from "./scripts/runtime-dependency-closure.mjs";
import {
  resolvePackagedNodePtyPrebuildPath,
  restoreTargetNodePtyPrebuild,
} from "./scripts/node-pty-package-assets.mjs";
import { cleanupPackagedSourcemaps } from "./scripts/packaged-sourcemap-cleanup.mjs";
import { getTargetPlatform } from "./scripts/target-platform.mjs";
import {
  resolveDesktopArtifactSuffix,
  resolveDesktopIconBaseName,
  resolveDesktopIconsDirName,
  resolveDesktopProductIdentity,
} from "./scripts/desktop-product-identity.mjs";
import { verifyStagedKoffi } from "./scripts/koffi-package-assets.mjs";
const ELECTRON_BUILDER_ARCH = {
  1: "x64",
  3: "arm64",
};
function resolveElectronBuilderWindowsTarget({
  electronPlatformName,
  arch,
  configuredTargetPlatform,
}) {
  if (electronPlatformName !== "win32") {
    throw new Error(
      `[electron-builder.config] context platform is not win32: ${String(electronPlatformName)}`,
    );
  }
  const actualArch = ELECTRON_BUILDER_ARCH[arch];
  if (!actualArch) {
    throw new Error(
      `[electron-builder.config] unsupported electron-builder Windows architecture: ${String(arch)}`,
    );
  }
  const actualTarget = {
    os: "win32",
    arch: actualArch,
    key: `win32-${actualArch}`,
  };
  if (
    configuredTargetPlatform?.os !== actualTarget.os ||
    configuredTargetPlatform?.arch !== actualTarget.arch ||
    configuredTargetPlatform?.key !== actualTarget.key
  ) {
    throw new Error(
      `[electron-builder.config] configured target ${String(configuredTargetPlatform?.key)} does not match electron-builder target ${actualTarget.key}`,
    );
  }
  return actualTarget;
}
import {
  findDesktopNativePackageViolations,
  createDesktopNativePackagePrunePatterns,
  parseAsarListWithPackState,
} from "./scripts/desktop-native-package-policy.mjs";
import { replaceAppAsarFromStaging } from "./scripts/app-asar-repack.mjs";
import {
  patchNsisInstallSectionFile,
  restoreNsisInstallSectionFileSync,
} from "./scripts/patch-nsis-install-section.mjs";

const buildMetadata = getBuildMetadata();
const targetPlatform = getTargetPlatform();
const builtinProviderConfig = await loadBuiltinProviderConfig();
const desktopIdentityEnv = {
  ...process.env,
  ZCODE_ENV: builtinProviderConfig.environment,
};
const desktopProductIdentity = resolveDesktopProductIdentity(desktopIdentityEnv);
// Icon base name and multi-size directories follow the same identity check:
// local uses inverted icons, official identity uses the original icons.
const desktopIconBase = resolveDesktopIconBaseName(desktopIdentityEnv);
const desktopIconsDir = resolveDesktopIconsDirName(desktopIdentityEnv);
const nativeSearchReleasePlan = resolveNativeSearchReleasePlan({
  platform: targetPlatform.os,
  arch: targetPlatform.arch,
});
const rawMacSigningIdentity = process.env.APPLE_SIGNING_IDENTITY || process.env.CSC_NAME;
const macSigningIdentity =
  rawMacSigningIdentity?.replace(/^Developer ID Application:\s*/, "") ?? null;
const shouldEnableMacSigning =
  process.env.ZCODE_ENABLE_MAC_SIGN === "1" && Boolean(macSigningIdentity);
const workspaceRoot = resolve(import.meta.dirname, "../..");
const desktopPackageRoot = import.meta.dirname;
const runtimeModuleLookupRoots = [
  desktopPackageRoot,
  workspaceRoot,
  resolve(desktopPackageRoot, "node_modules", ".pnpm", "node_modules"),
  resolve(workspaceRoot, "node_modules", ".pnpm", "node_modules"),
];
const desktopDistDir = process.env.ZCODE_DESKTOP_DIST_DIR || "dist";
const DEFAULT_ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/";
// `pnpm exec asar` needs `.bin/asar`, but when @electron/asar is only a transitive
// electron-builder dep, Linux CI (pnpm hoisted) often cannot resolve the binary
// and `asar list` exits 1 without running. Depend on @electron/asar explicitly
// and run the CLI with Node directly so no platform misses the shim.
const requireFromConfig = createRequire(import.meta.url);
let nsisInstallSectionPatched = false;
let nsisInstallSectionOriginalSource = null;
let nsisInstallSectionPath = null;
const desktopElectronVersion = requireFromConfig("./package.json").devDependencies.electron;
const asarCliPath = resolve(
  dirname(requireFromConfig.resolve("@electron/asar/package.json")),
  "bin",
  "asar.js",
);
const REQUIRED_ASAR_RUNTIME_MODULES = [
  "module-details-from-path",
  "@opentelemetry/api-logs",
  // Bugfix: telemetry's OTLP exporter loads sdk-metrics at startup. Pnpm dev mode
  // resolves it from the workspace root, but electron-builder does not reliably
  // copy this hoisted dep, crashing the installer at launch. Inject sdk-metrics
  // as a closure root and bring its OpenTelemetry runtime deps recursively.
  "@opentelemetry/sdk-metrics",
  // OTLP proto export-chain closure root: bring otlp-transformer/protobufjs and
  // their children recursively, otherwise a hoisted layout missing protobufjs
  // crashes the installed app at startup with Cannot find module 'protobufjs/minimal'.
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/exporter-metrics-otlp-proto",
  "pngjs",
  // The proxy connectivity probe in @zcode/services dynamically requires("undici")
  // for ProxyAgent. tsup merges services code into the main/host output but does
  // not inline this runtime-required package, and electron-builder output may
  // drop the hoisted undici, so the final mac installer crashes at startup with
  // Cannot find module "undici". Force-inject undici into app.asar like the
  // other fallback deps so users never get a main-process crash in the installed app.
  "undici",
  // node-forge used to live only in bundle.mjs's verify list, relying on
  // electron-builder to pack it into app.asar — the same hazard class as yauzl
  // missing pend: a module the checks require must have someone responsible for
  // supplying it. node-forge has no children; when already in the artifact the
  // afterPack scan skips it, leaving existing packaging results unchanged.
  "node-forge",
  // Since 2.7.0 services added a feedback-log compression path using yazl; 2.6.0
  // had no such startup dep. Under pnpm hoisting yazl may enter app.asar while
  // child dep buffer-crc32 does not reliably ship; explicitly inject yazl as a
  // closure root so recursive collection completes the ZIP chain's deps.
  "yazl",
  // Once yauzl became a direct production dep of desktop/services, pnpm list --prod
  // dedupes the top-level yauzl node into a childless empty node, and
  // electron-builder's pnpm collector honors the first-registered empty node,
  // skipping the later one with the full tree — leaving yauzl in app.asar
  // without its runtime dep pend until bundle verification reports it. Inject
  // yauzl as a closure root, matching bundle.mjs's verify list, so recursive
  // collection brings pend into the artifact.
  "yauzl",
  // In production ssh2 is packed into app.asar but electron-builder occasionally
  // drops its dependency chain. Cannot find module 'asn1' (Require stack: ssh2
  // keyParser) has happened in the wild. Inject the ssh2 key chain together so
  // remote SSH connections in the installed app never fail on missing packages.
  "asn1",
  "bcrypt-pbkdf",
  "tweetnacl",
  // electron-updater -> builder-util-runtime -> debug requires("ms") at runtime.
  // Under pnpm hoisting electron-builder occasionally drops this leaf dep;
  // 3.4.0 (built by ci/cua-v0.3.17) crashed installers at startup with Cannot
  // find module 'ms' (Require stack: debug/src/common.js), taking down the
  // auto-update path. ms is a leaf package; injecting it explicitly keeps debug
  // resolving stably inside app.asar.
  "ms",
  // manifestUpdateProvider imports builder-util-runtime (HttpError) directly.
  // It is CommonJS with an internal require("events"), so it cannot be inlined
  // into the ESM main/host bundle. tsup marks it external; inject it into
  // app.asar as a closure root so debug/ms come along recursively.
  "builder-util-runtime",
];
// pacman deps must use Arch official repository package names. electron-builder's
// historical default set contains the removed libappindicator-gtk3/http-parser
// and lacks runtime libs Electron actually needs; maintain the minimal runtime
// closure explicitly so pacman -U never fails to resolve or hides a missing lib
// until startup.
const PACMAN_RUNTIME_DEPENDENCIES = [
  "gtk3",
  "nss",
  "libxss",
  "libxtst",
  "libnotify",
  "alsa-lib",
  "mesa",
  "xdg-utils",
];

const WINDOWS_INSTALL_MANIFEST_NAME = ".zcode-install-manifest";

async function writeWindowsInstallManifest(context) {
  if (context.electronPlatformName !== "win32") return;

  const root = context.appOutDir;
  const files = [];
  const visit = async (directory, relativeDirectory = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(relativePath.replaceAll("/", "\\"));
      }
    }
  };

  await visit(root);
  files.sort();
  await writeFile(join(root, WINDOWS_INSTALL_MANIFEST_NAME), `${files.join("\r\n")}\r\n`, "utf8");
}

function resolveElectronDownloadMirror(env = process.env) {
  const existingMirror =
    env.ZCODE_ELECTRON_RUNTIME_MIRROR ||
    env.NPM_CONFIG_ELECTRON_MIRROR ||
    env.npm_config_electron_mirror ||
    env.npm_package_config_electron_mirror ||
    env.ELECTRON_MIRROR;
  if (existingMirror?.trim()) {
    return existingMirror.trim();
  }

  return DEFAULT_ELECTRON_MIRROR;
}

const commandStdoutMaxBuffer = 64 * 1024 * 1024;
// The artifact suffix only marks the backend environment (_TEST); identity is
// distinguished by productName, so production-backend Preview packages carry no suffix.
const desktopArtifactEnvSuffix = resolveDesktopArtifactSuffix(process.env);

// Preview is an internally signed test package. When CI explicitly enables macOS
// signing but no identity exists, fail before producing an unsigned package so
// that "artifact exists" is never mistaken for having passed the same signing
// path as production.
if (
  desktopProductIdentity.flavor === "preview" &&
  process.env.ZCODE_ENABLE_MAC_SIGN === "1" &&
  !macSigningIdentity
) {
  throw new Error(
    "ZCode Preview macOS packaging requires APPLE_SIGNING_IDENTITY or CSC_NAME when ZCODE_ENABLE_MAC_SIGN=1",
  );
}

const PACKAGING_PRUNE_PATTERNS = [
  "!**/*.map",
  "!**/*.pdb",
  "!**/__tests__/**",
  "!**/test/**",
  "!**/tests/**",
  "!**/example/**",
  "!**/examples/**",
  "!**/README*",
  "!**/CHANGELOG*",
  "!**/CONTRIBUTING*",
  "!**/CODE_OF_CONDUCT*",
  "!**/SECURITY*",
];

function buildDesktopArtifactName(platformName, extension = "${ext}") {
  // Test-environment artifacts must differ in filename from official installers
  // so uploads, downloads, and manual acceptance never mix them up.
  return `\${productName}-\${version}-${platformName}-\${arch}${desktopArtifactEnvSuffix}.${extension}`;
}

function runAsarCommand(args) {
  runCommand(process.execPath, [asarCliPath, ...args], {
    cwd: import.meta.dirname,
    env: process.env,
  });
}

function runAsarCommandAndReadStdout(args) {
  return runCommandAndReadStdout(process.execPath, [asarCliPath, ...args], {
    cwd: import.meta.dirname,
    env: process.env,
    // app.asar is large in the current desktop package; asar list output can
    // exceed the default buffer and trigger ENOBUFS. Enlarge the buffer
    // explicitly so the packaging flow is never failed by the check that
    // decides whether injection is needed.
    maxBuffer: commandStdoutMaxBuffer,
    stdio: ["ignore", "pipe", "inherit"],
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

function resolveAppAsarPath(context) {
  if (context.electronPlatformName === "darwin") {
    const appName = `${context.packager?.appInfo?.productFilename ?? "ZCode"}.app`;
    return resolve(context.appOutDir, appName, "Contents", "Resources", "app.asar");
  }

  return resolve(context.appOutDir, "resources", "app.asar");
}

function resolvePackagedResourcesDir(context) {
  if (context.electronPlatformName === "darwin") {
    const appName = `${context.packager?.appInfo?.productFilename ?? "ZCode"}.app`;
    return resolve(context.appOutDir, appName, "Contents", "Resources");
  }

  return resolve(context.appOutDir, "resources");
}

function normalizeAsarEntry(entry) {
  return entry.trim().replaceAll("\\", "/");
}

function resolveMissingRuntimeModules(appAsarPath) {
  const asarEntries = runAsarCommandAndReadStdout(["list", appAsarPath])
    .split("\n")
    .map(normalizeAsarEntry)
    .filter(Boolean);
  const asarEntrySet = new Set(asarEntries);

  const runtimeModules = collectRuntimeModuleClosureEntries(
    REQUIRED_ASAR_RUNTIME_MODULES,
    runtimeModuleLookupRoots,
  );
  const resolvableRuntimeModules = runtimeModules.filter((entry) => {
    if (!entry.sourceModulePath) {
      // On some platforms/install layouts, some runtime deps may be pruned or never
      // land in this packaging workspace. Throwing in the copy phase used to
      // abort the whole platform package; now log a warning and skip the module
      // so afterPack only handles deps that actually resolve here, instead of
      // failing all of CI over one missing optional dep.
      console.warn(
        `[afterPack] runtime module not found, skip injection: ${entry.moduleName}; searched=${runtimeModuleLookupRoots
          .map((lookupRoot) => resolve(lookupRoot, "node_modules", entry.moduleName))
          .join(", ")}`,
      );
      return false;
    }
    return true;
  });
  return resolvableRuntimeModules.filter((entry) => {
    const { moduleName } = entry;
    const moduleRoot = `/node_modules/${moduleName}`;
    if (asarEntrySet.has(moduleRoot)) {
      return false;
    }
    for (const entry of asarEntrySet) {
      if (entry.startsWith(`${moduleRoot}/`)) {
        return false;
      }
    }
    return true;
  });
}

async function injectHoistedRuntimeModulesIntoAsar(context) {
  const appAsarPath = resolveAppAsarPath(context);
  if (!existsSync(appAsarPath)) {
    throw new Error(`Packaged artifact is missing app.asar: ${appAsarPath}`);
  }

  const missingRuntimeModules = runTimedSync("afterPack:scan-missing-runtime-modules", () =>
    resolveMissingRuntimeModules(appAsarPath),
  );
  if (missingRuntimeModules.length === 0) {
    // afterPack used to fully extract/pack app.asar every time, rewriting it even
    // when runtime deps were already complete — adding tens of seconds to every
    // package run. Scan for missing modules first and only rewrite when something
    // is actually absent.
    console.log("[afterPack] runtime modules already complete, skip app.asar rewrite");
    return;
  }
  console.log(`[afterPack] missing runtime modules count=${missingRuntimeModules.length}`);

  // CI points TMPDIR at the in-project .tmp, which GitLab get_sources/clean may
  // wipe before the script starts. Rewriting app.asar in afterPack also relies
  // on mkdtempSync, so create the parent dir defensively — otherwise the later
  // signing stage only sees the .app vanish.
  mkdirSync(tmpdir(), { recursive: true });
  const stagingDir = mkdtempSync(resolve(tmpdir(), "zcode-app-asar-"));
  try {
    runTimedSync("afterPack:asar-extract", () =>
      runAsarCommand(["extract", appAsarPath, stagingDir]),
    );

    const stagingNodeModulesDir = resolve(stagingDir, "node_modules");
    mkdirSync(stagingNodeModulesDir, { recursive: true });

    runTimedSync("afterPack:copy-runtime-modules", () => {
      for (const runtimeModule of missingRuntimeModules) {
        const { moduleName, sourceModulePath } = runtimeModule;
        const targetModulePath = resolve(stagingNodeModulesDir, moduleName);

        if (!sourceModulePath) {
          throw new Error(
            `Runtime dependency ${moduleName} not found, searched: ${runtimeModuleLookupRoots
              .map((lookupRoot) => resolve(lookupRoot, "node_modules", moduleName))
              .join(", ")}`,
          );
        }

        // Under pnpm hoisting, electron-builder may pack the main package into
        // app.asar while dropping runtime deps it still resolves from the root
        // node_modules. require-in-the-middle missed module-details-from-path
        // before, and now @fiahfy/icns misses pngjs — both trigger Cannot find
        // module in the installed app and crash the main process at startup.
        // Complete the dependency closure recursively from package.json instead
        // of patching one missing package at a time and discovering the next
        // child dep after release. Explicit package.json deps, local node_modules
        // mirrors, and files includes all failed to land it in asar reliably,
        // so rewrite app.asar directly in afterPack: inject these runtime
        // packages first, then hand off to signing and packaging.
        mkdirSync(dirname(targetModulePath), { recursive: true });
        rmSync(targetModulePath, { force: true, recursive: true });
        cpSync(sourceModulePath, targetModulePath, { recursive: true });
      }
    });

    await runTimedAsync("afterPack:asar-pack", () =>
      replaceAppAsarFromStaging({
        sourceDir: stagingDir,
        appAsarPath,
        targetPlatformKey: targetPlatform.key,
        runAsarCommand,
      }),
    );
  } finally {
    rmSync(stagingDir, { force: true, recursive: true });
  }
}

async function stripPackagedSourcemapReferences(context) {
  // electron-builder's files rules can exclude .map files but cannot strip the
  // trailing sourcemap comments from JS/CSS; afterPack's runtime-dep injection
  // may also reintroduce third-party sourceMappingURLs. Clean app.asar and
  // unpacked/extraResources uniformly so release packages expose no sourcemap
  // path entries.
  await cleanupPackagedSourcemaps({
    appAsarPath: resolveAppAsarPath(context),
    resourcesDir: resolvePackagedResourcesDir(context),
    runAsarCommand,
    runTimedSync,
    runTimedAsync,
    replaceAppAsarFromStaging: ({ sourceDir, appAsarPath }) =>
      replaceAppAsarFromStaging({
        sourceDir,
        appAsarPath,
        targetPlatformKey: targetPlatform.key,
        runAsarCommand,
      }),
  });
}

function assertPackagedNativeResourcePolicy(context) {
  const appAsarPath = resolveAppAsarPath(context);
  const entries = parseAsarListWithPackState(
    runAsarCommandAndReadStdout(["list", "--is-pack", appAsarPath]),
  );
  const violations = findDesktopNativePackageViolations(entries, targetPlatform.key);
  if (violations.length > 0) {
    // supportedArchitectures lets the workspace prepare multi-platform deps, but an
    // installer may only carry target-platform resources. Canvas and node-pty
    // natives for other platforms used to land in asar/unpacked together,
    // inflating the package by hundreds of MiB.
    throw new Error(`Desktop native resource boundary check failed:\n- ${violations.join("\n- ")}`);
  }
}

function assertPackagedNodePtyPrebuild(context) {
  const targetBinaryPath = resolvePackagedNodePtyPrebuildPath({
    resourcesDir: resolvePackagedResourcesDir(context),
    platformKey: targetPlatform.key,
  });
  if (!existsSync(targetBinaryPath))
    throw new Error(`node-pty prebuilt binary missing: ${targetBinaryPath}`);
}

/** @type {import("electron-builder").Configuration} */
export default {
  appId: desktopProductIdentity.appId,
  // Linux deb packaging (fpm) validates homepage, author.email, and maintainer in
  // the package metadata. Missing fields fail the artifact stage outright in CI,
  // so complete them uniformly in the build config instead of relying on external injection.
  extraMetadata: {
    version: buildMetadata.appVersion,
    zcodeProductFlavor: desktopProductIdentity.flavor,
    homepage: "https://zcode.z.ai",
    author: {
      name: "ZCode",
      email: "dev@zcode.z.ai",
    },
  },
  // The macOS signing stage codesigns every language pack under Electron
  // Framework one by one. The default full language set produces a huge number
  // of locale.pak signing calls and stretches packaging time. Keep only the
  // languages the current product needs to cut signed files and total CI time.
  electronLanguages: ["en-US", "zh-CN"],
  // Under pnpm workspace + semver ranges (e.g. ^41.0.3), electron-builder
  // sometimes cannot derive the Electron version stably from the dependency
  // tree and aborts the bundle. Pin the Electron version the desktop currently
  // uses explicitly so packaging never guesses unreliably again.
  electronVersion: "41.0.3",
  electronDownload: {
    // ELECTRON_MIRROR is @electron/get's global env var; it overrides the
    // mirrorOptions that generic artifacts like dmg-builder pass themselves,
    // misrouting builder helper packages into the Electron runtime mirror
    // directory. Use electron-builder's dedicated config instead so only the
    // Electron runtime zip download is affected.
    mirror: resolveElectronDownloadMirror(),
  },
  productName: desktopProductIdentity.productName,
  // App icon (no extension; each platform appends .icns/.ico/.png): the local
  // identity uses inverted icons, while the official identity points explicitly
  // at the original icons, resolving to the same files as the old default.
  icon: `build/${desktopIconBase}`,
  directories: {
    // macOS arm64/x64 CI may share one checkout and package in parallel. The
    // output root can be isolated per arch so one job cleaning dist never
    // deletes the .app another job is signing.
    output: desktopDistDir,
    buildResources: "build",
  },
  files: [
    "out/**/*",
    "package.json",
    // app.asar packs the desktop runtime node_modules along with it, and .map /
    // README files shipped by deps would enter the installer verbatim. Prune
    // once at the top package level: remove non-runtime files only, keep LICENSEs.
    ...PACKAGING_PRUNE_PATTERNS,
    ...createDesktopNativePackagePrunePatterns(targetPlatform.key),
    "!node_modules/@zcode/**",
    "!node_modules/react/**",
    "!node_modules/react-dom/**",
  ],
  asarUnpack: [
    // node-pty's target prebuild also contains helper executables like
    // spawn-helper / winpty-agent.exe, so the whole target directory must stay
    // unpacked; other-platform directories are already pruned by files rules.
    `node_modules/node-pty/prebuilds/${targetPlatform.key}/**`,
  ],
  beforePack: async (context) => {
    runTimedSync("beforePack:restoreTargetNodePtyPrebuild", () =>
      restoreTargetNodePtyPrebuild({ desktopPackageRoot, targetPlatform }),
    );
    if (context.electronPlatformName !== "win32" || nsisInstallSectionPatched) {
      return;
    }

    nsisInstallSectionPath = resolve(
      dirname(requireFromConfig.resolve("app-builder-lib/package.json")),
      "templates",
      "nsis",
      "installSection.nsh",
    );
    const patchResult = await runTimedAsync("beforePack:patchNsisInstallSection", () =>
      patchNsisInstallSectionFile(nsisInstallSectionPath),
    );
    nsisInstallSectionPatched = true;
    nsisInstallSectionOriginalSource = patchResult.originalSource;
    if (patchResult.changed) {
      // electron-builder compiles NSIS later in the current process; restore the
      // upstream template in node_modules after the whole build process exits
      // so one packaging run's customizations never persist in dev dependencies.
      process.once("exit", () => {
        restoreNsisInstallSectionFileSync({
          filePath: nsisInstallSectionPath,
          originalSource: nsisInstallSectionOriginalSource,
        });
      });
    }
  },
  afterExtract: async (context) => {
    // Fix: the macOS rename phase deletes the archive's top-level license, so the
    // target platform's original text must be kept in afterExtract.
    const framework = context.packager.info.framework;
    const resources =
      context.electronPlatformName === "darwin"
        ? resolve(context.appOutDir, framework.distMacOsAppName, "Contents", "Resources")
        : resolve(context.appOutDir, "resources");
    await stageElectronNotices(context.appOutDir, resources, framework.version);
  },
  afterPack: async (context) => {
    const actualWindowsTarget =
      context.electronPlatformName === "win32"
        ? resolveElectronBuilderWindowsTarget({
            electronPlatformName: context.electronPlatformName,
            arch: context.arch,
            configuredTargetPlatform: targetPlatform,
          })
        : null;
    await runTimedAsync("afterPack:injectHoistedRuntimeModulesIntoAsar", () =>
      injectHoistedRuntimeModulesIntoAsar(context),
    );
    await runTimedAsync("afterPack:stripPackagedSourcemapReferences", () =>
      stripPackagedSourcemapReferences(context),
    );
    runTimedSync("afterPack:assertPackagedNativeResourcePolicy", () =>
      assertPackagedNativeResourcePolicy(context),
    );
    runTimedSync("afterPack:assertPackagedNodePtyPrebuild", () =>
      assertPackagedNodePtyPrebuild(context),
    );
    if (actualWindowsTarget) {
      await runTimedAsync("afterPack:writeWindowsInstallManifest", () =>
        writeWindowsInstallManifest(context),
      );
    }
  },
  extraResources: [
    { from: resolve(workspaceRoot, noticesFileName), to: noticesFileName },
    ...(targetPlatform.os === "darwin"
      ? [
          {
            // Snap data source for the CUA permission floater
            // (CGWindowListCopyWindowInfo, needs no TCC permission). The main
            // process resolves it via process.resourcesPath; when missing the
            // watcher fails open and the floater still works, just without
            // snapping — so no existence assertion here.
            from: "resources/macos-window-bounds/zcode-window-bounds",
            to: "macos-window-bounds/zcode-window-bounds",
          },
        ]
      : []),
    {
      // Official packages cannot read built-in fallback configs (community,
      // feedback, etc.) from the repo directory. Place them explicitly in
      // resources/config, matching the main process's process.resourcesPath resolution.
      from: resolve(workspaceRoot, "config/default.json"),
      to: "config/default.json",
    },
    {
      // The Provider Registry's ZCode Built-in Config is the only built-in source of
      // static Provider/Model facts. Ship it explicitly with the package so the
      // official Host never falls back to old Catalog/Preset hardcodes.
      from: builtinProviderConfig.sourcePath,
      to: "config/provider/zcode-builtin.json",
    },
    {
      // App icons: placed in the resources directory after packaging; the main process loads them via process.resourcesPath.
      from: `build/${desktopIconBase}.png`,
      to: "icon.png",
    },
    ...(targetPlatform.os === "linux"
      ? [
          {
            // AppImage user-level hicolor icon install uses the real 512x512 asset so
            // the directory's nominal size never disagrees with the PNG IHDR.
            from: `build/${desktopIconsDir}/512x512.png`,
            to: "icon_512x512.png",
          },
        ]
      : []),
    {
      // Standalone Windows icons: dev and packaged modes share the same taskbar/window icon resources.
      from: `build/${desktopIconBase}_windows.png`,
      to: "icon_windows.png",
    },
    ...(targetPlatform.os === "win32"
      ? [
          {
            // Windows tray icon: in packaged mode Tray can only stably read
            // standalone resources under resources. Do not reuse the window PNG
            // here, or the notification area degrades into a blurry upscale at high DPI.
            from: `build/${desktopIconBase}.ico`,
            to: "tray_icon.ico",
          },
        ]
      : []),
    {
      // Agent runtime assets, packaged into resources/glm. The desktop embeds the
      // agent's JS bundle (glm/zcode.cjs, generated by prepare:agent-bundle); the
      // Host process runs `zcode.cjs app-server --stdio` with the app's own
      // Electron Node runtime (ELECTRON_RUN_AS_NODE) instead of shipping a
      // standalone Node binary. Remote SSH/WSL still uses native binaries (no Electron).
      from: `bundled-agents/${targetPlatform.key}/glm`,
      to: "glm",
      filter: ["**/*", "!**/*.map"],
    },
    {
      // The agent shell used to rely entirely on the host system PATH, so GUI
      // launches often missed the user's own rg. Ship ripgrep as a built-in
      // desktop runtime tool in resources/tools; host/server append the directory
      // to PATH later with the user's version first and the bundled rg as fallback.
      from: `bundled-tools/${targetPlatform.key}/ripgrep`,
      to: "tools/ripgrep",
      filter: ["**/*"],
    },
    ...nativeSearchReleasePlan.extraResourceToolIds.map((toolId) => ({
      from: `bundled-tools/${targetPlatform.key}/${toolId}`,
      to: `tools/${toolId}`,
      filter: ["**/*"],
    })),
  ],
  // postinstall prefers reusing node-pty's bundled Windows prebuilds and only
  // electron-rebuilds other platforms on demand. Packaging uniformly reuses the
  // native files prepared at install time so electron-builder never triggers
  // another uncontrolled round of local compilation.
  npmRebuild: false,
  // OAuth deep link protocol registration (macOS packages must declare CFBundleURLTypes in Info.plist).
  protocols: [
    {
      // The protocol handler's display name used to be the lowercase scheme, so the
      // packaged protocol description never showed the product name. The display
      // name now follows the installer identity; the local identity uses a
      // dedicated zcode-local scheme so it never fights the official install
      // for the default handler.
      name: desktopProductIdentity.productName,
      schemes: [desktopProductIdentity.flavor === "local" ? "zcode-local" : "zcode"],
    },
  ],
  mac: {
    target: ["dmg", "zip"],
    category: "public.app-category.developer-tools",
    artifactName: buildDesktopArtifactName("mac"),
    extendInfo: {
      NSAppleEventsUsageDescription: `${desktopProductIdentity.productName} needs Apple Events access to coordinate local automation workflows with user-approved desktop apps.`,
    },
    // The pre-sign script runs native codesign and needs the full "Developer ID
    // Application: ..." identity string, but electron-builder's mac.identity on
    // 26.x rejects names with that prefix. Normalize the prefix on the
    // electron-builder side only so local pre-signing and final .app signing
    // never fight each other.
    // z-code previously only had local unsigned packaging config: even with CI
    // cert variables injected, electron-builder never switched to the hardened
    // runtime / entitlement release parameters on its own. Gather them behind
    // explicit env switches so local dev is never pinned by signing config and
    // CI release turns them on as needed.
    identity: shouldEnableMacSigning ? macSigningIdentity : null,
    // macOS artifacts use a two-stage pipeline: sign at build time, notarize in a
    // standalone stage. Without explicitly disabling electron-builder's built-in
    // notarize here, it would read Apple credentials at build time and attempt
    // notarization immediately, hard-requiring APPLE_APP_SPECIFIC_PASSWORD and
    // failing before any DMG is produced.
    notarize: false,
    hardenedRuntime: shouldEnableMacSigning,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    // Runtime executables were already signed in the standalone pre-sign stage
    // before packaging; if electron-builder deep-scans these directories again
    // while signing the main app, macOS codesign time balloons. Match absolute
    // paths by "any prefix + Contents/Resources" so ^Contents/... patterns still
    // hit in CI. Matches skip re-signing/retraversing pre-signed directories
    // while keeping main-app and framework signatures. The CUA Helper already
    // completed Developer ID signing and notarization stapling in its own job;
    // re-signing the nested Helper would change its CDHash and invalidate the
    // staple in the final user package.
    signIgnore: [
      "[/\\\\]Contents[/\\\\]Resources[/\\\\]glm([/\\\\]|$)",
      "[/\\\\]Contents[/\\\\]Resources[/\\\\]tools([/\\\\]|$)",
    ],
  },
  win: {
    target: ["nsis"],
    artifactName: buildDesktopArtifactName("win"),
  },
  linux: {
    target: ["AppImage", "deb", "rpm", "pacman"],
    artifactName: buildDesktopArtifactName("linux"),
    // The desktop package name is scoped (@zcode/desktop), so electron-builder
    // would default the Linux executable/Icon to @zcodedesktop. Some desktop
    // environments cannot match a hicolor icon by that name and fall back to the
    // system gear. Pin a stable lowercase name so Icon=zcode matches
    // /usr/share/icons/hicolor/*/apps/zcode.png.
    executableName: desktopProductIdentity.linuxExecutableName,
    category: "Development",
    maintainer: "ZCode <dev@zcode.z.ai>",
  },
  deb: {
    // Production and Preview must be two dpkg packages; renaming only the
    // executable still lets the installer treat the other version as an upgrade replacement.
    packageName: desktopProductIdentity.linuxPackageName,
  },
  pacman: {
    // Same flavor isolation as deb/rpm so pacman never treats Preview/Production as one package overwriting the other.
    packageName: desktopProductIdentity.linuxPackageName,
    // Explicitly list Arch-official-repo resolvable Electron runtime deps to replace
    // electron-builder's stale defaults, which fail installs on removed package names.
    depends: PACMAN_RUNTIME_DEPENDENCIES,
    // Electron Builder names the pacman target .pacman by default; the Arch native standard extension is .pkg.tar.zst.
    artifactName: buildDesktopArtifactName("linux", "pkg.tar.zst"),
  },
  rpm: {
    // Same constraint as deb: production and Preview must be two independent rpm
    // packages or dnf treats the other flavor as an upgrade replacement. rpms
    // target RHEL 8+ (glibc 2.28); the package-wide glibc floor is already at
    // 2.28 via the node-pty prebuild and bfs/ugrep, while the Electron 41 main
    // binary only references up to 2.25. fpm needs rpmbuild and xz on the build host.
    packageName: desktopProductIdentity.linuxPackageName,
    // electron-builder's rpm default Requires (gtk3/nss/libXtst etc.) omit the
    // mesa-libgbm and alsa-lib that the Electron ELF actually DT_NEEDEDs; a
    // minimal rockylinux:8 container boots to a missing libgbm.so.1 after
    // install. Append -d via fpm (accumulating after the default Requires) —
    // never depends, which would replace the whole default Requires set.
    fpm: ["-d", "mesa-libgbm", "-d", "alsa-lib"],
  },
  dmg: {
    // The runtime resources carried by current installers (especially agent
    // node_modules) exceed the default DMG size estimate. With automatic sizing
    // the mounted DMG volume was only ~1.9Gi, and copying the .app ran out of
    // space and lost the Electron Framework main binary, so launches after
    // install failed with DYLD Library missing. Enlarge the DMG explicitly so
    // truncated copies never produce "Framework dir exists but core files missing".
    size: "3200m",
    // Use a custom installer background image.
    background: "build/dmg_background.png",
    // Installer volume icons uniformly use installer-specific artwork instead of
    // reusing the app icon, which would hurt installer recognizability.
    icon: `build/${desktopIconBase}_installer.icns`,
    contents: [
      // Experimental tweak: pin explicit icon coordinates for hidden resource
      // files to push them toward the corners.
      { x: 640, y: 56, type: "file", path: ".background.tiff" },
      { x: 640, y: 56, type: "file", path: ".VolumeIcon.icns" },
      { x: 130, y: 220 },
      { x: 410, y: 220, type: "link", path: "/Applications" },
    ],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    // The Windows install flow uses standalone installer icons, decoupled from the app runtime icons.
    installerIcon: `build/${desktopIconBase}_installer.ico`,
    uninstallerIcon: `build/${desktopIconBase}_installer.ico`,
    installerHeaderIcon: `build/${desktopIconBase}_installer.ico`,
  },
  detectUpdateChannel: false,
  publish: {
    provider: "generic",
    // Current OSS/CDN answers multi-Range requests with 206 but keeps Content-Type
    // application/x-msdownload, so electron-updater falls back to a full download
    // for the missing multipart/byteranges. With multiple ranges off, updates
    // still go differential — just pulling diff blocks in single-Range order —
    // so Windows users never degrade from ~15MB to a 300MB+ full package.
    useMultipleRangeRequest: false,
    // New clients use the server-side manifest provider at runtime; keep only the
    // electron-builder-required generic publish placeholder here so packaged
    // output stops carrying the configurable old stable feed.
    url: "http://localhost:8081",
  },
};
