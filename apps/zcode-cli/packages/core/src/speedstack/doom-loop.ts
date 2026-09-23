// ============================================================
// Speed Stack Rank 8: doom-loop fingerprint escalation
// ============================================================
//
// A model stuck in a loop calls the same tool with (near-)identical
// input over and over. The legacy repeat detector in
// runtime/helpers/model-anomaly.ts only matches byte-identical stable
// JSON and warns once; this module adds a normalized fingerprint
// (path separators, ./.., trivial whitespace, key order) plus an
// escalation ladder:
//
//   streak 3 -> nudge ("stop repeating this call")
//   streak 4 -> forced strategy change (names untried tools)
//   streak 5 -> interactive turn: resumable pause
//              unattended (automation/off-peak) turn: one final
//              redirect + streak reset (one-shot; the turn budget
//              still hard-stops a truly stuck turn)
//
// Guards:
//   - Kill switch: ZCODE_DOOMLOOP=0 disables everything here.
//   - Fail-open: any fingerprint/escalation error degrades to the
//     legacy behavior (runtime callers wrap this in try/catch).
//   - Different targets (files/commands/patterns) reset the streak;
//     multi-file edits and batch operations never escalate.
//   - The ladder never sets speedStackBudgetEscalated; budget cap
//     enforcement keeps its own semantics.

/** Kill switch: set to 0 to disable all doom-loop behavior. */
export const DOOM_LOOP_KILL_SWITCH_ENV = "ZCODE_DOOMLOOP";

/** Escalation streak thresholds (consecutive similar calls). */
export const DOOM_LOOP_NUDGE_STREAK = 3;
export const DOOM_LOOP_STRATEGY_STREAK = 4;
export const DOOM_LOOP_FINAL_STREAK = 5;

function isFalsyEnvValue(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off"
  );
}

/**
 * Kill-switch check. Fail-open: any error reading env leaves the
 * feature enabled rather than crashing the turn.
 */
export function isDoomLoopDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return isFalsyEnvValue(env[DOOM_LOOP_KILL_SWITCH_ENV]);
  } catch {
    return false;
  }
}

const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Collapse duplicate slashes and resolve `.`/`..` lexically (no fs
 * access). Relative `..` segments that cannot resolve are preserved.
 */
function collapseDotSegments(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  if (absolute) return `/${joined}`;
  return joined === "" ? "." : joined;
}

/**
 * Normalize a string for similarity comparison: trivial whitespace
 * (CRLF, trailing whitespace, 3+ blank lines) plus path separators
 * and ./.. segments. URIs are left alone so `https://host/` survives.
 */
function normalizeDoomLoopString(value: string): string {
  let text = value.replace(/\r\n?/g, "\n");
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  if (URI_SCHEME_RE.test(text)) return text;
  if (text.includes("\\")) text = text.replace(/\\/g, "/");
  if (text.includes("/")) text = collapseDotSegments(text);
  return text;
}

/**
 * Recursively normalize a tool input: strings via
 * normalizeDoomLoopString, object keys in stable sorted order.
 * Numbers, booleans, null, and array order are preserved — offsets,
 * limits, commands, and edit strings stay meaningful.
 */
export function normalizeDoomLoopValue(value: unknown): unknown {
  if (typeof value === "string") return normalizeDoomLoopString(value);
  if (Array.isArray(value)) return value.map(normalizeDoomLoopValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = normalizeDoomLoopValue(record[key]);
    }
    return out;
  }
  return value;
}

function stableStringify(value: unknown): string {
  // Keys are pre-sorted by normalizeDoomLoopValue; JSON.stringify
  // preserves insertion order for string keys.
  return JSON.stringify(value) ?? "null";
}

/** Normalized fingerprint: `"<tool>":<stable-json>`. */
export function fingerprintToolCall(toolName: string, input: unknown): string {
  return `${JSON.stringify(toolName)}:${stableStringify(normalizeDoomLoopValue(input))}`;
}

/** Input keys that identify the call's target (file/command/pattern). */
const TARGET_KEYS = [
  "path",
  "filePath",
  "file",
  "filename",
  "pattern",
  "command",
  "code",
  "url",
  "query",
  "text",
] as const;

/**
 * Extract the call's target for the different-target reset guard.
 * Deterministic in the normalized input: equal fingerprints always
 * yield equal targets, so this is defense-in-depth on top of the
 * fingerprint itself.
 */
export function extractDoomLoopTarget(input: unknown): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return normalizeDoomLoopString(value);
    }
  }
  return undefined;
}

/** Per-turn doom-loop detector state (lives on the turn-loop state). */
export interface DoomLoopTurnState {
  doomLoopFingerprint?: string | undefined;
  doomLoopTarget?: string | undefined;
  doomLoopStreak: number;
  doomLoopStage: number;
  doomLoopUsedTools: string[];
}

export function createDoomLoopTurnState(): DoomLoopTurnState {
  return { doomLoopStreak: 0, doomLoopStage: 0, doomLoopUsedTools: [] };
}

export type DoomLoopTransition =
  | { kind: "none"; streak: number }
  | { kind: "nudge"; streak: number; toolName: string }
  | { kind: "strategy-change"; streak: number; toolName: string }
  | { kind: "final"; streak: number; toolName: string };

/**
 * Advance the streak for one tool call. A different fingerprint or a
 * different target resets the streak and the ladder. Each stage fires
 * at most once per streak (stage is terminal).
 */
export function advanceDoomLoop(
  state: DoomLoopTurnState,
  toolName: string,
  input: unknown,
): DoomLoopTransition {
  const fingerprint = fingerprintToolCall(toolName, input);
  const target = extractDoomLoopTarget(input);
  if (state.doomLoopFingerprint !== fingerprint || state.doomLoopTarget !== target) {
    state.doomLoopFingerprint = fingerprint;
    state.doomLoopTarget = target;
    state.doomLoopStreak = 1;
    state.doomLoopStage = 0;
    return { kind: "none", streak: 1 };
  }
  state.doomLoopStreak += 1;
  const streak = state.doomLoopStreak;
  if (streak === DOOM_LOOP_NUDGE_STREAK && state.doomLoopStage < 1) {
    state.doomLoopStage = 1;
    return { kind: "nudge", streak, toolName };
  }
  if (streak === DOOM_LOOP_STRATEGY_STREAK && state.doomLoopStage < 2) {
    state.doomLoopStage = 2;
    return { kind: "strategy-change", streak, toolName };
  }
  if (streak >= DOOM_LOOP_FINAL_STREAK && state.doomLoopStage < 3) {
    state.doomLoopStage = 3;
    return { kind: "final", streak, toolName };
  }
  return { kind: "none", streak };
}

/** Record a tool name as used this turn (for strategy-change suggestions). */
export function recordDoomLoopToolUse(state: DoomLoopTurnState, toolName: string): void {
  const name = toolName.trim();
  if (!name) return;
  const lower = name.toLowerCase();
  if (!state.doomLoopUsedTools.some((used) => used.toLowerCase() === lower)) {
    state.doomLoopUsedTools.push(name);
  }
}

/**
 * Candidate replacement tools: pruned pack keepNames first, then the
 * sent tool names. Excludes the looping tool and tools already used
 * this turn.
 */
export function untriedDoomLoopTools(
  packKeepNames: ReadonlySet<string> | undefined,
  sentToolNames: readonly string[] | undefined,
  usedToolNames: readonly string[],
  loopingToolName: string,
  limit = 5,
): string[] {
  const candidates: string[] = [];
  if (packKeepNames) candidates.push(...packKeepNames);
  else if (sentToolNames) candidates.push(...sentToolNames);
  const used = new Set(usedToolNames.map((name) => name.toLowerCase()));
  const looping = loopingToolName.toLowerCase();
  const out: string[] = [];
  for (const name of candidates) {
    const lower = name.toLowerCase();
    if (lower === looping || used.has(lower)) continue;
    if (out.some((seen) => seen.toLowerCase() === lower)) continue;
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

export interface DoomLoopObservation {
  kind: "nudge" | "strategy-change" | "final";
  streak: number;
  toolCallId: string;
  toolName: string;
  untriedTools: string[];
}

export interface DoomLoopDetectOptions {
  packKeepNames?: ReadonlySet<string> | undefined;
  sentToolNames?: readonly string[] | undefined;
  untriedToolLimit?: number | undefined;
}

/**
 * Run the detector over a batch of tool calls in order, recording tool
 * use and returning one observation per escalation event.
 */
export function detectDoomLoopTransitions(
  toolCalls: ReadonlyArray<{ id: string; name: string; input: unknown }>,
  state: DoomLoopTurnState,
  options: DoomLoopDetectOptions = {},
): DoomLoopObservation[] {
  const observations: DoomLoopObservation[] = [];
  for (const call of toolCalls) {
    recordDoomLoopToolUse(state, call.name);
    const transition = advanceDoomLoop(state, call.name, call.input);
    if (transition.kind === "none") continue;
    observations.push({
      kind: transition.kind,
      streak: transition.streak,
      toolCallId: call.id,
      toolName: transition.toolName,
      untriedTools:
        transition.kind === "strategy-change"
          ? untriedDoomLoopTools(
              options.packKeepNames,
              options.sentToolNames,
              state.doomLoopUsedTools,
              transition.toolName,
              options.untriedToolLimit,
            )
          : [],
    });
  }
  return observations;
}

export function buildDoomLoopNudgeBody(toolName: string, streak: number): string {
  return [
    `You have called ${toolName} with very similar input ${streak} times in a row.`,
    "The repeated calls are not moving you forward — stop and re-read the latest tool result before your next step.",
  ].join("\n");
}

export function buildDoomLoopStrategyBody(
  toolName: string,
  streak: number,
  untriedTools: readonly string[],
): string {
  const lines = [
    `You have called ${toolName} with very similar input ${streak} times in a row. Repeating it is not working — change strategy now.`,
  ];
  if (untriedTools.length > 0) {
    lines.push(
      `Tools available this turn that you have not tried yet: ${untriedTools.join(", ")}. ` +
        `Use one of them instead of calling ${toolName} again.`,
    );
  } else {
    lines.push(
      `Step back and approach the goal a different way instead of calling ${toolName} again.`,
    );
  }
  return lines.join("\n");
}

export function buildDoomLoopFinalBody(
  toolName: string,
  streak: number,
  unattended: boolean,
): string {
  if (unattended) {
    return [
      `You have called ${toolName} with very similar input ${streak} times in a row.`,
      "Final redirect: take a genuinely different approach now, or stop calling tools and summarize where you are stuck. " +
        `Do not call ${toolName} with similar input again this turn.`,
    ].join("\n");
  }
  return [
    `You have called ${toolName} with very similar input ${streak} times in a row.`,
    "I am pausing here so the turn does not burn on this loop. Tell me a different approach, or say 'continue' and I will resume.",
  ].join("\n");
}

/** Resumable pause message used when the loop top stops an interactive turn. */
export function buildDoomLoopPauseBody(toolName: string, streak: number): string {
  return [
    `Paused: ${toolName} was called with very similar input ${streak} times in a row without progress.`,
    'The session state is saved and this turn is resumable — tell me a different approach, or send another message (e.g. "continue") to pick up where it left off.',
  ].join("\n");
}
