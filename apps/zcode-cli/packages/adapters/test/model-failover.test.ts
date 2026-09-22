import assert from "node:assert/strict";
import test from "node:test";
import type { Model, ModelEvent, ModelRequest, ModelResult } from "@zcode/contracts";
import {
  clearModelFailoverCooldowns,
  isFailoverableModelError,
  isModelFailoverCooledDown,
  MODEL_FAILOVER_MAX_SWAPS,
  withModelFailover,
} from "../src/model/model-failover.js";

function statusError(statusCode: number, message = `HTTP ${statusCode}`): Error {
  return Object.assign(new Error(message), { statusCode });
}

function stubModel(
  identity: { providerId: string; modelId: string },
  behavior: {
    generate?: (request: ModelRequest) => Promise<ModelResult>;
    stream?: (request: ModelRequest) => AsyncIterable<ModelEvent>;
  } = {},
): Model {
  const model: Model = {
    providerId: identity.providerId as Model["providerId"],
    modelId: identity.modelId as Model["modelId"],
    properties: {} as Model["properties"],
    optionSpecs: {} as Model["optionSpecs"],
    options: {},
    bind: (options) => stubModel(identity, { ...behavior, ...(options ? {} : {}) }),
    generateText: behavior.generate ?? (async () => ({ text: "ok", finishReason: "stop", usage: {} as ModelResult["usage"] })),
    streamText: behavior.stream ?? (async function* () {}),
  };
  return model;
}

function okResult(text: string): ModelResult {
  return { text, finishReason: "stop", usage: {} as ModelResult["usage"] };
}

const REQUEST: ModelRequest = { messages: [], options: { maxOutputTokens: 10 } };

test("isFailoverableModelError swaps transient 429/5xx, never auth/quota", () => {
  clearModelFailoverCooldowns();
  assert.equal(isFailoverableModelError(statusError(429)), true);
  assert.equal(isFailoverableModelError(statusError(500)), true);
  assert.equal(isFailoverableModelError(statusError(529)), true);
  assert.equal(isFailoverableModelError(statusError(503)), true);
  assert.equal(isFailoverableModelError(statusError(401)), false);
  assert.equal(isFailoverableModelError(statusError(403)), false);
  assert.equal(isFailoverableModelError(statusError(400)), false);
  assert.equal(isFailoverableModelError(new Error("plain failure")), false);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(isFailoverableModelError(statusError(429), aborted.signal), false);
});

test("generateText fails over to the next alternative on 429", async () => {
  clearModelFailoverCooldowns();
  const primary = stubModel(
    { providerId: "p", modelId: "a" },
    { generate: async () => { throw statusError(429); } },
  );
  const backup = stubModel(
    { providerId: "p", modelId: "b" },
    { generate: async () => okResult("from-backup") },
  );
  const seen: string[] = [];
  const wrapped = withModelFailover(
    primary,
    { resolveNext: () => backup },
    { onSwap: (info) => seen.push(`${info.from.modelId}->${info.to.modelId}`) },
  );
  const result = await wrapped.generateText(REQUEST);
  assert.equal(result.text, "from-backup");
  assert.deepEqual(seen, ["a->b"]);
  assert.equal(isModelFailoverCooledDown("p", "a"), true);
  assert.equal(isModelFailoverCooledDown("p", "b"), false);
});

test("generateText rethrows after the swap budget is spent", async () => {
  clearModelFailoverCooldowns();
  const failing = (id: string) =>
    stubModel(
      { providerId: "p", modelId: id },
      { generate: async () => { throw statusError(503); } },
    );
  let resolutions = 0;
  const wrapped = withModelFailover(failing("a"), {
    resolveNext: () => {
      resolutions += 1;
      return failing(`alt-${resolutions}`);
    },
  });
  await assert.rejects(wrapped.generateText(REQUEST), /HTTP 503/);
  assert.equal(resolutions, MODEL_FAILOVER_MAX_SWAPS);
});

test("streamText swaps before commit but never replays committed content", async () => {
  clearModelFailoverCooldowns();
  async function* failFast(): AsyncGenerator<ModelEvent> {
    yield { type: "start" };
    throw statusError(429);
  }
  async function* failCommitted(): AsyncGenerator<ModelEvent> {
    yield { type: "start" };
    yield { type: "text_delta", text: "partial" };
    throw statusError(429);
  }
  async function* backupStream(): AsyncGenerator<ModelEvent> {
    yield { type: "start" };
    yield { type: "text_delta", text: "backup-text" };
  }
  const backup = stubModel({ providerId: "p", modelId: "b" }, { stream: backupStream });

  // Pre-commit failure swaps transparently.
  const preCommit = stubModel({ providerId: "p", modelId: "a" }, { stream: failFast });
  let swaps = 0;
  const events: ModelEvent[] = [];
  for await (const event of withModelFailover(
    preCommit,
    { resolveNext: () => backup },
    { onSwap: () => { swaps += 1; } },
  ).streamText(REQUEST)) {
    events.push(event);
  }
  assert.equal(swaps, 1);
  assert.ok(events.some((event) => event.type === "text_delta" && event.text === "backup-text"));

  // Post-commit failure rethrows; the backup is never touched.
  const committed = stubModel({ providerId: "p", modelId: "c" }, { stream: failCommitted });
  let backupUsed = false;
  const wrapped = withModelFailover(committed, {
    resolveNext: () => {
      backupUsed = true;
      return backup;
    },
  });
  const seen: ModelEvent[] = [];
  await assert.rejects(
    (async () => {
      for await (const event of wrapped.streamText(REQUEST)) seen.push(event);
    })(),
    /HTTP 429/,
  );
  assert.equal(backupUsed, false);
  assert.ok(seen.some((event) => event.type === "text_delta" && event.text === "partial"));
});

test("failover can be disabled via ZCODE_MODEL_FAILOVER=0", async () => {
  clearModelFailoverCooldowns();
  const primary = stubModel(
    { providerId: "p", modelId: "a" },
    { generate: async () => { throw statusError(429); } },
  );
  const previous = process.env.ZCODE_MODEL_FAILOVER;
  process.env.ZCODE_MODEL_FAILOVER = "0";
  try {
    const wrapped = withModelFailover(primary, {
      resolveNext: () => stubModel({ providerId: "p", modelId: "b" }),
    });
    assert.equal(wrapped, primary);
  } finally {
    if (previous === undefined) delete process.env.ZCODE_MODEL_FAILOVER;
    else process.env.ZCODE_MODEL_FAILOVER = previous;
  }
});
