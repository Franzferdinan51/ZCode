/**
 * In-place model failover (hermes-agent fallback-chain port, execution half).
 *
 * The auto-router already computes ranked `alternatives` (data half); this
 * module performs the swap: when a terminal model failure is a transient
 * provider-side 429/overloaded/5xx, the next available alternative model is
 * tried instead of surfacing a hard stall. Hermes
 * `agent/chat_completion_helpers.py:try_activate_fallback` + `fallback_cooldown.py`.
 *
 * Safety gates (all must hold for a swap):
 * - failure classifies as rate_limited / provider_overloaded / server_error
 *   AND retryable (quota/billing terminal codes are retryable:false, so a
 *   drained account never burns through sibling models);
 * - the failed model is put on cooldown (5 min) and skipped while cooling;
 * - streams swap only before any content event (text/reasoning/tool/finish)
 *   is yielded — after commit the original error is rethrown, never replayed;
 * - at most 2 swaps per call; `ZCODE_MODEL_FAILOVER=0` disables entirely.
 */

import {
  ModelFailureReason,
  type Model,
  type ModelEvent,
  type ModelRequest,
  type ModelResult,
} from "@zcode/contracts";
import { classifyModelFailure } from "./failure-classifier.js";

const FAILOVERABLE_REASONS: ReadonlySet<string> = new Set([
  ModelFailureReason.RateLimited,
  ModelFailureReason.ProviderOverloaded,
  ModelFailureReason.ServerError,
]);

export const MODEL_FAILOVER_COOLDOWN_MS = 5 * 60_000;
export const MODEL_FAILOVER_MAX_SWAPS = 2;

/** Content-carrying stream events: once yielded, failover must not replay. */
const COMMITTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "text_start",
  "text_delta",
  "text_end",
  "reasoning_start",
  "reasoning_delta",
  "reasoning_end",
  "tool_input_start",
  "tool_input_delta",
  "tool_input_end",
  "tool_call",
  "finish",
]);

const cooldownUntilByModel = new Map<string, number>();

export function modelFailoverKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

export function noteModelFailoverFailure(
  providerId: string,
  modelId: string,
  now: number = Date.now(),
): void {
  cooldownUntilByModel.set(
    modelFailoverKey(providerId, modelId),
    now + MODEL_FAILOVER_COOLDOWN_MS,
  );
}

export function isModelFailoverCooledDown(
  providerId: string,
  modelId: string,
  now: number = Date.now(),
): boolean {
  const until = cooldownUntilByModel.get(modelFailoverKey(providerId, modelId));
  if (until === undefined) return false;
  if (until <= now) {
    cooldownUntilByModel.delete(modelFailoverKey(providerId, modelId));
    return false;
  }
  return true;
}

/** Test/shutdown hook: drop all failover cooldowns. */
export function clearModelFailoverCooldowns(): void {
  cooldownUntilByModel.clear();
}

export function isFailoverableModelError(error: unknown, abortSignal?: AbortSignal): boolean {
  if (abortSignal?.aborted) return false;
  const failure = classifyModelFailure(error, abortSignal);
  return failure.retryable === true && FAILOVERABLE_REASONS.has(failure.reason);
}

export function isFailoverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ZCODE_MODEL_FAILOVER !== "0";
}

export interface ModelFailoverResolver {
  /**
   * Next alternative for a failed model (already skipping cooled-down
   * entries), or null when the chain is spent. May throw to abort failover.
   */
  resolveNext(failed: { providerId: string; modelId: string }): Model | null;
}

export interface ModelFailoverOptions {
  maxSwaps?: number;
  now?: () => number;
  onSwap?: (info: {
    from: { providerId: string; modelId: string };
    to: { providerId: string; modelId: string };
    reason: string;
  }) => void;
}

function failoverKeyOf(model: Model): { providerId: string; modelId: string } {
  return { providerId: String(model.providerId), modelId: String(model.modelId) };
}

/**
 * Wrap a Model so transient provider-side failures (429/overloaded/5xx)
 * transparently retry on the next resolver alternative. Identity fields
 * (`providerId`/`modelId`/...) always describe the primary; swaps are
 * reported via `onSwap` for telemetry.
 */
export function withModelFailover(
  primary: Model,
  resolver: ModelFailoverResolver,
  options: ModelFailoverOptions = {},
): Model {
  if (!isFailoverEnabled()) return primary;
  const maxSwaps = options.maxSwaps ?? MODEL_FAILOVER_MAX_SWAPS;
  const now = options.now ?? Date.now;

  const attemptGenerate = async (
    model: Model,
    request: ModelRequest,
    swapsUsed: number,
  ): Promise<ModelResult> => {
    try {
      return await model.generateText(request);
    } catch (error) {
      const failed = failoverKeyOf(model);
      noteModelFailoverFailure(failed.providerId, failed.modelId, now());
      if (swapsUsed >= maxSwaps || !isFailoverableModelError(error, request.abortSignal)) {
        throw error;
      }
      const next = resolver.resolveNext(failed);
      if (!next) throw error;
      const to = failoverKeyOf(next);
      options.onSwap?.({ from: failed, to, reason: "generate" });
      return attemptGenerate(next, request, swapsUsed + 1);
    }
  };

  const attemptStream = async function* (
    model: Model,
    request: ModelRequest,
    swapsUsed: number,
  ): AsyncGenerator<ModelEvent> {
    let committed = false;
    let iterator: AsyncIterator<ModelEvent>;
    try {
      const iterable = model.streamText(request);
      iterator = iterable[Symbol.asyncIterator]();
    } catch (error) {
      const swapped = await swapOrThrow(model, request, swapsUsed, error);
      yield* attemptStream(swapped, request, swapsUsed + 1);
      return;
    }
    while (true) {
      let step: IteratorResult<ModelEvent>;
      try {
        step = await iterator.next();
      } catch (error) {
        if (committed) throw error;
        const swapped = await swapOrThrow(model, request, swapsUsed, error);
        yield* attemptStream(swapped, request, swapsUsed + 1);
        return;
      }
      if (step.done) return;
      if (COMMITTED_EVENT_TYPES.has(step.value.type)) committed = true;
      yield step.value;
    }
  };

  const swapOrThrow = async (
    model: Model,
    request: ModelRequest,
    swapsUsed: number,
    error: unknown,
  ): Promise<Model> => {
    const failed = failoverKeyOf(model);
    noteModelFailoverFailure(failed.providerId, failed.modelId, now());
    if (swapsUsed >= maxSwaps || !isFailoverableModelError(error, request.abortSignal)) {
      throw error;
    }
    const next = resolver.resolveNext(failed);
    if (!next) throw error;
    const to = failoverKeyOf(next);
    options.onSwap?.({ from: failed, to, reason: "stream" });
    return next;
  };

  const wrap = (model: Model): Model => ({
    providerId: primary.providerId,
    modelId: primary.modelId,
    displayName: primary.displayName,
    properties: primary.properties,
    optionSpecs: primary.optionSpecs,
    options: model.options,
    bind: (bindOptions) => wrap(model.bind(bindOptions)),
    generateText: (request) => attemptGenerate(model, request, 0),
    streamText: (request) => ({
      [Symbol.asyncIterator]: () => attemptStream(model, request, 0),
    }),
  });
  return wrap(primary);
}
