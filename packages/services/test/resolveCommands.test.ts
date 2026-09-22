import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { createSystemService } from "../src/system/systemService.js";

async function makeBinDir(files: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-resolve-commands-"));
  for (const file of files) {
    const path = join(dir, file);
    await writeFile(path, "#!/bin/sh\nexit 0\n");
    await chmod(path, 0o755);
  }
  return dir;
}

test("resolveCommands finds executables on PATH and reports missing as null", async () => {
  const dir = await makeBinDir(["codex", "pi"]);
  try {
    const service = createSystemService({
      env: { ...process.env, PATH: `${dir}${delimiter}/nonexistent` },
      platform: "darwin",
    });
    const resolved = await service.resolveCommands({ commands: ["codex", "pi", "grok"] });
    assert.equal(resolved.codex, join(dir, "codex"));
    assert.equal(resolved.pi, join(dir, "pi"));
    assert.equal(resolved.grok, null);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("resolveCommands rejects paths and empty PATH", async () => {
  const service = createSystemService({ env: { ...process.env, PATH: "" }, platform: "linux" });
  const resolved = await service.resolveCommands({
    commands: ["../bin/codex", "/usr/bin/codex", "codex;rm", "codex"],
  });
  assert.equal(resolved["../bin/codex"], null);
  assert.equal(resolved["/usr/bin/codex"], null);
  assert.equal(resolved["codex;rm"], null);
  assert.equal(resolved.codex, null);
});

test("resolveCommands honors PATHEXT on win32", async () => {
  const dir = await makeBinDir(["muse.CMD"]);
  try {
    const service = createSystemService({
      env: { PATH: dir, PATHEXT: ".CMD" },
      isExecutable: () => true,
      platform: "win32",
    });
    const resolved = await service.resolveCommands({ commands: ["muse"] });
    assert.equal(resolved.muse, join(dir, "muse.CMD"));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
