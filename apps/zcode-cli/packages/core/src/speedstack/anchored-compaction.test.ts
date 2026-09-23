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

// Rank 4 additions: rotation, kill switch, combined archive, boundary events.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANCHORED_ARCHIVE_KEEP_ENV,
  ANCHORED_COMPACT_KILL_SWITCH_ENV,
  BOUNDARY_COMPACT_WATERMARK_ENV,
  DEFAULT_ANCHORED_ARCHIVE_KEEP,
  DEFAULT_BOUNDARY_COMPACT_WATERMARK,
  EMPTY_ANCHORS,
  archiveSessionTranscriptWithAnchors,
  combineAnchoredInstructions,
  detectBoundaryEventFromToolCall,
  evaluateBoundaryCompactDecision,
  isAnchoredCompactionEnabled,
  resolveArchiveKeepCount,
  resolveBoundaryWatermark,
  rotateSessionArchives,
} from "./anchored-compaction.ts";

const ANCHOR_MESSAGES = [
  { role: "assistant", text: "Decision: keep the archive rotation at five." },
  { role: "user", text: "Edit packages/core/src/x.ts and rerun." },
];

test("anchored compaction is enabled by default, kill-switchable", () => {
  assert.equal(isAnchoredCompactionEnabled({}), true);
  assert.equal(
    isAnchoredCompactionEnabled({ [ANCHORED_COMPACT_KILL_SWITCH_ENV]: "0" }),
    false,
  );
});

test("resolveArchiveKeepCount honors env, falls back on junk", () => {
  assert.equal(resolveArchiveKeepCount({}), DEFAULT_ANCHORED_ARCHIVE_KEEP);
  assert.equal(
    resolveArchiveKeepCount({ [ANCHORED_ARCHIVE_KEEP_ENV]: "3" }),
    3,
  );
  assert.equal(
    resolveArchiveKeepCount({ [ANCHORED_ARCHIVE_KEEP_ENV]: "nope" }),
    DEFAULT_ANCHORED_ARCHIVE_KEEP,
  );
  assert.equal(
    resolveArchiveKeepCount({ [ANCHORED_ARCHIVE_KEEP_ENV]: "0" }),
    DEFAULT_ANCHORED_ARCHIVE_KEEP,
  );
});

test("archiveSessionTranscriptWithAnchors persists anchors and rotates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anchors-rank4-"));
  try {
    for (let i = 0; i < 4; i++) {
      const { archivePath, anchors } = await archiveSessionTranscriptWithAnchors(
        dir,
        "sess-rot",
        ANCHOR_MESSAGES,
        2,
      );
      assert.ok(archivePath.endsWith(".json"));
      assert.ok(anchors.decisions.length > 0);
      // Filenames embed timestamps; force distinct names across iterations.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const files = (await readdir(dir)).filter((f) => f.startsWith("sess-rot-"));
    assert.ok(files.length <= 2, `expected rotation to cap at 2, got ${files.length}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rotateSessionArchives is a fail-open no-op for missing dirs", async () => {
  assert.equal(
    await rotateSessionArchives(join(tmpdir(), "does-not-exist-xyz"), "s", 5),
    0,
  );
});

test("combineAnchoredInstructions keeps custom instructions primary", () => {
  const combined = combineAnchoredInstructions("Do the summary.", EMPTY_ANCHORS);
  assert.ok(combined.startsWith("Do the summary."));
  assert.ok(combined.toLowerCase().includes("must preserve"));
  const bare = combineAnchoredInstructions(undefined, EMPTY_ANCHORS);
  assert.ok(bare.toLowerCase().includes("must preserve"));
});

test("detectBoundaryEventFromToolCall fires on passing tests only", () => {
  const passing = detectBoundaryEventFromToolCall(
    "Bash",
    { command: "npm test -- --run" },
    "Test Suites: 1 passed, 1 total",
    true,
  );
  assert.equal(passing, "tests-passed");

  const failing = detectBoundaryEventFromToolCall(
    "Bash",
    { command: "npm test" },
    "1 failed, 2 passed",
    true,
  );
  assert.equal(failing, undefined);

  const toolFailed = detectBoundaryEventFromToolCall(
    "Bash",
    { command: "npm test" },
    "3 passed",
    false,
  );
  assert.equal(toolFailed, undefined);

  const notTests = detectBoundaryEventFromToolCall(
    "Bash",
    { command: "ls -la" },
    "",
    true,
  );
  assert.equal(notTests, undefined);

  const read = detectBoundaryEventFromToolCall("Read", { path: "x.ts" }, "content", true);
  assert.equal(read, undefined);
});

test("detectBoundaryEventFromToolCall fires on completed todos", () => {
  const verified = detectBoundaryEventFromToolCall(
    "TodoWrite",
    { todos: [{ content: "write tests", status: "completed" }] },
    undefined,
    true,
  );
  assert.equal(verified, "subtask-verified");

  const inProgress = detectBoundaryEventFromToolCall(
    "TodoWrite",
    { todos: [{ content: "write tests", status: "in_progress" }] },
    undefined,
    true,
  );
  assert.equal(inProgress, undefined);
});

test("detectBoundaryEventFromToolCall never throws on junk", () => {
  assert.doesNotThrow(() =>
    detectBoundaryEventFromToolCall("Bash", null, undefined, true),
  );
  assert.equal(detectBoundaryEventFromToolCall("Bash", null, undefined, true), undefined);
});

test("evaluateBoundaryCompactDecision needs event + watermark pressure", () => {
  assert.equal(
    evaluateBoundaryCompactDecision({ tokenPressure: 0.6, hasBoundaryEvent: true }),
    true,
  );
  assert.equal(
    evaluateBoundaryCompactDecision({ tokenPressure: 0.4, hasBoundaryEvent: true }),
    false,
  );
  assert.equal(
    evaluateBoundaryCompactDecision({ tokenPressure: 0.9, hasBoundaryEvent: false }),
    false,
  );
  assert.equal(
    evaluateBoundaryCompactDecision({
      tokenPressure: 0.7,
      hasBoundaryEvent: true,
      watermark: 0.8,
    }),
    false,
  );
});

test("resolveBoundaryWatermark honors env, falls back on junk", () => {
  assert.equal(resolveBoundaryWatermark({}), DEFAULT_BOUNDARY_COMPACT_WATERMARK);
  assert.equal(
    resolveBoundaryWatermark({ [BOUNDARY_COMPACT_WATERMARK_ENV]: "0.7" }),
    0.7,
  );
  assert.equal(
    resolveBoundaryWatermark({ [BOUNDARY_COMPACT_WATERMARK_ENV]: "nope" }),
    DEFAULT_BOUNDARY_COMPACT_WATERMARK,
  );
  assert.equal(
    resolveBoundaryWatermark({ [BOUNDARY_COMPACT_WATERMARK_ENV]: "1.5" }),
    DEFAULT_BOUNDARY_COMPACT_WATERMARK,
  );
});
