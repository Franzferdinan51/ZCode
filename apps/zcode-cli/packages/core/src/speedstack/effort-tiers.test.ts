// Tests for speedstack/effort-tiers.ts — node:test, no external deps.
import test from "node:test";
import assert from "node:assert/strict";
import {
  effortTierToModelOptions,
  normalizeSpeedStackSessionConfig,
  parseEffortTier,
  resolveEffectiveEffortTier,
} from "./effort-tiers.ts";

const MODEL = {
  optionSpecs: {
    reasoningLevel: { values: ["low", "medium", "high"] },
    maxOutputTokens: { max: 32_000 },
  },
};

test("parseEffortTier accepts low/medium/high case-insensitively", () => {
  assert.equal(parseEffortTier("low"), "low");
  assert.equal(parseEffortTier("MEDIUM"), "medium");
  assert.equal(parseEffortTier(" High "), "high");
});

test("parseEffortTier fails open to undefined", () => {
  assert.equal(parseEffortTier("ultra"), undefined);
  assert.equal(parseEffortTier(""), undefined);
  assert.equal(parseEffortTier(undefined), undefined);
  assert.equal(parseEffortTier(42), undefined);
});

test("effortTierToModelOptions maps tiers onto the model's own specs", () => {
  assert.deepEqual(effortTierToModelOptions(MODEL, "low"), {
    reasoningLevel: "low",
    maxOutputTokens: 4_000,
  });
  assert.deepEqual(effortTierToModelOptions(MODEL, "medium"), {
    reasoningLevel: "medium",
    maxOutputTokens: 12_000,
  });
  assert.deepEqual(effortTierToModelOptions(MODEL, "high"), {
    reasoningLevel: "high",
    maxOutputTokens: 32_000,
  });
});

test("effortTierToModelOptions respects a smaller model max", () => {
  const small = {
    optionSpecs: {
      reasoningLevel: { values: ["off", "on"] },
      maxOutputTokens: { max: 2_000 },
    },
  };
  const options = effortTierToModelOptions(small, "high");
  assert.equal(options.maxOutputTokens, 2_000);
  assert.equal(options.reasoningLevel, "on");
  const medium = effortTierToModelOptions(small, "medium");
  assert.equal(medium.reasoningLevel, "on"); // middle of two values
});

test("resolveEffectiveEffortTier prefers explicit config over route hint", () => {
  assert.equal(resolveEffectiveEffortTier({ effortTier: "low" }, "high"), "low");
  assert.equal(resolveEffectiveEffortTier({}, "high"), "high");
  assert.equal(resolveEffectiveEffortTier(undefined, undefined), undefined);
});

test("normalizeSpeedStackSessionConfig keeps only valid fields", () => {
  const config = normalizeSpeedStackSessionConfig({
    effortTier: "HIGH",
    planThenExecute: true,
    mcpServerAllowlist: ["fs", "", 42],
    unknown: "dropped",
  });
  assert.deepEqual(config, {
    effortTier: "high",
    planThenExecute: true,
    mcpServerAllowlist: ["fs"],
  });
  assert.deepEqual(normalizeSpeedStackSessionConfig(null), {});
});
