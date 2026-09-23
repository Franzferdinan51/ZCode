import { SessionEventType } from "../deps.js";
import type { ModelToolCall, TraceContext } from "../deps.js";
import {
  buildRepeatedToolCallReminderBody,
  buildToolCallBudgetReminderBody,
  detectRepeatedToolCallWarnings,
  detectToolCallBudgetWarning,
} from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import {
  isAutomationMutationRestrictedTurn,
  isOffPeakCreateRestrictedTurn,
} from "./turn-loop-state.js";
import { systemReminderAttachmentEntry } from "../../agent/message-history.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";
import {
  buildDoomLoopFinalBody,
  buildDoomLoopNudgeBody,
  buildDoomLoopStrategyBody,
  detectDoomLoopTransitions,
  isDoomLoopDisabled,
  type DoomLoopObservation,
} from "../../speedstack/doom-loop.js";

export async function handleToolCallAnomalyWarnings(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    modelTraceContext: TraceContext;
    toolCalls: ModelToolCall[];
  },
): Promise<void> {
  const anomalyGuardConfig = {
    ...runtime.config.modelAnomalyGuard,
    // Z2: per-turn 80%-of-calls budget threshold. This arms the
    // disabled-by-default detector for the current turn only; the explicit
    // config value still wins when set.
    toolCallWarningThreshold:
      state.speedStackBudgetWarningThreshold ??
      runtime.config.modelAnomalyGuard?.toolCallWarningThreshold,
  };
  // Z2: one budget warn per turn — the loop-top enforcement
  // (turn-loop.ts) shares the speedStackBudgetWarned flag.
  // Rank 8: a doom-loop strategy-change nudge already warned the model more
  // forcefully — the generic 80% call-count warning is redundant then.
  const budgetWarning =
    state.speedStackBudgetWarned || state.doomLoopStrategyNudged === true
      ? undefined
      : detectToolCallBudgetWarning(
          state.toolCallCount,
          options.toolCalls.length,
          state,
          anomalyGuardConfig,
        );
  if (budgetWarning) {
    if (budgetWarning.warningInjected) {
      state.speedStackBudgetWarned = true;
      commitTurnRequestEntries(runtime, state.turnRequestState, [
        systemReminderAttachmentEntry(
          "model_anomaly",
          buildToolCallBudgetReminderBody(budgetWarning.observedCount),
        ),
      ]);
    }
    const warningEvent = runtime.createEvent(
      SessionEventType.ModelAnomalyWarning,
      {
        category: "tool_call_budget",
        severity: "warning",
        observedCount: budgetWarning.observedCount,
        threshold: budgetWarning.threshold,
        warningInjected: budgetWarning.warningInjected,
      },
      options.modelTraceContext,
    );
    await runtime.appendEvent(warningEvent, options.modelTraceContext);
    state.events.push(warningEvent);
  }

  // Rank 8: doom-loop fingerprint escalation (normalized near-duplicate
  // detection: nudge -> strategy change -> pause/redirect). Fail-open: any
  // error degrades to the legacy exact-repeat behavior below.
  let doomLoopHandledIds: ReadonlySet<string> | undefined;
  try {
    if (!isDoomLoopDisabled()) {
      doomLoopHandledIds = await handleDoomLoopEscalation(runtime, state, {
        modelTraceContext: options.modelTraceContext,
        toolCalls: options.toolCalls,
      });
    }
  } catch {
    doomLoopHandledIds = undefined;
  }

  const repeatedWarnings = detectRepeatedToolCallWarnings(
    options.toolCalls,
    state,
    runtime.config.modelAnomalyGuard,
  );
  for (const warning of repeatedWarnings) {
    // The doom-loop nudge already covered this call — skip the legacy
    // near-identical warning to avoid double-injecting.
    if (doomLoopHandledIds?.has(warning.toolCallId)) continue;
    if (warning.warningInjected) {
      commitTurnRequestEntries(runtime, state.turnRequestState, [
        systemReminderAttachmentEntry(
          "model_anomaly",
          buildRepeatedToolCallReminderBody(warning.toolName, warning.observedCount),
        ),
      ]);
    }
    const warningEvent = runtime.createEvent(
      SessionEventType.ModelAnomalyWarning,
      {
        category: "repeated_tool_call",
        severity: "warning",
        observedCount: warning.observedCount,
        threshold: warning.threshold,
        toolCallId: warning.toolCallId,
        toolName: warning.toolName,
        warningInjected: warning.warningInjected,
      },
      options.modelTraceContext,
    );
    await runtime.appendEvent(warningEvent, options.modelTraceContext);
    state.events.push(warningEvent);
  }
}

/** Tool names that count as edits for the ultra-tier verification pass. */
const VERIFICATION_EDIT_TOOL_NAMES = new Set(["ApplyPatch", "Edit", "Write"]);

/**
 * Rank 8: doom-loop fingerprint escalation.
 *
 * Runs the normalized-fingerprint detector over the completed tool calls and
 * injects the ladder reminders:
 *   - nudge at 3 similar calls,
 *   - forced strategy change (naming untried tools) at 4,
 *   - final at 5: interactive turns request a resumable pause at loop top;
 *     unattended (automation/off-peak) turns get one final redirect and a
 *     streak reset (one-shot; the turn budget still hard-stops a stuck turn).
 *
 * Never touches speedStackBudgetEscalated. Returns the tool call ids it
 * handled so the legacy exact-repeat warning can skip them.
 */
async function handleDoomLoopEscalation(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    modelTraceContext: TraceContext;
    toolCalls: ModelToolCall[];
  },
): Promise<Set<string>> {
  const handledIds = new Set<string>();
  const unattended =
    isAutomationMutationRestrictedTurn(state) || isOffPeakCreateRestrictedTurn(state);
  const pack = state.speedStackToolPack;
  const observations: DoomLoopObservation[] = detectDoomLoopTransitions(options.toolCalls, state, {
    packKeepNames: pack?.pruned === true ? pack.keepNames : undefined,
    sentToolNames: state.speedStackSentToolNames,
  });
  for (const observation of observations) {
    handledIds.add(observation.toolCallId);
    if (observation.kind === "strategy-change") {
      // Coordinate with the generic budget warning: the model already got
      // the stronger nudge, so the 80% call-count warning is suppressed.
      // This flag is separate from speedStackBudgetEscalated on purpose.
      state.doomLoopStrategyNudged = true;
    }
    if (observation.kind === "final") {
      if (unattended) {
        // One-shot redirect: reset the streak so the ladder does not
        // re-fire; the terminal stage (3) stays set.
        state.doomLoopFinalRedirectSent = true;
        state.doomLoopStreak = 1;
      } else {
        state.doomLoopPauseRequested = true;
        state.doomLoopPauseToolName = observation.toolName;
        state.doomLoopPauseStreak = observation.streak;
      }
    }
    const body =
      observation.kind === "nudge"
        ? buildDoomLoopNudgeBody(observation.toolName, observation.streak)
        : observation.kind === "strategy-change"
          ? buildDoomLoopStrategyBody(
              observation.toolName,
              observation.streak,
              observation.untriedTools,
            )
          : buildDoomLoopFinalBody(observation.toolName, observation.streak, unattended);
    commitTurnRequestEntries(runtime, state.turnRequestState, [
      systemReminderAttachmentEntry("model_anomaly", body),
    ]);
    const warningEvent = runtime.createEvent(
      SessionEventType.ModelAnomalyWarning,
      {
        category: "doom_loop",
        severity: observation.kind === "nudge" ? "warning" : "error",
        stage: observation.kind,
        observedCount: observation.streak,
        toolCallId: observation.toolCallId,
        toolName: observation.toolName,
        unattended,
        warningInjected: true,
      },
      options.modelTraceContext,
    );
    await runtime.appendEvent(warningEvent, options.modelTraceContext);
    state.events.push(warningEvent);
  }
  return handledIds;
}

/**
 * Z2: ultra/xhigh-tier review pass. After a tool batch that included file
 * edits, inject one verification reminder (once per turn) through the
 * existing anomaly-warning channel so the model re-reads what it changed
 * before continuing.
 */
export async function handleVerificationPassReminder(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: { toolCalls: ModelToolCall[]; modelTraceContext: TraceContext },
): Promise<void> {
  try {
    const policy = state.speedStackBehaviorPolicy;
    if (!policy || policy.verificationPasses <= 0 || state.speedStackVerificationReminderSent) {
      return;
    }
    const edited = options.toolCalls.some((call) =>
      VERIFICATION_EDIT_TOOL_NAMES.has(call.name ?? ""),
    );
    if (!edited) return;
    state.speedStackVerificationReminderSent = true;
    commitTurnRequestEntries(runtime, state.turnRequestState, [
      systemReminderAttachmentEntry(
        "model_anomaly",
        "Verification pass (ultra effort): you just made file edits. Before " +
          "continuing, re-read the edited files and confirm the changes are " +
          "correct and complete.",
      ),
    ]);
    const event = runtime.createEvent(
      SessionEventType.ModelAnomalyWarning,
      {
        category: "verification_pass",
        severity: "info",
        verificationPasses: policy.verificationPasses,
      },
      options.modelTraceContext,
    );
    await runtime.appendEvent(event, options.modelTraceContext);
    state.events.push(event);
  } catch {
    // Fail-open: a dropped reminder must not break the turn.
  }
}
