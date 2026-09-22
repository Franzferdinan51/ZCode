import assert from "node:assert/strict";
import test from "node:test";
import { filterModelOptions } from "../src/app-input.js";
import { fuzzyScoreText, highlightRangesForRowText, rankModelOptions } from "../src/model-fuzzy.js";
import type { TuiModelOption } from "../src/types.js";

function option(overrides: Partial<TuiModelOption> & { providerId: string; modelId: string }): TuiModelOption {
  const { providerId, modelId, ...rest } = overrides;
  return {
    ref: { providerId, modelId },
    label: modelId,
    providerLabel: providerId,
    ...rest,
  } as TuiModelOption;
}

test("fuzzyScoreText matches subsequences with merged ranges", () => {
  const match = fuzzyScoreText("grok-4-fast", "gk4");
  assert.ok(match);
  assert.ok(match.score > 0);
  assert.deepEqual(match.ranges, [
    { start: 0, end: 1 },
    { start: 3, end: 4 },
    { start: 5, end: 6 },
  ]);
  assert.equal(fuzzyScoreText("grok", "xyz"), null);
  assert.deepEqual(fuzzyScoreText("anything", "  "), { score: 0, ranges: [] });
});

test("substring matches outrank scattered subsequences", () => {
  const scattered = fuzzyScoreText("xaxbxc", "abc")!;
  const contiguous = fuzzyScoreText("xxabcxx", "abc")!;
  assert.ok(scattered && contiguous);
  assert.ok(contiguous.score > scattered.score);
});

test("word-boundary matches outrank mid-word matches", () => {
  const boundary = fuzzyScoreText("openai/gpt-5", "gpt")!;
  const midword = fuzzyScoreText("xxagpxt", "gpt")!;
  assert.ok(boundary && midword);
  assert.ok(boundary.score > midword.score);
});

test("rankModelOptions orders by score and keeps catalog order on ties", () => {
  const models = [
    option({ providerId: "x", modelId: "zzz-grok", label: "zzz-grok" }),
    option({ providerId: "xai", modelId: "grok-4", label: "Grok 4" }),
    option({ providerId: "x", modelId: "agrok", label: "agrok" }),
  ];
  const ranked = rankModelOptions(models, "grok");
  assert.deepEqual(
    ranked.map((entry) => entry.model.ref.modelId),
    // Start-of-string, then word-boundary, then mid-word.
    ["grok-4", "zzz-grok", "agrok"],
  );
});

test("rankModelOptions floats session recents to the top", () => {
  const models = [
    option({ providerId: "a", modelId: "alpha" }),
    option({ providerId: "b", modelId: "beta" }),
    option({ providerId: "c", modelId: "gamma" }),
  ];
  const ranked = rankModelOptions(models, "", ["b/beta"]);
  assert.deepEqual(
    ranked.map((entry) => entry.model.ref.modelId),
    ["beta", "alpha", "gamma"],
  );
});

test("rankModelOptions matches provider labels with lower weight", () => {
  const models = [
    option({ providerId: "p1", modelId: "m1", label: "m1", providerLabel: "Anthropic" }),
    option({ providerId: "x", modelId: "anthropic-helper", label: "anthropic-helper" }),
  ];
  const ranked = rankModelOptions(models, "anthropic");
  assert.equal(ranked[0]?.model.ref.modelId, "anthropic-helper");
  assert.equal(ranked.length, 2);
});

test("filterModelOptions keeps /model query semantics with fuzzy ranking", () => {
  const models = [
    option({ providerId: "xai", modelId: "grok-4-fast", label: "Grok 4 Fast" }),
    option({ providerId: "openai", modelId: "gpt-5", label: "GPT 5" }),
  ];
  assert.deepEqual(filterModelOptions("/model grok", models).map((m) => m.ref.modelId), [
    "grok-4-fast",
  ]);
  assert.deepEqual(filterModelOptions("/model g4f", models).map((m) => m.ref.modelId), [
    "grok-4-fast",
  ]);
  assert.equal(filterModelOptions("/model", models).length, 2);
  assert.deepEqual(filterModelOptions("/model list", models), []);
  assert.deepEqual(filterModelOptions("hello", models), []);
});

test("highlightRangesForRowText clips to the fitted row", () => {
  assert.deepEqual(highlightRangesForRowText("Grok 4 Fast", "g4f"), [
    { start: 0, end: 1 },
    { start: 5, end: 6 },
    { start: 7, end: 8 },
  ]);
  assert.deepEqual(highlightRangesForRowText("Grok", ""), []);
  assert.deepEqual(highlightRangesForRowText("Grok", "zzz"), []);
});
