import assert from "node:assert/strict";
import test from "node:test";
import {
  EXTERNAL_HARNESSES,
  externalHarnessBinaries,
  harnessRouteTarget,
  resolveExternalHarnessStatus,
} from "../src/harness-router/externalHarnesses.js";

test("catalog covers the requested harnesses", () => {
  const ids = new Set(EXTERNAL_HARNESSES.map((harness) => harness.id));
  for (const id of [
    "zcode",
    "codex",
    "pi",
    "grok",
    "grok-local",
    "muse",
    "minimax",
    "cline",
  ]) {
    assert.equal(ids.has(id), true, `missing harness ${id}`);
  }
  // Z.AI has no standalone coding CLI binary; it is covered by the built-in
  // ZCode agent runtime plus the zai-api provider template.
  assert.equal(ids.has("zai"), false);
});

test("catalog entries have unique ids, binaries, and launch commands", () => {
  const ids = new Set<string>();
  const binaries = new Set<string>();
  for (const harness of EXTERNAL_HARNESSES) {
    assert.equal(ids.has(harness.id), false, `duplicate id ${harness.id}`);
    ids.add(harness.id);
    assert.equal(binaries.has(harness.binary), false, `duplicate binary ${harness.binary}`);
    binaries.add(harness.binary);
    assert.ok(harness.name.trim().length > 0);
    assert.ok(harness.launchCommand.trim().length > 0);
    assert.ok(
      harness.launchCommand.split(/\s+/)[0] === harness.binary,
      `${harness.id} must launch its own binary`,
    );
  }
});

test("externalHarnessBinaries deduplicates in order", () => {
  assert.deepEqual(externalHarnessBinaries(), [
    "zcode",
    "codex",
    "pi",
    "grok",
    "grok-local",
    "muse",
    "claude",
    "gemini",
    "qwen",
    "kimi",
    "opencode",
    "aider",
    "omp",
    "goose",
    "cline",
    "mmx",
    "mcode",
    "hermes",
  ]);
});

test("harnessRouteTarget maps driver harnesses to registry targets", () => {
  assert.deepEqual(harnessRouteTarget("codex"), {
    driverId: "codex",
    providerId: "external:codex",
    modelId: "external-codex",
  });
  assert.deepEqual(harnessRouteTarget("muse")?.providerId, "external:muse");
  assert.deepEqual(harnessRouteTarget("grok-local"), {
    driverId: "grok-local",
    providerId: "external:grok-local",
    modelId: "external-grok-local",
  });
  assert.deepEqual(harnessRouteTarget("mcode")?.modelId, "external-mcode");
  assert.deepEqual(harnessRouteTarget("hermes"), {
    driverId: "hermes",
    providerId: "external:hermes",
    modelId: "external-hermes",
  });
  assert.equal(harnessRouteTarget("zcode"), null);
  assert.equal(harnessRouteTarget("pi"), null);
  assert.equal(harnessRouteTarget("nope"), null);
});

test("resolveExternalHarnessStatus honors builtin and detection availability", () => {
  const builtin = EXTERNAL_HARNESSES[0];
  const cli = EXTERNAL_HARNESSES[1];
  assert.equal(resolveExternalHarnessStatus(builtin, null, true), "builtin");
  assert.equal(resolveExternalHarnessStatus(cli, "/usr/local/bin/codex", true), "installed");
  assert.equal(resolveExternalHarnessStatus(cli, null, true), "missing");
  assert.equal(resolveExternalHarnessStatus(cli, null, false), "unknown");
});
