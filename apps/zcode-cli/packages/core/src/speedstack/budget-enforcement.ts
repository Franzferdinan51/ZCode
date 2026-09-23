// ============================================================
// Speed Stack: turn/tool budget enforcement (soft-then-hard)
// ============================================================
//
// Pure warn -> escalate -> stop state machine for per-turn budgets.
// The turn loop (runtime/methods/turn-loop.ts) evaluates this at the top of
// every iteration:
//
//   ok        usage below 80% of every configured cap -> keep going.
//   warn      usage crossed 80% of a cap (once per turn) -> inject the warn
//             reminder through the existing anomaly-warning channel, keep
//             going.
//   escalate  usage hit 100% of a cap -> inject ONE strategy-change nudge
//             and grant exactly one more model step so the model can wrap up.
//   stop      the escalation step is done -> hard stop.
//
// Unconfigured caps never trigger ({} = unbounded = today's behavior).
// Fail-open everywhere: garbage budgets degrade to "ok".
//
// Kill switch (env): ZCODE_BUDGET_ENFORCE=0 disables enforcement for the
// process (the runtime then never initializes budget state).

import type { BudgetUsage, TurnBudgets } from "./turn-budgets.js";

/** Fraction of a cap at which the soft warning fires. */
export const BUDGET_WARN_FRACTION = 0.8;

/** Kill-switch env: "0" disables budget enforcement for the process. */
export const BUDGET_ENFORCE_KILL_SWITCH_ENV = "ZCODE_BUDGET_ENFORCE";

/** True when the budget-enforcement kill switch is engaged. */
export function isBudgetEnforcementDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    return env[BUDGET_ENFORCE_KILL_SWITCH_ENV] === "0";
  } catch {
    return false;
  }
}

/** Enforcement stage already reached this turn (loop-state tracked). */
export interface BudgetStageState {
  readonly warned: boolean;
  readonly escalated: boolean;
}

/** Outcome of evaluating usage against the budgets. */
export type BudgetEnforcementAction = "ok" | "warn" | "escalate" | "stop";

/**
 * Pure transition function. A cap counts as hit at >= 100%, warned at >=
 * ceil(80%). Steps and calls are evaluated independently; either one can
 * drive the transition. Pure and never throws.
 */
export function evaluateBudgetEnforcement(
  usage: BudgetUsage,
  budgets: TurnBudgets,
  stage: BudgetStageState,
): BudgetEnforcementAction {
  try {
    const stepsHit =
      budgets.maxSteps !== undefined && usage.steps >= budgets.maxSteps;
    const callsHit =
      budgets.maxToolCalls !== undefined &&
      usage.toolCalls >= budgets.maxToolCalls;
    if (stepsHit || callsHit) {
      // The escalation grants exactly one more model step; the step after
      // that is the hard stop.
      return stage.escalated ? "stop" : "escalate";
    }
    const stepsWarn =
      budgets.maxSteps !== undefined &&
      usage.steps >= Math.ceil(budgets.maxSteps * BUDGET_WARN_FRACTION);
    const callsWarn =
      budgets.maxToolCalls !== undefined &&
      usage.toolCalls >=
        Math.ceil(budgets.maxToolCalls * BUDGET_WARN_FRACTION);
    if ((stepsWarn || callsWarn) && !stage.warned) {
      return "warn";
    }
    return "ok";
  } catch {
    return "ok";
  }
}

/** Shared context for the budget message builders. */
export interface BudgetMessageContext {
  readonly steps: number;
  readonly toolCalls: number;
  readonly maxSteps: number | undefined;
  readonly maxToolCalls: number | undefined;
  readonly tier: string | undefined;
}

function describeCaps(ctx: BudgetMessageContext): string {
  const steps = ctx.maxSteps !== undefined ? `${ctx.steps}/${ctx.maxSteps} steps` : `${ctx.steps} steps`;
  const calls =
    ctx.maxToolCalls !== undefined
      ? `${ctx.toolCalls}/${ctx.maxToolCalls} tool calls`
      : `${ctx.toolCalls} tool calls`;
  const tier = ctx.tier ? ` (${ctx.tier} effort)` : "";
  return `${steps}, ${calls}${tier}`;
}

/** 80% soft-warning body, injected through the anomaly-warning channel. */
export function buildBudgetWarnBody(ctx: BudgetMessageContext): string {
  return [
    `Turn budget 80% used: ${describeCaps(ctx)}.`,
    "Wrap up efficiently: avoid starting new exploration threads, " +
      "reuse results you already have, and steer toward the final answer.",
  ].join("\n");
}

/**
 * Strategy-change nudge: the ONE auto-escalation step before the hard stop.
 * The model gets exactly one more model step after this is injected.
 */
export function buildBudgetEscalationBody(ctx: BudgetMessageContext): string {
  return [
    `Turn budget exhausted: ${describeCaps(ctx)}.`,
    "CHANGE STRATEGY: you have exactly one more model step before this turn " +
      "is stopped. Do not start new tool exploration. Synthesize what you " +
      "already have into the final answer now, and note anything left undone.",
  ].join("\n");
}

/**
 * Hard-stop body: becomes the turn's final assistant text. The session is
 * already persisted by the normal turn-completion path, so the turn is
 * resumable; the text surfaces the explicit resume path.
 */
export function buildBudgetExhaustedBody(ctx: BudgetMessageContext): string {
  return [
    `Stopped: turn budget exhausted (${describeCaps(ctx)}).`,
    "The session state is saved and this turn is resumable — send another " +
      "message (e.g. \"continue\") to pick up where it left off.",
    "To allow longer turns, raise the caps with " +
      "ZCODE_BUDGET_<TIER>_MAX_STEPS / ZCODE_BUDGET_<TIER>_MAX_TOOL_CALLS " +
      "(TIER = ECONOMY, BALANCED, HEAVY) or ZCODE_BUDGET_DEFAULT_*.",
  ].join("\n");
}
