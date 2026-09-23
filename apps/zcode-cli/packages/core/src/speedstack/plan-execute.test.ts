// Tests for speedstack/plan-execute.ts — node:test, no external deps.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExecutorPrompt,
  buildPlannerPrompt,
  readPlanArtifact,
  resolvePlanExecuteModels,
  writePlanArtifact,
} from "./plan-execute.ts";

const AVAILABLE = [
  "ornith-1.5-35b-a3b",
  "ornith-1.5-9b",
  "google/gemma-4-12b-qat",
  "text-embedding-nomic-embed-text-v1.5",
];

test("resolvePlanExecuteModels picks planner/executor from local list only", () => {
  const roles = resolvePlanExecuteModels(AVAILABLE);
  assert.equal(roles.plannerModelId, "ornith-1.5-35b-a3b");
  assert.equal(roles.executorModelId, "ornith-1.5-9b");
  assert.ok(!/embed/i.test(roles.plannerModelId));
  assert.ok(!/embed/i.test(roles.executorModelId));
});

test("resolvePlanExecuteModels uses one model for both roles when alone", () => {
  const roles = resolvePlanExecuteModels(["only-model"]);
  assert.equal(roles.plannerModelId, "only-model");
  assert.equal(roles.executorModelId, "only-model");
});

test("resolvePlanExecuteModels honors explicit prefs only when available", () => {
  const roles = resolvePlanExecuteModels(AVAILABLE, {
    plannerModelId: "google/gemma-4-12b-qat",
    executorModelId: "not-loaded-model",
  });
  assert.equal(roles.plannerModelId, "google/gemma-4-12b-qat");
  assert.equal(roles.executorModelId, "ornith-1.5-9b");
});

test("resolvePlanExecuteModels throws with no usable model", () => {
  assert.throws(
    () => resolvePlanExecuteModels(["text-embedding-nomic-embed-text-v1.5"]),
    /at least one locally available model/,
  );
  assert.throws(() => resolvePlanExecuteModels([]), /at least one/);
});

test("planner/executor prompts carry the task and plan", () => {
  const planner = buildPlannerPrompt("add retries");
  assert.ok(planner.includes("add retries"));
  assert.ok(planner.toLowerCase().includes("planner"));
  const executor = buildExecutorPrompt("# Plan\n1. step");
  assert.ok(executor.includes("# Plan"));
  assert.ok(executor.toLowerCase().includes("executor"));
});

test("plan artifact round-trips through the session dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-artifact-"));
  try {
    assert.equal(await readPlanArtifact(dir), undefined);
    const path = await writePlanArtifact(dir, "# Plan\n1. do it");
    assert.ok(path.endsWith("PLAN.md"));
    assert.equal(await readPlanArtifact(dir), "# Plan\n1. do it");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
