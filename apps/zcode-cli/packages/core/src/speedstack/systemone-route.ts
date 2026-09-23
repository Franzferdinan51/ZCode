// ============================================================
// Speed Stack: SystemOne route client + per-task policies
// ============================================================
//
// One lightweight client for the local SystemOne shim
// (POST http://127.0.0.1:8765/v1/systemone/route), plus the two per-task
// policies driven by its route decision:
//
//   Z1 effort wiring  - route.effort -> EffortTier -> ModelOptions
//                     (reasoningLevel + maxOutputTokens) via
//                     resolveEffortTierAndOptions / applySystemOneEffortOverride.
//   Z2 MCP pruning    - resolveMcpAttachPolicy decides whether MCP servers
//                     attach at all; pruneMcpServerMap / pruneMcpTools apply
//                     explicit allowlists from SpeedStackSessionConfig.
//
// Everything here is fail-open: the shim being down, slow, or returning
// garbage yields `undefined` / "attach everything", i.e. today's behavior.

import type { Logger, ModelOptions } from "@zcode/contracts";
import { extractRouteEffortHint } from "@zcode/shared/systemone-scorer";
import {
  effortTierToModelOptions,
  resolveEffectiveEffortTier,
  type EffortTier,
  type EffortTierModel,
  type SpeedStackSessionConfig,
} from "./effort-tiers.js";

/** Local SystemOne shim route endpoint (see systemone/shim.py). */
export const SYSTEMONE_ROUTE_ENDPOINT = "http://127.0.0.1:8765/v1/systemone/route";

/** Hard bound on the route lookup; the shim answers in ~100ms when healthy. */
export const SYSTEMONE_ROUTE_TIMEOUT_MS = 3_000;

/**
 * Kill-switch (env): set `ZCODE_SPEEDSTACK_PRUNE=0` to force full MCP attach,
 * disabling route-driven MCP pruning for the process. Documented alongside
 * the config-level kill-switch `SpeedStackSessionConfig.mcpPruning`.
 */
export const SYSTEMONE_PRUNE_KILL_SWITCH_ENV = "ZCODE_SPEEDSTACK_PRUNE";

/**
 * Default pruning policy: only skip MCP servers when the router confidently
 * calls the task trivial. Conservative on purpose — anything ambiguous keeps
 * the full tool surface.
 */
export const SYSTEMONE_PRUNE_CONFIDENCE_THRESHOLD = 0.8;

/** Minimal route decision consumed by the Z1/Z2 policies. */
export interface SystemOneRouteDecision {
  readonly tier: string;
  readonly confidence: number;
  readonly effort?: string;
  readonly taskLabels?: readonly string[];
}

/**
 * POST {task} to the SystemOne route endpoint and return the parsed route
 * decision. Fail-open: any failure (shim down, timeout, non-200, malformed
 * body) returns undefined and never throws.
 */
export async function fetchSystemOneRouteDecision(
  task: string,
  options?: { endpoint?: string; timeoutMs?: number },
): Promise<SystemOneRouteDecision | undefined> {
  const endpoint = options?.endpoint ?? SYSTEMONE_ROUTE_ENDPOINT;
  const timeoutMs = options?.timeoutMs ?? SYSTEMONE_ROUTE_TIMEOUT_MS;
  if (!task || !task.trim()) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task }),
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return parseRouteDecision(await response.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function parseRouteDecision(payload: unknown): SystemOneRouteDecision | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const route = (payload as Record<string, unknown>)["route"];
  if (!route || typeof route !== "object") return undefined;
  const record = route as Record<string, unknown>;
  const tier = record["tier"];
  const confidence = record["confidence"];
  if (typeof tier !== "string" || typeof confidence !== "number") return undefined;
  const decision: {
    tier: string;
    confidence: number;
    effort?: string;
    taskLabels?: readonly string[];
  } = { tier, confidence };
  if (typeof record["effort"] === "string") decision.effort = record["effort"];
  if (Array.isArray(record["task_labels"])) {
    decision.taskLabels = record["task_labels"].filter(
      (label): label is string => typeof label === "string",
    );
  }
  return decision;
}

// -- Z1: effort wiring ------------------------------------------------

/**
 * Resolve the effective effort tier and its concrete ModelOptions from a
 * route decision + session config. Returns undefined when there is nothing
 * to apply (no route, no usable hint, no explicit tier) — the caller then
 * keeps today's model options untouched.
 */
export function resolveEffortTierAndOptions(input: {
  route: SystemOneRouteDecision | undefined;
  config: SpeedStackSessionConfig | undefined;
  model: EffortTierModel;
}): { tier: EffortTier; options: Required<ModelOptions> } | undefined {
  const hint = extractRouteEffortHint(input.route);
  const tier = resolveEffectiveEffortTier(input.config, hint);
  if (!tier) return undefined;
  return { tier, options: effortTierToModelOptions(input.model, tier) };
}

/** Structural session state needed by the effort override. */
export interface SystemOneRouteHolder {
  readonly speedStackConfig?: SpeedStackSessionConfig;
  systemOneRouteValue?: SystemOneRouteDecision | undefined;
}

/**
 * Apply the route-driven effort override to a turn model. Returns the model
 * with reasoningLevel + maxOutputTokens bound when a tier resolves,
 * otherwise the model unchanged. Never throws (fail-open).
 */
export function applySystemOneEffortOverride<
  ModelT extends EffortTierModel & {
    bind(options?: ModelOptions): ModelT;
    readonly options: ModelOptions;
  },
>(
  holder: SystemOneRouteHolder,
  model: ModelT,
  logger?: Logger,
): ModelT {
  try {
    const resolved = resolveEffortTierAndOptions({
      route: holder.systemOneRouteValue,
      config: holder.speedStackConfig,
      model,
    });
    if (!resolved) return model;
    logger?.debug("SystemOne effort override applied", {
      effortTier: resolved.tier,
      event: "systemone.effort.applied",
      maxOutputTokens: resolved.options.maxOutputTokens,
      module: "core.speedstack",
      reasoningLevel: resolved.options.reasoningLevel,
    });
    return model.bind({
      ...model.options,
      reasoningLevel: resolved.options.reasoningLevel,
      maxOutputTokens: resolved.options.maxOutputTokens,
    });
  } catch {
    return model;
  }
}

// -- Z2: MCP attach policy --------------------------------------------

/** Outcome of the per-task MCP attach policy. */
export interface McpAttachPolicy {
  /** False -> skip MCP servers entirely (built-in tools only). */
  readonly attachMcp: boolean;
  /** Human-readable reason; always logged with the decision. */
  readonly reason: string;
}

/**
 * Decide whether MCP servers attach for this task.
 *
 * Kill-switches (either forces full attach, i.e. today's behavior):
 *   1. Env: ZCODE_SPEEDSTACK_PRUNE=0
 *   2. Session config: SpeedStackSessionConfig.mcpPruning === false
 *
 * Default policy (conservative, live by default): attach built-in tools
 * only when the route says tier == "economy" with confidence >= 0.8.
 * Everything else — including a missing route decision (shim down:
 * fail-open) — attaches the full MCP surface exactly like today.
 */
export function resolveMcpAttachPolicy(
  route: SystemOneRouteDecision | undefined,
  config: SpeedStackSessionConfig | undefined,
): McpAttachPolicy {
  if (process.env[SYSTEMONE_PRUNE_KILL_SWITCH_ENV] === "0") {
    return {
      attachMcp: true,
      reason: `kill-switch: ${SYSTEMONE_PRUNE_KILL_SWITCH_ENV}=0`,
    };
  }
  if (config?.mcpPruning === false) {
    return {
      attachMcp: true,
      reason: "kill-switch: SpeedStackSessionConfig.mcpPruning=false",
    };
  }
  if (
    route &&
    route.tier === "economy" &&
    route.confidence >= SYSTEMONE_PRUNE_CONFIDENCE_THRESHOLD
  ) {
    return {
      attachMcp: false,
      reason:
        `route tier=economy confidence=${route.confidence} ` +
        `>= ${SYSTEMONE_PRUNE_CONFIDENCE_THRESHOLD}`,
    };
  }
  return {
    attachMcp: true,
    reason: route
      ? route.tier === "economy"
        ? `route tier=economy confidence=${route.confidence} below prune threshold ${SYSTEMONE_PRUNE_CONFIDENCE_THRESHOLD}`
        : `route tier=${route.tier} is not economy (pruning is economy-only)`
      : "no route decision (fail-open)",
  };
}
