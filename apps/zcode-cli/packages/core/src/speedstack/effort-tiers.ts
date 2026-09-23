// ============================================================
// Speed Stack: effort tiers per task
// ============================================================
//
// A coarse low/medium/high/xhigh/ultra effort setting per task, mapped onto
// the model's OWN optionSpecs (never provider-specific level names, never
// cloud model names). Surfacing: SpeedStackSessionConfig, carried by the
// task/session.
//
// SystemOne extension: extractRouteEffortHint reads an optional `effort`
// field from a route response object, fail-open (undefined = current
// behavior unchanged).
//
// Thinking modes (3.24.0): the desktop thinking selector offers
// Off / Low / Medium / High / XHigh / Ultra / Auto. `ThinkingMode` captures
// that choice: "off" disables thinking, a tier pins the effort, "auto" lets
// the SystemOne route decide per task. Model routing (`modelRouting`) is a
// fully independent switch: the route may retarget the session model only
// when it is on, and the thinking mode never gates model routing (nor the
// reverse).

import type { ModelOptions } from "@zcode/contracts";

export const EFFORT_TIERS = ["low", "medium", "high", "xhigh", "ultra"] as const;

/** Per-task reasoning effort tier. */
export type EffortTier = (typeof EFFORT_TIERS)[number];

export const DEFAULT_EFFORT_TIER: EffortTier = "medium";

/**
 * Thinking selector mode. "auto" = the SystemOne route picks the effort per
 * task; "off" = thinking disabled; a tier pins that effort for every task.
 */
export const THINKING_MODES = ["auto", "off", ...EFFORT_TIERS] as const;
export type ThinkingMode = (typeof THINKING_MODES)[number];

/** Output-token budgets per tier; the model's own max always wins. */
const LOW_TIER_MAX_OUTPUT_TOKENS = 4_000;
const MEDIUM_TIER_MAX_OUTPUT_TOKENS = 12_000;
const HIGH_TIER_MAX_OUTPUT_TOKENS = 32_000;
const XHIGH_TIER_MAX_OUTPUT_TOKENS = 64_000;
/** ultra -> the model's own maximum output tokens (no ZCode-side cap). */

/** Reasoning-level values that mean "thinking off" (case-insensitive). */
const OFF_LEVEL_PATTERN = /^(off|disabled|false|no|none|nothink|no[-_]?think)$/i;

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
 * Parse user input into a ThinkingMode. Case-insensitive, fail-open to
 * undefined (caller keeps current behavior).
 */
export function parseThinkingMode(input: unknown): ThinkingMode | undefined {
  if (typeof input !== "string") return undefined;
  const normalized = input.trim().toLowerCase();
  if (normalized === "auto" || normalized === "off") return normalized;
  return parseEffortTier(normalized);
}

/**
 * Find the model's own "thinking off" reasoning level, if it declares one.
 * Mirrors the UI's off-entry detection so runtime "Off" binds the same value
 * the user would pick manually. Returns undefined when the model has no
 * off-like level (caller then leaves the model untouched: fail-open).
 */
export function findThinkingOffLevel(
  values: readonly string[],
): string | undefined {
  return values.find((value) => OFF_LEVEL_PATTERN.test(value.trim()));
}

/**
 * Map an effort tier onto the index of the model's own ordered reasoning
 * levels (spec order is low..high per Model Config). Legacy low/medium/high
 * keep their exact historical indices; xhigh/ultra spread across the upper
 * half so models with 4+ levels get distinct depths. Models with fewer
 * levels collapse adjacent tiers onto the same value.
 */
function tierLevelIndex(tier: EffortTier, levelCount: number): number {
  if (levelCount <= 1) return 0;
  if (tier === "low") return 0;
  if (tier === "medium") return Math.floor(levelCount / 2);
  if (tier === "high" || tier === "ultra") return levelCount - 1;
  // xhigh: halfway between the medium index and the max.
  const mediumIndex = Math.floor(levelCount / 2);
  return Math.min(levelCount - 1, Math.round((mediumIndex + (levelCount - 1)) / 2));
}

/**
 * Map an effort tier onto concrete ModelOptions using the model's own
 * optionSpecs:
 * - reasoningLevel: tierLevelIndex(tier) into the model's ordered values.
 * - maxOutputTokens: tier budget capped by the model's max
 *   (low 4k / medium 12k / high 32k / xhigh 64k / ultra model max).
 */
export function effortTierToModelOptions(
  model: EffortTierModel,
  tier: EffortTier = DEFAULT_EFFORT_TIER,
): Required<ModelOptions> {
  const levels = model.optionSpecs.reasoningLevel.values;
  const reasoningLevel = levels[tierLevelIndex(tier, levels.length)]!;
  const modelMax = model.optionSpecs.maxOutputTokens.max;
  const tierBudget =
    tier === "low"
      ? LOW_TIER_MAX_OUTPUT_TOKENS
      : tier === "medium"
        ? MEDIUM_TIER_MAX_OUTPUT_TOKENS
        : tier === "high"
          ? HIGH_TIER_MAX_OUTPUT_TOKENS
          : tier === "xhigh"
            ? XHIGH_TIER_MAX_OUTPUT_TOKENS
            : modelMax;
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
  /** Reasoning effort tier for this task (legacy explicit pin). */
  effortTier?: EffortTier;
  /**
   * Model routing switch (3.24.0). When true, a SystemOne route decision may
   * retarget the session model per task ("Auto (SystemOne)" in the desktop
   * model picker). False/undefined = the pinned model never moves.
   * Independent of thinkingMode: neither gates the other.
   */
  modelRouting?: boolean;
  /**
   * Thinking selector mode (3.24.0): "off" disables thinking, a tier pins
   * the effort, "auto"/undefined lets the route decide per task.
   * Independent of modelRouting: neither gates the other.
   */
  thinkingMode?: ThinkingMode;
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
  if (raw["modelRouting"] === true) config.modelRouting = true;
  const thinkingMode = parseThinkingMode(raw["thinkingMode"]);
  if (thinkingMode) config.thinkingMode = thinkingMode;
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
 * current behavior). Legacy helper kept for the explicit-pin path; new code
 * should prefer resolveThinkingTier, which also honors thinkingMode/off.
 */
export function resolveEffectiveEffortTier(
  config: SpeedStackSessionConfig | undefined,
  routeHint: EffortTier | undefined,
): EffortTier | undefined {
  return config?.effortTier ?? routeHint ?? undefined;
}

/** Outcome of thinking-mode resolution for one task. */
export type ResolvedThinking =
  | { readonly kind: "off" }
  | { readonly kind: "tier"; readonly tier: EffortTier };

/**
 * Resolve what thinking to apply for one task.
 *
 * Precedence (model/thinking independence: this never looks at modelRouting):
 *   1. thinkingMode === "off"            -> thinking off
 *   2. thinkingMode is a tier             -> pinned tier (user's explicit choice)
 *   3. config.effortTier (legacy pin)     -> that tier
 *   4. thinkingMode "auto"/unset + route  -> the route's effort hint
 *   5. otherwise                          -> undefined (caller keeps behavior)
 */
export function resolveThinkingTier(input: {
  thinkingMode?: ThinkingMode;
  explicitTier?: EffortTier;
  routeHint?: EffortTier;
}): ResolvedThinking | undefined {
  const mode = input.thinkingMode;
  if (mode === "off") return { kind: "off" };
  if (mode !== undefined && mode !== "auto") return { kind: "tier", tier: mode };
  if (input.explicitTier) return { kind: "tier", tier: input.explicitTier };
  if (input.routeHint) return { kind: "tier", tier: input.routeHint };
  return undefined;
}
