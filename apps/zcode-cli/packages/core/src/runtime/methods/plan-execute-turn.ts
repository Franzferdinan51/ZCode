// ============================================================
// Speed Stack Rank 3: route-driven plan-then-execute turn
// ============================================================
//
// The routing decision (route tier, effort behavior policy, task labels)
// decides whether a turn runs plan-then-execute (see
// speedstack/plan-execute-gate.ts). This module executes the two phases:
//
//   Phase 1 — planner: same pinned model, read-only tool visibility
//   (everything not marked tool.readOnly is hidden from the planner).
//   The planner's response is persisted as PLAN.md in the session's
//   plan directory — shared ground truth on disk.
//   Phase 2 — executor: same model, full tool visibility, the executor
//   prompt prepended to the history. The plan auto-executes; there is
//   no approval gate (Ryan's standing rule).
//
// The planner pass runs under a small planner budget so a runaway plan
// can never eat the executor's turn budget. When the planner produces
// nothing usable (empty response, planner budget exhausted), the turn
// fails open to a normal direct execution.
//
// A completed plan-execute turn notes a "plan-stage" boundary-compact
// event for the Rank 4 boundary check.

import { homedir } from "node:os";

import { systemReminderAttachmentEntry } from "../../agent/message-history.js";
import {
  buildExecutorPrompt,
  buildPlannerPrompt,
  readPlanExecuteModelPreferences,
  resolvePlanExecuteModels,
  resolvePlanExecuteSessionDir,
  writePlanArtifact,
} from "../../speedstack/plan-execute.js";
import type { PlanExecuteGateDecision } from "../../speedstack/plan-execute-gate.js";
import type { SystemOneRouteDecision } from "../../speedstack/systemone-route.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";
import { runRegularTurnLoop } from "./turn-loop.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

export interface PlanThenExecuteTurnOptions {
  readonly input: string;
  readonly gate: PlanExecuteGateDecision;
  readonly routeDecision: SystemOneRouteDecision | undefined;
  /**
   * The model already admitted for this turn (LM Studio pinned model).
   * Used for role-model resolution only — never loads/unloads anything.
   */
  readonly admittedModelId?: string | undefined;
}

/** Clear the turn-budget stage so the executor starts from a fresh slate. */
function resetTurnBudgetStage(state: RegularTurnLoopState): void {
  state.speedStackBudgets = undefined;
  state.speedStackBudgetTier = undefined;
  state.speedStackBudgetWarningThreshold = undefined;
  state.speedStackBudgetWarned = undefined;
  state.speedStackBudgetEscalated = undefined;
  state.speedStackPlannerBudgetExhausted = undefined;
}

function logContext(): Record<string, unknown> {
  return {
    event: "plan_execute.turn",
    module: "core.runtime",
  };
}

export async function runPlanThenExecuteTurn(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: PlanThenExecuteTurnOptions,
): Promise<void> {
  // Role-model resolution is selection-only (no load/unload/switch).
  // Included in the log for routing transparency.
  let roleModels: { plannerModelId: string; executorModelId: string } | undefined;
  try {
    const available = options.admittedModelId ? [options.admittedModelId] : [];
    roleModels = resolvePlanExecuteModels(
      available,
      {
        routeModelId: options.routeDecision?.modelId,
        routeTier: options.routeDecision?.tier,
      },
      readPlanExecuteModelPreferences(),
    );
  } catch {
    // fail-open: role models are advisory/transparency-only
  }
  this.logger?.info("Plan-then-execute started", {
    ...logContext(),
    outcome: "started",
    reason: options.gate.reason,
    plannerModelId: roleModels?.plannerModelId ?? null,
    executorModelId: roleModels?.executorModelId ?? null,
  });

  // -- Phase 1: planner with READ-ONLY tool visibility ------------------
  const savedDisallowlist = state.toolDisallowlist;
  // The planner's budget hard-stop completes the turn machine; the fallback
  // path restores this pre-planner machine instead of reusing a completed one.
  const savedTurnMachine = state.turnMachine;
  try {
    const disallowed = this.getTools(state.model)
      .filter((tool) => tool.readOnly !== true)
      .map((tool) => tool.name);
    state.toolDisallowlist = [...(savedDisallowlist ?? []), ...disallowed];
    state.speedStackPlannerPhase = true;
    commitTurnRequestEntries(this, state.turnRequestState, [
      systemReminderAttachmentEntry(
        "plan_execute_planner",
        buildPlannerPrompt(options.input),
      ),
    ]);
    await runRegularTurnLoop.call(this, state);
  } finally {
    state.speedStackPlannerPhase = false;
    state.toolDisallowlist = savedDisallowlist;
  }

  const planText = (state.modelResponse ?? "").trim();
  if (planText.length === 0 || state.speedStackPlannerBudgetExhausted === true) {
    // Fail-open: no usable plan — run the turn as a normal direct
    // execution instead of inventing one.
    this.logger?.warn("Plan-then-execute planner produced no plan; falling back to direct", {
      ...logContext(),
      outcome: "planner_fallback",
      plannerBudgetExhausted: state.speedStackPlannerBudgetExhausted === true,
    });
    resetTurnBudgetStage(state);
    state.modelResponse = "";
    state.turnMachine = savedTurnMachine;
    await runRegularTurnLoop.call(this, state);
    return;
  }

  // -- Shared ground truth on disk --------------------------------------
  const planDir = resolvePlanExecuteSessionDir(homedir(), this.sessionId);
  let planPath: string;
  try {
    planPath = await writePlanArtifact(planDir, planText);
  } catch (error) {
    // Fail-open: without the artifact the executor still gets the plan inline.
    this.logger?.warn("Plan artifact write failed; continuing with inline plan", {
      ...logContext(),
      outcome: "artifact_write_failed",
      error: error instanceof Error ? error.message : String(error),
    });
    planPath = `${planDir}/PLAN.md (write failed)`;
  }

  // -- Phase 2: executor with full tool visibility -----------------------
  resetTurnBudgetStage(state);
  state.modelResponse = "";
  commitTurnRequestEntries(this, state.turnRequestState, [
    systemReminderAttachmentEntry(
      "plan_execute_executor",
      `${buildExecutorPrompt(planText)}\n\nPlan artifact (shared ground truth): ${planPath}`,
    ),
  ]);
  await runRegularTurnLoop.call(this, state);

  // Rank 4: a completed plan-execute turn is a compaction boundary.
  this.speedStackPendingBoundaryEvent = "plan-stage";
  this.logger?.info("Plan-then-execute turn completed", {
    ...logContext(),
    outcome: "completed",
    planPath,
  });
}
