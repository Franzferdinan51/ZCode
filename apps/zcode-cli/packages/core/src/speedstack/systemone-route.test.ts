/**
 * Speed Stack SystemOne routing wiring tests (Z1 effort + Z2 MCP attach policy).
 *
 * These tests cover the pure wiring helpers in speedstack/systemone-route.ts:
 * - route decision -> effort tier -> ModelOptions (reasoningLevel +
 *   maxOutputTokens)
 * - explicit session effort tier overrides the route decision
 * - malformed/unavailable route -> fail-open (no override)
 * - MCP attach policy: economy + confidence >= 0.8 prunes; lower
 *   confidence, non-economy, and missing decisions attach fully
 * - kill-switches: ZCODE_SPEEDSTACK_PRUNE=0 env and mcpPruning=false config
 *
 * The HTTP fetch path (fail-open on unreachable shim) is exercised by
 * `fetchSystemOneRouteDecision` against a guaranteed-dead port below.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applySystemOneEffortOverride,
  fetchSystemOneRouteDecision,
  isSystemOneDisabled,
  resolveEffortTierAndOptions,
  resolveMcpAttachPolicy,
  SYSTEMONE_PRUNE_CONFIDENCE_THRESHOLD,
  type SystemOneRouteDecision,
} from "./systemone-route.js";

const TIER_MODEL = {
  optionSpecs: {
    reasoningLevel: { values: ["low", "medium", "high"] },
    maxOutputTokens: { max: 64000 },
  },
};

function route(overrides: Partial<SystemOneRouteDecision> = {}): SystemOneRouteDecision {
  return {
    tier: "economy",
    confidence: 0.8,
    effort: "low",
    task_labels: ["summarize"],
    rationale: "test",
    model_id: "test-model",
    ...overrides,
  };
}

test("route decision economy/low maps to low reasoning level and small output cap", () => {
  const resolved = resolveEffortTierAndOptions({
    route: route({ tier: "economy", effort: "low", confidence: 0.9 }),
    model: TIER_MODEL,
  });
  assert.ok(resolved, "expected a resolved effort");
  assert.equal(resolved.tier, "low");
  assert.equal(resolved.options.reasoningLevel, "low");
  // low -> LOW_TIER_MAX_OUTPUT_TOKENS (4000), capped by the model max
  assert.equal(resolved.options.maxOutputTokens, 4000);
});

test("route decision balanced/medium maps to medium reasoning level and medium budget", () => {
  const resolved = resolveEffortTierAndOptions({
    route: route({ tier: "balanced", effort: "medium", confidence: 0.9 }),
    model: TIER_MODEL,
  });
  assert.ok(resolved);
  assert.equal(resolved.tier, "medium");
  assert.equal(resolved.options.reasoningLevel, "medium");
  // medium -> MEDIUM_TIER_MAX_OUTPUT_TOKENS (12000)
  assert.equal(resolved.options.maxOutputTokens, 12000);
});

test("route decision heavy/high maps to high reasoning level and full output cap", () => {
  const resolved = resolveEffortTierAndOptions({
    route: route({ tier: "heavy", effort: "high", confidence: 0.9 }),
    model: TIER_MODEL,
  });
  assert.ok(resolved);
  assert.equal(resolved.tier, "high");
  assert.equal(resolved.options.reasoningLevel, "high");
  assert.equal(resolved.options.maxOutputTokens, 64000);
});

test("explicit session effort tier overrides the route decision", () => {
  const resolved = resolveEffortTierAndOptions({
    config: { effortTier: "high" },
    route: route({ tier: "economy", effort: "low", confidence: 0.99 }),
    model: TIER_MODEL,
  });
  assert.ok(resolved);
  assert.equal(resolved.tier, "high");
});

test("missing route decision resolves nothing (fail-open)", () => {
  assert.equal(resolveEffortTierAndOptions({ route: undefined, model: TIER_MODEL }), undefined);
});

test("route without a usable effort resolves nothing (fail-open)", () => {
  const bad = route({ effort: "bogus" as unknown as "low" });
  assert.equal(resolveEffortTierAndOptions({ route: bad, model: TIER_MODEL }), undefined);
});

test("applySystemOneEffortOverride binds the model with route options", () => {
  const bound: unknown[] = [];
  const fakeModel = {
    options: { reasoningLevel: "medium", maxOutputTokens: 64000 },
    optionSpecs: TIER_MODEL.optionSpecs,
    bind(options?: unknown) {
      bound.push(options);
      return this;
    },
  };
  const out = applySystemOneEffortOverride(
    {
      speedStackConfig: {},
      systemOneRouteValue: route({ tier: "economy", effort: "low" }),
    },
    fakeModel,
  );
  assert.equal(out, fakeModel);
  assert.equal(bound.length, 1);
  const options = bound[0] as { reasoningLevel: string; maxOutputTokens: number };
  assert.equal(options.reasoningLevel, "low");
  assert.equal(options.maxOutputTokens, 4000);
});

test("applySystemOneEffortOverride without a route returns the model untouched", () => {
  let bindCalls = 0;
  const fakeModel = {
    options: {},
    optionSpecs: TIER_MODEL.optionSpecs,
    bind() {
      bindCalls += 1;
      return this;
    },
  };
  const out = applySystemOneEffortOverride({ speedStackConfig: {} }, fakeModel);
  assert.equal(out, fakeModel);
  assert.equal(bindCalls, 0);
});

test("fetchSystemOneRouteDecision fails open on an unreachable shim", async () => {
  // Port 1 is guaranteed closed; the fetch must resolve undefined, not throw.
  const decision = await fetchSystemOneRouteDecision("hello world", {
    endpoint: "http://127.0.0.1:1/v1/systemone/route",
    timeoutMs: 250,
  });
  assert.equal(decision, undefined);
});

test("MCP attach policy: economy + confidence >= 0.8 skips MCP", () => {
  const policy = resolveMcpAttachPolicy(route({ tier: "economy", confidence: 0.8 }), {});
  assert.equal(policy.attachMcp, false);
  assert.match(policy.reason, /economy/);
});

test("MCP attach policy: economy below the confidence threshold attaches fully", () => {
  const policy = resolveMcpAttachPolicy(
    route({ tier: "economy", confidence: SYSTEMONE_PRUNE_CONFIDENCE_THRESHOLD - 0.01 }),
    {},
  );
  assert.equal(policy.attachMcp, true);
  assert.match(policy.reason, /confidence/);
});

test("MCP attach policy: non-economy tiers attach fully", () => {
  for (const tier of ["balanced", "heavy"] as const) {
    const policy = resolveMcpAttachPolicy(route({ tier, confidence: 0.99 }), {});
    assert.equal(policy.attachMcp, true, tier);
  }
});

test("MCP attach policy: missing route decision attaches fully (fail-open)", () => {
  assert.equal(resolveMcpAttachPolicy(undefined, {}).attachMcp, true);
});

test("MCP attach policy: env kill-switch disables pruning", () => {
  process.env.ZCODE_SPEEDSTACK_PRUNE = "0";
  try {
    const policy = resolveMcpAttachPolicy(route({ tier: "economy", confidence: 0.99 }), {});
    assert.equal(policy.attachMcp, true);
    assert.match(policy.reason, /kill-switch/);
  } finally {
    delete process.env.ZCODE_SPEEDSTACK_PRUNE;
  }
});

test("MCP attach policy: config kill-switch disables pruning", () => {
  const policy = resolveMcpAttachPolicy(route({ tier: "economy", confidence: 0.99 }), {
    mcpPruning: false,
  });
  assert.equal(policy.attachMcp, true);
  assert.match(policy.reason, /kill-switch/);
});

test("MCP attach policy: env var set to 1 keeps pruning live", () => {
  process.env.ZCODE_SPEEDSTACK_PRUNE = "1";
  try {
    const policy = resolveMcpAttachPolicy(route({ tier: "economy", confidence: 0.99 }), {});
    assert.equal(policy.attachMcp, false);
  } finally {
    delete process.env.ZCODE_SPEEDSTACK_PRUNE;
  }
});

test("ZCODE_SYSTEMONE=0 disables route lookups (master kill-switch)", async () => {
  process.env.ZCODE_SYSTEMONE = "0";
  try {
    assert.equal(isSystemOneDisabled(), true);
    // Even a live endpoint is never contacted when the kill-switch is set.
    const decision = await fetchSystemOneRouteDecision("summarize this", {
      endpoint: "http://127.0.0.1:8765/v1/systemone/route",
      timeoutMs: 100,
    });
    assert.equal(decision, undefined);
  } finally {
    delete process.env.ZCODE_SYSTEMONE;
  }
});

test("ZCODE_SYSTEMONE unset keeps route lookups live", async () => {
  delete process.env.ZCODE_SYSTEMONE;
  assert.equal(isSystemOneDisabled(), false);
  // Guaranteed-dead port: fail-open still yields undefined, but the lookup
  // was attempted (no kill-switch short-circuit).
  const decision = await fetchSystemOneRouteDecision("summarize this", {
    endpoint: "http://127.0.0.1:9/v1/systemone/route",
    timeoutMs: 500,
  });
  assert.equal(decision, undefined);
});
