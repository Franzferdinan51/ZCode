// ============================================================
// Speed Stack: route-driven plan-then-execute gate (Rank 3)
// ============================================================
//
// Pure, side-effect-free decision: plan-then-execute or direct execution.
//
// Strict signals (conservative on purpose — the runtime owns the pinned
// model, so plan-then-execute is behavioral, never a model switch):
//   1. kill switch ZCODE_PLAN_EXECUTE=0        → always direct
//   2. explicit user config                     → pinned on/off
//   3. Package-2 effort behavior policy
//      (planThenExecuteEligible) or heavy tier  → plan
//   4. risky task labels + decent route
//      confidence                                → plan
//   5. multi-file task signals + decent route
//      confidence                                → plan
// Otherwise: direct (simple tasks never pay planning overhead).
//
// Fail-open: any error in the gate means "direct".

import {
  isPlanThenExecuteEligible,
  type EffortBehaviorPolicy,
} from "./effort-tiers.js";
import { isPlanThenExecuteDisabled } from "./plan-execute.js";

export interface PlanExecuteGateInput {
  readonly policy?: EffortBehaviorPolicy | undefined;
  readonly routeTier?: string | undefined;
  readonly routeConfidence?: number | undefined;
  readonly taskLabels?: readonly string[] | undefined;
  readonly taskText?: string | undefined;
  /**
   * SpeedStackSessionConfig.planThenExecute: explicit user pin.
   * true  → force plan, false → force direct, undefined → route decides.
   */
  readonly explicitConfig?: boolean | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export interface PlanExecuteGateDecision {
  readonly plan: boolean;
  readonly reason:
    | "kill-switch"
    | "config-off"
    | "config-on"
    | "effort-policy-or-heavy-tier"
    | "risky-labels"
    | "multi-file-signals"
    | "direct"
    | "gate-error-fail-open";
}

/**
 * Labels that mark a task as ambiguous/risky enough to justify planning.
 * Never matched below the confidence floor (route must be sure enough).
 */
const RISKY_LABEL_PATTERN =
  /^(ambiguous|risky|multi[- ]?file|refactor|migration|design|planning|complex)$/i;

/** Explicit multi-file language in the task text. */
const MULTI_FILE_TEXT_PATTERN =
  /\b(multi[- ]file|across .*files|refactor|migration|codebase|multiple files)\b/i;

/** Path-like tokens with a directory separator. */
const FILE_PATH_PATTERN =
  /(?:^|[\s("'`])((?:[~.]?\/)?[\w.~-]+(?:\/[\w.~-]+)+\.\w+)/g;

/** Bare filenames with common source extensions. */
const BARE_FILE_PATTERN =
  /(?:^|[\s("'`])([\w.~-]+\.(?:ts|tsx|js|mjs|cjs|json|md|py|rs|go|java|rb))\b/g;

/** Route confidence below this means label/text signals stay advisory. */
export const PLAN_EXECUTE_SIGNAL_CONFIDENCE_FLOOR = 0.6;

/** Distinct file mentions at or above this count = multi-file task. */
export const PLAN_EXECUTE_MULTI_FILE_THRESHOLD = 3;

function countDistinctFilePaths(text: string): number {
  const found = new Set<string>();
  for (const pattern of [FILE_PATH_PATTERN, BARE_FILE_PATTERN]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) found.add(match[1].replace(/^`|`$/g, ""));
    }
  }
  return found.size;
}

function hasRiskyLabels(labels: readonly string[]): boolean {
  return labels.some((label) => RISKY_LABEL_PATTERN.test(label.trim()));
}

function hasMultiFileSignals(text: string): boolean {
  if (MULTI_FILE_TEXT_PATTERN.test(text)) return true;
  return countDistinctFilePaths(text) >= PLAN_EXECUTE_MULTI_FILE_THRESHOLD;
}

export function decidePlanThenExecute(
  input: PlanExecuteGateInput,
): PlanExecuteGateDecision {
  try {
    if (isPlanThenExecuteDisabled(input.env)) {
      return { plan: false, reason: "kill-switch" };
    }
    if (input.explicitConfig === false) {
      return { plan: false, reason: "config-off" };
    }
    if (input.explicitConfig === true) {
      return { plan: true, reason: "config-on" };
    }
    // Rank 2 eligibility carries over: xhigh+ behavior tiers or heavy routes.
    if (
      isPlanThenExecuteEligible({
        policy: input.policy,
        routeTier: input.routeTier,
      })
    ) {
      return { plan: true, reason: "effort-policy-or-heavy-tier" };
    }
    const confidence = input.routeConfidence ?? 0;
    const labels = input.taskLabels ?? [];
    if (
      hasRiskyLabels(labels) &&
      confidence >= PLAN_EXECUTE_SIGNAL_CONFIDENCE_FLOOR
    ) {
      return { plan: true, reason: "risky-labels" };
    }
    if (
      hasMultiFileSignals(input.taskText ?? "") &&
      confidence >= PLAN_EXECUTE_SIGNAL_CONFIDENCE_FLOOR
    ) {
      return { plan: true, reason: "multi-file-signals" };
    }
    return { plan: false, reason: "direct" };
  } catch {
    return { plan: false, reason: "gate-error-fail-open" };
  }
}
