// Composed at module load from the snippet facade so the model always sees the
// current API surface — the same constant the compiler is fed, so the contract in
// this description can never drift from what typechecks

import { SNIPPET_FACADE_DTS } from "@zcode/dynamic-workflow";

const INTRO = [
  "Compile and run a small dynamic-workflow TypeScript snippet synchronously, against the same compiler, sandbox, and world-read path a real workflow run uses.",
  "The test bench for workflow authoring: verify a parser against real command output, check what a glob/grep actually returns, exercise gating logic on real repo state — before composing the full workflow. Fully ephemeral: nothing persisted, no background task, result comes back in this call.",
].join(" ");

const WHEN_TO_USE = [
  "When to use:",
  "- Before authoring or revising a CreateWorkflow script: test fixed logic (parsers, filters, glob patterns, gate predicates) piece by piece. A passing snippet pastes into the workflow verbatim.",
  "- To observe real facade semantics (workspace-relative sorted paths; over-cap reads reject) instead of guessing.",
  "- NOT for orchestration: no agent()/ask() here — that is what a real workflow run is for.",
].join("\n");

const RULES = [
  "Authoring rules:",
  "- Same language as a workflow script, minus subagents: plain TypeScript, plain `interface`s, top-level `await`, final `return <value>` serialized into the tool result.",
  "- No `agent()` or `report()` — absent from the snippet facade, fail typechecking.",
  "- `world.run(cmd, args?, {timeoutMs?})` executes a real command: cmd must be a string literal, nonzero exits come back as values; a snippet containing world.run asks the user for confirmation before running.",
  "- `strict` (noUncheckedIndexedAccess off): indexing needs no guard; `.find()`/`.match()`/optionals still yield `T | undefined`/`null`.",
  "- No `declare`, `export`, `import`, or Node/web APIs.",
  "- `log(...)` messages are captured in order and returned with the result.",
  "- Bounded by a wall clock (default 60s, `timeoutMs` up to 600s). Keep the return small — results over 256KB fail the call.",
  "- On diagnostics, fix the snippet and call again. Nothing was executed.",
].join("\n");

export const EVAL_WORKFLOW_SNIPPET_TOOL_DESCRIPTION = [
  INTRO,
  "",
  WHEN_TO_USE,
  "",
  "The snippet is checked against these facade declarations:",
  "```ts",
  SNIPPET_FACADE_DTS.trim(),
  "```",
  "",
  RULES,
].join("\n");
