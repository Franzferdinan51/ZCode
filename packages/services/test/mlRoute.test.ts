import assert from "node:assert/strict";
import test from "node:test";
import type { AutoRouteCandidate, AutoRouteSignals } from "@zcode/shared/auto-router";
import type { MlRouteBackendConfig } from "@zcode/shared/systemone-scorer";
import { suggestMlRoute } from "../src/routing/mlRouteService.js";
import { disposeMlRouteSidecars, queryMlRouteBackend } from "../src/routing/mlRouteSidecar.js";

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

const backend: MlRouteBackendConfig = { backend: "custom", endpoint: "http://127.0.0.1:1/v1/x" };
const signals: AutoRouteSignals = { textSample: "Fix the crash in src/app.ts" };

test("suggestMlRoute re-ranks heuristic survivors with ML probabilities", async () => {
  const candidates = [
    candidate({ providerId: "a", modelId: "chat", order: 0, supportsToolCall: false }),
    candidate({ providerId: "b", modelId: "code", order: 1, supportsToolCall: true }),
  ];
  const seen: string[] = [];
  const response = await suggestMlRoute(
    { candidates, signals, backend },
    {
      queryBackend: async (request) => {
        seen.push(JSON.stringify(request.questions[0].criteria));
        return {
          answers: [{ choice: "B", probabilities: { A: 0.15, B: 0.85 }, confidence: 0.85 }],
        };
      },
      onAgreement: (info) => seen.push(`agree=${info.agree}`),
    },
  );
  assert.equal(response.reason, "ok");
  assert.equal(response.suggestion?.providerId, "b");
  assert.equal(response.suggestion?.modelId, "code");
  assert.equal(response.agreement?.mlPick, "b/code");
  // Both survivors were offered as single-letter aliases.
  assert.match(seen[0], /"id":"A"/);
  assert.match(seen[0], /"id":"B"/);
});

test("suggestMlRoute fails open on backend errors and bad payloads", async () => {
  const candidates = [
    candidate({ providerId: "a", modelId: "chat", order: 0 }),
    candidate({ providerId: "b", modelId: "code", order: 1 }),
  ];
  const throwing = await suggestMlRoute(
    { candidates, signals, backend },
    {
      queryBackend: async () => {
        throw new Error("boom");
      },
    },
  );
  assert.equal(throwing.reason, "backend-error");
  assert.equal(throwing.suggestion, null);

  const invalid = await suggestMlRoute(
    { candidates, signals, backend },
    { queryBackend: async () => ({ answers: [{ choice: "Z" }] }) },
  );
  assert.equal(invalid.reason, "invalid-response");
  assert.equal(invalid.suggestion, null);

  const weak = await suggestMlRoute(
    { candidates, signals, backend: { ...backend, minWinnerProbability: 0.99 } },
    {
      queryBackend: async () => ({
        answers: [{ choice: "B", probabilities: { A: 0.2, B: 0.8 }, confidence: 0.8 }],
      }),
    },
  );
  assert.equal(weak.reason, "low-confidence");
  assert.equal(weak.suggestion, null);
});

test("suggestMlRoute reports degenerate candidate sets without calling the backend", async () => {
  let calls = 0;
  const solo = await suggestMlRoute(
    { candidates: [candidate()], signals, backend },
    {
      queryBackend: async () => {
        calls += 1;
        return {};
      },
    },
  );
  assert.equal(solo.reason, "no-survivors");
  assert.equal(calls, 0);
});

test("queryMlRouteBackend rejects non-loopback endpoints", async () => {
  await assert.rejects(
    queryMlRouteBackend(
      {
        state: "hi",
        questions: [{ id: "route", type: "choice", instructions: "x", criteria: [] }],
      },
      { backend: "custom", endpoint: "http://192.168.1.2:8079/v1/systemone" },
    ),
    /loopback/,
  );
});

test("queryMlRouteBackend speaks NDJSON to a stdio bridge process", async () => {
  // Fake bridge: ready handshake, then always pick the last alias.
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "console.log(JSON.stringify({ ready: true }));",
    "rl.on('line', (line) => {",
    "  const req = JSON.parse(line);",
    "  const ids = req.questions[0].criteria.map((c) => c.id);",
    "  const probs = {};",
    "  ids.forEach((id, i) => { probs[id] = i === ids.length - 1 ? 0.9 : 0.1 / (ids.length - 1 || 1); });",
    "  console.log(JSON.stringify({ answers: [{ choice: ids[ids.length - 1], probabilities: probs, confidence: 0.9 }] }));",
    "});",
  ].join("\n");
  try {
    const raw = await queryMlRouteBackend(
      {
        state: "hi",
        questions: [
          {
            id: "route",
            type: "choice",
            instructions: "pick",
            criteria: [
              { id: "A", description: "a/m" },
              { id: "B", description: "b/m" },
            ],
          },
        ],
      },
      { backend: "custom", command: [process.execPath, "-e", script], timeoutMs: 10_000 },
    );
    assert.deepEqual(raw, {
      answers: [{ choice: "B", probabilities: { A: 0.1, B: 0.9 }, confidence: 0.9 }],
    });
    // Second call reuses the persistent process.
    const again = await queryMlRouteBackend(
      {
        state: "hi",
        questions: [
          {
            id: "route",
            type: "choice",
            instructions: "pick",
            criteria: [{ id: "A", description: "a/m" }],
          },
        ],
      },
      { backend: "custom", command: [process.execPath, "-e", script], timeoutMs: 10_000 },
    );
    assert.deepEqual((again as { answers: Array<{ choice: string }> }).answers[0].choice, "A");
  } finally {
    disposeMlRouteSidecars();
  }
});
