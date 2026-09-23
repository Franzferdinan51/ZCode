// Tests for the soft-then-hard budget enforcement state machine
// (speedstack/budget-enforcement.ts).
// Run: tsx --test src/speedstack/budget-enforcement.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUDGET_ENFORCE_KILL_SWITCH_ENV,
  buildBudgetEscalationBody,
  buildBudgetExhaustedBody,
  buildBudgetWarnBody,
  evaluateBudgetEnforcement,
  isBudgetEnforcementDisabled,
} from "./budget-enforcement.js";

function envOf(values: Record<string, string>): NodeJS.ProcessEnv {
  return { ...values };
}

describe("evaluateBudgetEnforcement", () => {
  it("stays ok below 80% of every cap", () => {
    assert.equal(
      evaluateBudgetEnforcement(
        { steps: 31, toolCalls: 79 },
        { maxSteps: 40, maxToolCalls: 100 },
        { warned: false, escalated: false },
      ),
      "ok",
    );
  });

  it("warns once at 80% of either cap, then stays ok while warned", () => {
    const budgets = { maxSteps: 40, maxToolCalls: 100 };
    assert.equal(
      evaluateBudgetEnforcement({ steps: 32, toolCalls: 10 }, budgets, {
        warned: false,
        escalated: false,
      }),
      "warn",
    );
    assert.equal(
      evaluateBudgetEnforcement({ steps: 10, toolCalls: 80 }, budgets, {
        warned: false,
        escalated: false,
      }),
      "warn",
    );
    // No second warn for the same turn.
    assert.equal(
      evaluateBudgetEnforcement({ steps: 39, toolCalls: 99 }, budgets, {
        warned: true,
        escalated: false,
      }),
      "ok",
    );
  });

  it("escalates at 100%, then stops after the escalation step", () => {
    const budgets = { maxSteps: 40, maxToolCalls: 100 };
    assert.equal(
      evaluateBudgetEnforcement({ steps: 40, toolCalls: 5 }, budgets, {
        warned: true,
        escalated: false,
      }),
      "escalate",
    );
    assert.equal(
      evaluateBudgetEnforcement({ steps: 41, toolCalls: 5 }, budgets, {
        warned: true,
        escalated: true,
      }),
      "stop",
    );
  });

  it("jumps straight from ok to escalate when usage leaps past the cap", () => {
    assert.equal(
      evaluateBudgetEnforcement({ steps: 200, toolCalls: 1 }, { maxSteps: 40 }, {
        warned: false,
        escalated: false,
      }),
      "escalate",
    );
  });

  it("never triggers on unconfigured caps", () => {
    assert.equal(
      evaluateBudgetEnforcement(
        { steps: 10_000, toolCalls: 50_000 },
        {},
        { warned: false, escalated: false },
      ),
      "ok",
    );
  });

  it("uses ceil for the 80% boundary (40 steps warns at 32)", () => {
    assert.equal(
      evaluateBudgetEnforcement({ steps: 31, toolCalls: 0 }, { maxSteps: 40 }, {
        warned: false,
        escalated: false,
      }),
      "ok",
    );
    assert.equal(
      evaluateBudgetEnforcement({ steps: 32, toolCalls: 0 }, { maxSteps: 40 }, {
        warned: false,
        escalated: false,
      }),
      "warn",
    );
  });
});

describe("budget message bodies", () => {
  const ctx = { steps: 32, toolCalls: 80, maxSteps: 40, maxToolCalls: 100, tier: "medium" };

  it("warn body names the caps and steers to wrap up", () => {
    const body = buildBudgetWarnBody(ctx);
    assert.match(body, /80%/);
    assert.match(body, /32\/40/);
    assert.match(body, /80\/100/);
  });

  it("escalation body demands a strategy change with one step left", () => {
    const body = buildBudgetEscalationBody(ctx);
    assert.match(body, /CHANGE STRATEGY/);
    assert.match(body, /exactly one more model step/);
  });

  it("exhausted body states the stop and the explicit resume path", () => {
    const body = buildBudgetExhaustedBody(ctx);
    assert.match(body, /Stopped: turn budget exhausted/);
    assert.match(body, /resumable/);
    assert.match(body, /continue/);
    assert.match(body, /ZCODE_BUDGET_<TIER>_MAX_STEPS/);
  });
});

describe("isBudgetEnforcementDisabled", () => {
  it("reads the kill switch, fails open", () => {
    assert.equal(
      isBudgetEnforcementDisabled(envOf({ [BUDGET_ENFORCE_KILL_SWITCH_ENV]: "0" })),
      true,
    );
    assert.equal(isBudgetEnforcementDisabled(envOf({})), false);
  });
});
