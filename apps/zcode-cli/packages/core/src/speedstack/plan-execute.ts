// ============================================================
// Speed Stack: plan-then-execute mode
// ============================================================
//
// A strong planner model produces a plan artifact (PLAN.md); a fast executor
// model implements the steps. Per-task toggle via
// SpeedStackSessionConfig.planThenExecute.
//
// LOCAL-ONLY model selection (Ryan's standing rule):
// - Role models are chosen ONLY from the locally available model list.
// - This module NEVER loads or unloads a model (pure selection).
// - If a single model is available, planner and executor both use it.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PLAN_ARTIFACT_FILENAME = "PLAN.md";

/** Planner default: Ryan's preferred local pick on the Mac mini. */
const DEFAULT_PLANNER_MODEL_PREFERENCES = ["ornith-1.5-35b-a3b"] as const;

/**
 * Executor defaults: smaller local models first (his "small/MoE first" rule).
 * Embedding models are always skipped for both roles.
 */
const DEFAULT_EXECUTOR_MODEL_PREFERENCES = [
  "ornith-1.5-9b",
  "ornith-1.5-9b-obliterated",
  "google/gemma-4-12b-qat",
  "google/gemma-4-e4b",
  "minicpm5-2b",
] as const;

const EMBEDDING_MODEL_ID_PATTERN = /embed/i;

export interface PlanExecuteModelPreferences {
  readonly plannerModelId?: string;
  readonly executorModelId?: string;
}

export interface PlanExecuteRoleModels {
  readonly plannerModelId: string;
  readonly executorModelId: string;
}

function isUsableModelId(modelId: string): boolean {
  return modelId.trim().length > 0 && !EMBEDDING_MODEL_ID_PATTERN.test(modelId);
}

function pickFromAvailable(
  available: readonly string[],
  preferences: readonly string[],
): string | undefined {
  const usable = available.filter(isUsableModelId);
  for (const preferred of preferences) {
    const match = usable.find((id) => id === preferred);
    if (match) return match;
  }
  return usable[0];
}

/**
 * Resolve planner/executor model ids from the LOCALLY AVAILABLE list.
 * Pure selection — never loads, unloads, or otherwise touches model state.
 * Explicit preferences win only when present in the available list.
 */
export function resolvePlanExecuteModels(
  availableModelIds: readonly string[],
  preferred: PlanExecuteModelPreferences = {},
): PlanExecuteRoleModels {
  const available = availableModelIds.filter((id) => typeof id === "string");
  const planner =
    (preferred.plannerModelId && available.includes(preferred.plannerModelId)
      ? preferred.plannerModelId
      : undefined) ??
    pickFromAvailable(available, DEFAULT_PLANNER_MODEL_PREFERENCES);
  if (!planner) {
    throw new Error("plan-then-execute needs at least one locally available model");
  }
  const executor =
    (preferred.executorModelId && available.includes(preferred.executorModelId)
      ? preferred.executorModelId
      : undefined) ??
    pickFromAvailable(available, DEFAULT_EXECUTOR_MODEL_PREFERENCES) ??
    planner;
  return { plannerModelId: planner, executorModelId: executor };
}

/** Prompt for the planner pass: produce an explicit step-by-step plan. */
export function buildPlannerPrompt(task: string): string {
  return [
    "You are the PLANNER in a plan-then-execute workflow.",
    "Produce a concrete, step-by-step implementation plan and nothing else.",
    "",
    "Rules:",
    "- One numbered step per action; each step names the files it touches.",
    "- Mark steps that can run in parallel with [parallel].",
    "- End the plan with a verification step (build + tests to run).",
    "- Do NOT write code in the plan; the executor implements it.",
    "",
    `Task: ${task}`,
  ].join("\n");
}

/** Prompt for the executor pass: implement the given plan step by step. */
export function buildExecutorPrompt(planMarkdown: string): string {
  return [
    "You are the EXECUTOR in a plan-then-execute workflow.",
    "Implement the plan below exactly, step by step.",
    "If a step is impossible as written, stop and explain why instead of improvising.",
    "",
    "Plan:",
    "```markdown",
    planMarkdown,
    "```",
  ].join("\n");
}

/** Persist the plan artifact (file-based state, Ralph-compatible). */
export async function writePlanArtifact(
  sessionDir: string,
  planMarkdown: string,
): Promise<string> {
  await mkdir(sessionDir, { recursive: true });
  const artifactPath = join(sessionDir, PLAN_ARTIFACT_FILENAME);
  await writeFile(artifactPath, planMarkdown, "utf8");
  return artifactPath;
}

/** Read the plan artifact back; undefined when absent. */
export async function readPlanArtifact(
  sessionDir: string,
): Promise<string | undefined> {
  try {
    return await readFile(join(sessionDir, PLAN_ARTIFACT_FILENAME), "utf8");
  } catch {
    return undefined;
  }
}
