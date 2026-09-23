// ============================================================
// Speed Stack: effort tiers per task
// ============================================================
//
// A coarse low/medium/high effort setting per task, mapped onto the model's
// OWN optionSpecs (never provider-specific level names, never cloud model
// names). Surfacing: SpeedStackSessionConfig, carried by the task/session.
//
// SystemOne extension: extractRouteEffortHint reads an optional `effort`
// field from a route response object, fail-open (undefined = current
// behavior unchanged).

import type { ModelOptions } from "@zcode/contracts";

export const EFFORT_TIERS = ["low", "medium", "high"] as const;

/** Per-task reasoning effort tier. */
export type EffortTier = (typeof EFFORT_TIERS)[number];

export const DEFAULT_EFFORT_TIER: EffortTier = "medium";

/** Output-token budgets per tier; the model's own max always wins. */
const LOW_TIER_MAX_OUTPUT_TOKENS = 4_000;
const MEDIUM_TIER_MAX_OUTPUT_TOKENS = 12_000;

/** Minimal structural view of a model needed for tier mapping. */
export interface EffortTierModel {
  readonly optionSpecs: {
    readonly reasoningLevel: { readonly values: readonly string[] };
    readonly maxOutputTokens: { readonly max: number };
  };
}

/**
 * Parse user input into an EffortTier. Case-insensitive, fail-open to
 * undefined (caller keeps current behavior).
 */
export function parseEffortTier(input: unknown): EffortTier | undefined {
  if (typeof input !== "string") return undefined;
  const normalized = input.trim().toLowerCase();
  return (EFFORT_TIERS as readonly string[]).includes(normalized)
    ? (normalized as EffortTier)
    : undefined;
}

/**
 * Map an effort tier onto concrete ModelOptions using the model's own
 * optionSpecs:
 * - reasoningLevel: low -> first value, medium -> middle value,
 *   high -> last value (spec order is low..high per Model Config).
 * - maxOutputTokens: tier budget capped by the model's max.
 */
export function effortTierToModelOptions(
  model: EffortTierModel,
  tier: EffortTier = DEFAULT_EFFORT_TIER,
): Required<ModelOptions> {
  const levels = model.optionSpecs.reasoningLevel.values;
  const reasoningLevel =
    tier === "low"
      ? levels[0]!
      : tier === "high"
        ? levels[levels.length - 1]!
        : levels[Math.floor(levels.length / 2)]!;
  const modelMax = model.optionSpecs.maxOutputTokens.max;
  const tierBudget =
    tier === "low"
      ? LOW_TIER_MAX_OUTPUT_TOKENS
      : tier === "high"
        ? modelMax
        : MEDIUM_TIER_MAX_OUTPUT_TOKENS;
  return {
    reasoningLevel,
    maxOutputTokens: Math.min(tierBudget, modelMax),
  };
}

/**
 * Per-task/per-session speed-stack config surface. All fields optional;
 * absent fields mean "current behavior unchanged".
 */
export interface SpeedStackSessionConfig {
  /** Reasoning effort tier for this task. */
  effortTier?: EffortTier;
  /** When true, run plan-then-execute instead of a single reactive loop. */
  planThenExecute?: boolean;
  /** MCP server allowlist; undefined/empty = attach everything (default). */
  mcpServerAllowlist?: readonly string[];
  /** MCP tool allowlist ("server.tool" or "tool"); undefined/empty = all. */
  mcpToolAllowlist?: readonly string[];
  /**
   * MCP pruning kill-switch (config level). `false` disables route-driven
   * MCP pruning for the session; undefined/true leaves the default policy
   * live. The env-level kill-switch is ZCODE_SPEEDSTACK_PRUNE=0 — see
   * resolveMcpAttachPolicy in speedstack/systemone-route.ts, which documents
   * both.
   */
  mcpPruning?: boolean;
}

export function normalizeSpeedStackSessionConfig(
  input: unknown,
): SpeedStackSessionConfig {
  if (!input || typeof input !== "object") return {};
  const raw = input as Record<string, unknown>;
  const config: SpeedStackSessionConfig = {};
  const tier = parseEffortTier(raw["effortTier"]);
  if (tier) config.effortTier = tier;
  if (raw["planThenExecute"] === true) config.planThenExecute = true;
  if (Array.isArray(raw["mcpServerAllowlist"])) {
    config.mcpServerAllowlist = raw["mcpServerAllowlist"].filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    );
  }
  if (Array.isArray(raw["mcpToolAllowlist"])) {
    config.mcpToolAllowlist = raw["mcpToolAllowlist"].filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    );
  }
  if (typeof raw["mcpPruning"] === "boolean") {
    config.mcpPruning = raw["mcpPruning"];
  }
  return config;
}

/**
 * Resolve the effective effort tier: explicit session config wins, then the
 * SystemOne route hint (see extractRouteEffortHint in
 * packages/shared/src/systemone-scorer.ts), then undefined (caller keeps
 * current behavior).
 */
export function resolveEffectiveEffortTier(
  config: SpeedStackSessionConfig | undefined,
  routeHint: EffortTier | undefined,
): EffortTier | undefined {
  return config?.effortTier ?? routeHint ?? undefined;
}
