import { pickProductEndpointEnv } from "@zcode/shared/zcodeEndpoint";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "tsup";
import { getBuildMetadata } from "./scripts/build-metadata.mjs";
import { resolveDesktopProductFlavor } from "./scripts/desktop-product-identity.mjs";
// tsup bundles the config file first; load build tools dynamically so their
// import.meta.dirname is not relocated into desktop.
const { loadBuiltinProviderConfig } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/builtin-provider-config.mjs")).href
);

const buildMetadata = getBuildMetadata();

// Load .env files manually: unlike Vite, tsup does not auto-read .env.*;
// these files only provide link constants.
function loadEnvFiles(): Record<string, string> {
  const vars: Record<string, string> = {};
  const files = ["../../.env", "../../.env.local"];
  if (process.env.NODE_ENV === "production") {
    files.push("../../.env.production");
  } else {
    files.push("../../.env.development", "../../.env.development.local");
  }
  for (const file of files) {
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2];
      }
    }
  }
  // Real environment variables take highest precedence.
  if (process.env.ZCODE_ENV) vars.ZCODE_ENV = process.env.ZCODE_ENV;
  if (process.env.ZCODE_BASE_URL) vars.ZCODE_BASE_URL = process.env.ZCODE_BASE_URL;
  if (process.env.VITE_ZCODE_BASE_URL) vars.VITE_ZCODE_BASE_URL = process.env.VITE_ZCODE_BASE_URL;
  // OAuth origin/client_id are read by the host runtime; keep the override entry
  // here so dev builds can observe the unified env source.
  if (process.env.ZAI_OAUTH_CLIENT_ID) vars.ZAI_OAUTH_CLIENT_ID = process.env.ZAI_OAUTH_CLIENT_ID;
  if (process.env.ZAI_OAUTH_ORIGIN) vars.ZAI_OAUTH_ORIGIN = process.env.ZAI_OAUTH_ORIGIN;
  if (process.env.ZAI_BUSINESS_BASE_URL) {
    vars.ZAI_BUSINESS_BASE_URL = process.env.ZAI_BUSINESS_BASE_URL;
  }
  if (process.env.ZAI_BUSINESS_LOGIN_URL) {
    vars.ZAI_BUSINESS_LOGIN_URL = process.env.ZAI_BUSINESS_LOGIN_URL;
  }
  if (process.env.VITE_ZAI_OAUTH_CLIENT_ID) {
    vars.VITE_ZAI_OAUTH_CLIENT_ID = process.env.VITE_ZAI_OAUTH_CLIENT_ID;
  }
  if (process.env.VITE_ZAI_OAUTH_ORIGIN) {
    vars.VITE_ZAI_OAUTH_ORIGIN = process.env.VITE_ZAI_OAUTH_ORIGIN;
  }
  return {
    ...vars,
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  };
}

const env = loadEnvFiles();
const { environment: zcodeEnv } = await loadBuiltinProviderConfig();
// Package identity and backend environment are separate axes:
// ZCODE_PREVIEW_IDENTITY=1 makes a production-backend build still package and run as ZCode Preview.
const zcodeProductFlavor = resolveDesktopProductFlavor({ ...process.env, ZCODE_ENV: zcodeEnv });
console.log(`[tsup] ZCODE_ENV=${zcodeEnv} ZCODE_PRODUCT_FLAVOR=${zcodeProductFlavor}`);

export function resolveDesktopTsupBundleSecurityOptions(
  runtimeEnv: Record<string, string | undefined> = process.env,
) {
  const isProduction = runtimeEnv.NODE_ENV === "production";
  const isE2ECoverageBuild = runtimeEnv.ZCODE_E2E_COVERAGE === "1";
  return {
    // Release main/host/preload bundles were previously not minified with
    // NODE_ENV=production; the output kept source comments and formatting
    // newlines, increasing reverse-engineering and implementation exposure risk.
    keepNames: isProduction && !isE2ECoverageBuild,
    minify: isProduction && !isE2ECoverageBuild,
    // Production packages ship no sourcemaps; emitting sourceMappingURL would
    // expose dead map paths. E2E coverage builds only enter the isolated app
    // cache and need maps to map V8 bundle ranges back to TypeScript sources;
    // normal release builds stay sourcemap-free.
    sourcemap: isE2ECoverageBuild || !isProduction,
  };
}

type DesktopTsupEsbuildOptions = {
  chunkNames?: string;
  legalComments?: "none" | "inline" | "eof" | "linked" | "external";
};

export function applyDesktopTsupEsbuildSecurityOptions(options: DesktopTsupEsbuildOptions) {
  // esbuild may keep license/legal comments when minifying for production;
  // release bundles must not leave source comments or sourcemap-entry comments
  // in main/host/preload.
  options.legalComments = "none";
}

const desktopTsupBundleSecurityOptions = resolveDesktopTsupBundleSecurityOptions();

function createSharedDefines() {
  return {
    __ZCODE_VERSION__: JSON.stringify(buildMetadata.appVersion),
    __ZCODE_COMMIT__: JSON.stringify(buildMetadata.buildCommitId),
    __ZCODE_BUILD_TIME__: JSON.stringify(buildMetadata.buildTime),
    __ZCODE_ENV__: JSON.stringify(zcodeEnv),
    __ZCODE_ENDPOINT_ENV__: JSON.stringify(pickProductEndpointEnv(env)),
    __ZCODE_PRODUCT_FLAVOR__: JSON.stringify(zcodeProductFlavor),
    // Computer Use Helper build identity — helperInstaller reads it to decide which Helper bundle to download.
    // When missing, the installer throws "Packaged ZCode is missing its embedded Computer Use Helper build identity".
    // CI builds inject it via the ZCODE_CUA_HELPER_BUILD_ID env; dev uses empty string fallback (dev helper never downloads).
    __ZCODE_CUA_HELPER_BUILD_ID__: JSON.stringify(
      process.env.ZCODE_CUA_HELPER_BUILD_ID?.trim() ?? "",
    ),
    // The client has a single CDN config, separate from the publish-side OSS target list.
    __ZCODE_CDN_BASE_URL__: JSON.stringify(env.ZCODE_CDN_BASE_URL?.trim() || ""),
  };
}

const desktopNodeRuntimeExternals = [
  "electron",
  "node-pty",
  "ssh2",
  "undici",
  "yaml",
  // node-forge uses a dynamic require("crypto") internally; inlining it into the
  // ESM main/host bundle makes Electron report Dynamic require of "crypto" is
  // not supported. Keep it as a runtime external like undici.
  "node-forge",
  // The ZIP unpacker depends on CommonJS require("fs") internally and cannot be
  // inlined into the ESM main/host output.
  "yauzl",
  // builder-util-runtime is CommonJS: httpExecutor -> CancellationToken does
  // require("events") internally. Inlining it into the ESM main/host bundle
  // crashes Electron at startup with Dynamic require of "events" is not
  // supported. Keep it as a runtime external like undici/node-forge.
  "builder-util-runtime",
];

function createDevReadyMarkerHook(target: "main" | "host" | "preload"): string {
  // A CLI-level --onSuccess fires once per child build in multi-config watch mode.
  // Previously the ready marker was written as soon as preload succeeded, so
  // Electron could start while main/host were still building. Each config now
  // writes its own marker on success so the dev startup script waits for all builds.
  return `node scripts/write-dev-ready-marker.mjs ${target}`;
}

export default defineConfig([
  {
    name: "main",
    entry: {
      "main/index": "src/main/index.ts",
      "main/browserWebmRecorder": "src/main/browserView/electronBrowserWebmRecorder.ts",
      "main/zcodeDataSizeWorker": "src/main/zcodeDataSizeWorker.ts",
      // Scan worker for the resource manager "storage" tab: main owns the
      // StorageService while traversal runs on a dedicated thread, resolved via new Worker(new URL()).
      "main/storageScanWorker": "src/main/storageScanWorker.ts",
    },
    outDir: "out",
    format: "esm",
    platform: "node",
    target: "node22",
    // If undici is inlined directly into the main ESM bundle, at runtime it hits
    // its internal CommonJS require("assert"), and Electron reports Dynamic
    // require of "assert" is not supported when loading the main output.
    // Desktop keeps undici external; the remote single-file bundle inlines it separately.
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zcode/server",
      "@zcode/shared",
      "@zcode/rpc",
      "@zcode/services",
      "@zcode/client",
      // The Provider Refactor workspace packages export TypeScript sources; the
      // Electron production runtime has no TS loader, so they must be inlined
      // with the Desktop bundle instead of leaving bare references to src/index.ts.
      "@zcode/provider",
      "@zcode/provider-node",
      // services is inlined into main, but its producer import used to stay a bare
      // reference; electron-builder also excludes node_modules/@zcode, so the
      // installed app crashed at startup with ERR_MODULE_NOT_FOUND. The
      // producer JS broker must be inlined along with services; the native
      // addon still only exists in the standalone Helper.
      "@zcode/zcode-cua",
    ],
    // OTLP endpoints and auth are only read at runtime; build-environment
    // credentials must never be baked into public installers.
    define: createSharedDefines(),
    // When main/host watch concurrently and share the out root, default chunk
    // names overwrite each other, which can point main's imports at a chunk
    // host just rewrote and trigger flaky "missing named export" startup errors.
    // Emit chunks per target into separate directories to isolate concurrent builds.
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "main/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("main"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "preload",
    entry: {
      "preload/embeddedBrowserJavaScriptDialog": "src/preload/embeddedBrowserJavaScriptDialog.ts",
      "preload/codingPlanWebview": "src/preload/codingPlanWebview.ts",
      "preload/browserVideoRecorder": "src/preload/browserVideoRecorder.ts",
      "preload/index": "src/preload/index.ts",
      "preload/resourceManager": "src/preload/resourceManager.ts",
      "preload/cuaPermissionPanel": "src/preload/cuaPermissionPanel.ts",
    },
    outDir: "out",
    format: "cjs",
    platform: "node",
    target: "node22",
    external: ["electron"],
    noExternal: ["@zcode/shared"],
    outExtension: () => ({ js: ".cjs" }),
    define: createSharedDefines(),
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
    },
    onSuccess: createDevReadyMarkerHook("preload"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "host",
    entry: {
      "host/index": "src/host/index.ts",
      "host/tasksStorageWorker": "src/host/tasksStorageWorker.ts",
    },
    outDir: "out",
    format: "esm",
    platform: "node",
    target: "node22",
    // host shares the same services graph as main; inlining undici would trigger
    // the same dynamic-require crash in the Electron ESM runtime. Keep it
    // external here too so the desktop host process starts in dev and packaged modes.
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zcode/server",
      "@zcode/shared",
      "@zcode/rpc",
      "@zcode/services",
      "@zcode/client",
      "@zcode/provider",
      "@zcode/provider-node",
      "@zcode/zcode-cua",
    ],
    define: createSharedDefines(),
    // Same chunk-isolation strategy as main so host/main outputs never overwrite each other.
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "host/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("host"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "scheduler",
    entry: { "scheduler/index": "src/scheduler/index.ts" },
    outDir: "out",
    format: "esm",
    platform: "node",
    target: "node22",
    // Isomorphic with host: the resident cron scheduler process reuses
    // @zcode/services (tasks-index + cron) and likewise keeps undici etc.
    // external to avoid dynamic-require crashes in the Electron ESM runtime.
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zcode/server",
      "@zcode/shared",
      "@zcode/rpc",
      "@zcode/services",
      "@zcode/client",
      "@zcode/provider",
      "@zcode/provider-node",
      "@zcode/zcode-cua",
    ],
    define: createSharedDefines(),
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "scheduler/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("scheduler"),
    ...desktopTsupBundleSecurityOptions,
  },
]);
