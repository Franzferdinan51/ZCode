// ============================================================
// Speed Stack: config-driven per-tier turn/tool budgets
// ============================================================
//
// Per-route-tier caps on model steps and tool calls per turn. These are the
// caps Ryan's tuning directive covers: they MUST stay config-driven (env),
// never hard-coded, so caps can be tuned without a release and validated
// against the eval harness.
//
// Current state: no enforcement exists yet (the turn loop is unbounded
// today). resolveTurnBudgets() returns {} when nothing is configured, i.e.
// today's behavior. The next package adds enforcement + raises the caps;
// this module is the config surface it will read.
//
// Env (all optional; positive integers only; garbage fails open to
// unbounded):
//   ZCODE_BUDGET_<TIER>_MAX_STEPS       e.g. ZCODE_BUDGET_ECONOMY_MAX_STEPS=25
//   ZCODE_BUDGET_<TIER>_MAX_TOOL_CALLS  e.g. ZCODE_BUDGET_HEAVY_MAX_TOOL_CALLS=150
//   ZCODE_BUDGET_DEFAULT_MAX_STEPS / ZCODE_BUDGET_DEFAULT_MAX_TOOL_CALLS
//     fallback when the tier has no tier-specific value (or no route).
// <TIER> is the uppercase route tier: ECONOMY, BALANCED, HEAVY.
//
// Pure module: no runtime imports, runnable under plain `node --test`
// type-stripping like its speedstack siblings. No model IDs anywhere.

/** Route tiers the SystemOne shim emits (grounded in the live payload). */
export const BUDGET_ROUTE_TIERS = ["economy", "balanced", "heavy"] as const;
export type BudgetRouteTier = (typeof BUDGET_ROUTE_TIERS)[number];

/** Per-turn caps. undefined = unbounded (today's behavior). */
export interface TurnBudgets {
  /** Max model steps for the turn. */
  readonly maxSteps?: number | undefined;
  /** Max tool calls for the turn. */
  readonly maxToolCalls?: number | undefined;
}

/** Observed usage, compared against TurnBudgets by checkBudgetHit. */
export interface BudgetUsage {
  readonly steps: number;
  readonly toolCalls: number;
}

/** Result of comparing usage against budgets. */
export interface BudgetHit {
  readonly stepsHit: boolean;
  readonly toolCallsHit: boolean;
  readonly anyHit: boolean;
}

/** Parse a budget env value: positive integer, else undefined (fail-open). */
export function parseBudgetValue(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number.parseInt(trimmed, 10);
  return value > 0 ? value : undefined;
}

function tierEnvPrefix(tier: string | undefined): string | undefined {
  if (!tier) return undefined;
  const normalized = tier.trim().toLowerCase();
  if ((BUDGET_ROUTE_TIERS as readonly string[]).includes(normalized)) {
    return `ZCODE_BUDGET_${normalized.toUpperCase()}`;
  }
  return undefined;
}

/**
 * Resolve the per-turn budgets for a route tier from the environment.
 * Tier-specific vars win; ZCODE_BUDGET_DEFAULT_* is the fallback.
 * Returns {} when nothing is configured (unbounded: today's behavior).
 * Never throws.
 */
export function resolveTurnBudgets(
  tier: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): TurnBudgets {
  try {
    const prefix = tierEnvPrefix(tier);
    const maxSteps =
      parseBudgetValue(prefix ? env[`${prefix}_MAX_STEPS`] : undefined) ??
      parseBudgetValue(env["ZCODE_BUDGET_DEFAULT_MAX_STEPS"]);
    const maxToolCalls =
      parseBudgetValue(prefix ? env[`${prefix}_MAX_TOOL_CALLS`] : undefined) ??
      parseBudgetValue(env["ZCODE_BUDGET_DEFAULT_MAX_TOOL_CALLS"]);
    const budgets: { maxSteps?: number; maxToolCalls?: number } = {};
    if (maxSteps !== undefined) budgets.maxSteps = maxSteps;
    if (maxToolCalls !== undefined) budgets.maxToolCalls = maxToolCalls;
    return budgets;
  } catch {
    return {};
  }
}

/**
 * Compare observed usage against budgets. A cap counts as hit when the
 * budget is configured and usage reached it (>=). Unconfigured budgets
 * never hit. Pure.
 */
export function checkBudgetHit(
  usage: BudgetUsage,
  budgets: TurnBudgets,
): BudgetHit {
  const stepsHit =
    budgets.maxSteps !== undefined && usage.steps >= budgets.maxSteps;
  const toolCallsHit =
    budgets.maxToolCalls !== undefined &&
    usage.toolCalls >= budgets.maxToolCalls;
  return { stepsHit, toolCallsHit, anyHit: stepsHit || toolCallsHit };
}

/** Human-readable one-liner for logs and harness reports. */
export function describeTurnBudgets(
  tier: string | undefined,
  budgets: TurnBudgets,
): string {
  const steps = budgets.maxSteps ?? "unbounded";
  const calls = budgets.maxToolCalls ?? "unbounded";
  return `tier=${tier ?? "none"} maxSteps=${steps} maxToolCalls=${calls}`;
}
