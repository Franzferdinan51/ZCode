/**
 * Effort-aware subagent spawning guidance tests (Rank 10).
 *
 * Pure logic: no runtime, no model. Run with
 * `npx tsx --test src/speedstack/subagent-guidance.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSubagentPolicyReminderBody,
  isExplicitSubagentRequestInTexts,
  isExplicitSubagentRequestText,
  shouldHideSubagentDispatchTools,
  shouldInjectSubagentGuidanceReminder,
  SUBAGENT_SPAWN_OVERHEAD_TOKENS,
} from "./subagent-guidance.ts";
import type { EffortBehaviorPolicy } from "./effort-tiers.ts";

function policyWith(subagents: "never" | "conservative" | "parallel"): EffortBehaviorPolicy {
  return { subagents } as EffortBehaviorPolicy;
}

test("isExplicitSubagentRequestText: direct phrasings match", () => {
  for (const text of [
    "use a subagent to research this",
    "Use a subagent for the migration",
    "spawn an agent to investigate",
    "launch two subagents in parallel",
    "delegate the docs rewrite to a subagent",
    "have an agent handle the log analysis",
    "get a subagent to look into this",
  ]) {
    assert.equal(isExplicitSubagentRequestText(text), true, text);
  }
});

test("isExplicitSubagentRequestText: negations and bare mentions do not match", () => {
  for (const text of [
    "don't use a subagent for this",
    "do not spawn agents here",
    "no subagents — do it inline",
    "never use a subagent",
    "subagents are too expensive for this",
    "the subagent finished",
    "",
    undefined,
  ]) {
    assert.equal(isExplicitSubagentRequestText(text), false, String(text));
  }
});

test("buildSubagentPolicyReminderBody: undefined policy and never allowance -> undefined", () => {
  assert.equal(buildSubagentPolicyReminderBody(undefined), undefined);
  assert.equal(buildSubagentPolicyReminderBody(policyWith("never")), undefined);
});

test("buildSubagentPolicyReminderBody: conservative prefers parallel tool calls", () => {
  const body = buildSubagentPolicyReminderBody(policyWith("conservative"));
  assert.ok(body, "expected a reminder body");
  assert.match(body, /parallel tool calls/i);
  assert.match(body, /broad, independent investigations/i);
  assert.match(body, new RegExp(SUBAGENT_SPAWN_OVERHEAD_TOKENS.replace("-", "\\-")));
  assert.match(body, /explicitly asked/i);
});

test("buildSubagentPolicyReminderBody: parallel allows fan-out, still prefers inline", () => {
  const body = buildSubagentPolicyReminderBody(policyWith("parallel"));
  assert.ok(body, "expected a reminder body");
  assert.match(body, /fan out/i);
  assert.match(body, /parallel tool calls/i);
  assert.match(body, /explicitly asked/i);
});

test("buildSubagentPolicyReminderBody: never throws on garbage", () => {
  assert.equal(buildSubagentPolicyReminderBody({} as EffortBehaviorPolicy), undefined);
});

test("isExplicitSubagentRequestInTexts: true when any text matches", () => {
  assert.equal(
    isExplicitSubagentRequestInTexts(["refactor this", "use a subagent to dig in"]),
    true,
  );
  assert.equal(
    isExplicitSubagentRequestInTexts(["multi-part", undefined, null, "spawn an agent"]),
    true,
  );
});

test("isExplicitSubagentRequestInTexts: false when none match or input is empty", () => {
  assert.equal(
    isExplicitSubagentRequestInTexts(["refactor this", "subagents are expensive"]),
    false,
  );
  assert.equal(isExplicitSubagentRequestInTexts([]), false);
  assert.equal(isExplicitSubagentRequestInTexts(undefined), false);
  // A negation in one text does not veto a real request in another — the
  // negation guard applies per text inside isExplicitSubagentRequestText.
  assert.equal(
    isExplicitSubagentRequestInTexts(["don't use a subagent", "spawn an agent now"]),
    true,
  );
});

test("shouldHideSubagentDispatchTools: explicit request always wins over effort-tier gating", () => {
  const never = policyWith("never");
  // Low/off policy, no explicit request: the hide applies.
  assert.equal(
    shouldHideSubagentDispatchTools({ policy: never, explicitUserRequest: false }),
    true,
  );
  // Same policy, explicit user request: the hide is lifted.
  assert.equal(
    shouldHideSubagentDispatchTools({ policy: never, explicitUserRequest: true }),
    false,
  );
  // Permissive tiers never hide, with or without a request.
  for (const subagents of ["conservative", "parallel"] as const) {
    assert.equal(
      shouldHideSubagentDispatchTools({ policy: policyWith(subagents), explicitUserRequest: false }),
      false,
      subagents,
    );
    assert.equal(
      shouldHideSubagentDispatchTools({ policy: policyWith(subagents), explicitUserRequest: true }),
      false,
      subagents,
    );
  }
  // Unresolved policy fails open: hide nothing.
  assert.equal(
    shouldHideSubagentDispatchTools({ policy: undefined, explicitUserRequest: false }),
    false,
  );
});

function injectionInput(
  overrides: Partial<{
    policy: EffortBehaviorPolicy | undefined;
    agentToolVisible: boolean;
    modelStepCount: number;
    alreadyReminded: boolean;
    outputTokenRecoveryActive: boolean;
  }> = {},
) {
  return {
    policy: policyWith("conservative"),
    agentToolVisible: true,
    modelStepCount: 0,
    alreadyReminded: false,
    outputTokenRecoveryActive: false,
    ...overrides,
  };
}

test("shouldInjectSubagentGuidanceReminder: fires once, on step 0, when the tool is visible", () => {
  assert.equal(shouldInjectSubagentGuidanceReminder(injectionInput()), true);
  assert.equal(shouldInjectSubagentGuidanceReminder(injectionInput({ policy: policyWith("parallel") })), true);
});

test("shouldInjectSubagentGuidanceReminder: suppressed when nothing to guide", () => {
  // Low/off hides the dispatch tools: no reminder (body is undefined anyway).
  assert.equal(
    shouldInjectSubagentGuidanceReminder(injectionInput({ policy: policyWith("never") })),
    false,
  );
  // No policy: fail-open, no injection.
  assert.equal(
    shouldInjectSubagentGuidanceReminder(injectionInput({ policy: undefined })),
    false,
  );
  // Agent tool pruned by the tool pack: guidance would be noise.
  assert.equal(
    shouldInjectSubagentGuidanceReminder(injectionInput({ agentToolVisible: false })),
    false,
  );
});

test("shouldInjectSubagentGuidanceReminder: one-shot and context-gated", () => {
  assert.equal(
    shouldInjectSubagentGuidanceReminder(injectionInput({ alreadyReminded: true })),
    false,
  );
  assert.equal(
    shouldInjectSubagentGuidanceReminder(injectionInput({ modelStepCount: 1 })),
    false,
  );
  assert.equal(
    shouldInjectSubagentGuidanceReminder(injectionInput({ outputTokenRecoveryActive: true })),
    false,
  );
});
