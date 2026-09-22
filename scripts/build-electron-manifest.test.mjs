import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const script = resolve(import.meta.dirname, "build-electron-manifest.mjs");
const sha = "ab".repeat(64);

async function run(args, outDir) {
  const out = join(outDir, "electron-manifest.yml");
  await execFileAsync(process.execPath, [script, "--out", out, ...args]);
  return readFile(out, "utf8");
}

test("emits a version-only manifest that electron-updater accepts", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "manifest-"));
  const text = await run(["--version", "3.15.0"], outDir);
  assert.match(text, /^version: 3\.15\.0$/m);
  assert.match(text, /^releaseDate: '/m);
  assert.doesNotMatch(text, /^files:/m);
});

test("emits absolute file URLs with checksums for desktop assets", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "manifest-"));
  const base = "https://github.com/Franzferdinan51/ZCode/releases/download/tag/";
  const text = await run(
    ["--version", "3.15.0", "--asset-base-url", base, "--asset", `ZCode-Local.dmg:${sha}`],
    outDir,
  );
  assert.match(text, new RegExp(`^  - url: ${base.replace(/[./]/g, (c) => `\\${c}`)}ZCode-Local\\.dmg$`, "m"));
  assert.match(text, new RegExp(`^    sha512: ${sha}$`, "m"));
});

test("rejects bad versions, paths, and checksums", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "manifest-"));
  await assert.rejects(run(["--version", "nope"], outDir), /Invalid version/);
  await assert.rejects(run(["--version", "3.15.0", "--asset", `../evil:${sha}`], outDir), /Invalid --asset name/);
  await assert.rejects(run(["--version", "3.15.0", "--asset", "a.dmg:xyz"], outDir), /Invalid --asset sha512/);
});
