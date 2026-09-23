// Tests for speedstack/plan-execute-gate.ts — node:test, no external deps.
//
// The gate is pure: given route signals + config + env, decide plan vs
// direct. Strict-signal ordering: kill switch > explicit config > effort
// policy/heavy tier > risky labels > multi-file signals > direct.
import test from "node:test";
import assert from "node:assert/strict";
import {
  decidePlanThenExecute,
  PLAN_EXECUTE_MULTI_FILE_THRESHOLD,
  PLAN_EXECUTE_SIGNAL_CONFIDENCE_FLOOR,
} from "./plan-execute-gate.ts";
import { getEffortBehaviorPolicy } from "./effort-tiers.ts";

test("kill switch wins over every other signal", () => {
  const decision = decidePlanThenExecute({
    explicitConfig: true,
    policy: getEffortBehaviorPolicy("xhigh"),
    routeTier: "heavy",
    routeConfidence: 0.99,
    taskLabels: ["risky"],
    taskText: "refactor packages/a.ts packages/b.ts packages/c.ts",
    env: { ZCODE_PLAN_EXECUTE: "0" },
  });
  assert.equal(decision.plan, false);
  assert.equal(decision.reason, "kill-switch");
});

test("explicit config pins the outcome", () => {
  assert.equal(
    decidePlanThenExecute({ explicitConfig: true }).reason,
    "config-on",
  );
  assert.equal(
    decidePlanThenExecute({ explicitConfig: false }).reason,
    "config-off",
  );
  assert.equal(
    decidePlanThenExecute({ explicitConfig: true }).plan,
    true,
  );
  assert.equal(
    decidePlanThenExecute({ explicitConfig: false }).plan,
    false,
  );
});

test("xhigh+ effort policy plans", () => {
  const decision = decidePlanThenExecute({
    policy: getEffortBehaviorPolicy("xhigh"),
    taskText: "something",
  });
  assert.equal(decision.plan, true);
  assert.equal(decision.reason, "effort-policy-or-heavy-tier");
});

test("heavy route tier plans even without a policy", () => {
  const decision = decidePlanThenExecute({
    routeTier: "heavy",
    routeConfidence: 0.7,
    taskText: "something",
  });
  assert.equal(decision.plan, true);
  assert.equal(decision.reason, "effort-policy-or-heavy-tier");
});

test("risky labels plan above the confidence floor", () => {
  const plan = decidePlanThenExecute({
    routeTier: "balanced",
    routeConfidence: PLAN_EXECUTE_SIGNAL_CONFIDENCE_FLOOR,
    taskLabels: ["ambiguous"],
    taskText: "something",
  });
  assert.equal(plan.plan, true);
  assert.equal(plan.reason, "risky-labels");

  const direct = decidePlanThenExecute({
    routeTier: "balanced",
    routeConfidence: PLAN_EXECUTE_SIGNAL_CONFIDENCE_FLOOR - 0.01,
    taskLabels: ["ambiguous"],
    taskText: "something",
  });
  assert.equal(direct.plan, false);
  assert.equal(direct.reason, "direct");
});

test("multi-file signals plan above the confidence floor", () => {
  const plan = decidePlanThenExecute({
    routeTier: "balanced",
    routeConfidence: 0.9,
    taskLabels: [],
    taskText:
      "Edit src/a.ts, src/b.ts and src/c.ts to add the new flag.",
  });
  assert.equal(plan.plan, true);
  assert.equal(plan.reason, "multi-file-signals");
});

test("fewer than the file threshold stays direct", () => {
  const decision = decidePlanThenExecute({
    routeTier: "balanced",
    routeConfidence: 0.9,
    taskLabels: [],
    taskText: "Fix the typo in src/a.ts.",
  });
  assert.equal(decision.plan, false);
  assert.equal(decision.reason, "direct");
});

test("explicit multi-file language plans", () => {
  const decision = decidePlanThenExecute({
    routeTier: "balanced",
    routeConfidence: 0.9,
    taskText: "This is a multi-file refactor of the auth module.",
  });
  assert.equal(decision.plan, true);
});

test("simple tasks with no route stay direct", () => {
  assert.equal(decidePlanThenExecute({ taskText: "what time is it" }).plan, false);
  assert.equal(decidePlanThenExecute({}).plan, false);
});

test("gate never throws on junk input (fail-open to direct)", () => {
  assert.doesNotThrow(() =>
    decidePlanThenExecute({
      routeConfidence: Number.NaN,
      taskLabels: [undefined as never],
      taskText: undefined,
      policy: null as never,
      env: null as never,
    }),
  );
});

test("multi-file threshold constant is sane", () => {
  assert.ok(PLAN_EXECUTE_MULTI_FILE_THRESHOLD >= 2);
  assert.ok(
    PLAN_EXECUTE_SIGNAL_CONFIDENCE_FLOOR > 0 &&
      PLAN_EXECUTE_SIGNAL_CONFIDENCE_FLOOR <= 1,
  );
});
