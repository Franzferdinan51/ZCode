// ============================================================
// Speed Stack: effort-aware subagent spawning guidance (Rank 10)
// ============================================================
//
// Rank 10 of the 3.25.0 agent-flow program: audit the effort-aware
// subagent controls and add the missing model guidance.
//
// What already existed (kept, not rebuilt):
// - effort tiers resolve a `subagents` allowance per turn: "never"
//   (low/off — the Agent/Task dispatch tools are hidden from the model),
//   "conservative" (medium/high), "parallel" (xhigh/ultra).
// - subagent maxTurns already scales with the effort policy.
// - the Agent tool description already says subagents are for broad
//   exploration / independent parallel tasks and notes the full-context
//   fork cost.
//
// What this module adds (the Rank 10 gap):
// - tier-specific per-turn guidance: prefer same-turn parallel tool calls
//   (independent Read/Grep/Glob/Bash in one message run concurrently)
//   over spawning; reserve subagents for genuinely broad, independent
//   investigations; spell out the ~2.5-4K token fixed spawn overhead.
// - the escape hatch: an explicit user request to use a subagent always
//   wins over the policy. `isExplicitSubagentRequestText` detects it
//   (pure, unit-tested); the turn loop uses it to lift the low/off hide.
// - the turn-loop's Rank 10 decisions as pure, unit-tested helpers:
//   `isExplicitSubagentRequestInTexts` (scan the turn's user texts),
//   `shouldHideSubagentDispatchTools` (explicit request beats the
//   effort-tier hide), and `shouldInjectSubagentGuidanceReminder`
//   (the one-shot injection condition).
//
// This module is intentionally pure (no runtime imports) so it stays
// runnable under plain `node --test` type-stripping like its speedstack
// siblings. Fail-open everywhere: unknown input -> no guidance / no
// override, i.e. today's behavior.

import {
  isSubagentSpawningAllowed,
  type EffortBehaviorPolicy,
} from "./effort-tiers.js";

/**
 * Patterns that express an explicit user request to delegate work to a
 * subagent. Conservative by design: only direct "use/spawn/launch a
 * subagent"-style phrasings match. A bare mention ("subagents are
 * expensive") does not.
 */
const EXPLICIT_SUBAGENT_REQUEST_PATTERNS: readonly RegExp[] = [
  /\buse\s+(a\s+|the\s+)?sub-?agents?\b/i,
  /\bspawn\s+(an?\s+)?(sub-?)?agents?\b/i,
  /\blaunch\s+(an?\s+|some\s+|\d+\s+|two\s+|three\s+)?(sub-?)?agents?\b/i,
  /\bdelegate\s+[^.?!]{0,80}?\bto\s+(an?\s+)?(sub-?)?agents?\b/i,
  /\bhave\s+(an?\s+)?(sub-?)?agents?\b[^.?!]{0,60}?\b(do|handle|research|investigate|look into|take care of)\b/i,
  /\bget\s+(a\s+|the\s+)?sub-?agents?\b[^.?!]{0,60}?\bto\b/i,
];

/**
 * Negation guard: "don't use a subagent", "no subagents", "never spawn
 * agents" must NOT count as explicit requests. Checked first.
 */
const NEGATED_SUBAGENT_PATTERNS: readonly RegExp[] = [
  /\b(don'?t|do\s+not|never|no|not|avoid|without|rather than)\b[^.?!]{0,50}?\b(sub-?)?agents?\b/i,
  /\b(sub-?)?agents?\b[^.?!]{0,40}?\b(are\s+)?(not|n'?t|never)\b/i,
];

/**
 * Whether the given user text explicitly asks the agent to use a
 * subagent. The escape hatch: an explicit request always wins over the
 * effort-tier spawning policy. Pure; never throws.
 */
export function isExplicitSubagentRequestText(text: string | undefined): boolean {
  try {
    if (!text || text.trim().length === 0) return false;
    if (NEGATED_SUBAGENT_PATTERNS.some((pattern) => pattern.test(text))) return false;
    return EXPLICIT_SUBAGENT_REQUEST_PATTERNS.some((pattern) => pattern.test(text));
  } catch {
    return false;
  }
}

/**
 * Whether ANY of the turn's user message texts explicitly asks to use a
 * subagent. The turn loop extracts the texts and calls this; the escape
 * hatch then lifts the effort-tier hide for the whole turn. Pure; never
 * throws.
 */
export function isExplicitSubagentRequestInTexts(
  texts: readonly (string | undefined | null)[] | undefined,
): boolean {
  try {
    for (const text of texts ?? []) {
      if (isExplicitSubagentRequestText(text ?? undefined)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export interface SubagentToolHideInput {
  /** The resolved effort behavior policy (undefined = unresolved). */
  readonly policy: EffortBehaviorPolicy | undefined;
  /** Whether the turn's user text explicitly asks to use a subagent. */
  readonly explicitUserRequest: boolean;
}

/**
 * Turn-loop decision: hide the Agent/Task dispatch tools from the model.
 *
 * Rank 10 escape hatch: an explicit user request ALWAYS wins over the
 * effort-tier gating — the low/off hide is lifted, the model keeps the
 * dispatch tools. Fail-open: an unresolved policy (isSubagentSpawningAllowed
 * returns true) hides nothing.
 */
export function shouldHideSubagentDispatchTools(
  input: SubagentToolHideInput,
): boolean {
  try {
    return !isSubagentSpawningAllowed(input.policy) && !input.explicitUserRequest;
  } catch {
    return false;
  }
}

export interface SubagentGuidanceInjectionInput {
  /** The resolved effort behavior policy. */
  readonly policy: EffortBehaviorPolicy | undefined;
  /** Whether the Agent dispatch tool survived the disallow + tool-pack filters. */
  readonly agentToolVisible: boolean;
  /** Model steps taken so far in the turn (the reminder is one-shot on step 0). */
  readonly modelStepCount: number;
  /** Whether this turn already committed the reminder. */
  readonly alreadyReminded: boolean | undefined;
  /** Output-token recovery mode suppresses non-critical reminders. */
  readonly outputTokenRecoveryActive: boolean;
}

/**
 * Whether the turn loop should commit the one-shot subagent guidance
 * reminder this step. One-shot: step 0, not yet reminded. Fires only when
 * the Agent tool is visible (low/off hides it — guidance about hidden
 * tools would be noise) and the policy actually carries guidance
 * (fail-open: no body = no injection). Pure; never throws.
 */
export function shouldInjectSubagentGuidanceReminder(
  input: SubagentGuidanceInjectionInput,
): boolean {
  try {
    if (input.outputTokenRecoveryActive) return false;
    if (input.modelStepCount !== 0) return false;
    if (input.alreadyReminded === true) return false;
    if (!input.agentToolVisible) return false;
    return buildSubagentPolicyReminderBody(input.policy) !== undefined;
  } catch {
    return false;
  }
}

/** Fixed spawn overhead, stated in the guidance so the model can price it. */
export const SUBAGENT_SPAWN_OVERHEAD_TOKENS = "2.5-4K";

/**
 * Build the one-shot per-turn subagent spawning reminder for the resolved
 * effort behavior policy. Tier-specific:
 * - "conservative" (medium/high): prefer same-turn parallel tool calls;
 *   reserve Agent for broad independent investigations.
 * - "parallel" (xhigh/ultra): parallel Agent fan-out is allowed for
 *   genuinely independent investigations; inline parallel calls still win
 *   for work finishable in this turn.
 *
 * Returns undefined when no reminder is needed:
 * - no policy (fail-open: say nothing rather than guess the tier);
 * - "never" allowance (low/off): the dispatch tools are hidden from the
 *   model, so guidance about them would be noise. The escape hatch still
 *   applies: if the user explicitly asked, the turn loop lifts the hide.
 */
export function buildSubagentPolicyReminderBody(
  policy: EffortBehaviorPolicy | undefined,
): string | undefined {
  try {
    const allowance = policy?.subagents;
    if (allowance === undefined || allowance === "never") return undefined;
    const overhead =
      `Spawning an Agent costs ~${SUBAGENT_SPAWN_OVERHEAD_TOKENS} tokens of fixed prompt overhead plus its own turns.`;
    const overheadContinuation =
      `spawning an Agent costs ~${SUBAGENT_SPAWN_OVERHEAD_TOKENS} tokens of fixed prompt overhead plus its own turns.`;
    const escapeHatch =
      "If the user explicitly asked you to use a subagent, their request wins over this guidance.";
    if (allowance === "conservative") {
      return [
        "Subagent policy (conservative effort): prefer parallel tool calls in THIS turn over spawning subagents — " +
          "independent Read/Grep/Glob/Bash calls in one message run concurrently and cost no spawn overhead.",
        "Reserve Agent for genuinely broad, independent investigations that run while you continue other work — " +
          "not for single-fact lookups or chains you can finish inline.",
        overhead,
        escapeHatch,
      ].join(" ");
    }
    // "parallel"
    return [
      "Subagent policy (parallel effort): you may fan out with parallel Agent calls for genuinely independent " +
        "investigations — launch them in one message so they run concurrently.",
      "Still prefer same-turn parallel tool calls for work you can finish inline; " +
        overheadContinuation,
      escapeHatch,
    ].join(" ");
  } catch {
    return undefined;
  }
}
