#!/usr/bin/env node
// Bundles the SystemOne Python shim into the ZCode release so routing
// works out of the box with zero manual setup.
//
// Copies the `systemone` Python package (shim.py + its local imports +
// the model registry) from the SystemOne release checkout into
// `<release>/systemone`, plus ZCode-specific docs. The CLI auto-starts it
// (`python3.11 -m systemone.shim --port 8765`) when nothing answers on
// 127.0.0.1:8765.
//
// Source resolution: ZCODE_SYSTEMONE_SRC env, else the default checkout
// path on Ryan's Mac. A missing source is a warning, not a build failure —
// the release still works, routing just stays fail-open.

import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const bundledDocsDir = join(scriptDir, "systemone-shim-files");

const DEFAULT_SOURCE_DIR = "/Users/duckets/systemone-release/systemone";

// The shim's runtime closure: shim.py imports .api, api.py imports
// .calibration. Everything else in the checkout (tune/distill/bench,
// examples, tests, logs) is dev tooling and stays out of the release.
const SHIM_FILES = [
  "__init__.py",
  "api.py",
  "calibration.py",
  "shim.py",
  "model_registry.json",
  "README.md",
];

const DOC_FILES = ["requirements.txt", "README-ZCODE.md"];

export function resolveSystemOneSourceDir(env = process.env) {
  return env.ZCODE_SYSTEMONE_SRC?.trim() || DEFAULT_SOURCE_DIR;
}

/**
 * Copy the SystemOne shim package into `<packageRoot>/systemone`.
 * Returns true when bundled, false when the source was missing (warned).
 */
export async function stageSystemOneShim(packageRoot, options = {}) {
  const env = options.env ?? process.env;
  const sourceDir = resolve(
    options.sourceDir ?? resolveSystemOneSourceDir(env),
  );
  const sourceStat = await stat(sourceDir).catch(() => null);
  if (!sourceStat?.isDirectory()) {
    console.warn(
      `[zcode] SystemOne shim source not found at ${sourceDir} ` +
        `(set ZCODE_SYSTEMONE_SRC to override); release ships without a ` +
        `bundled shim — auto-start disabled, routing stays fail-open.`,
    );
    return false;
  }
  const destDir = join(packageRoot, "systemone");
  await mkdir(destDir, { recursive: true });
  for (const file of SHIM_FILES) {
    const from = join(sourceDir, file);
    const fromStat = await stat(from).catch(() => null);
    if (!fromStat?.isFile()) {
      throw new Error(`SystemOne shim source is missing ${file}: ${from}`);
    }
    await cp(from, join(destDir, file));
  }
  for (const file of DOC_FILES) {
    const from = join(bundledDocsDir, file);
    const fromStat = await stat(from).catch(() => null);
    if (!fromStat?.isFile()) {
      throw new Error(`Missing bundled shim doc: ${from}`);
    }
    await cp(from, join(destDir, file));
  }
  const manifest = {
    name: "systemone-shim",
    bundledAt: new Date().toISOString(),
    source: sourceDir,
    files: [...SHIM_FILES, ...DOC_FILES],
    entry: "python3.11 -m systemone.shim --port 8765 (cwd: release root)",
  };
  await writeFile(
    join(destDir, ".zcode-bundle.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(`[zcode] bundled SystemOne shim from ${sourceDir}`);
  return true;
}
