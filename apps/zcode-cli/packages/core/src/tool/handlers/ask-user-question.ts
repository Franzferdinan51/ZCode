// ============================================================
// AskUserQuestion Tool Handler
// ============================================================

import {
  ASK_USER_QUESTION_TOOL_NAME,
  AskUserQuestionAnsweredInputSchema,
  AskUserQuestionInputJsonSchema,
  AskUserQuestionInputSchema,
  AskUserQuestionOutputJsonSchema,
  AskUserQuestionOutputSchema,
  CoreErrorType,
  createCoreError,
  type AskUserQuestionOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_ASK_USER_QUESTION_MODEL_BYTES = 100_000;

const ASK_USER_QUESTION_DESCRIPTION =
  [
    "Ask the user a question when you are blocked on a decision only they can make — one you cannot resolve from the request, the code, or sensible defaults.",
    "",
    "- If a conventional default exists or you can verify the fact in the codebase, pick it, mention it, and proceed — do not ask.",
    "- Users can always answer \"Other\" with custom text. `multiSelect: true` allows multiple answers; put your recommended option first with \"(Recommended)\" in its label.",
    "- In plan mode, use this to clarify requirements BEFORE ExitPlanMode — never to ask \"is my plan ready?\" (that is ExitPlanMode's job). To enter plan mode, use EnterPlanMode.",
    "- Optional `preview` on single-select options renders artifacts (ASCII mockups, code snippets, diagrams) for visual comparison; skip it for simple preference questions.",
  ].join("\n") + "\n";

const askUserQuestionHandler: ToolHandler = async (input, context) => {
  const parsed = AskUserQuestionAnsweredInputSchema.safeParse(input);

  if (!parsed.success) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "AskUserQuestion requires user answers before execution",
      {
        context: {
          issues: parsed.error.issues.map((issue) => ({
            message: issue.message,
            path: issue.path,
          })),
          toolCallId: context.toolCallId,
          toolName: ASK_USER_QUESTION_TOOL_NAME,
        },
        recoverable: true,
      },
    );
  }

  return {
    questions: parsed.data.questions,
    answers: parsed.data.answers ?? {},
    ...(parsed.data.annotations ? { annotations: parsed.data.annotations } : {}),
  } satisfies AskUserQuestionOutput;
};

export const askUserQuestionToolEntry: ToolEntry = {
  capability:
    "Ask the user multiple-choice clarification questions and continue with their answers",
  requiresUserInteraction: true,
  metadata: {
    name: ASK_USER_QUESTION_TOOL_NAME,
    description: ASK_USER_QUESTION_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    requiresUserInteraction: true,
    timeoutMs: 30000,
    maxOutputBytes: MAX_ASK_USER_QUESTION_MODEL_BYTES,
    sideEffectScope: "userInteraction",
    riskLevel: "low",
    needsApproval: true,
  },
  handler: askUserQuestionHandler,
  formatModelContent: formatAskUserQuestionModelContent,
  inputSchema: AskUserQuestionInputJsonSchema,
  outputSchema: AskUserQuestionOutputJsonSchema,
  runtimeInputSchema: AskUserQuestionInputSchema,
  runtimeOutputSchema: AskUserQuestionOutputSchema,
  permission: {
    permission: "userInteraction.askQuestion",
    reason: "AskUserQuestion pauses execution to collect answers from the user",
    riskLevel: "low",
    sideEffectScope: "userInteraction",
    needsApproval: true,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_ASK_USER_QUESTION_MODEL_BYTES,
    maxModelBytes: MAX_ASK_USER_QUESTION_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_ASK_USER_QUESTION_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "AskUserQuestion was cancelled before answers were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatAskUserQuestionModelContent(output: unknown): string {
  const result = output as AskUserQuestionOutput;
  if (Object.keys(result.answers).length === 0) {
    return "The user did not provide answers to these questions. Continue using your best judgment; do not treat this as a rejection or invent a user preference.";
  }
  const answersText = Object.entries(result.answers)
    .map(([questionText, answer]) => {
      const annotation = result.annotations?.[questionText];
      const parts = [`"${questionText}"="${answer}"`];
      if (annotation?.preview) {
        parts.push(`selected preview:\n${annotation.preview}`);
      }
      if (annotation?.notes) {
        parts.push(`user notes: ${annotation.notes}`);
      }
      return parts.join(" ");
    })
    .join(", ");

  const unansweredCount = result.questions.filter(
    (question) => !(question.question in result.answers),
  ).length;
  if (unansweredCount > 0) {
    return `The user answered some questions and skipped ${unansweredCount}. Provided answers: ${answersText}. Continue with the provided answers and use your best judgment for the unanswered questions; do not invent user preferences.`;
  }

  return `User has answered your questions: ${answersText}. You can now continue with the user's answers in mind.`;
}
