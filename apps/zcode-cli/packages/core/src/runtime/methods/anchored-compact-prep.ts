// ============================================================
// Speed Stack Rank 4: anchored-compaction prep for live compaction
// ============================================================
//
// Bridges speedstack/anchored-compaction.ts into the runtime:
//   - converts RuntimeMessageEntry lists to anchor source messages,
//   - archives the pre-compact transcript + extracts anchors (fail-open),
//   - builds the anchored summary instructions,
//   - notes boundary-compact events from completed tool calls.
//
// The archival layer is file-based: any failure logs and returns
// undefined / no-ops so the normal compaction path always survives.

import { homedir } from "node:os";

import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  archiveSessionTranscriptWithAnchors,
  combineAnchoredInstructions,
  detectBoundaryEventFromToolCall,
  isAnchoredCompactionEnabled,
  resolveAnchoredArchiveDir,
  resolveArchiveKeepCount,
  type AnchoredArchiveResult,
  type AnchorSourceMessage,
  type BoundaryCompactEventKind,
} from "../../speedstack/anchored-compaction.js";
import type { ToolExecutionResult } from "../../tool/types.js";
import type { TraceContext } from "../deps.js";
import { traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

/**
 * Flatten a runtime entry to plain text for anchor extraction.
 * Defensive: skips unknown shapes instead of throwing.
 */
export function runtimeEntriesToAnchorMessages(
  entries: readonly RuntimeMessageEntry[],
): AnchorSourceMessage[] {
  const messages: AnchorSourceMessage[] = [];
  for (const entry of entries) {
    try {
      if (!entry) continue;
      if (entry.kind === "attachment") {
        const text = entry.content;
        if (typeof text === "string" && text.trim().length > 0) {
          messages.push({ role: "system", text });
        }
        continue;
      }
      const message = (entry as { message?: unknown }).message as
        | { role?: unknown; content?: unknown }
        | undefined;
      if (!message) continue;
      const text = flattenModelMessageContent(message.content);
      if (text.trim().length > 0) {
        messages.push({ role: String(message.role ?? "unknown"), text });
      }
    } catch {
      // skip unconvertible entries — anchoring is best-effort
    }
  }
  return messages;
}

function flattenModelMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const text = (part as Record<string, unknown>)["text"];
        return typeof text === "string" ? text : "";
      })
      .filter((text) => text.length > 0)
      .join("\n");
  }
  return "";
}

export interface AnchoredCompactionPrep {
  /** Effective summary instructions: custom + anchored prompt. */
  readonly instructions: string;
  readonly archivePath: string;
  readonly anchors: AnchoredArchiveResult["anchors"];
}

/**
 * Archive the transcript, extract anchors, and build the anchored summary
 * instructions for the live summarizer. Fail-open: returns undefined and the
 * caller keeps the normal compact path.
 */
export async function prepareAnchoredCompaction(
  runtime: AgentRuntimeInternal,
  input: {
    sessionId: string;
    entries: readonly RuntimeMessageEntry[];
    customInstructions: string | undefined;
    traceContext: TraceContext;
  },
): Promise<AnchoredCompactionPrep | undefined> {
  try {
    if (!isAnchoredCompactionEnabled()) return undefined;
    const messages = runtimeEntriesToAnchorMessages(input.entries);
    if (messages.length === 0) return undefined;
    const { archivePath, anchors } = await archiveSessionTranscriptWithAnchors(
      resolveAnchoredArchiveDir(homedir()),
      input.sessionId,
      messages,
      resolveArchiveKeepCount(),
    );
    runtime.logger?.info("Anchored compaction prepared", {
      ...traceContextToLogContext(input.traceContext),
      event: "compact.anchored.prepared",
      module: "core.runtime",
      archivePath,
      anchorDecisions: anchors.decisions.length,
      anchorFilePaths: anchors.filePaths.length,
      anchorErrors: anchors.errors.length,
      anchorTodoState: anchors.todoState.length,
    });
    return {
      instructions: combineAnchoredInstructions(
        input.customInstructions,
        anchors,
      ),
      archivePath,
      anchors,
    };
  } catch (error) {
    runtime.logger?.warn(
      "Anchored compaction prep failed; continuing without anchors",
      {
        ...traceContextToLogContext(input.traceContext),
        event: "compact.anchored.failed",
        module: "core.runtime",
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return undefined;
  }
}

/**
 * Archive the pre-compact transcript after a microcompact, so the raw
 * history stays recoverable on disk. Fail-open: never throws.
 */
export async function archivePreCompactTranscript(
  runtime: AgentRuntimeInternal,
  input: {
    sessionId: string;
    entries: readonly RuntimeMessageEntry[];
    traceContext: TraceContext;
    reason: string;
  },
): Promise<void> {
  try {
    if (!isAnchoredCompactionEnabled()) return;
    const messages = runtimeEntriesToAnchorMessages(input.entries);
    if (messages.length === 0) return;
    const { archivePath } = await archiveSessionTranscriptWithAnchors(
      resolveAnchoredArchiveDir(homedir()),
      input.sessionId,
      messages,
      resolveArchiveKeepCount(),
    );
    runtime.logger?.info("Pre-compact transcript archived", {
      ...traceContextToLogContext(input.traceContext),
      event: "compact.anchored.archived",
      module: "core.runtime",
      archivePath,
      reason: input.reason,
    });
  } catch (error) {
    runtime.logger?.warn("Pre-compact archive failed; continuing", {
      ...traceContextToLogContext(input.traceContext),
      event: "compact.anchored.archive_failed",
      module: "core.runtime",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    const serialized = JSON.stringify(output);
    return typeof serialized === "string" ? serialized : "";
  } catch {
    return "";
  }
}

/**
 * Scan completed tool results for boundary-compact events
 * (tests-passed / subtask-verified) and record the first one on the
 * runtime for the loop's boundary-compact check. One-shot per turn:
 * the loop clears it after the check. Never throws.
 */
export function noteSpeedStackBoundaryEvents(
  runtime: AgentRuntimeInternal,
  _state: RegularTurnLoopState,
  results: readonly ToolExecutionResult[],
  toolInputs: Map<string, Record<string, unknown>>,
): void {
  try {
    if (!isAnchoredCompactionEnabled()) return;
    if (runtime.speedStackPendingBoundaryEvent) return;
    for (const result of results) {
      const kind = detectBoundaryEventFromToolCall(
        result.toolName,
        toolInputs.get(result.toolCallId),
        result.serialization?.content ?? stringifyToolOutput(result.output),
        result.success,
      );
      if (kind) {
        runtime.speedStackPendingBoundaryEvent = kind;
        runtime.logger?.info("Speed Stack boundary event noted", {
          event: "speedstack.boundary_event",
          module: "core.runtime",
          kind: kind satisfies BoundaryCompactEventKind,
          toolName: result.toolName,
          outcome: "noted",
        });
        return;
      }
    }
  } catch {
    // fail-open: boundary detection must never break tool execution
  }
}
