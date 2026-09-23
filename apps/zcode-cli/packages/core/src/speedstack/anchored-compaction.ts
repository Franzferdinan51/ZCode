// ============================================================
// Speed Stack: anchored session compaction
// ============================================================
//
// Companion to core/src/compact/ (auto/micro/manual). Microcompact already
// drops raw tool-output bulk; this module adds the anchor discipline:
//   1. archive the FULL transcript to disk first (never lose raw history),
//   2. extract anchors (decisions, file paths, errors, todo state),
//   3. compact with the anchors injected into the summary prompt so the
//      summarizer preserves them.
//
// Rank 4 (this file, second half):
//   4. archive rotation — capped per-session history on disk, fail-open.
//   5. boundary-compact triggers — after plan stages, passing tests, and
//      verified subtasks, compaction may run at a LOWER watermark than the
//      emergency threshold (fresh agent sees the new state sooner).
//
// Kill switch: ZCODE_ANCHORED_COMPACT=0 disables anchoring entirely.

import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface AnchorSourceMessage {
  readonly role: string;
  readonly text: string;
}

export interface SessionAnchors {
  readonly decisions: string[];
  readonly filePaths: string[];
  readonly errors: string[];
  readonly todoState: string[];
}

export const EMPTY_ANCHORS: SessionAnchors = {
  decisions: [],
  filePaths: [],
  errors: [],
  todoState: [],
};

const DECISION_PATTERNS = [
  /^decision\s*:/i,
  /\bdecided to\b/i,
  /\bwe (?:will|should)\b/i,
  /^conclusion\s*:/i,
];
const ERROR_PATTERNS = [/^error\s*:/i, /\bfailed\b/i, /\bexception\b/i, /stack trace/i];
const TODO_PATTERNS = [/^[-*]\s*\[[ x]\]/i, /^todo\s*:/i, /\btodo\b/i];
const FILE_PATH_PATTERN = /(?:^|[\s("'`])((?:[~.]?\/)?[\w.~-]+(?:\/[\w.~-]+)+\.\w+|`[^`\n]+\.\w+`)/g;
const BARE_FILE_PATTERN = /(?:^|[\s("'`])([\w.~-]+\.(?:ts|tsx|js|mjs|json|md|py|rs|go))\b/g;

function matchesAny(line: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(line));
}

function pushUnique(list: string[], value: string): void {
  const trimmed = value.trim().replace(/^`|`$/g, "");
  if (trimmed.length > 0 && !list.includes(trimmed)) list.push(trimmed);
}

function extractFilePaths(line: string, into: string[]): void {
  for (const pattern of [FILE_PATH_PATTERN, BARE_FILE_PATTERN]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      if (match[1]) pushUnique(into, match[1]);
    }
  }
}

/**
 * Extract anchors from message text. Heuristic and fail-open: unknown
 * shapes yield empty anchor lists, never an exception.
 */
export function extractSessionAnchors(
  messages: readonly AnchorSourceMessage[],
): SessionAnchors {
  const anchors: SessionAnchors = {
    decisions: [],
    filePaths: [],
    errors: [],
    todoState: [],
  };
  for (const message of messages) {
    if (!message || typeof message.text !== "string") continue;
    for (const line of message.text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (matchesAny(trimmed, DECISION_PATTERNS)) pushUnique(anchors.decisions, trimmed);
      if (matchesAny(trimmed, ERROR_PATTERNS)) pushUnique(anchors.errors, trimmed);
      if (matchesAny(trimmed, TODO_PATTERNS)) pushUnique(anchors.todoState, trimmed);
      extractFilePaths(trimmed, anchors.filePaths);
    }
  }
  return anchors;
}

/**
 * Archive the full transcript to disk BEFORE compaction. Returns the
 * archive path. Raw history is never lost even though the compacted
 * session drops the bulk.
 */
export async function archiveSessionTranscript(
  archiveDir: string,
  sessionId: string,
  messages: readonly AnchorSourceMessage[],
  anchors?: SessionAnchors,
): Promise<string> {
  await mkdir(archiveDir, { recursive: true });
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "session";
  const archivePath = join(
    archiveDir,
    `${safeSessionId}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  const payload = {
    archivedAt: new Date().toISOString(),
    sessionId,
    messageCount: messages.length,
    anchors: anchors ?? EMPTY_ANCHORS,
    messages: messages.map((message) => ({
      role: message.role,
      text: message.text,
    })),
  };
  await writeFile(archivePath, JSON.stringify(payload, null, 2), "utf8");
  return archivePath;
}

/** Summary prompt with anchors injected so the summarizer preserves them. */
export function buildAnchoredSummaryPrompt(anchors: SessionAnchors): string {
  const section = (title: string, items: readonly string[]): string =>
    items.length > 0
      ? [`${title}:`, ...items.map((item) => `- ${item}`)].join("\n")
      : `${title}: (none recorded)`;
  return [
    "Summarize the session below into a compact handoff for a fresh agent.",
    "You MUST preserve every item in the anchored lists verbatim — decisions,",
    "file paths, errors, and todo state carry forward; raw tool-output bulk",
    "is dropped.",
    "",
    section("Anchored decisions", anchors.decisions),
    "",
    section("Anchored file paths", anchors.filePaths),
    "",
    section("Anchored errors", anchors.errors),
    "",
    section("Anchored todo state", anchors.todoState),
  ].join("\n");
}

// ============================================================
// Rank 4: archive rotation, kill switch, boundary triggers
// ============================================================

/** Kill switch: ZCODE_ANCHORED_COMPACT=0 disables anchored compaction. */
export const ANCHORED_COMPACT_KILL_SWITCH_ENV = "ZCODE_ANCHORED_COMPACT";

/** How many archives to keep per session (default below). */
export const ANCHORED_ARCHIVE_KEEP_ENV = "ZCODE_ANCHORED_COMPACT_KEEP";

/** Default per-session archive cap. */
export const DEFAULT_ANCHORED_ARCHIVE_KEEP = 5;

/**
 * Boundary-compact watermark: fraction of the emergency compact threshold
 * at which a boundary event (plan stage / passing tests / verified subtask)
 * may trigger compaction early. Env ZCODE_BOUNDARY_COMPACT_WATERMARK.
 */
export const BOUNDARY_COMPACT_WATERMARK_ENV = "ZCODE_BOUNDARY_COMPACT_WATERMARK";

/** Default boundary watermark: 55% of the emergency compact threshold. */
export const DEFAULT_BOUNDARY_COMPACT_WATERMARK = 0.55;

function isFalsyEnvValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off"
  );
}

/**
 * Anchored-compaction kill switch. Default: enabled.
 * Fail-open: unreadable env never disables.
 */
export function isAnchoredCompactionEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    return !isFalsyEnvValue(env[ANCHORED_COMPACT_KILL_SWITCH_ENV]);
  } catch {
    return true;
  }
}

/** Default on-disk archive root for session transcripts. */
export function resolveAnchoredArchiveDir(homeDir: string): string {
  return join(homeDir, ".zcode-local", "speedstack", "compact-archives");
}

/** Per-session archive cap; invalid env values fall back to the default. */
export function resolveArchiveKeepCount(
  env: NodeJS.ProcessEnv = process.env,
): number {
  try {
    const raw = env[ANCHORED_ARCHIVE_KEEP_ENV];
    if (raw === undefined) return DEFAULT_ANCHORED_ARCHIVE_KEEP;
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_ANCHORED_ARCHIVE_KEEP;
  } catch {
    return DEFAULT_ANCHORED_ARCHIVE_KEEP;
  }
}

/**
 * Delete the oldest archives for a session beyond keepMax.
 * Filenames embed ISO timestamps, so lexicographic order is chronological.
 * Never throws; returns the number of archives removed.
 */
export async function rotateSessionArchives(
  archiveDir: string,
  sessionId: string,
  keepMax: number = DEFAULT_ANCHORED_ARCHIVE_KEEP,
): Promise<number> {
  try {
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "session";
    const files = (await readdir(archiveDir))
      .filter((file) => file.startsWith(`${safeSessionId}-`) && file.endsWith(".json"))
      .sort();
    if (files.length <= keepMax) return 0;
    let removed = 0;
    for (const file of files.slice(0, files.length - keepMax)) {
      try {
        await unlink(join(archiveDir, file));
        removed += 1;
      } catch {
        // fail-open: a stuck file must never break the turn
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

export interface AnchoredArchiveResult {
  readonly archivePath: string;
  readonly anchors: SessionAnchors;
}

/**
 * Archive the transcript with its anchors, then rotate old archives.
 * Fail-open for the rotation step only — a write failure still throws so
 * the caller can fall back to non-anchored compaction.
 */
export async function archiveSessionTranscriptWithAnchors(
  archiveDir: string,
  sessionId: string,
  messages: readonly AnchorSourceMessage[],
  keepMax: number = DEFAULT_ANCHORED_ARCHIVE_KEEP,
): Promise<AnchoredArchiveResult> {
  const anchors = extractSessionAnchors(messages);
  const archivePath = await archiveSessionTranscript(
    archiveDir,
    sessionId,
    messages,
    anchors,
  );
  await rotateSessionArchives(archiveDir, sessionId, keepMax);
  return { archivePath, anchors };
}

/**
 * Combine the caller's compact instructions with the anchored summary
 * prompt. Anchors are appended (never dropped) so the summarizer's custom
 * instructions stay primary.
 */
export function combineAnchoredInstructions(
  customInstructions: string | undefined,
  anchors: SessionAnchors,
): string {
  const anchored = buildAnchoredSummaryPrompt(anchors);
  const base = (customInstructions ?? "").trim();
  return base.length > 0 ? `${base}\n\n${anchored}` : anchored;
}

/** Boundary-compact event kinds that may trigger early compaction. */
export type BoundaryCompactEventKind = "plan-stage" | "tests-passed" | "subtask-verified";

/** Test-runner invocations we recognize as "tests ran". */
const TEST_COMMAND_PATTERN =
  /\b((npm|pnpm|yarn|bun)\s+(test|run\s+test)|pytest|vitest|jest|go\s+test|cargo\s+test|make\s+test)\b/i;

/** Positive outcome markers in test output (with success=true required). */
const TEST_SUCCESS_PATTERN = /\b(passed|passing|ok|success|exit code:? 0)\b/i;

/** Negative markers always veto the tests-passed event. */
const TEST_FAILURE_PATTERN = /\b(failed|failure|error|exit code:? [1-9])/i;

function extractBashCommand(toolInput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const command = (toolInput as Record<string, unknown>)["command"];
  return typeof command === "string" ? command : undefined;
}

/**
 * Conservative boundary-event detector for completed tool calls.
 * - "tests-passed": a recognized test command via Bash with tool success,
 *   no failure markers in the output.
 * - "subtask-verified": a TodoWrite call marking at least one todo completed.
 * Anything else: no event. Never throws.
 */
export function detectBoundaryEventFromToolCall(
  toolName: string,
  toolInput: unknown,
  toolResultText: string | undefined,
  toolSucceeded: boolean,
): BoundaryCompactEventKind | undefined {
  try {
    if (toolName === "Bash" && toolSucceeded) {
      const command = extractBashCommand(toolInput);
      if (command && TEST_COMMAND_PATTERN.test(command)) {
        const text = toolResultText ?? "";
        if (TEST_FAILURE_PATTERN.test(text)) return undefined;
        if (text.length === 0 || TEST_SUCCESS_PATTERN.test(text)) {
          return "tests-passed";
        }
      }
      return undefined;
    }
    if (toolName === "TodoWrite") {
      const serialized = JSON.stringify(toolInput ?? {});
      if (/"status"\s*:\s*"completed"/.test(serialized)) {
        return "subtask-verified";
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export interface BoundaryCompactDecisionInput {
  /** Fraction of the emergency compact threshold currently used (0..1+). */
  readonly tokenPressure: number;
  readonly hasBoundaryEvent: boolean;
  readonly watermark?: number | undefined;
}

/**
 * Boundary-compact fires only when BOTH hold: a boundary event was noted
 * AND token pressure is at/above the (lower) boundary watermark.
 * Pure helper so the policy is unit-testable; never throws.
 */
export function evaluateBoundaryCompactDecision(
  input: BoundaryCompactDecisionInput,
): boolean {
  try {
    const watermark = input.watermark ?? DEFAULT_BOUNDARY_COMPACT_WATERMARK;
    return input.hasBoundaryEvent && input.tokenPressure >= watermark;
  } catch {
    return false;
  }
}

/** Boundary watermark from env; invalid values fall back to the default. */
export function resolveBoundaryWatermark(
  env: NodeJS.ProcessEnv = process.env,
): number {
  try {
    const raw = env[BOUNDARY_COMPACT_WATERMARK_ENV];
    if (raw === undefined) return DEFAULT_BOUNDARY_COMPACT_WATERMARK;
    const value = Number.parseFloat(raw.trim());
    return Number.isFinite(value) && value > 0 && value < 1
      ? value
      : DEFAULT_BOUNDARY_COMPACT_WATERMARK;
  } catch {
    return DEFAULT_BOUNDARY_COMPACT_WATERMARK;
  }
}
