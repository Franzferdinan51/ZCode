// Tests for speedstack/turn-budgets.ts (config-driven per-tier budgets).
// Run: tsx --test src/speedstack/turn-budgets.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkBudgetHit,
  describeTurnBudgets,
  parseBudgetValue,
  resolveTurnBudgets,
} from "./turn-budgets.js";

function envOf(values: Record<string, string>): NodeJS.ProcessEnv {
  return { ...values };
}

describe("parseBudgetValue", () => {
  it("accepts positive integers", () => {
    assert.equal(parseBudgetValue("25"), 25);
    assert.equal(parseBudgetValue("  150 "), 150);
  });
  it("fails open on garbage, zero, negatives, undefined", () => {
    assert.equal(parseBudgetValue(undefined), undefined);
    assert.equal(parseBudgetValue(""), undefined);
    assert.equal(parseBudgetValue("0"), undefined);
    assert.equal(parseBudgetValue("-5"), undefined);
    assert.equal(parseBudgetValue("12.5"), undefined);
    assert.equal(parseBudgetValue("many"), undefined);
  });
});

describe("resolveTurnBudgets", () => {
  it("returns {} when nothing is configured (unbounded: today's behavior)", () => {
    assert.deepEqual(resolveTurnBudgets("economy", envOf({})), {});
    assert.deepEqual(resolveTurnBudgets(undefined, envOf({})), {});
  });
  it("reads tier-specific vars", () => {
    const budgets = resolveTurnBudgets(
      "economy",
      envOf({
        ZCODE_BUDGET_ECONOMY_MAX_STEPS: "25",
        ZCODE_BUDGET_ECONOMY_MAX_TOOL_CALLS: "60",
      }),
    );
    assert.deepEqual(budgets, { maxSteps: 25, maxToolCalls: 60 });
  });
  it("tier matching is case-insensitive", () => {
    const budgets = resolveTurnBudgets(
      "Balanced",
      envOf({ ZCODE_BUDGET_BALANCED_MAX_STEPS: "40" }),
    );
    assert.deepEqual(budgets, { maxSteps: 40 });
  });
  it("falls back to DEFAULT vars for unknown tiers and missing tier", () => {
    const env = envOf({
      ZCODE_BUDGET_DEFAULT_MAX_STEPS: "50",
      ZCODE_BUDGET_DEFAULT_MAX_TOOL_CALLS: "120",
    });
    assert.deepEqual(resolveTurnBudgets("xhigh", env), {
      maxSteps: 50,
      maxToolCalls: 120,
    });
    assert.deepEqual(resolveTurnBudgets(undefined, env), {
      maxSteps: 50,
      maxToolCalls: 120,
    });
  });
  it("tier-specific wins over default; partial config merges", () => {
    const budgets = resolveTurnBudgets(
      "heavy",
      envOf({
        ZCODE_BUDGET_HEAVY_MAX_STEPS: "80",
        ZCODE_BUDGET_DEFAULT_MAX_TOOL_CALLS: "200",
      }),
    );
    assert.deepEqual(budgets, { maxSteps: 80, maxToolCalls: 200 });
  });
  it("garbage values fail open to unbounded, not to zero", () => {
    const budgets = resolveTurnBudgets(
      "economy",
      envOf({
        ZCODE_BUDGET_ECONOMY_MAX_STEPS: "banana",
        ZCODE_BUDGET_ECONOMY_MAX_TOOL_CALLS: "0",
      }),
    );
    assert.deepEqual(budgets, {});
  });
});

describe("checkBudgetHit", () => {
  it("hits when usage reaches a configured cap", () => {
    assert.deepEqual(
      checkBudgetHit({ steps: 25, toolCalls: 10 }, { maxSteps: 25 }),
      { stepsHit: true, toolCallsHit: false, anyHit: true },
    );
    assert.deepEqual(
      checkBudgetHit(
        { steps: 3, toolCalls: 60 },
        { maxSteps: 25, maxToolCalls: 60 },
      ),
      { stepsHit: false, toolCallsHit: true, anyHit: true },
    );
  });
  it("no hit below caps; unconfigured caps never hit", () => {
    assert.deepEqual(checkBudgetHit({ steps: 24, toolCalls: 59 }, { maxSteps: 25, maxToolCalls: 60 }), {
      stepsHit: false,
      toolCallsHit: false,
      anyHit: false,
    });
    assert.deepEqual(checkBudgetHit({ steps: 10_000, toolCalls: 10_000 }, {}), {
      stepsHit: false,
      toolCallsHit: false,
      anyHit: false,
    });
  });
});

describe("describeTurnBudgets", () => {
  it("renders a one-liner", () => {
    assert.equal(
      describeTurnBudgets("economy", { maxSteps: 25, maxToolCalls: 60 }),
      "tier=economy maxSteps=25 maxToolCalls=60",
    );
    assert.equal(describeTurnBudgets(undefined, {}), "tier=none maxSteps=unbounded maxToolCalls=unbounded");
  });
});
