// Tests for the doom-loop fingerprint escalation state machine
// (speedstack/doom-loop.ts).
// Run: tsx --test src/speedstack/doom-loop.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DOOM_LOOP_KILL_SWITCH_ENV,
  advanceDoomLoop,
  buildDoomLoopFinalBody,
  buildDoomLoopNudgeBody,
  buildDoomLoopPauseBody,
  buildDoomLoopStrategyBody,
  createDoomLoopTurnState,
  detectDoomLoopTransitions,
  extractDoomLoopTarget,
  fingerprintToolCall,
  isDoomLoopDisabled,
  normalizeDoomLoopValue,
  recordDoomLoopToolUse,
  untriedDoomLoopTools,
} from "./doom-loop.js";

function envOf(values: Record<string, string>): NodeJS.ProcessEnv {
  return { ...values };
}

function readCall(id: string, path: string) {
  return { id, name: "Read", input: { path } };
}

describe("isDoomLoopDisabled", () => {
  it("is disabled when the kill switch is 0", () => {
    assert.equal(isDoomLoopDisabled(envOf({ [DOOM_LOOP_KILL_SWITCH_ENV]: "0" })), true);
  });

  it("is enabled when the kill switch is unset", () => {
    assert.equal(isDoomLoopDisabled(envOf({})), false);
  });

  it("treats common falsy spellings as disabled", () => {
    for (const value of ["false", "no", "off", " 0 "]) {
      assert.equal(isDoomLoopDisabled(envOf({ [DOOM_LOOP_KILL_SWITCH_ENV]: value })), true, value);
    }
  });
});

describe("fingerprintToolCall", () => {
  it("normalizes Windows path separators", () => {
    const a = fingerprintToolCall("Read", { path: "C:\\Users\\duckets\\notes.txt" });
    const b = fingerprintToolCall("Read", { path: "C:/Users/duckets/notes.txt" });
    assert.equal(a, b);
  });

  it("resolves ./.. segments", () => {
    const a = fingerprintToolCall("Read", { path: "/a/b/../c/./notes.txt" });
    const b = fingerprintToolCall("Read", { path: "/a/c/notes.txt" });
    assert.equal(a, b);
  });

  it("normalizes trivial whitespace", () => {
    const a = fingerprintToolCall("Bash", { command: "ls -la  \r\n\r\n\r\n/tmp" });
    const b = fingerprintToolCall("Bash", { command: "ls -la\n\n/tmp" });
    assert.equal(a, b);
  });

  it("is stable under key reordering", () => {
    const a = fingerprintToolCall("Read", { path: "/x", offset: 1, limit: 10 });
    const b = fingerprintToolCall("Read", { limit: 10, offset: 1, path: "/x" });
    assert.equal(a, b);
  });

  it("leaves URIs alone", () => {
    const a = fingerprintToolCall("WebFetch", { url: "https://example.com/a//b" });
    const b = fingerprintToolCall("WebFetch", { url: "https://example.com/a//b" });
    assert.equal(a, b);
  });

  it("keeps meaningful differences: offsets", () => {
    const a = fingerprintToolCall("Read", { path: "/x", offset: 1 });
    const b = fingerprintToolCall("Read", { path: "/x", offset: 2 });
    assert.notEqual(a, b);
  });

  it("keeps meaningful differences: commands", () => {
    const a = fingerprintToolCall("Bash", { command: "ls /a" });
    const b = fingerprintToolCall("Bash", { command: "ls /b" });
    assert.notEqual(a, b);
  });

  it("keeps meaningful differences: edit strings", () => {
    const a = fingerprintToolCall("Edit", {
      path: "/x",
      old_string: "aaa",
      new_string: "bbb",
    });
    const b = fingerprintToolCall("Edit", {
      path: "/x",
      old_string: "aaa",
      new_string: "ccc",
    });
    assert.notEqual(a, b);
  });

  it("distinguishes tool names", () => {
    const a = fingerprintToolCall("Read", { path: "/x" });
    const b = fingerprintToolCall("Glob", { path: "/x" });
    assert.notEqual(a, b);
  });
});

describe("normalizeDoomLoopValue", () => {
  it("normalizes nested structures", () => {
    const out = normalizeDoomLoopValue({
      z: ["C:\\a\\b", "x  \n\n\n\ny"],
      a: { deep: "/p/./q" },
    });
    assert.deepEqual(out, {
      a: { deep: "/p/q" },
      z: ["C:/a/b", "x\n\ny"],
    });
  });
});

describe("extractDoomLoopTarget", () => {
  it("finds path-like targets", () => {
    assert.equal(extractDoomLoopTarget({ path: "/a/../b" }), "/b");
    assert.equal(extractDoomLoopTarget({ command: "ls" }), "ls");
  });

  it("returns undefined for non-objects", () => {
    assert.equal(extractDoomLoopTarget(undefined), undefined);
    assert.equal(extractDoomLoopTarget(["/a"]), undefined);
    assert.equal(extractDoomLoopTarget({}), undefined);
  });
});

describe("advanceDoomLoop", () => {
  it("nudges at 3, forces strategy change at 4, final at 5 — each once", () => {
    const state = createDoomLoopTurnState();
    const kinds: string[] = [];
    for (let i = 0; i < 7; i++) {
      kinds.push(advanceDoomLoop(state, "Read", { path: "/x" }).kind);
    }
    assert.deepEqual(kinds, ["none", "none", "nudge", "strategy-change", "final", "none", "none"]);
    assert.equal(state.doomLoopStreak, 7);
    assert.equal(state.doomLoopStage, 3);
  });

  it("treats near-duplicates (whitespace/path variants) as the same call", () => {
    const state = createDoomLoopTurnState();
    advanceDoomLoop(state, "Read", { path: "/a/./x.txt" });
    advanceDoomLoop(state, "Read", { path: "/a/x.txt  " });
    const t = advanceDoomLoop(state, "Read", { path: "/a//x.txt" });
    assert.equal(t.kind, "nudge");
    assert.equal(t.kind === "nudge" ? t.streak : 0, 3);
  });

  it("resets when the target changes", () => {
    const state = createDoomLoopTurnState();
    advanceDoomLoop(state, "Read", { path: "/a" });
    advanceDoomLoop(state, "Read", { path: "/a" });
    const t = advanceDoomLoop(state, "Read", { path: "/b" });
    assert.equal(t.kind, "none");
    assert.equal(state.doomLoopStreak, 1);
    assert.equal(state.doomLoopStage, 0);
  });

  it("does not escalate multi-file edit batches", () => {
    const state = createDoomLoopTurnState();
    const kinds = ["/a", "/b", "/c", "/d", "/e"].map(
      (path) =>
        advanceDoomLoop(state, "Edit", {
          path,
          old_string: "x",
          new_string: "y",
        }).kind,
    );
    assert.deepEqual(kinds, ["none", "none", "none", "none", "none"]);
  });

  it("restarts the ladder for a new loop after a reset", () => {
    const state = createDoomLoopTurnState();
    for (let i = 0; i < 5; i++) advanceDoomLoop(state, "Read", { path: "/x" });
    assert.equal(state.doomLoopStage, 3);
    const t = advanceDoomLoop(state, "Bash", { command: "ls" });
    assert.equal(t.kind, "none");
    assert.equal(state.doomLoopStage, 0);
    advanceDoomLoop(state, "Bash", { command: "ls" });
    assert.equal(advanceDoomLoop(state, "Bash", { command: "ls" }).kind, "nudge");
  });
});

describe("detectDoomLoopTransitions", () => {
  it("records tool use for every call", () => {
    const state = createDoomLoopTurnState();
    detectDoomLoopTransitions(
      [readCall("1", "/a"), { id: "2", name: "Grep", input: { pattern: "x" } }],
      state,
    );
    assert.deepEqual(state.doomLoopUsedTools, ["Read", "Grep"]);
  });

  it("returns one observation per stage with ids", () => {
    const state = createDoomLoopTurnState();
    const calls = ["1", "2", "3", "4", "5"].map((id) => readCall(id, "/x"));
    const observations = detectDoomLoopTransitions(calls, state, {
      packKeepNames: new Set(["Read", "Grep", "Glob"]),
    });
    assert.deepEqual(
      observations.map((o) => o.kind),
      ["nudge", "strategy-change", "final"],
    );
    assert.equal(observations[0]?.toolCallId, "3");
    assert.equal(observations[1]?.toolCallId, "4");
    assert.equal(observations[2]?.toolCallId, "5");
  });

  it("names untried tools on the strategy-change observation", () => {
    const state = createDoomLoopTurnState();
    const calls = ["1", "2", "3", "4"].map((id) => readCall(id, "/x"));
    const [strategy] = detectDoomLoopTransitions(calls, state, {
      packKeepNames: new Set(["Read", "Grep", "Glob", "Bash"]),
    }).filter((o) => o.kind === "strategy-change");
    assert.deepEqual(strategy?.untriedTools, ["Grep", "Glob", "Bash"]);
  });
});

describe("recordDoomLoopToolUse", () => {
  it("dedupes case-insensitively", () => {
    const state = createDoomLoopTurnState();
    recordDoomLoopToolUse(state, "Read");
    recordDoomLoopToolUse(state, "read");
    recordDoomLoopToolUse(state, "  ");
    assert.deepEqual(state.doomLoopUsedTools, ["Read"]);
  });
});

describe("untriedDoomLoopTools", () => {
  it("prefers pack keepNames and excludes looping + used tools", () => {
    const out = untriedDoomLoopTools(
      new Set(["Read", "Grep", "Glob"]),
      ["Read", "Bash"],
      ["Read", "Grep"],
      "Read",
    );
    assert.deepEqual(out, ["Glob"]);
  });

  it("falls back to sent tool names when there is no pack", () => {
    const out = untriedDoomLoopTools(undefined, ["Read", "Bash"], ["Read"], "Read");
    assert.deepEqual(out, ["Bash"]);
  });

  it("returns empty when nothing is available", () => {
    assert.deepEqual(untriedDoomLoopTools(undefined, undefined, [], "Read"), []);
  });
});

describe("message builders", () => {
  it("nudge names the tool and streak", () => {
    const body = buildDoomLoopNudgeBody("Read", 3);
    assert.ok(body.includes("Read"));
    assert.ok(body.includes("3 times"));
  });

  it("strategy body lists untried tools", () => {
    const body = buildDoomLoopStrategyBody("Read", 4, ["Grep", "Glob"]);
    assert.ok(body.includes("Grep, Glob"));
    assert.ok(body.includes("change strategy"));
  });

  it("strategy body degrades gracefully with no untried tools", () => {
    const body = buildDoomLoopStrategyBody("Read", 4, []);
    assert.ok(body.includes("different way"));
  });

  it("final body differs for unattended turns", () => {
    const unattended = buildDoomLoopFinalBody("Read", 5, true);
    const interactive = buildDoomLoopFinalBody("Read", 5, false);
    assert.ok(unattended.includes("Final redirect"));
    assert.ok(interactive.includes("continue"));
    assert.notEqual(unattended, interactive);
  });

  it("pause body is resumable", () => {
    const body = buildDoomLoopPauseBody("Bash", 5);
    assert.ok(body.includes("Paused"));
    assert.ok(body.includes("resumable"));
  });
});
