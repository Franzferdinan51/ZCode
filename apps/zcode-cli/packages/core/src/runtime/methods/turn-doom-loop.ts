// ============================================================
// Rank 8: doom-loop interactive pause at loop top
// ============================================================
//
// Split out of turn-loop.ts to keep that file under the repo's
// max-lines lint budget.

import { createMessageId, SessionEventType, TurnMachineImpl } from "../deps.js";
import { buildDoomLoopPauseBody } from "../../speedstack/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

/**
 * Rank 8: doom-loop interactive final stage. When the detector requested a
 * pause, complete the turn with a resumable message (mirroring the budget
 * hard-stop pattern). One-shot: the flag is cleared before completing.
 * Unattended turns never set the flag — they get the final redirect
 * reminder instead and keep looping under the normal budget enforcement.
 */
export async function checkDoomLoopPause(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<"continue" | "stop"> {
  if (state.doomLoopPauseRequested !== true) return "continue";
  state.doomLoopPauseRequested = false;
  const toolName = state.doomLoopPauseToolName ?? "a tool";
  const streak = state.doomLoopPauseStreak ?? 0;
  const body = buildDoomLoopPauseBody(toolName, streak);
  state.modelResponse = body;
  if (state.activeTurn) {
    state.activeTurn.steerable = false;
  }
  state.stableProductStartMessageId = state.currentUserMessageId;
  state.stableBoundaryAssistantMessageId = createMessageId();
  const pauseEvent = runtime.createEvent(
    SessionEventType.ModelAnomalyWarning,
    {
      category: "doom_loop",
      severity: "info",
      stage: "pause",
      observedCount: streak,
      toolName,
      warningInjected: false,
    },
    state.turnTraceContext,
  );
  await runtime.appendEvent(pauseEvent, state.turnTraceContext);
  state.events.push(pauseEvent);
  state.turnMachine = new TurnMachineImpl(state.turnMachine.complete(body, "success"));
  return "stop";
}
