/* eslint-disable max-lines -- workflow tool handler: two read modes + bounded truncation + entry metadata; the handler is one cohesive unit. */
// ============================================================
// SearchAndRead Tool Handler
// ============================================================
// Rank 7 workflow tool: composes Grep (content search) with bounded file
// reads so the model gets match context in ONE tool call instead of a
// Grep -> N x Read round-trip chain. Every extra round trip is a full
// local-inference step; collapsing the chain is the win.
//
// Two modes:
// - "content" (default): searchText for the pattern, then read bounded
//   +/- context_lines windows around each match via readTextFileRange.
//   Files are ranked by match count and capped at max_files.
// - "files": searchFiles for the glob, then read each file whole
//   (bounded by MAX_FILE_INLINE_BYTES).
//
// Read-only. Reads are stamped into the shared read-file state (see
// recordWorkflowToolRead in read.ts): full-file reads satisfy Edit's
// read-before-edit check, so SearchAndRead(files) -> Edit chains without
// a redundant Read; window reads are partial views (Edit still requires
// a full Read) but keep Read's unchanged-file dedup coherent.

import { relative, sep, isAbsolute } from "node:path";
import {
  CoreErrorType,
  SearchAndReadInputJsonSchema,
  SearchAndReadInputSchema,
  SearchAndReadOutputJsonSchema,
  SearchAndReadOutputSchema,
  createCoreError,
  isFileSystemPortError,
  type FileSystemPort,
  type SearchAndReadFileResult,
  type SearchAndReadInput,
  type SearchAndReadOutput,
  type TraceContext,
} from "@zcode/contracts";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
} from "../types.js";
import { resolveWorkspacePath } from "../path-policy.js";
import { addReadLineNumbers, recordWorkflowToolRead } from "./read.js";

const SEARCH_AND_READ_PROVIDER_DESCRIPTION = [
  "Search file contents (or list files) AND read the results back in one call — replaces a Grep -> N x Read chain.",
  "",
  "- content mode (default): give `pattern`; returns +/- `context_lines` windows around each match for up to `max_files` files.",
  "- files mode: give `glob`; returns the full text of up to `max_files` matching files.",
  "- Use this instead of Grep+Read when you will read the matches anyway — one call, one round trip.",
  "- Do NOT use it to search without reading (use Grep), or to read files you already know (use Read).",
].join("\n");

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_FILES = 5;
/** Per-file inline budget (files mode; content-mode windows are line-bounded). */
const MAX_FILE_INLINE_BYTES = 100_000;
/** Max window lines read back per file in content mode. */
const MAX_WINDOW_LINES_PER_FILE = 400;
/** Bound on raw search entries pulled before file ranking. */
const SEARCH_ENTRY_HEAD_LIMIT_MULTIPLIER = 50;
const SEARCH_AND_READ_TIMEOUT_MS = 30_000;

/**
 * Truncate a string to a true UTF-8 BYTE bound (not a char count). A
 * naive `slice(0, n)` on char count can exceed the budget by up to 4x
 * when the text is heavy on multi-byte code points. The cut never lands
 * in the middle of a multi-byte sequence: a trailing incomplete
 * character is dropped rather than decoded as U+FFFD. Pure.
 */
export function truncateUtf8ToByteBound(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // Walk back over UTF-8 continuation bytes (10xxxxxx) to the start of
  // the character the bound cuts into.
  while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end--;
  if (end > 0) {
    const lead = buf[end - 1];
    const seqLen = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    if (end - 1 + seqLen <= maxBytes) {
      // The cut character is complete within the bound — keep it.
      end = end - 1 + seqLen;
    } else {
      // The trailing character is incomplete — drop it (end lands on its
      // lead byte) rather than decoding a U+FFFD.
      end = end - 1;
    }
  }
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

function createSearchAndReadTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}

/** Display path: relative to the working directory when possible. */
function toDisplayPath(filePath: string, workingDirectory: string): string {
  const relativePath = relative(workingDirectory, filePath);
  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath.split(sep).join("/");
  }
  return filePath;
}

function resolveSearchRoot(
  parsed: SearchAndReadInput,
  context: ToolExecutionContext,
): string {
  if (parsed.path) {
    return resolveWorkspacePath({
      inputPath: parsed.path,
      operation: "read",
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
    });
  }
  return context.workspaceRoot ?? context.workingDirectory;
}

/** Display path: relative to the workspace root when possible. */
function displayPath(filePath: string, context: ToolExecutionContext): string {
  return toDisplayPath(filePath, context.workingDirectory);
}

const searchAndReadHandler: ToolHandler = async (input, context) => {
  const startedAt = Date.now();
  const parsed = SearchAndReadInputSchema.parse(input) as SearchAndReadInput;
  const mode = parsed.mode ?? "content";
  const fileSystemPort = context.fileSystemPort;

  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for SearchAndRead tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "SearchAndRead",
        },
        recoverable: false,
      },
    );
  }

  try {
    const body =
      mode === "files"
        ? await searchAndReadFiles(parsed, context, fileSystemPort)
        : await searchAndReadContent(parsed, context, fileSystemPort);
    const output: SearchAndReadOutput = {
      ...body,
      durationMs: Date.now() - startedAt,
    };
    return output;
  } catch (error) {
    if (isFileSystemPortError(error) && (error as { code?: string }).code === "cancelled") {
      throw createCoreError(CoreErrorType.ToolCancelled, "SearchAndRead was cancelled", {
        cause: error,
        context: {
          toolCallId: context.toolCallId,
          toolName: "SearchAndRead",
        },
        recoverable: true,
      });
    }
    throw error;
  }
};

async function searchAndReadContent(
  parsed: SearchAndReadInput,
  context: ToolExecutionContext,
  fileSystemPort: FileSystemPort,
): Promise<Omit<SearchAndReadOutput, "durationMs">> {
  const maxFiles = parsed.max_files ?? DEFAULT_MAX_FILES;
  const contextLines = parsed.context_lines ?? DEFAULT_CONTEXT_LINES;
  const searchPath = resolveSearchRoot(parsed, context);
  const trace = createSearchAndReadTrace(context);

  const result = await fileSystemPort.searchText(
    {
      path: searchPath,
      pattern: parsed.pattern as string,
      glob: parsed.glob,
      outputMode: "content",
      ignoreCase: parsed.case_insensitive,
      // No before/after context here: windows are read back below with
      // readTextFileRange so the bytes stay bounded per file.
      headLimit: maxFiles * SEARCH_ENTRY_HEAD_LIMIT_MULTIPLIER,
      trace,
    },
    { signal: context.abortSignal },
  );

  const lineNumbersByFile = new Map<string, number[]>();
  for (const entry of result.entries) {
    if (entry.lineNumber === undefined) continue;
    const list = lineNumbersByFile.get(entry.path);
    if (list) list.push(entry.lineNumber);
    else lineNumbersByFile.set(entry.path, [entry.lineNumber]);
  }
  // Rank files by match count: the most relevant files get read first.
  const ranked = [...lineNumbersByFile.entries()].sort((a, b) => b[1].length - a[1].length);
  const capped = ranked.length > maxFiles;

  const results: SearchAndReadFileResult[] = [];
  for (const [filePath, lineNumbers] of ranked.slice(0, maxFiles)) {
    results.push(await readMatchWindows(filePath, lineNumbers, contextLines, context, fileSystemPort));
  }

  return {
    mode: "content",
    filesMatched: ranked.length,
    filesRead: results.length,
    totalMatches: result.numMatches,
    capped,
    results,
  };
}

async function readMatchWindows(
  filePath: string,
  lineNumbers: number[],
  contextLines: number,
  context: ToolExecutionContext,
  fileSystemPort: FileSystemPort,
): Promise<SearchAndReadFileResult> {
  const trace = createSearchAndReadTrace(context);
  const sorted = [...new Set(lineNumbers)].sort((a, b) => a - b);
  // Merge match lines into [start, end] windows (1-based, inclusive).
  const windows: Array<[number, number]> = [];
  for (const line of sorted) {
    const start = Math.max(1, line - contextLines);
    const end = line + contextLines;
    const last = windows[windows.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else windows.push([start, end]);
  }

  const sections: string[] = [];
  let linesEmitted = 0;
  let truncated = false;
  for (const [start, end] of windows) {
    let windowEnd = end;
    if (linesEmitted + (windowEnd - start + 1) > MAX_WINDOW_LINES_PER_FILE) {
      windowEnd = start + (MAX_WINDOW_LINES_PER_FILE - linesEmitted) - 1;
      truncated = true;
    }
    if (windowEnd < start) {
      truncated = true;
      break;
    }
    const range = await fileSystemPort.readTextFileRange(
      {
        path: filePath,
        offsetLine: start - 1,
        limitLines: windowEnd - start + 1,
        trace,
      },
      { signal: context.abortSignal },
    );
    sections.push(
      `--- lines ${start}-${windowEnd} ---\n${addReadLineNumbers({ content: range.content, startLine: start })}`,
    );
    linesEmitted += windowEnd - start + 1;
    if (truncated) break;
  }
  const content = sections.join("\n");

  // Window reads are partial views: they keep read-dedup coherent but do
  // NOT satisfy Edit's read-before-edit check.
  const stat = await statQuietly(filePath, context, fileSystemPort, trace);
  recordWorkflowToolRead(context, {
    filePath,
    content,
    isPartialView: true,
    revisionId: stat?.revision?.id,
    mtimeMs: stat?.revision?.mtimeMs ?? stat?.mtimeMs,
    sizeBytes: stat?.sizeBytes,
  });

  return {
    path: displayPath(filePath, context),
    matchCount: sorted.length,
    tooLarge: false,
    truncated,
    content,
  };
}

async function searchAndReadFiles(
  parsed: SearchAndReadInput,
  context: ToolExecutionContext,
  fileSystemPort: FileSystemPort,
): Promise<Omit<SearchAndReadOutput, "durationMs">> {
  const maxFiles = parsed.max_files ?? DEFAULT_MAX_FILES;
  const searchPath = resolveSearchRoot(parsed, context);
  const trace = createSearchAndReadTrace(context);

  const result = await fileSystemPort.searchFiles(
    {
      path: searchPath,
      pattern: parsed.glob as string,
      trace,
    },
    { signal: context.abortSignal },
  );

  const capped = result.files.length > maxFiles;
  const results: SearchAndReadFileResult[] = [];
  for (const filePath of result.files.slice(0, maxFiles)) {
    results.push(await readWholeFileBounded(filePath, context, fileSystemPort));
  }

  return {
    mode: "files",
    filesMatched: result.numFiles,
    filesRead: results.length,
    totalMatches: 0,
    capped,
    results,
  };
}

async function readWholeFileBounded(
  filePath: string,
  context: ToolExecutionContext,
  fileSystemPort: FileSystemPort,
): Promise<SearchAndReadFileResult> {
  const trace = createSearchAndReadTrace(context);
  const stat = await statQuietly(filePath, context, fileSystemPort, trace);
  if (stat?.sizeBytes !== undefined && stat.sizeBytes > MAX_FILE_INLINE_BYTES) {
    return {
      path: displayPath(filePath, context),
      matchCount: 0,
      tooLarge: true,
      truncated: false,
      content: `(file too large to inline: ${stat.sizeBytes} bytes — use Read with offset/limit)`,
    };
  }
  const read = await fileSystemPort.readTextFile(
    { path: filePath, trace },
    { signal: context.abortSignal },
  );
  // Byte-bound truncation (UTF-8), not char-count: multi-byte text must
  // not blow the inline budget.
  const { text: content, truncated } = truncateUtf8ToByteBound(
    read.content,
    MAX_FILE_INLINE_BYTES,
  );
  // Full-file reads satisfy Edit's read-before-edit check: a
  // SearchAndRead(files) -> Edit chain needs no redundant Read.
  recordWorkflowToolRead(context, {
    filePath,
    content,
    isPartialView: truncated,
    revisionId: stat?.revision?.id ?? read.revision?.id,
    mtimeMs: stat?.revision?.mtimeMs ?? stat?.mtimeMs ?? read.revision?.mtimeMs,
    sizeBytes: stat?.sizeBytes,
  });
  return {
    path: displayPath(filePath, context),
    matchCount: 0,
    tooLarge: false,
    truncated,
    content,
  };
}

async function statQuietly(
  filePath: string,
  context: ToolExecutionContext,
  fileSystemPort: FileSystemPort,
  trace: TraceContext,
): Promise<
  { revision?: { id?: string; mtimeMs?: number }; mtimeMs?: number; sizeBytes?: number } | undefined
> {
  try {
    const stat = await fileSystemPort.stat({ path: filePath, trace }, { signal: context.abortSignal });
    return stat;
  } catch {
    return undefined;
  }
}

function formatSearchAndReadModelContent(output: unknown): string {
  const parsed = SearchAndReadOutputSchema.safeParse(output);
  if (!parsed.success) {
    return typeof output === "string" ? output : (JSON.stringify(output) ?? String(output));
  }
  const data = parsed.data;
  const lines = [
    `SearchAndRead (${data.mode}): read ${data.filesRead}/${data.filesMatched} files` +
      (data.capped ? " (capped by max_files)" : "") +
      (data.mode === "content" ? `, ${data.totalMatches} total matches` : "") +
      ".",
  ];
  for (const result of data.results) {
    const flags = [
      result.tooLarge ? "too large — not inlined" : "",
      result.truncated ? "truncated" : "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `\n### ${result.path}` +
        (data.mode === "content" ? ` (${result.matchCount} matches)` : "") +
        (flags ? ` [${flags}]` : ""),
      result.content,
    );
  }
  return lines.join("\n");
}

export const searchAndReadToolEntry: ToolEntry = {
  capability: "Search file contents or list files and read the matches back in one call",
  metadata: {
    name: "SearchAndRead",
    description: SEARCH_AND_READ_PROVIDER_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: SEARCH_AND_READ_TIMEOUT_MS,
    maxOutputBytes: 1_000_000,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: searchAndReadHandler,
  formatModelContent: formatSearchAndReadModelContent,
  inputSchema: SearchAndReadInputJsonSchema,
  outputSchema: SearchAndReadOutputJsonSchema,
  runtimeInputSchema: SearchAndReadInputSchema,
  runtimeOutputSchema: SearchAndReadOutputSchema,
  permission: {
    permission: "read",
    reason: "SearchAndRead only searches and reads file contents; no external side effects",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["path", "input"],
    alwaysAllowPatternSources: ["path", "input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 100_000,
    maxModelBytes: 100_000,
    strategy: "artifact",
    preview: {
      maxBytes: 20_000,
      direction: "head",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  timeout: {
    defaultMs: SEARCH_AND_READ_TIMEOUT_MS,
    maxMs: SEARCH_AND_READ_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "SearchAndRead was cancelled before results were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
