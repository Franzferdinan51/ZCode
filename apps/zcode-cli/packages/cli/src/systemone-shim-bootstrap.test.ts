/**
 * Unit tests for the SystemOne shim auto-start bootstrap's pure helpers.
 * Process-spawning paths (findSuitablePython, ensureSystemOneShim) are
 * exercised end-to-end in the zero-setup verification instead.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  findSystemOneDir,
  shouldEnsureSystemOneShim,
} from "./systemone-shim-bootstrap.js";

test("shouldEnsureSystemOneShim: kill-switch disables the bootstrap", () => {
  assert.equal(
    shouldEnsureSystemOneShim([], { env: { ZCODE_SYSTEMONE: "0" } }),
    false,
  );
});

test("shouldEnsureSystemOneShim: trivial and nested invocations are skipped", () => {
  for (const argv of [
    ["--version"],
    ["-v"],
    ["--help"],
    ["-h"],
    ["--licenses"],
    ["--prepare-storage"],
  ]) {
    assert.equal(shouldEnsureSystemOneShim(argv, { env: {} }), false, argv.join(" "));
  }
  assert.equal(
    shouldEnsureSystemOneShim(["__zcode-plugin-host", "x"], {
      env: {},
      isPluginHost: true,
    }),
    false,
  );
});

test("shouldEnsureSystemOneShim: normal invocations bootstrap", () => {
  assert.equal(shouldEnsureSystemOneShim([], { env: {} }), true);
  assert.equal(shouldEnsureSystemOneShim(["-p", "hi"], { env: {} }), true);
  assert.equal(shouldEnsureSystemOneShim(["app-server", "--stdio"], { env: {} }), true);
});

test("findSystemOneDir: explicit ZCODE_SYSTEMONE_DIR wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "s1dir-"));
  writeFileSync(join(dir, "shim.py"), "# test");
  assert.equal(findSystemOneDir({ env: { ZCODE_SYSTEMONE_DIR: dir } }), dir);
});

test("findSystemOneDir: release layout <root>/systemone next to the bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "s1rel-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(root, "systemone"), { recursive: true });
  writeFileSync(join(root, "systemone", "shim.py"), "# test");
  assert.equal(
    findSystemOneDir({ env: {}, fromDir: agentDir }),
    join(root, "systemone"),
  );
});

test("findSystemOneDir: returns undefined when nothing is bundled", () => {
  const dir = mkdtempSync(join(tmpdir(), "s1none-"));
  assert.equal(findSystemOneDir({ env: {}, fromDir: dir }), undefined);
});
