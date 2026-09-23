// Tests for speedstack/ralph-loop.ts — node:test, no external deps.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRalphProgress,
  detectNoProgress,
  normalizeRalphOutput,
  runRalphLoop,
} from "./ralph-loop.ts";

test("normalizeRalphOutput collapses whitespace", () => {
  assert.equal(normalizeRalphOutput("  a\n  b\tc "), "a b c");
});

test("detectNoProgress needs two identical trailing outputs", () => {
  assert.equal(detectNoProgress([]), false);
  assert.equal(detectNoProgress(["a"]), false);
  assert.equal(detectNoProgress(["a", "b"]), false);
  assert.equal(detectNoProgress(["a", "b  \n b", "b b"]), true);
  assert.equal(detectNoProgress(["a", "a", "b"]), false);
});

test("runRalphLoop stops on the done marker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ralph-"));
  try {
    const progressFile = join(dir, "progress.txt");
    const outcome = await runRalphLoop({ progressFile }, async (iteration) =>
      iteration === 3 ? "fixed it\n<ralph-done>" : `attempt ${iteration}`,
    );
    assert.equal(outcome.stopReason, "done-marker");
    assert.equal(outcome.iterations, 3);
    const log = await readFile(progressFile, "utf8");
    assert.ok(log.includes("reason=done-marker"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRalphLoop stops on no progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ralph-"));
  try {
    const outcome = await runRalphLoop(
      { progressFile: join(dir, "p.txt") },
      async () => "same output every time",
    );
    assert.equal(outcome.stopReason, "no-progress");
    assert.equal(outcome.iterations, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRalphLoop respects the max-iteration cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ralph-"));
  try {
    let calls = 0;
    const outcome = await runRalphLoop(
      { progressFile: join(dir, "p.txt"), maxIterations: 4, stopOnNoProgress: false },
      async (iteration) => {
        calls++;
        return `unique output ${iteration}`;
      },
    );
    assert.equal(outcome.stopReason, "max-iterations");
    assert.equal(calls, 4);
    assert.equal(outcome.iterations, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRalphLoop reports iteration errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ralph-"));
  try {
    const outcome = await runRalphLoop({ progressFile: join(dir, "p.txt") }, async () => {
      throw new Error("boom");
    });
    assert.equal(outcome.stopReason, "iteration-error");
    assert.equal(outcome.lastOutput, "boom");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRalphLoop requires a progress file", async () => {
  await assert.rejects(
    runRalphLoop({ progressFile: "   " }, async () => "x"),
    /progressFile/,
  );
});

test("appendRalphProgress writes timestamped entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ralph-"));
  try {
    const file = join(dir, "sub", "progress.txt");
    await appendRalphProgress(file, "hello");
    const content = await readFile(file, "utf8");
    assert.ok(content.includes("hello"));
    assert.match(content, /^\[20\d\d-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
