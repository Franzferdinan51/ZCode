// ============================================================
// Speed Stack eval harness: representative task battery
// ============================================================
//
// Deterministic task set for the 3.25.0 Package 1 eval harness.
// Five of these were measured live against the SystemOne shim on
// 2026-09-23 (tier/labels/confidence recorded there); the harness
// re-measures at run time -- the `expected` block is documentation,
// not an assertion, so shim evolution never breaks the harness.

export interface EvalTask {
  /** Stable id (used by --simulate maps and replay reports). */
  readonly id: string;
  /** The task text sent to the shim (and to label inference). */
  readonly task: string;
  /** What was observed live on 2026-09-23; informational only. */
  readonly expected?: {
    readonly tier?: string;
    readonly labels?: readonly string[];
    readonly confidence?: number;
  };
  /** Why this task is in the battery. */
  readonly rationale: string;
}

export const EVAL_TASKS: readonly EvalTask[] = [
  {
    id: "rename-file",
    task: "rename a file",
    expected: { tier: "balanced", labels: ["files"], confidence: 0.68 },
    rationale:
      "Minimal files task: exercises the always-on core + files label; " +
      "should prune heavily (no web/media/workflow schemas).",
  },
  {
    id: "find-todos",
    task: "find all TODO comments in the repo",
    expected: { tier: "balanced", labels: ["search"], confidence: 0.68 },
    rationale:
      "Search/code task: keeps Grep/Glob/Read, drops workflow/ask/media packs.",
  },
  {
    id: "web-news",
    task: "search the web for local LLM news",
    expected: { tier: "balanced", labels: ["search"], confidence: 0.68 },
    rationale:
      "Web task: must keep WebSearch/WebFetch; keyword inference should " +
      "add the web label even if the shim only emits search.",
  },
  {
    id: "summarize-doc",
    task: "summarize this long document",
    expected: { tier: "economy", labels: ["summarize"], confidence: 0.8 },
    rationale:
      "Economy-tier task: whole-MCP skip territory (>=0.8); schema " +
      "pruning should keep only Read (+core).",
  },
  {
    id: "debug-crash",
    task: "debug why the server crashes on startup",
    expected: { tier: "heavy", labels: ["code", "ops"], confidence: 0.67 },
    rationale:
      "Heavy-tier task: code+ops labels keep Bash/Read/Glob/Grep; " +
      "confidence 0.67 still clears the 0.6 schema-prune threshold.",
  },
  {
    id: "morning-reminder",
    task: "remind me every morning at 8am to check the grow tent",
    rationale:
      "Schedule/message task: keeps cron + messaging tools; representative " +
      "of Ryan's recurring-automation workload.",
  },
];
