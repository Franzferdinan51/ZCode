// Tests for speedstack/anchored-compaction.ts — node:test, no external deps.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveSessionTranscript,
  buildAnchoredSummaryPrompt,
  extractSessionAnchors,
} from "./anchored-compaction.ts";

const MESSAGES = [
  { role: "assistant", text: "Decision: use pnpm workspaces for the monorepo." },
  { role: "user", text: "Edit packages/core/src/speedstack/effort-tiers.ts and rerun." },
  { role: "assistant", text: "Error: tsc failed with exit code 2\nSee stack trace above." },
  { role: "assistant", text: "- [ ] add unit tests\n- [x] write spec" },
  { role: "assistant", text: "Some filler with no anchors at all." },
];

test("extractSessionAnchors finds decisions, paths, errors, todos", () => {
  const anchors = extractSessionAnchors(MESSAGES);
  assert.ok(anchors.decisions.some((d) => d.includes("pnpm workspaces")));
  assert.ok(
    anchors.filePaths.some((p) => p.includes("packages/core/src/speedstack/effort-tiers.ts")),
  );
  assert.ok(anchors.errors.some((e) => e.includes("tsc failed")));
  assert.ok(anchors.todoState.some((t) => t.includes("add unit tests")));
});

test("extractSessionAnchors dedupes and tolerates junk", () => {
  const anchors = extractSessionAnchors([
    { role: "user", text: "Decision: ship it.\nDecision: ship it." },
    { role: "user", text: "" },
  ]);
  assert.equal(anchors.decisions.length, 1);
  assert.deepEqual(extractSessionAnchors([]).decisions, []);
  assert.deepEqual(
    extractSessionAnchors([{ role: "x", text: undefined as never }]).errors,
    [],
  );
});

test("archiveSessionTranscript writes the full transcript to disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anchors-"));
  try {
    const path = await archiveSessionTranscript(dir, "sess-1", MESSAGES);
    const raw = await readFile(path, "utf8");
    const payload = JSON.parse(raw);
    assert.equal(payload.sessionId, "sess-1");
    assert.equal(payload.messageCount, MESSAGES.length);
    assert.equal(payload.messages.length, MESSAGES.length);
    assert.ok(payload.archivedAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("archiveSessionTranscript sanitizes the session id for filenames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anchors-"));
  try {
    const path = await archiveSessionTranscript(dir, "../evil/id", MESSAGES);
    assert.ok(!path.includes(".."));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildAnchoredSummaryPrompt preserves anchors verbatim", () => {
  const anchors = extractSessionAnchors(MESSAGES);
  const prompt = buildAnchoredSummaryPrompt(anchors);
  assert.ok(prompt.includes("pnpm workspaces"));
  assert.ok(prompt.includes("effort-tiers.ts"));
  assert.ok(prompt.toLowerCase().includes("must preserve"));
});
