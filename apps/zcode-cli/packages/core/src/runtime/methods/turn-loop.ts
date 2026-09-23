/* eslint-disable max-lines -- grown past 400 lines by the 3.25.0 speed-stack wiring (Rank 10 guidance, budgets, tool packs, doom-loop); splitting the turn loop risks behavior drift at ship time. */
import { beginLocalTurnPreparation } from "@zcode/contracts";
import {
  CompactPhase,
  CompactReason,
  createMessageId,
  SessionEventType,
  traceContextToLogContext,
  TurnMachineImpl,
} from "../deps.js";
import { AGENT_TOOL_NAME, TASK_TOOL_NAME } from "../../tool/compat.js";
import {
  BUDGET_WARN_FRACTION,
  buildBudgetEscalationBody,
  buildBudgetExhaustedBody,
  buildBudgetWarnBody,
  evaluateBudgetEnforcement,
  isBudgetEnforcementDisabled,
  buildSubagentPolicyReminderBody,
  isExplicitSubagentRequestInTexts,
  shouldHideSubagentDispatchTools,
  shouldInjectSubagentGuidanceReminder,
  resolvePlannerBudgets,
  resolveSystemOneBehaviorPolicy,
  type BudgetMessageContext,
} from "../../speedstack/index.js";
import {
  buildRuntimeModeReminderBody,
  buildPlanModeExitReminderBody,
  buildRuntimeOutputStyleReminderBody,
  buildTodoReminderBody,
  buildRuntimeProviderRequestMessages,
  createCompactRapidRefillError,
  throwIfTurnAborted,
  shouldBuildTodoReminder,
} from "../helpers/index.js";
import {
  systemReminderAttachmentEntry,
  todoReminderRuntimeMetadata,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { runModelBackedTurnStep } from "./turn-model-step.js";
import { checkDoomLoopPause } from "./turn-doom-loop.js";
import { computeTurnToolPackShortlist } from "./tool-packs.js";
import {
  AUTOMATION_MUTATION_TOOL_NAMES,
  evaluateRapidRefill,
  isAutomationMutationRestrictedTurn,
  isOffPeakCreateRestrictedTurn,
  MAX_CONSECUTIVE_RAPID_REFILLS,
  OFF_PEAK_MUTATION_TOOL_NAMES,
  RAPID_REFILL_TOOL_TURN_THRESHOLD,
  recordCompactHistoryRound,
  recordCompactSuccess,
} from "./turn-loop-state.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import {
  appendTurnRequestEntries,
  commitTurnRequestEntries,
  filterOutputTokenContinuationEntries,
} from "./turn-output-token-continuation.js";

export async function runRegularTurnLoop(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<void> {
  // Z2: effort behavior policy + turn budgets ("effort means behavior").
  // Resolved once per turn; enforcement runs at the top of every iteration:
  // soft warn at 80%, one strategy-change escalation, then a hard stop with
  // a resumable final message.
  initTurnBudgetState(this, state);
  while (true) {
    throwIfTurnAborted(state.turnAbortSignal);
    if ((await enforceTurnBudgets(this, state)) === "stop") {
      break;
    }
    // Rank 8: an interactive doom-loop final stage requested a resumable
    // pause — complete the turn here, before the next model step.
    if ((await checkDoomLoopPause(this, state)) === "stop") {
      break;
    }
    const outputTokenRecoveryActive = state.turnRequestState.outputTokenContinuationCount > 0;
    // guide 只允许由完整 tool result batch 设置这个一次性诊断；普通 queue 不在
    // model roundtrip 起点消费，避免把未来 turn 错并入当前 product turn。
    const drainedSteerForNextRequest = state.drainedSteerForNextRequest;
    state.drainedSteerForNextRequest = undefined;

    if (state.modelStepCount > 0 && !outputTokenRecoveryActive) {
      const drainedRuntimeCommands = await this.drainPendingRuntimeCommandsForActiveLoop();
      state.backgroundSubagentResultConsumed ||=
        drainedRuntimeCommands.backgroundSubagentResultConsumed;
      state.workflowResultConsumed ||= drainedRuntimeCommands.workflowResultConsumed;
      appendTurnRequestEntries(state.turnRequestState, drainedRuntimeCommands.runtimeEntries);
      if (drainedRuntimeCommands.drained > 0) {
        state.repeatedToolCallSignature = undefined;
        state.repeatedToolCallStreakCount = 0;
      }
    }

    const compactPhase =
      state.modelStepCount === 0 ? CompactPhase.PreRequest : CompactPhase.MidTurn;
    await this.microcompactIfNeeded(state.turnTraceContext, state.events, state.turnAbortSignal, {
      model: state.model,
      modelStepIndex: state.modelStepCount,
      phase: compactPhase,
      turnRequestState: state.turnRequestState,
    });
    throwIfTurnAborted(state.turnAbortSignal);

    const rapidRefill = evaluateRapidRefill(state.compactTracking);
    const autoCompactOutcome = await this.autoCompactIfNeeded(
      state.turnTraceContext,
      state.events,
      state.turnAbortSignal,
      {
        compactReason: CompactReason.ContextLimit,
        modelStepIndex: state.modelStepCount,
        phase: compactPhase,
        rapidRefill,
        model: state.model,
        turnRequestState: state.turnRequestState,
        // Z2: effort-policy compaction aggressiveness (xhigh/ultra compact earlier).
        compactionAggressiveness: state.speedStackBehaviorPolicy?.compactionAggressiveness,
      },
    );
    if (autoCompactOutcome === "rapid_refill_blocked") {
      throw createCompactRapidRefillError({
        consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
        maxConsecutiveRapidRefills: MAX_CONSECUTIVE_RAPID_REFILLS,
        toolTurnThreshold: RAPID_REFILL_TOOL_TURN_THRESHOLD,
        toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
      });
    }
    if (autoCompactOutcome === "compacted") {
      recordCompactSuccess(state, rapidRefill);
      recordCompactHistoryRound(state);
    }
    // Z3: Rank 4 boundary-triggered compaction (plan stage / passing tests /
    // verified subtask) at a lower watermark than emergency compaction.
    // One-shot: the pending event is cleared before the check.
    if (autoCompactOutcome !== "compacted" && this.speedStackPendingBoundaryEvent) {
      const boundaryEvent = this.speedStackPendingBoundaryEvent;
      this.speedStackPendingBoundaryEvent = undefined;
      const boundaryOutcome = await this.boundaryCompactIfNeeded(
        state.turnTraceContext,
        state.events,
        state.turnAbortSignal,
        {
          compactReason: CompactReason.ContextLimit,
          modelStepIndex: state.modelStepCount,
          phase: compactPhase,
          rapidRefill,
          model: state.model,
          turnRequestState: state.turnRequestState,
          boundaryEvent,
        },
      );
      if (boundaryOutcome === "compacted") {
        recordCompactSuccess(state, rapidRefill);
        recordCompactHistoryRound(state);
      }
    }
    throwIfTurnAborted(state.turnAbortSignal);

    const finishMcp = beginLocalTurnPreparation(state.turnTraceContext, "mcp");
    await this.initializeMcp(state.turnTraceContext);
    finishMcp();
    throwIfTurnAborted(state.turnAbortSignal);
    const finishTools = beginLocalTurnPreparation(state.turnTraceContext, "tools");
    const turnDisallowedTools = buildTurnDisallowedTools(state);
    // automation 派发到已 active 会话或重试恢复时，入口 metadata 可能没有带到
    // loop state；但 queryId 仍是 automation-*。provider 请求边界必须按 queryId 再硬过滤
    // automation 写工具，否则模型会先看到并创建、修改或删除任务定义。
    const tools = state.automationCreateLimitReached
      ? []
      : turnDisallowedTools
        ? this.getTools(state.model).filter((tool) => !turnDisallowedTools.has(tool.name))
        : this.getTools(state.model);
    // Z1 tool packs: suppress non-relevant tool schemas BEFORE request
    // construction -- the win is not sending the schemas, not rejecting
    // calls later. Fail-open: low confidence / missing route / kill switch
    // keeps the full list (today's behavior).
    const toolPackShortlist = computeTurnToolPackShortlist.call(this, state, tools);
    const requestTools = toolPackShortlist.pruned
      ? tools.filter((tool) => toolPackShortlist.keepNames.has(tool.name))
      : tools;
    finishTools();
    if (!outputTokenRecoveryActive && this.needsPlanModeExitReminder) {
      this.needsPlanModeExitReminder = false;
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("plan_mode_exit", buildPlanModeExitReminderBody()),
      ]);
    }
    const runtimeModeReminderBody = outputTokenRecoveryActive
      ? null
      : buildRuntimeModeReminderBody(
          state.turnRequestState.entries,
          this.getMode(),
          this.getPlanEnabled(),
        );
    if (runtimeModeReminderBody) {
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("runtime_mode", runtimeModeReminderBody),
      ]);
    }
    if (
      !outputTokenRecoveryActive &&
      tools.some((tool) => tool.name === "TodoWrite") &&
      shouldBuildTodoReminder(state.turnRequestState.entries)
    ) {
      const currentTodos = await this.readSessionTodosForContext(state.turnTraceContext);
      const reminderBody = buildTodoReminderBody(currentTodos);
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("todo_reminder", reminderBody),
      ]);
      await this.persistSyntheticUserNoticeForSession({
        messageID: createMessageId(),
        metadata: { runtimeMessage: todoReminderRuntimeMetadata() },
        sessionId: this.sessionId,
        source: "todo_reminder",
        text: reminderBody,
        traceContext: state.turnTraceContext,
      });
    }
    // Rank 10: one-shot subagent spawning guidance, tier-specific. Fires
    // only when the Agent tool survived the disallow filter (low/off hides
    // it, so there is nothing to guide) and the tool pack kept it visible.
    // Fail-open: no policy or no reminder body = no injection.
    if (
      shouldInjectSubagentGuidanceReminder({
        policy: state.speedStackBehaviorPolicy,
        agentToolVisible: tools.some((tool) => tool.name === AGENT_TOOL_NAME),
        modelStepCount: state.modelStepCount,
        alreadyReminded: state.speedStackSubagentGuidanceReminded,
        outputTokenRecoveryActive,
      })
    ) {
      const subagentGuidanceBody = buildSubagentPolicyReminderBody(
        state.speedStackBehaviorPolicy,
      );
      if (subagentGuidanceBody) {
        state.speedStackSubagentGuidanceReminded = true;
        commitTurnRequestEntries(this, state.turnRequestState, [
          systemReminderAttachmentEntry("subagent_guidance", subagentGuidanceBody),
        ]);
      }
    }
    const outputStyleReminderBody =
      state.modelStepCount === 0
        ? buildRuntimeOutputStyleReminderBody(state.turnOutputStyle)
        : null;
    if (outputStyleReminderBody) {
      // output_style 是 provider-visible 的当前 turn runtime attachment，
      // 需要进入内存历史参与后续 request 的增量轨迹；但不把它落 session。
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("output_style", outputStyleReminderBody),
      ]);
    }
    const providerEntries = [...state.turnRequestState.entries];
    const requestEntries = providerEntries;
    // provider-visible user ordering projection 会改变最终 latest user 落点，
    // cache-control 必须在 projection 后统一设置，避免 raw synthetic entry 抢占缓存锚点。
    const providerProjection = buildRuntimeProviderRequestMessages(this, {
      entries: requestEntries,
      applyCacheControl: true,
      model: state.model,
    });
    const { messages } = providerProjection;
    const recordableEntries = filterOutputTokenContinuationEntries(requestEntries);
    const recordableProjection =
      recordableEntries === requestEntries
        ? providerProjection
        : buildRuntimeProviderRequestMessages(this, {
            entries: recordableEntries,
            applyCacheControl: true,
            model: state.model,
          });
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.startModelRequest(
        `${state.model.providerId}/${state.model.modelId}`,
        recordableProjection.messages,
      ),
    );

    // 生产包需要知道 Turn 是否已经跨过 provider 边界；这里只记录请求元数据，
    // 不记录 prompt、消息内容或 streaming chunk，避免泄露内容并控制日志量。
    this.logger?.info("Model request started", {
      ...traceContextToLogContext(state.turnTraceContext),
      event: "model.request.started",
      module: "core.runtime",
      status: "started",
      messageCount: messages.length,
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
      toolPackPruned: toolPackShortlist.pruned,
      toolPackLabels: [...toolPackShortlist.labels],
      toolPackTierScores: toolPackShortlist.tierScores,
      toolPackMargin: toolPackShortlist.margin,
      toolPackReason: toolPackShortlist.reason,
      toolPackSchemaTokensBefore: toolPackShortlist.schemaTokensBefore,
      toolPackSchemaTokensAfter: toolPackShortlist.schemaTokensAfter,
      toolCount: requestTools.length,
    });

    const result = await runModelBackedTurnStep.call(this, state, {
      drainedSteerForNextRequest,
      latestRealUserMessageIndex: providerProjection.diagnostics.latestRealUserMessageIndex,
      messages,
      sourceEntries: providerProjection.sourceEntries,
      requestEntries,
      recordedMessages: recordableProjection.messages,
      tools: requestTools,
    });

    if (result === "break") {
      break;
    }
  }
}

function buildTurnDisallowedTools(state: RegularTurnLoopState): Set<string> | null {
  const tools = new Set(state.toolDisallowlist ?? []);
  if (isAutomationMutationRestrictedTurn(state)) {
    // 定时任务执行轮只应运行任务 prompt，不能反过来管理自己的定义。
    // 保留 CronList 供只读查询；所有 mutation 在 provider 请求边界统一隐藏。
    for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  if (isOffPeakCreateRestrictedTurn(state)) {
    // 闲时执行轮禁止再创建闲时任务（防递归自我派生）；OffPeakList 只读保留。
    // 注意 automation 执行轮不进此分支——cron turn 放行 OffPeakCreate。
    for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  if (
    shouldHideSubagentDispatchTools({
      policy: state.speedStackBehaviorPolicy,
      explicitUserRequest: isTurnExplicitSubagentRequest(state),
    })
  ) {
    // Z2: low/off effort forbids subagent delegation — the dispatch tools are
    // hidden from the model so it does the work itself. Fail-open: an
    // unresolved policy never gates.
    // Rank 10 escape hatch: an explicit user request to use a subagent
    // always wins over the effort-tier policy — the hide is lifted.
    tools.add(AGENT_TOOL_NAME);
    tools.add(TASK_TOOL_NAME);
  }
  return tools.size > 0 ? tools : null;
}

/**
 * Rank 10 escape hatch: whether the turn's user message explicitly asks to
 * use a subagent. Computed once per turn and cached on state; fail-open
 * (any error => false => the effort-tier policy stands).
 */
function isTurnExplicitSubagentRequest(state: RegularTurnLoopState): boolean {
  try {
    if (state.speedStackExplicitSubagentRequest !== undefined) {
      return state.speedStackExplicitSubagentRequest;
    }
    const result = isExplicitSubagentRequestInTexts(
      extractTurnUserMessageTexts(state),
    );
    state.speedStackExplicitSubagentRequest = result;
    return result;
  } catch {
    return false;
  }
}

/** Best-effort extraction of user-role message texts from the turn request. */
function extractTurnUserMessageTexts(state: RegularTurnLoopState): string[] {
  const texts: string[] = [];
  for (const entry of state.turnRequestState.entries) {
    if (!entry || (entry as { kind?: string }).kind === "attachment") continue;
    const message = (entry as { message?: { role?: string; content?: unknown } }).message;
    if (!message || message.role !== "user") continue;
    const text = extractMessageContentText(message.content);
    if (text.trim().length > 0) texts.push(text);
  }
  return texts;
}

function extractMessageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const record = block as Record<string, unknown>;
          if (typeof record.text === "string") return record.text;
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

// -- Z2: turn/tool budget enforcement (soft-then-hard) --------------------
//
// initTurnBudgetState resolves the effort behavior policy + effective turn
// budgets once per turn (fail-open: disabled kill switch, unresolved effort,
// or empty budgets all degrade to today's unbounded behavior).
// enforceTurnBudgets runs at the top of every loop iteration and returns
// "stop" exactly once, when the escalation step is done.

function initTurnBudgetState(runtime: AgentRuntimeInternal, state: RegularTurnLoopState): void {
  try {
    if (isBudgetEnforcementDisabled()) return;
    if (state.speedStackPlannerPhase === true) {
      // Z3: the planner pass gets its own small budget so a runaway plan
      // can never eat the executor's turn budget.
      const plannerBudgets = resolvePlannerBudgets(process.env);
      state.speedStackBudgets = {
        maxSteps: plannerBudgets.maxSteps,
        maxToolCalls: plannerBudgets.maxToolCalls,
      };
      state.speedStackBudgetTier = "medium";
      state.speedStackBudgetWarningThreshold = Math.ceil(
        plannerBudgets.maxToolCalls * BUDGET_WARN_FRACTION,
      );
      return;
    }
    const resolution = resolveSystemOneBehaviorPolicy(runtime, process.env);
    state.speedStackBehaviorPolicy = resolution.policy;
    state.speedStackBudgets = resolution.budgets;
    state.speedStackBudgetTier = resolution.tier;
    if (
      resolution.budgets.maxToolCalls !== undefined &&
      state.speedStackBudgetWarningThreshold === undefined
    ) {
      // Arm the (disabled-by-default) anomaly-channel detector for this turn:
      // 80% of the per-turn call cap. The explicit
      // modelAnomalyGuard.toolCallWarningThreshold still wins when set.
      state.speedStackBudgetWarningThreshold = Math.ceil(
        resolution.budgets.maxToolCalls * BUDGET_WARN_FRACTION,
      );
    }
  } catch {
    // Fail-open: no budget state = today's behavior.
  }
}

async function emitBudgetAnomalyEvent(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  severity: "warning" | "error",
  category: string,
): Promise<void> {
  try {
    const event = runtime.createEvent(
      SessionEventType.ModelAnomalyWarning,
      {
        category,
        severity,
        modelStepCount: state.modelStepCount,
        toolCallCount: state.toolCallCount,
        maxSteps: state.speedStackBudgets?.maxSteps,
        maxToolCalls: state.speedStackBudgets?.maxToolCalls,
      },
      state.turnTraceContext,
    );
    await runtime.appendEvent(event, state.turnTraceContext);
    state.events.push(event);
  } catch {
    // Fail-open: the reminder was already injected; a dropped event must not
    // break the turn.
  }
}

async function enforceTurnBudgets(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<"continue" | "stop"> {
  const budgets = state.speedStackBudgets;
  if (!budgets || (budgets.maxSteps === undefined && budgets.maxToolCalls === undefined)) {
    return "continue";
  }
  const messageContext: BudgetMessageContext = {
    steps: state.modelStepCount,
    toolCalls: state.toolCallCount,
    maxSteps: budgets.maxSteps,
    maxToolCalls: budgets.maxToolCalls,
    tier: state.speedStackBudgetTier,
  };
  const action = evaluateBudgetEnforcement(
    { steps: state.modelStepCount, toolCalls: state.toolCallCount },
    budgets,
    {
      warned: state.speedStackBudgetWarned === true,
      escalated: state.speedStackBudgetEscalated === true,
    },
  );
  if (action === "ok") return "continue";
  if (action === "warn") {
    // Soft warning (once per turn) through the anomaly-warning channel.
    state.speedStackBudgetWarned = true;
    commitTurnRequestEntries(runtime, state.turnRequestState, [
      systemReminderAttachmentEntry("model_anomaly", buildBudgetWarnBody(messageContext)),
    ]);
    await emitBudgetAnomalyEvent(runtime, state, "warning", "turn_budget_warning");
    return "continue";
  }
  if (action === "escalate") {
    // One strategy-change escalation: the model gets exactly one more model
    // step to wrap up before the hard stop.
    state.speedStackBudgetEscalated = true;
    commitTurnRequestEntries(runtime, state.turnRequestState, [
      systemReminderAttachmentEntry("model_anomaly", buildBudgetEscalationBody(messageContext)),
    ]);
    await emitBudgetAnomalyEvent(runtime, state, "warning", "turn_budget_escalation");
    return "continue";
  }
  // Hard stop: resumable final message, mirroring the automation-limit path.
  // Session state is already persisted by the normal turn-completion path;
  // the message tells the user exactly how to resume.
  const body = buildBudgetExhaustedBody(messageContext);
  if (state.speedStackPlannerPhase === true) {
    // Z3: the planner hit its small budget — the plan-execute driver
    // fails open to a direct turn instead of inventing a plan.
    state.speedStackPlannerBudgetExhausted = true;
  }
  state.modelResponse = body;
  if (state.activeTurn) {
    state.activeTurn.steerable = false;
  }
  state.stableProductStartMessageId = state.currentUserMessageId;
  state.stableBoundaryAssistantMessageId = createMessageId();
  await emitBudgetAnomalyEvent(runtime, state, "error", "turn_budget_exhausted");
  state.turnMachine = new TurnMachineImpl(state.turnMachine.complete(body, "success"));
  return "stop";
}
