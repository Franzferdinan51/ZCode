import {
  SESSION_ENTRY_MODEL_SELECTION,
  type Model,
  type ModelSelection,
  type TraceContext,
  type TurnInputIntentMetadata,
} from "@zcode/contracts";
import { getCurrentModelInvocationContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { createRuntimeModel, withModelInvocationContext } from "./runtime-model.js";
import { applyRuntimeExecutionState } from "../execution-state.js";
import {
  applySystemOneEffortOverride,
  resolveSystemOneModelTarget,
  type SystemOneRouteDecision,
} from "../../speedstack/systemone-route.js";
import { resolveThinkingTier } from "../../speedstack/effort-tiers.js";
import { extractRouteEffortHint } from "@zcode/shared/systemone-scorer";

export function createTurnModel(
  runtime: AgentRuntimeInternal,
  options: {
    selection?: ModelSelection;
    requestDependencies?: import("@zcode/contracts").ModelRequestDependencies;
  } = {},
): Model {
  const selection = options.selection ?? runtime.getSessionModelSelection();
  const model = createRuntimeModel(runtime, {
    selection,
    requestDependencies: options.requestDependencies,
  });
  // Z1: route-driven effort override (reasoningLevel + maxOutputTokens).
  // No-op until the session's route decision has settled (fail-open).
  const routedModel = applySystemOneEffortOverride(runtime, model, runtime.logger);
  return withModelInvocationContext(routedModel, (request) => ({
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
      abortSignal: request.abortSignal,
      model: routedModel,
      traceContext: getCurrentModelInvocationContext()?.traceContext ?? runtime.rootTraceContext,
    }),
  }));
}

/**
 * 在 Submission 真正开始执行或 Guide 被下一次 model step 消费时应用其执行配置。
 * 选择只决定新创建的 Model；已经被其他 Loop 持有的 Model 不会被修改。
 */
export async function applySubmissionExecutionState(
  runtime: AgentRuntimeInternal,
  intent: TurnInputIntentMetadata | undefined,
  traceContext: TraceContext,
  modelExecution?: import("../types.js").ModelExecutionContext,
  preparedModel?: Model,
): Promise<Model | undefined> {
  const selection = intent?.modelSelection;
  const previousSelection = runtime.getSessionModelSelection();
  let model = preparedModel;

  if (selection) {
    model ??= createTurnModel(runtime, {
      selection,
      requestDependencies: modelExecution?.requestDependencies,
    });
    // SystemOne Z0 owns the session model when model routing is on: the
    // composer's retained fallback selection must not clobber the routed
    // retarget applied earlier in the turn.
    const routeOwnsModel = intent?.speedStack?.modelRouting === true;
    if (modelExecution?.selectionScope !== "execution" && !routeOwnsModel) {
      const appliedSelection = cloneModelSelection(selection);
      runtime.setSessionModelSelection(appliedSelection);
      await persistRuntimeModelSelection(runtime, appliedSelection);
      if (!sameModelSelection(previousSelection, appliedSelection)) {
        await runtime.emitModelSelected({
          model,
          modelSelection: appliedSelection,
          effectiveReasoningLevel: model.options.reasoningLevel,
          previousModelSelection: previousSelection,
          supportedThoughtLevels: model.optionSpecs.reasoningLevel.values,
          traceContext,
        });
      }
    }
  }

  if (intent?.mode !== undefined || intent?.planEnabled !== undefined) {
    await applyRuntimeExecutionState(runtime, intent, { source: "command", traceContext });
  }

  return model;
}

/**
 * SystemOne Z0: per-task model routing ("Auto (SystemOne)").
 *
 * When the session config has modelRouting on and the route named a model
 * id, retarget the session selection in place for this task: clone the
 * current selection (keeps providerId/options), swap the model id, validate
 * the routed model resolves via the model factory, then commit + persist +
 * emit ModelSelected. Fully independent of the Z1 thinking wiring (which
 * runs later in createTurnModel): routing never forces a thinking change
 * and a pinned/off thinking mode never blocks the retarget.
 *
 * Fail-open: any failure (no route, routing off, unknown model id) keeps
 * the current model and returns no retarget.
 */
export async function applySystemOneModelRetarget(
  runtime: AgentRuntimeInternal,
  route: SystemOneRouteDecision | undefined,
  baseSelection: ModelSelection | undefined,
  traceContext: TraceContext,
): Promise<{ retargetedModelId?: string; selection?: ModelSelection }> {
  try {
    const targetModelId = resolveSystemOneModelTarget({
      route,
      modelRouting: runtime.speedStackConfig?.modelRouting,
      currentModelId: baseSelection?.modelId,
    });
    if (!targetModelId || !baseSelection) return {};
    const previousSelection = runtime.getSessionModelSelection();
    const appliedSelection: ModelSelection = {
      ...cloneModelSelection(baseSelection),
      modelId: targetModelId,
    };
    // Validate the routed model resolves before committing: an unknown
    // model id must not wedge the session.
    const model = createRuntimeModel(runtime, { selection: appliedSelection });
    runtime.setSessionModelSelection(appliedSelection);
    await persistRuntimeModelSelection(runtime, appliedSelection);
    // Applied effort for this turn (same precedence Z1 uses): off, a pinned
    // tier, or the route's effort hint. Shown per-response in the UI chip.
    const appliedThinking = resolveThinkingTier({
      thinkingMode: runtime.speedStackConfig?.thinkingMode,
      explicitTier: runtime.speedStackConfig?.effortTier,
      routeHint: extractRouteEffortHint(route),
    });
    const appliedEffort =
      appliedThinking?.kind === "tier"
        ? appliedThinking.tier
        : (appliedThinking?.kind ?? "medium");
    const retargeted = !sameModelSelection(previousSelection, appliedSelection);
    // Emit on every routed turn (not only on model change) so the v4
    // snapshot's systemOneLastRouting stays fresh for the per-response chip.
    // Same-model emits produce no config delta (see product-projection).
    await runtime.emitModelSelected({
      model,
      modelSelection: appliedSelection,
      effectiveReasoningLevel: model.options.reasoningLevel,
      previousModelSelection: retargeted ? previousSelection : undefined,
      supportedThoughtLevels: model.optionSpecs.reasoningLevel.values,
      systemOneRouting: route
        ? {
            tier: route.tier,
            effort: appliedEffort,
            confidence: route.confidence,
            retargeted,
          }
        : undefined,
      traceContext,
    });
    runtime.logger?.info("SystemOne model retarget applied", {
      event: "systemone.model.retargeted",
      fromModelId: previousSelection?.modelId,
      modelId: targetModelId,
      module: "core.runtime",
      tier: route?.tier,
    });
    return { retargetedModelId: targetModelId, selection: appliedSelection };
  } catch (error) {
    runtime.logger?.warn("SystemOne model retarget failed; keeping current model", {
      error: error instanceof Error ? error.message : String(error),
      event: "systemone.model.retarget_failed",
      module: "core.runtime",
    });
    return {};
  }
}

export function sameModelSelection(
  left: ModelSelection | undefined,
  right: ModelSelection,
): boolean {
  return (
    left?.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel
  );
}

export async function persistRuntimeModelSelection(
  runtime: AgentRuntimeInternal,
  selection: ModelSelection,
): Promise<void> {
  if (!runtime.sessionStore?.saveSessionEntry) return;
  const timestamp = Date.now();
  try {
    await runtime.sessionStore.saveSessionEntry({
      id: `${runtime.sessionId}:runtime-model-selection`,
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      data: selection,
    });
  } catch (error) {
    runtime.logger?.warn("Session model selection persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.model_selection.persist_failed",
      modelId: selection.modelId,
      module: "core.runtime",
      providerId: selection.providerId,
      status: "failed",
      thoughtLevel: selection.options?.reasoningLevel,
    });
  }
}
