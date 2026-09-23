# Spec: Speed Stack for ZCode-Local (agent runtime)

Date: 2026-09-22. Owner: Juno (speed-stack worker). Status: implemented 2026-09-22
(commit pending; see git log).

## Goal

Add the app-level equivalents of the 2026 coding-agent "speed stack" to the
ZCode-Local agent runtime (`apps/zcode-cli`), as additive, opt-in features that
never change default behavior.

## Hard constraints (Ryan)

- Model choices are LOCAL models only (LM Studio on the Mac mini). Never use
  cloud model names as defaults.
- NEVER load or unload a model. Planner/executor role selection picks only from
  the locally available model list; if one model is loaded, both roles use it.
- Prefer smaller models / MoE first; Ornith-1.5-35B-A3B is the preferred pick
  on the Mac mini. Never unload a model he loaded himself.

## Features

### 1. Effort tiers per task (`core/src/speedstack/effort-tiers.ts`)

- `EffortTier = "low" | "medium" | "high"`, parsed from user input
  (`parseEffortTier`, case-insensitive, fail-open to `undefined`).
- `effortTierToModelOptions(model, tier)` maps a tier onto the model's OWN
  `optionSpecs` — no provider-specific level names are hardcoded:
  - `reasoningLevel`: low -> first value, medium -> middle value,
    high -> last value of `optionSpecs.reasoningLevel.values`.
  - `maxOutputTokens`: low -> min(4_000, max), medium -> min(12_000, max),
    high -> model max.
- `SpeedStackSessionConfig`: `{ effortTier?, planThenExecute?, mcpServerAllowlist?, mcpToolAllowlist? }`
  — the per-task/per-session surface (library-level; not yet surfaced in a
  live session-config owner — see "Out of scope").
- SystemOne route-result extension: `extractRouteEffortHint(raw)` in root
  `packages/shared/src/systemone-scorer.ts` reads an optional `effort` field
  from a route response object. Fail-open: anything unexpected -> `undefined`,
  current behavior unchanged. The CLI core's
  `resolveEffectiveEffortTier(config, routeHint)` prefers explicit session
  config, then the route hint (structurally identical tier union, no
  cross-package runtime import so the core tests stay dependency-free).
- State owner: the session/task that carries `SpeedStackSessionConfig`.
  Applying the resolved tier via `model.bind(options)` is the caller's job.

### 2. Plan-then-execute mode (`core/src/speedstack/plan-execute.ts`)

- Per-task toggle: `SpeedStackSessionConfig.planThenExecute`.
- `resolvePlanExecuteModels(availableModelIds, preferred?)` picks planner and
  executor model ids ONLY from `availableModelIds`. Rules:
  - never triggers load/unload; pure selection;
  - single available model -> both roles use it;
  - planner default preference: Ornith-1.5-35B-A3B (his preferred pick),
    then the first available non-embedding model;
  - executor default preference: smaller local models first
    (ornith-1.5-9b family, then gemma-4-12b, then minicpm5-2b),
    skipping embedding models; fallback: the planner's model.
  - explicit `preferred` overrides win, but only if present in the available list.
- `buildPlannerPrompt(task)` / `buildExecutorPrompt(planMarkdown)` prompt builders.
- `writePlanArtifact(dir, markdown)` / `readPlanArtifact(dir)` — plan artifact
  as `PLAN.md` under the session dir (file-based state, Ralph-compatible).
- Wiring into the live turn loop is intentionally NOT done here (force-fit);
  the module is a library the runtime/headless commands call.

### 3. Ralph loop (`core/src/speedstack/ralph-loop.ts`)

- `runRalphLoop(config, runIteration)` re-runs a task until a DONE marker
  appears in the iteration output, or a test command passes (the iteration
  function decides what "tests pass" means and includes the marker).
- `RalphLoopConfig`: `maxIterations` (default 10, hard cap),
  `doneMarker` (default `"<ralph-done>"`), `progressFile`,
  `stopOnNoProgress` (default true).
- No-progress detector: `detectNoProgress(outputs)` — the last two normalized
  outputs identical -> stop. Normalization: trim + collapse whitespace.
- Progress persisted: `appendRalphProgress(progressFile, entry)` appends
  timestamped entries (async fs).
- `runIteration` is injected, so unit tests never spawn processes; the real
  session runner is wired by the caller. Each iteration is expected to start
  from a fresh session (caller responsibility) to defeat context rot.

### 4. Per-session MCP tool pruning (`core/src/speedstack/mcp-pruning.ts`)

- Motivation: on-demand tool loading measured ~46.9% token reduction
  (Cursor's finding, cited as theirs).
- `normalizeMcpAllowlist(allowlist)`: `undefined`/empty/blank -> `undefined`
  meaning "no pruning, default behavior unchanged" (opt-in).
- `pruneMcpServerMap(servers, allowlist)`: keep only allowlisted server names.
- `pruneMcpTools(tools, allowlist)`: allowlist entries are `server.tool` or
  bare `tool` names; anything else is dropped.
- Pure functions over structural types; the caller applies them where the
  session's MCP server map is assembled.

### 5. Parallel/batched tool calls

- ALREADY IMPLEMENTED: `core/src/tool/scheduler.ts` builds dependency-aware
  `parallelGroups` (topological order; read-only/destructive/concurrentSafe
  metadata decides what can run together), and
  `core/src/tool/executor/batch-runner.ts` runs each group concurrently via
  `Promise.all` with a `maxConcurrency` cap (default 10).
- No new code; verified, not duplicated.

### 6. Anchored session compaction (`core/src/speedstack/anchored-compaction.ts`)

- Companion to the existing `core/src/compact/` (auto/micro/manual).
  Microcompact already drops raw tool-output bulk; this module adds:
- `extractSessionAnchors(messages)`: regex extraction of decisions, file paths,
  errors, and todo state from message text -> `SessionAnchors`.
- `archiveSessionTranscript(dir, sessionId, messages)`: writes the FULL
  transcript JSON to disk BEFORE compaction (never lose the raw history).
- `buildAnchoredSummaryPrompt(anchors)`: summary prompt with the anchors
  injected so the summarizer preserves them.
- Flow: archive -> extract anchors -> compact with anchored prompt.

### 7. Slash commands `/verify` and `/review`

- Builtin prompt commands (same pattern as `/init`), fully wired:
  - `/verify [scope]`: agent runs the repo's build + tests and reports
    pass/fail with the failing output. Prompt builder:
    `buildVerifyCommandPrompt(args)` (in `core/src/speedstack/`).
  - `/review [ref]`: agent reviews recent changes (`git status`/`git diff`
    against HEAD or the given ref) and reports findings. Prompt builder:
    `buildReviewCommandPrompt(args)` (in `core/src/speedstack/`).
- Wiring (all landed): parser entries in
  `cli/src/command-center/slash-commands.ts` (+ union members in
  `slash-command-types.ts`), dispatch branches in
  `cli/src/command-center/create.ts` (submit expanded prompt like `/init`),
  resolver cases in `bootstrap/src/builtin-prompt-command.ts` (imports the
  builders from `@zcode/core`, whose `src/index.ts` now re-exports
  `./speedstack/index.js` and whose `package.json` gains a `./speedstack`
  subpath export), help entries in root
  `packages/shared/src/zcode-slash-command-help.ts`.
- TUI `AVAILABLE_COMMANDS` picks the new entries up automatically from the
  help list.

### 8. Label-driven per-task tool packs (Z1, 3.25.0 Package 1)

- Motivation: every model step re-sends ALL tool schemas (~33.5K tokens for
  40 built-in tools, measured 2026-09-23). The route's `taskLabels` were
  parsed but unused -- this turns them into a per-task shortlist.
- `core/src/speedstack/tool-packs.ts` (pure, no runtime imports):
  `TOOL_PACK_LABEL_TABLE` (label -> keepTools/keepServers, declarative),
  always-on core (Read/Write/Edit/Bash/Glob/Grep/TodoRead/TodoWrite) +
  actor-protocol tools (never pruned), `computeToolShortlist` /
  `computeServerShortlist`, schema-token estimation (`chars/4`), miss
  detection + recovery reminder builder.
- Suppression happens BEFORE request construction in
  `runtime/methods/turn-loop.ts` (`computeTurnToolPackShortlist`); the win
  is not sending the schemas. Miss recovery in
  `runtime/methods/turn-model-step.ts`: withheld call -> full-set retry next
  step + on-demand MCP server start
  (`ensureToolPackPrunedMcpServersStarted`).
- Fail-open: kill switches (`ZCODE_SPEEDSTACK_PRUNE=0`,
  `mcpPruning=false`), missing route, confidence < 0.6, or any error ->
  full tool list. Schema pruning threshold 0.6 (below the 0.8 whole-MCP
  skip: schema recovery is cheap, server startup is not).
- Route signal preservation (Ryan design note): the shim's `probabilities`
  are parsed into `SystemOneRouteDecision.tierScores`, `routeTierMargin()`
  exposes the top-1/top-2 gap, and both ride `McpToolLevelPolicy`,
  `ToolPackRouteView`, `ToolShortlist`, and the telemetry logs end-to-end.
  No policy gates on them yet -- the future scored-classification/ranking
  work consumes them without rework.

### 9. Config-driven turn budgets + eval harness (3.25.0 Package 1)

- Per-route-tier turn/tool budgets are CONFIG-DRIVEN, never hard-coded
  (Ryan tuning directive): `core/src/speedstack/turn-budgets.ts`
  (`resolveTurnBudgets`, `checkBudgetHit`, `describeTurnBudgets`).
- Env (positive ints; unset/garbage = unbounded = today's behavior):
  `ZCODE_BUDGET_{ECONOMY,BALANCED,HEAVY}_{MAX_STEPS,MAX_TOOL_CALLS}`,
  plus `ZCODE_BUDGET_DEFAULT_{MAX_STEPS,MAX_TOOL_CALLS}` fallback.
- No enforcement yet -- the turn loop is unbounded today; the next package
  adds enforcement and raises the caps (current posture: too tight for real
  reasoning work is the thing being tuned, not asserted here).
- Eval harness: `core/src/speedstack/eval/` (`run.ts` CLI via tsx).
  Modes: `policy` (route + tool-pack + budget measurement over the 6-task
  battery, live shim or `--offline` fixtures), `smoke` (shim + LM Studio
  answer, no inference/model changes), `replay` (re-score a report's usage
  against new caps). Per-run budget override: `--budget <tier>:<steps>:<calls>`
  (repeatable, `-` = unbounded). Simulated usage: `--simulate usage.json`.
  The tune loop: `policy --simulate ... --budget ...` to find hits, then
  `replay --run report.json --budget ...` to validate raised caps.
  Reports record per task: route signals (tier/confidence/labels/
  tierScores/margin), schema tokens before/after, effective budgets,
  usage, and budget-hit verdicts. Full docs: `eval/README.md`.

## Acceptance

- `node --test` on `core/src/speedstack/*.test.ts`: all pass (pure logic;
  modules avoid runtime cross-package imports so node type-stripping runs them).
- `pnpm --filter @zcode/core typecheck` (turbo) and root `pnpm typecheck`
  covering `packages/shared`: BLOCKED by a pre-existing broken workspace —
  `apps/zcode-cli/packages/adapters` depends on `@zcode/model-option-map`,
  which does not exist in the workspace (introduced in 872ad96 "feat: open
  source", base commit `315ffd1`). `pnpm install` fails repo-wide, so the
  repo's own typecheck/lint cannot run. Substituted verification (all clean):
  `oxlint` on every touched file (0 warnings/errors); standalone `tsc
  --noEmit` on `core/src/speedstack/` (excluding `*.test.ts`, same as the
  repo tsconfig) with a stub for the type-only `@zcode/contracts` import;
  transpile syntax check on every other touched file; runtime smoke of the
  shared `extractRouteEffortHint` via node type-stripping.
- `node scripts/check-workspace-freshness.mjs` (required by
  `apps/zcode-cli/AGENTS.md`) does not exist in this checkout — noted, not
  runnable.
- `pnpm architecture:check --changed` (required by the
  architecture-governance skill) cannot run without installed deps
  (needs `typescript`/`yaml` from node_modules); the skill's design rules
  were applied manually instead: spec written before implementation, one
  owner per state (new modules are pure functions, no mutable state), one
  path (reused the `/init` prompt-command plumbing and the existing help
  registry), explicit layer boundaries (speedstack lives in `@zcode/core`,
  route-result handling in `@zcode/shared`; no new managed module, so no
  `architecture-policy.yaml` registration needed).
- No model is loaded/unloaded by any of this code; no cloud model names
  appear as defaults anywhere.

## Out of scope / skipped with reason

- A `/ralph` CLI slash command: the Ralph loop is shipped as a tested
  library (`ralph-loop.ts` + injected iteration runner). A real `/ralph`
  command needs session-orchestration integration (spawning and supervising
  fresh agent sessions per iteration), not a prompt rewrite like
  `/verify`/`/review` — wiring it through the bootstrap prompt resolver
  would be a force-fit. The library is ready for a future integration.
- Wiring effort tiers / plan-execute / MCP pruning into the live turn loop and
  session-config plumbing: deep integration points with their own state owners;
  shipped as library + config surface + spec so the runtime team wires them
  without a force-fit. (The MCP runtime already has `config.toolAllowlist`;
  a server allowlist would extend `config.mcp` — clean seam, left for the
  runtime owner. Anchored compaction complements the existing
  `core/src/compact/` pipeline, which already has preserved-segment concepts;
  bolting anchors on without the compaction owner's design review risks
  conflicting with it.)
- Subagent fan-out orchestration and prompt-caching: need harness/provider
  support beyond this change; noted in research only.
- UI (desktop/web) surfaces for the new commands: CLI-first; the shared help
  entries make them available to other clients later.

## Package 2 — "effort means behavior" (3.25.0)

### What it is

Package 2 turns the effort tier into a full per-turn **behavior policy**,
resolved once per turn alongside the existing effort override
(`resolveSystemOneBehaviorPolicy` in `speedstack/systemone-route.ts`, called
from `createTurnModel`). Every dimension has table defaults and is
independently overridable; misconfiguration fails open to the defaults.

### Policy table (`speedstack/effort-tiers.ts`)

`getEffortBehaviorPolicy(tier, env)` — raised step/call defaults
(low 25/60, medium 40/100, high 60/150, xhigh 90/250, ultra 120/400),
subagent allowance (`never` low/off, `conservative` medium/high,
`parallel` xhigh/ultra), tier-scaled child `maxTurns` (2/4/6/8/12),
read-breadth advisory caps (3/6/10/15/25), verification passes (1 for
xhigh/ultra), compaction aggressiveness (0.9 xhigh, 0.85 ultra), and the
plan-execute eligibility gate (`isPlanThenExecuteEligible`: policy flag OR
heavy route tier — consumed by the Rank-3 wiring, defined here).

Env overrides per dimension: `ZCODE_EFFORT_<TIER>_SUBAGENTS`,
`_SUBAGENT_MAX_TURNS`, `_READ_BREADTH`, `_VERIFICATION_PASSES`,
`_COMPACTION`, `_PLAN_EXECUTE` (`<TIER>` = LOW/MEDIUM/HIGH/XHIGH/ULTRA).

`resolveEffectiveTurnBudgets({routeTier, effortTier, env})` merges the table
defaults with the Package-1 `ZCODE_BUDGET_*` surface (env wins wherever
set); no effort resolved = Package-1 env-only behavior.

### Soft-then-hard enforcement (`speedstack/budget-enforcement.ts`)

Pure `evaluateBudgetEnforcement(usage, budgets, stage)`:
`ok` → `warn` (80% of either cap, once per turn, injected through the
existing `ModelAnomalyWarning` channel) → `escalate` (100%: one
strategy-change nudge, exactly one more model step) → `stop` (hard stop as
the turn's final assistant text, session already persisted by the normal
turn-completion path, explicit resume wording: send another message such as
"continue"). The turn loop evaluates it at the top of every iteration
(`enforceTurnBudgets` in `runtime/methods/turn-loop.ts`); the per-turn
80%-of-calls threshold also arms the disabled-by-default anomaly-channel
budget detector (`handleToolCallAnomalyWarnings`), sharing one warn flag so
a turn warns once. Kill switch: `ZCODE_BUDGET_ENFORCE=0`.

### Other runtime wiring

- Subagent gating: low/off hides `Agent`/`Task` from the model via the turn
  disallowlist (`buildTurnDisallowedTools`); child `maxTurns` is tier-scaled
  (`subagent.ts`), explicit request/config values still win.
- Ultra verification: one review reminder after `Edit`/`Write`/`ApplyPatch`
  per turn (`handleVerificationPassReminder`, via the anomaly channel).
- Compaction aggressiveness: `thresholdPercentOverride` in
  `compact/policy.ts` is now functional (was accepted-but-ignored), driven
  per turn from the policy.

### Verification (2026-09-23)

- `tsx --test src/speedstack/*.test.ts`: **133/133** (105 Package-1 +
  28 Package-2: policy defaults, every env-override dimension, off→low,
  env-wins merging, warn→escalate→stop transitions, message bodies,
  kill switches).
- `pnpm typecheck` (core package): clean.
- Budget tune loop (deterministic fixtures
  `speedstack/eval/usage-baseline.json`, `usage-runaway.json`, reports in
  `~/workspace/zcode/budget-tuning/`):
  - tight baseline `--budget balanced:20:40`: **1/6** cap hits (web-news)
  - raised policy defaults (no flags): **0/6**
  - runaway demo (debug-crash 200 steps/500 calls): **1/6** — the raised
    high-tier caps (60/150) still bound genuine runaways
  - `replay` of the tight report against raised defaults: **0/6**
- Pre-existing `oxlint` findings on touched files are unchanged at HEAD
  (verified via `git stash`); no new lint issues introduced.

### Deliberately not done

- Hard enforcement of `readBreadth`: resolved, reported per task, and
  advisory; hard caps land with the Rank 7/8 workflow/doom-loop work.
- Plan-execute wiring: eligibility is defined and reported; the Rank-3
  wiring consumes it.
- A live end-to-end turn-loop exercise of the stop path: covered by the
  pure state-machine tests + the established `turnMachine.complete` path
  (mirrors the automation-limit stop).

## SystemOne decision surface (3.25.0, shipped)

SystemOne is no longer just a model router. The 3.25.0 agent-flow release
turns the per-task route decision into the full agent behavior plan: the
router's tier/effort/labels drive how the turn runs, not just which
reasoning level the model gets. All of it is advisory and fail-open — a
broken or absent shim changes nothing about what the agent can do, only
about how efficiently it does it.

### What SystemOne decides

| Decision                          | Source                                   | Where it lands                                                                |
|-----------------------------------|------------------------------------------|-------------------------------------------------------------------------------|
| Effort tier + behavior policy     | Route `effort` (low/balanced/high/ultra) | `EffortBehaviorPolicy` (`speedstack/effort-tiers.ts`): max model steps, max tool calls, subagent allowance (low: never, ultra: parallel), tier-scaled subagent `maxTurns`, read/search breadth cap, verification passes after edits (xhigh/ultra: 1), compaction aggressiveness multiplier, plan-then-execute eligibility |
| Per-task tool packs (JIT)         | Route `taskLabels` + task text           | `runtime/methods/tool-packs.ts`: core tools always on; MCP servers/tools ranked by label→capability mapping, irrelevant ones suppressed before request construction (`speedstack/tool-packs.ts`) |
| MCP attach policy                 | Route tier + confidence                  | `resolveMcpAttachPolicy` (`speedstack/systemone-route.ts`): economy ≥0.8 skips all MCP; otherwise label-ranked subset; low confidence keeps everything |
| Turn/tool budgets                 | Effort policy + `ZCODE_BUDGET_*` overrides | Soft warning at 80% via the anomaly-warning channel, one auto-escalation, then hard stop with resumable session state (`speedstack/budget-enforcement.ts`, enforced in `runtime/methods/turn-loop.ts`) |
| Plan-then-execute vs direct       | Route tier, labels, multi-file signals  | `plan-execute-gate.ts`: heavy/xhigh+ with multi-file or ambiguous/risky signals → planner pass writes `PLAN.md` (read-only tools) → executor implements it; simple tasks never pay the planning tax |
| Verification depth                | Effort policy                             | `verificationPasses` (0/1): a review pass runs after edits on xhigh/ultra; `/verify` and `/review` slash commands stay available on demand |
| Compaction behavior               | Effort policy + boundaries                | `compactionAggressiveness` multiplier on the auto-compact threshold; anchored compaction archives the full transcript to disk, extracts anchors (decisions, file paths, errors, TODOs) verbatim, and injects them into the summarizer prompt so naive summarization can't drop them (`speedstack/anchored-compaction.ts`) |
| Doom-loop escalation              | Normalized call fingerprints              | `doom-loop.ts`: warning → strategy-change nudge naming untried tools → pause/auto-compact + retry; batch patterns (consecutive calls on different files) are exempt |
| Workflow tools                    | Telemetry of hot chains                   | `search_and_read`, `apply_patch_set` (grep→read→edit, glob→read in one round trip; additive, primitives stay available) |
| Subagent policy                   | Effort policy + subagent guidance         | In-loop parallel tool calls preferred; subagents reserved for broad independent investigations; low effort never spawns (`subagent-guidance.ts`) |

### The fail-open contract

Everything above degrades to "today's behavior" when SystemOne is
unavailable or unconvinced — the agent never loses capability, only
optimization:

- Shim down, slow (> timeout), non-200, or malformed response → no route
  decision; the turn runs exactly as it would without SystemOne
  (`speedstack/systemone-route.ts`: never throws, fail-open).
- Route confidence below the prune threshold → the full tool/MCP surface
  is attached (`no route decision (fail-open)`, `confidence below prune
  threshold (fail-open)`).
- Tool-pack computation throws → full attach (`tool-pack computation threw
  (fail-open)`).
- A pruned tool turns out to be needed → one-shot fail-open recovery
  (`recoverTurnToolPackMiss`): the turn retries with the full set, once.
- Plan-execute gate errors → direct mode (`gate-error-fail-open`).
- Budget hit mid-task → resumable session state; the stop message says how
  to resume.
- All numeric behavior values (budgets, policy dimensions) live in config /
  env, never hard-coded, so they can be tuned without a release. Model
  choice always flows from the router, the registry, or explicit user
  config — no hard-coded model IDs as defaults anywhere.

### Kill switches

Each surface has its own switch; all default to ON (integrated). Set to
`0` to disable that surface only — the rest of SystemOne keeps working.

| Env var                  | Disables                                        |
|--------------------------|-------------------------------------------------|
| `ZCODE_SYSTEMONE=0`      | All SystemOne routing/integration               |
| `ZCODE_SPEEDSTACK_PRUNE=0` | Per-task tool-pack pruning + MCP pruning      |
| `ZCODE_BUDGET_ENFORCE=0` | Turn/tool-call budget enforcement              |
| `ZCODE_PLAN_EXECUTE=0`   | Route-driven plan-then-execute gating           |
| `ZCODE_ANCHORED_COMPACT=0` | Anchored compaction (falls back to plain compact) |
| `ZCODE_DOOMLOOP=0`       | Doom-loop fingerprint escalation (plain warnings stay) |

`mcpPruning=false` (session/runtime config) disables MCP tool pruning from
the config side instead of the env side.

Tuning (not killing): `ZCODE_BUDGET_<TIER>_MAX_STEPS` /
`ZCODE_BUDGET_<TIER>_MAX_TOOL_CALLS` (tiers: ECONOMY/BALANCED/HEAVY/ULTRA,
plus `ZCODE_BUDGET_DEFAULT_*`), and `ZCODE_EFFORT_<TIER>_{SUBAGENTS,
SUBAGENT_MAX_TURNS,READ_BREADTH,VERIFICATION_PASSES,COMPACTION,PLAN_EXECUTE}`
adjust the effort-behavior table without a release.

### Independent controls (what SystemOne does NOT touch)

- **Model selection is independent.** The model comes from the pinned LM
  Studio model, the model picker, or explicit user config. SystemOne never
  loads, unloads, or switches models; its tier→model mapping is advisory
  and with one loaded model both planner and executor resolve to it.
- **Thinking level is independent.** `--thinking` / the thinking selector
  sets reasoning depth directly; the route's effort→reasoningLevel mapping
  only applies as an override when the user hasn't set one, and explicit
  user flags always win.
- No cloud model names appear as defaults anywhere in the speed-stack.

### Verification (2026-09-23)

- `tsx --test src/speedstack/*.test.ts`: **237/237** (21 suites).
- `tsc --noEmit` on `@zcode/core` and `@zcode/contracts`: clean.
- Budget tune loop against the eval harness (`speedstack/eval/`):
  raised policy defaults give 0/6 cap hits on the baseline battery while
  still bounding a 200-step/500-call runaway (1/6) — per Ryan's directive,
  budgets are comfortably above too-tight demo values.
- `git status` clean of deletions before ship; no local-only commits.
