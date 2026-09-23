# Speed Stack eval harness (Package 1)

Deterministic policy/schema measurement + live-stack smoke + budget replay
for the 3.25.0 agent-flow program. No model switching, no inference, no
releases touched.

## Quick start

From `apps/zcode-cli/packages/core`:

```bash
# Policy measurement against the live shim (deterministic per shim version)
tsx src/speedstack/eval/run.ts policy

# Fully deterministic (checked-in route fixtures, no network)
tsx src/speedstack/eval/run.ts policy --offline

# Live-stack smoke: shim + LM Studio answer (no inference, no model changes)
tsx src/speedstack/eval/run.ts smoke
```

Reports are JSON on stdout; a human summary goes to stderr. `--out <file>`
writes the JSON to a file instead.

## The budget tune loop (Ryan's directive)

Per-tier turn/tool budgets are **config-driven, never hard-coded**
(see `../turn-budgets.ts`). Effective config is always printed in the
report's `budgets` section, so every tuning run is reproducible.

Env (tunable without a release):

| Variable | Meaning |
|---|---|
| `ZCODE_BUDGET_ECONOMY_MAX_STEPS` / `_MAX_TOOL_CALLS` | economy tier caps |
| `ZCODE_BUDGET_BALANCED_MAX_STEPS` / `_MAX_TOOL_CALLS` | balanced tier caps |
| `ZCODE_BUDGET_HEAVY_MAX_STEPS` / `_MAX_TOOL_CALLS` | heavy tier caps |
| `ZCODE_BUDGET_DEFAULT_MAX_STEPS` / `_MAX_TOOL_CALLS` | fallback (unknown tier / no route) |

Unset (or garbage) = unbounded = today's behavior. Fail-open by design.

Per-run override without touching the environment:

```bash
tsx src/speedstack/eval/run.ts policy \
  --budget economy:25:60 --budget balanced:40:100 --budget heavy:80:200
# "-" unbounds: --budget economy:-:-
```

To validate budget behavior the harness needs observed usage. Two ways:

1. **Simulated usage** (tune loop today, no live run needed):
   ```bash
   # usage.json: {"rename-file":{"steps":12,"toolCalls":9}, ...}
   tsx src/speedstack/eval/run.ts policy --simulate usage.json \
     --budget economy:25:60 --budget balanced:40:100 --budget heavy:80:200
   ```
   Each task records `usage`, `budgets`, and `budgetHit`
   (`stepsHit`/`toolCallsHit`/`anyHit`). Sweep candidate caps by
   re-running with different `--budget` flags.

   Checked-in fixtures (Package 2 tune loop): `usage-baseline.json`
   models realistic per-task consumption (web-news exceeds a too-tight
   `balanced:20:40` -> 1/6 hits, all tasks clear the policy raised defaults
   -> 0/6); `usage-runaway.json` inflates debug-crash to runaway levels to
   prove the raised caps still bind. Per-task effective budgets merge the
   effort policy's raised defaults with `ZCODE_BUDGET_*` (env wins); each
   task also records its `effortPolicy` row and `planThenExecuteEligible`.
   Package 3 adds `planExecute` ({plan, reason}) per task: the pure
   route-driven plan-vs-direct gate decision, with the summary counting
   planned tasks (`plan-then-execute: N/M tasks`).

2. **Replay** (re-score a recorded report against new caps):
   ```bash
   tsx src/speedstack/eval/run.ts policy --simulate usage.json --out run1.json
   tsx src/speedstack/eval/run.ts replay --run run1.json \
     --budget economy:15:40 --out run1-tight.json
   ```
   `replay` recomputes `budgets`/`budgetHit` per task from the recorded
   `usage` — no shim, no work redone.

When the next package wires budget enforcement + live telemetry export,
live runs will fill `usage` with real steps/tool calls and the same
`replay` loop validates them.

## What policy mode measures per task

- `route`: tier, confidence, labels, **tierScores** (shim `probabilities`,
  preserved end-to-end), **margin** (top-1 vs top-2 gap), effort, modelId.
- `toolPack`: pruned?, keep/total tool count, schema tokens before/after
  (measured from the REAL built-in tool schemas via
  `tool-schema-sizes.json`), tokens saved + %.
- `budgets`: effective `{maxSteps, maxToolCalls}` for the task's tier.
- `budgetHit`: only when usage is present (simulated or replayed).

## Fixtures

- `tool-schema-sizes.json` — measured char counts per built-in tool.
  Regenerate after touching tool descriptions/schemas:
  `tsx src/speedstack/eval/measure-tool-schemas.ts`
- `route-fixtures.json` — recorded shim route decisions for the battery
  (`--offline` mode). Refresh: run policy mode live once and extract each
  task's `route` into the fixture file (see `tasks.ts` ids).

## Live-run integration (next package)

The report schema already carries the fields live telemetry will fill:
`usage: {steps, toolCalls, simulated:false}` per task. The runtime emits
`speedstack.tool_pack.shortlist` (per step: labels, tierScores, margin,
schema tokens) and `model.request.started` (per step: toolPack* fields);
the turn loop already tracks `toolCallCount`/model steps. Export those per
task into `usage` and the replay loop validates caps against reality.
