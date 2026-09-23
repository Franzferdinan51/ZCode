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
