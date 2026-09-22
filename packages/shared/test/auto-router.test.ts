import assert from "node:assert/strict";
import test from "node:test";
import {
  candidatesFromSelectionView,
  suggestRoute,
  type AutoRouteCandidate,
  type AutoRouteSelectionViewLike,
} from "../src/auto-router.js";

function candidate(overrides: Partial<AutoRouteCandidate> = {}): AutoRouteCandidate {
  return {
    providerId: "p",
    modelId: "m",
    order: 0,
    enabled: true,
    accessType: "api-key",
    consentGranted: false,
    contextWindow: 200_000,
    supportsImage: false,
    supportsVideo: false,
    supportsAudio: false,
    supportsPdf: false,
    supportsToolCall: true,
    supportsJsonSchemaOutput: false,
    ...overrides,
  };
}

test("code task prefers the tool-capable model", () => {
  const plain = candidate({ providerId: "a", modelId: "chat", order: 0, supportsToolCall: false });
  const coder = candidate({ providerId: "b", modelId: "code", order: 1, supportsToolCall: true });
  const suggestion = suggestRoute([plain, coder], {
    textSample: "Fix the crash in src/app.ts:\n```\nTypeError: x is undefined\n```",
  });
  assert.equal(suggestion?.providerId, "b");
  assert.equal(suggestion?.modelId, "code");
  assert.equal(suggestion?.confidence, "high");
  assert.ok((suggestion?.reasons.length ?? 0) > 0);
});

test("image attachment filters to vision-capable models", () => {
  const blind = candidate({ providerId: "a", modelId: "text", order: 0 });
  const seeing = candidate({
    providerId: "b",
    modelId: "vision",
    order: 1,
    supportsImage: true,
  });
  const suggestion = suggestRoute([blind, seeing], {
    textSample: "what is in this screenshot",
    attachmentKinds: ["image"],
  });
  assert.deepEqual(
    [suggestion?.providerId, suggestion?.modelId],
    ["b", "vision"],
  );
});

test("harness without consent is never suggested", () => {
  const harness = candidate({
    providerId: "external:codex",
    modelId: "external-codex",
    order: 0,
    accessType: "external-harness",
    consentGranted: false,
    supportsToolCall: false,
  });
  const suggestion = suggestRoute([harness], { textSample: "fix it" });
  assert.equal(suggestion, null);
});

test("consented harness stays eligible but deprioritized", () => {
  const harness = candidate({
    providerId: "external:codex",
    modelId: "external-codex",
    order: 0,
    accessType: "external-harness",
    consentGranted: true,
    supportsToolCall: false,
  });
  const local = candidate({ providerId: "a", modelId: "chat", order: 1 });
  const suggestion = suggestRoute([harness, local], {
    textSample: "fix the bug in main.ts",
  });
  assert.equal(suggestion?.providerId, "a");
});

test("plain chat with no signal yields no suggestion", () => {
  const a = candidate({ providerId: "a", modelId: "one", order: 0 });
  const b = candidate({ providerId: "b", modelId: "two", order: 1 });
  assert.equal(suggestRoute([a, b], { textSample: "hello there" }), null);
  assert.equal(suggestRoute([a, b]), null);
});

test("context fit drops models that cannot hold the input", () => {
  const small = candidate({ providerId: "a", modelId: "small", order: 0, contextWindow: 8000 });
  const big = candidate({ providerId: "b", modelId: "big", order: 1, contextWindow: 200_000 });
  const suggestion = suggestRoute([small, big], {
    textSample: "summarize this",
    approxInputChars: 100_000,
  });
  assert.equal(suggestion?.modelId, "big");
});

test("custom scorer plugs in as the classifier tier", () => {
  const a = candidate({ providerId: "a", modelId: "one", order: 0 });
  const b = candidate({ providerId: "b", modelId: "two", order: 1 });
  const suggestion = suggestRoute([a, b], { textSample: "hi" }, (list) =>
    list.map((entry) => ({
      candidate: entry,
      score: entry.modelId === "two" ? 5 : 1,
      reasons: ["classifier vote"],
    })),
  );
  assert.equal(suggestion?.modelId, "two");
  assert.deepEqual(suggestion?.reasons, ["classifier vote"]);
});

test("suggestion carries ranked fallback alternatives", () => {
  const a = candidate({ providerId: "a", modelId: "one", order: 0 });
  const b = candidate({ providerId: "b", modelId: "two", order: 1 });
  const c = candidate({ providerId: "c", modelId: "three", order: 2 });
  const suggestion = suggestRoute([a, b, c], { textSample: "hi" }, (list) =>
    list.map((entry) => ({
      candidate: entry,
      score: entry.modelId === "one" ? 5 : entry.modelId === "two" ? 3 : 1,
      reasons: ["voted"],
    })),
  );
  assert.deepEqual(
    suggestion?.alternatives.map((alt) => [alt.modelId, alt.score]),
    [
      ["two", 3],
      ["three", 1],
    ],
  );
  const lone = suggestRoute([a], { textSample: "hi" }, (list) =>
    list.map((entry) => ({ candidate: entry, score: 4, reasons: [] })),
  );
  assert.deepEqual(lone?.alternatives, []);
});

test("candidatesFromSelectionView projects order, consent, and capabilities", () => {
  const view = {
    providers: [
      {
        providerId: "external:codex",
        config: {
          access: { type: "external-harness", consentGranted: true },
        },
        models: [
          {
            modelId: "external-codex",
            config: {
              enabled: true,
              properties: {
                contextWindow: 128_000,
                inputFormat: { supportsImage: false },
                supportsToolCall: false,
              },
            },
          },
        ],
      },
      {
        providerId: "hidden-p",
        config: { visibility: "hidden" },
        models: [{ modelId: "x", config: { enabled: true } }],
      },
    ],
  } satisfies AutoRouteSelectionViewLike;
  const candidates = candidatesFromSelectionView(view);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], {
    providerId: "external:codex",
    modelId: "external-codex",
    order: 0,
    enabled: true,
    accessType: "external-harness",
    consentGranted: true,
    contextWindow: 128_000,
    supportsImage: false,
    supportsVideo: false,
    supportsAudio: false,
    supportsPdf: false,
    supportsToolCall: false,
    supportsJsonSchemaOutput: false,
  });
});
