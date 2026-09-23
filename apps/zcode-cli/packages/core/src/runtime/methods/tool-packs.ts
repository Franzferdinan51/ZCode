// ============================================================
// Speed Stack: label-driven per-task tool packs (Z1 runtime glue)
// ============================================================
//
// Turn-scoped application of the speedstack/tool-packs.ts policy:
//   1. computeTurnToolPackShortlist -- called in the turn loop after
//      initializeMcp, before request construction. Computes the per-task
//      shortlist, stores it on the turn state for miss detection, and
//      returns it so the caller can filter the provider-visible tools.
//      Suppression happens BEFORE request construction: the win is not
//      sending the schemas, not rejecting calls later.
//   2. detectTurnToolPackMissedCalls -- pure helper: which model-returned
//      calls hit this step's disallowlist (schema was not sent).
//   3. recoverTurnToolPackMiss -- one-shot fail-open recovery: mark the
//      turn for full-set requests, start any MCP servers the subset policy
//      pruned at startup, and leave a system reminder so the model retries
//      the missed calls with real schemas.
//
// Fail-open everywhere: any error here returns "send everything".

import { traceContextToLogContext } from "../deps.js";
import type { ModelToolContract } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { systemReminderAttachmentEntry } from "../../agent/message-history.js";
import {
  buildToolPackRecoveryReminderBody,
  computeToolShortlist,
  detectToolPackMissedCalls,
  type ToolShortlist,
} from "../../speedstack/tool-packs.js";
import { ensureToolPackPrunedMcpServersStarted } from "./mcp.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

/**
 * Compute the per-task tool shortlist for this model step and record it on
 * the turn state. Returns the shortlist; the caller filters
 * `options.tools` to `keepNames` when `pruned` is true.
 *
 * When a tool-miss already fired this turn (`speedStackFullToolRetry`), the
 * full set is returned so every remaining step sends complete schemas.
 */
export function computeTurnToolPackShortlist(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  tools: readonly ModelToolContract[],
): ToolShortlist {
  const traceContext = state.turnTraceContext;
  try {
    const shortlist = computeToolShortlist({
      route: this.systemOneRouteValue,
      config: this.speedStackConfig,
      taskText: this.systemOneRouteTaskText,
      tools,
      forceFullReason: state.speedStackFullToolRetry
        ? "tool-miss recovery: full tool set for the rest of this turn"
        : undefined,
      isMcpTool: (name) =>
        this.registry.getMetadata(name)?.mcpPresentation !== undefined,
      mcpServerOf: (name) =>
        this.registry.getMetadata(name)?.mcpPresentation?.serverName,
    });
    state.speedStackToolPack = shortlist.pruned ? shortlist : undefined;
    state.speedStackSentToolNames = shortlist.pruned
      ? tools.filter((tool) => shortlist.keepNames.has(tool.name)).map((tool) => tool.name)
      : undefined;
    this.logger?.info("Tool-pack shortlist computed", {
      ...traceContextToLogContext(traceContext),
      event: "speedstack.tool_pack.shortlist",
      module: "core.runtime",
      pruned: shortlist.pruned,
      labels: [...shortlist.labels],
      confidence: shortlist.confidence,
      tierScores: shortlist.tierScores,
      margin: shortlist.margin,
      reason: shortlist.reason,
      toolCountBefore: tools.length,
      toolCountAfter: shortlist.keepNames.size,
      schemaTokensBefore: shortlist.schemaTokensBefore,
      schemaTokensAfter: shortlist.schemaTokensAfter,
      schemaTokensSaved:
        shortlist.schemaTokensBefore - shortlist.schemaTokensAfter,
    });
    return shortlist;
  } catch (error) {
    // Fail open: never let telemetry/policy break the turn.
    this.logger?.warn("Tool-pack shortlist failed; sending full tool set", {
      ...traceContextToLogContext(traceContext),
      event: "speedstack.tool_pack.shortlist_failed",
      module: "core.runtime",
      error: error instanceof Error ? error.message : String(error),
    });
    state.speedStackToolPack = undefined;
    state.speedStackSentToolNames = undefined;
    return computeToolShortlist({ route: undefined, tools });
  }
}

/**
 * Which of the model's tool calls hit this step's tool-pack disallowlist --
 * i.e. the model called a tool whose schema was NOT sent. Empty when pruning
 * was inactive, when recovery already fired, or when nothing was missed.
 * Pure given the turn state.
 */
export function detectTurnToolPackMissedCalls(
  state: RegularTurnLoopState,
  toolCalls: readonly { readonly name: string }[],
): string[] {
  const pack = state.speedStackToolPack;
  if (!pack?.pruned || state.speedStackFullToolRetry) return [];
  const sent = (state.speedStackSentToolNames ?? []).map((name) => ({ name }));
  return detectToolPackMissedCalls(toolCalls, sent, pack.disallowedNames);
}

/**
 * One-shot fail-open recovery for a tool-pack miss. Marks the turn so all
 * remaining steps send the full tool set, starts any MCP servers the
 * subset policy pruned at startup, and leaves a system reminder so the
 * model retries the missed calls with real schemas on the next step.
 * Never throws.
 */
export async function recoverTurnToolPackMiss(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  missedToolNames: readonly string[],
): Promise<void> {
  if (state.speedStackFullToolRetry) return;
  state.speedStackFullToolRetry = true;
  const traceContext = state.turnTraceContext;
  this.logger?.warn("Tool-pack miss: failing open to the full tool set", {
    ...traceContextToLogContext(traceContext),
    event: "speedstack.tool_pack.miss",
    module: "core.runtime",
    missedToolNames: [...missedToolNames],
    labels: state.speedStackToolPack ? [...state.speedStackToolPack.labels] : [],
  });
  try {
    await ensureToolPackPrunedMcpServersStarted.call(this, traceContext);
  } catch (error) {
    // Fail open: schemas still go full even if MCP recovery hiccups.
    this.logger?.warn("Tool-pack MCP recovery failed (schemas still go full)", {
      ...traceContextToLogContext(traceContext),
      event: "speedstack.tool_pack.mcp_recovery_failed",
      module: "core.runtime",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    commitTurnRequestEntries(this, state.turnRequestState, [
      systemReminderAttachmentEntry(
        "model_anomaly",
        buildToolPackRecoveryReminderBody(missedToolNames),
      ),
    ]);
  } catch (error) {
    this.logger?.warn("Tool-pack recovery reminder failed", {
      ...traceContextToLogContext(traceContext),
      event: "speedstack.tool_pack.reminder_failed",
      module: "core.runtime",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
