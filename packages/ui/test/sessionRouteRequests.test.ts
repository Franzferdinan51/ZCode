import assert from "node:assert/strict";
import test from "node:test";
import {
  requestSessionRoute,
  subscribeSessionRouteRequests,
  type SessionRouteRequest,
} from "../src/harness-router/sessionRouteRequests.js";

test("request reaches subscribers and reports handled", () => {
  const seen: SessionRouteRequest[] = [];
  const unsubscribe = subscribeSessionRouteRequests((request) => {
    seen.push(request);
  });
  try {
    const handled = requestSessionRoute({
      scopeId: "session-1",
      selection: { providerId: "lm-studio", modelId: "local-model" },
    });
    assert.equal(handled, true);
    assert.deepEqual(seen, [
      {
        scopeId: "session-1",
        selection: { providerId: "lm-studio", modelId: "local-model" },
      },
    ]);
  } finally {
    unsubscribe();
  }
});

test("request with no subscribers reports unhandled", () => {
  const handled = requestSessionRoute({
    scopeId: "nobody",
    selection: { providerId: "a", modelId: "b" },
  });
  assert.equal(handled, false);
});

test("unsubscribe stops delivery", () => {
  let calls = 0;
  const unsubscribe = subscribeSessionRouteRequests(() => {
    calls += 1;
  });
  unsubscribe();
  requestSessionRoute({
    scopeId: "s",
    selection: { providerId: "a", modelId: "b" },
  });
  assert.equal(calls, 0);
});
