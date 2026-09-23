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

import { mkdir, writeFile } from "node:fs/promises";
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
