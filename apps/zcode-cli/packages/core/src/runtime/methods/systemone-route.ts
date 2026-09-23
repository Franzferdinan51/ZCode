// ============================================================
// Speed Stack: per-task SystemOne route decision (Z0/Z1/Z2)
// ============================================================
//
// Fetches the route decision once per task (3.24.0: no more per-session
// caching — every task gets its own route call) and exposes the latest
// settled value to the turn loop via `systemOneRouteValue`.
// Fail-open: the fetch never rejects — a missing shim, timeout, or bad
// payload just yields undefined and the session behaves exactly like today.

import type { AgentRuntimeInternal } from "../internal.js";
import {
  fetchSystemOneRouteDecision,
  type SystemOneRouteDecision,
} from "../../speedstack/systemone-route.js";

export async function ensureSystemOneRouteDecision(
  this: AgentRuntimeInternal,
  task: string,
): Promise<SystemOneRouteDecision | undefined> {
  // One route call per task: fetch fresh every time instead of caching the
  // first task's decision for the whole session. The latest value stays on
  // `systemOneRouteValue` for the Z1/Z2 policies consumed later in the turn.
  const decision = await fetchSystemOneRouteDecision(task).then(
    (resolved) => resolved,
    () => {
      // Unreachable: the client never rejects, but stay fail-open anyway.
      return undefined;
    },
  );
  this.systemOneRouteValue = decision;
  this.systemOneRouteTaskText = task;
  if (decision) {
    this.logger?.debug("SystemOne route decision fetched", {
      confidence: decision.confidence,
      effort: decision.effort,
      event: "systemone.route.fetched",
      modelId: decision.modelId,
      module: "core.runtime",
      taskLabels: decision.taskLabels,
      tier: decision.tier,
    });
  } else {
    this.logger?.debug("SystemOne route unavailable; fail-open", {
      event: "systemone.route.unavailable",
      module: "core.runtime",
    });
  }
  return decision;
}
