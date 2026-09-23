// ============================================================
// Speed Stack: per-session SystemOne route decision (Z1/Z2)
// ============================================================
//
// Fetches the route decision once per session (first task wins; later turns
// reuse the cached promise) and exposes the settled value to the turn loop.
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
  if (!this.systemOneRoutePromise) {
    this.systemOneRoutePromise = fetchSystemOneRouteDecision(task).then(
      (decision) => {
        this.systemOneRouteValue = decision;
        if (decision) {
          this.logger?.debug("SystemOne route decision cached", {
            confidence: decision.confidence,
            effort: decision.effort,
            event: "systemone.route.cached",
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
      },
      () => {
        // Unreachable: the client never rejects, but stay fail-open anyway.
        this.systemOneRouteValue = undefined;
        return undefined;
      },
    );
  }
  return this.systemOneRoutePromise;
}
