// Tests for speedstack wire schema + protocol-v4 carriage (3.24.0). node:test, no deps.
import test from "node:test";
import assert from "node:assert/strict";
import {
  speedStackWireConfigSchema,
  type SpeedStackWireConfig,
} from "./speedstack-wire.ts";
import { commandPayloadSchemas } from "./zcode-protocol-v4/command.ts";
import { conversationInputIntentSchema } from "./zcode-protocol-v4/input-intent.ts";

test("wire schema is tolerant: accepts raw knob values, strips unknowns", () => {
  const parsed = speedStackWireConfigSchema.parse({
    effortTier: "XHIGH",
    modelRouting: true,
    thinkingMode: "Auto",
    mcpPruning: false,
    planThenExecute: true,
    mcpServerAllowlist: ["fs"],
    mcpToolAllowlist: ["fs.read"],
    unknown: "dropped",
  } as SpeedStackWireConfig);
  assert.deepEqual(parsed, {
    effortTier: "XHIGH",
    modelRouting: true,
    thinkingMode: "Auto",
    mcpPruning: false,
    planThenExecute: true,
    mcpServerAllowlist: ["fs"],
    mcpToolAllowlist: ["fs.read"],
  });
  // Strict normalization (case-folding, enum checks) happens in core's
  // normalizeSpeedStackSessionConfig, not on the wire — older clients must
  // never break the protocol parse.
  assert.deepEqual(speedStackWireConfigSchema.parse({}), {});
});

test("sendText payload schema accepts speedStack", () => {
  const schema = commandPayloadSchemas.sendText;
  const payload = schema.parse({
    text: "hi",
    speedStack: { modelRouting: true, thinkingMode: "auto" },
  });
  assert.deepEqual(payload.speedStack, { modelRouting: true, thinkingMode: "auto" });
  // Absent = 3.23 behavior.
  assert.equal(schema.parse({ text: "hi" }).speedStack, undefined);
});

test("conversationInputIntentSchema accepts optional speedStack", () => {
  const base = {
    sourceCommandId: "c1",
    queueItemId: "q1",
    clientId: "cli",
    kind: "sendText",
    text: "hi",
    attachments: [],
    delivery: { requested: "startNow", admitted: "startNow" },
    order: { admissionSeq: 0 },
    steer: { state: "notRequested" },
    dispatch: { state: "admitted" },
    admittedAt: Date.now(),
  };
  const withKnobs = conversationInputIntentSchema.parse({
    ...base,
    speedStack: { modelRouting: true, thinkingMode: "off" },
  });
  assert.deepEqual(withKnobs.speedStack, { modelRouting: true, thinkingMode: "off" });
  const without = conversationInputIntentSchema.parse(base);
  assert.equal(without.speedStack, undefined);
});
