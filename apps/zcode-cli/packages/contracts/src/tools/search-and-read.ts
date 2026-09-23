// ============================================================
// SearchAndRead Tool - Workflow Tool (search -> bounded read)
// ============================================================
// Composes Grep (content search) with bounded file reads so the
// model gets match context in ONE tool call instead of a
// Grep -> N x Read round-trip chain. Every extra round trip is a
// full local-inference step; this tool collapses the chain into one.
//
// Two modes:
// - "content": search for a pattern, return +-context windows
//   around each match for up to `max_files` files.
// - "files": list files matching a glob, return their full text
//   (bounded per file).
//
// Read-only. Additive: Grep/Read/Glob remain available.

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";

export const SearchAndReadMode = {
  Content: "content",
  Files: "files",
} as const;

export type SearchAndReadMode = (typeof SearchAndReadMode)[keyof typeof SearchAndReadMode];

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

const SearchAndReadInputBaseSchema = z.object({
  /**
   * "content" (default): search file contents for `pattern` and return
   * context windows around each match.
   * "files": list files matching `glob` and return their full text.
   */
  mode: z
    .enum(["content", "files"])
    .optional()
    .describe(
      '"content": search contents and return match windows. "files": read whole files matching glob. Defaults to "content".',
    ),
  /**
   * Ripgrep-compatible regular expression. Required in "content" mode.
   */
  pattern: z
    .string()
    .optional()
    .describe('Regex to search for. Required in "content" mode.'),
  /**
   * Glob filter for files. Required in "files" mode.
   */
  glob: z
    .string()
    .optional()
    .describe('Glob filter (e.g. "*.ts"). Required in "files" mode.'),
  /**
   * File or directory to search. Defaults to the current working directory.
   */
  path: z
    .string()
    .optional()
    .describe("File or directory to search. Defaults to current working directory."),
  /**
   * Lines of context around each match (content mode). Defaults to 3, max 20.
   */
  context_lines: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe("Lines of context around each match. Defaults to 3."),
  /**
   * Maximum files to read back. Defaults to 5, max 25.
   */
  max_files: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe("Max files to read back. Defaults to 5."),
  /**
   * Case insensitive search (content mode).
   */
  case_insensitive: z.boolean().optional().describe("Case insensitive search."),
});

export const SearchAndReadInputSchema = SearchAndReadInputBaseSchema.strict().superRefine(
  (value, context) => {
    const mode = value.mode ?? "content";
    if (mode === "content" && !value.pattern) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '"pattern" is required in "content" mode.',
        path: ["pattern"],
      });
    }
    if (mode === "files" && !value.glob) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '"glob" is required in "files" mode.',
        path: ["glob"],
      });
    }
  },
);

export type SearchAndReadInput = z.infer<typeof SearchAndReadInputSchema>;
export const SearchAndReadInputJsonSchema = toToolJsonSchema(SearchAndReadInputSchema);

// -----------------------------------------------
// Output Schema
// -----------------------------------------------

export const SearchAndReadFileResultSchema = z
  .object({
    /** File path (relative to the search root when possible). */
    path: z.string(),
    /** Number of matches found in this file (content mode). */
    matchCount: z.number().int().nonnegative(),
    /** True when the file was too large to read back inline. */
    tooLarge: z.boolean(),
    /** True when content was truncated by the per-file byte budget. */
    truncated: z.boolean(),
    /** Match windows (content mode) or full file text (files mode). */
    content: z.string(),
  })
  .strict();

export type SearchAndReadFileResult = z.infer<typeof SearchAndReadFileResultSchema>;

export const SearchAndReadOutputSchema = z
  .object({
    mode: z.enum(["content", "files"]),
    /** Files matched by the search before the max_files cap. */
    filesMatched: z.number().int().nonnegative(),
    /** Files actually read back. */
    filesRead: z.number().int().nonnegative(),
    /** Total matches across all files (content mode). */
    totalMatches: z.number().int().nonnegative(),
    /** True when filesMatched > filesRead (max_files cap hit). */
    capped: z.boolean(),
    results: z.array(SearchAndReadFileResultSchema),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();

export type SearchAndReadOutput = z.infer<typeof SearchAndReadOutputSchema>;
export const SearchAndReadOutputJsonSchema = toToolJsonSchema(SearchAndReadOutputSchema);

// -----------------------------------------------
// Tool Call Structure
// -----------------------------------------------

export interface SearchAndReadToolCall {
  id: ToolCallId;
  name: "SearchAndRead";
  input: SearchAndReadInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface SearchAndReadToolResult {
  toolCallId: ToolCallId;
  output: SearchAndReadOutput;
  traceId: TraceId;
  durationMs: number;
}

// -----------------------------------------------
// SearchAndRead Errors
// -----------------------------------------------

export const SearchAndReadErrorCode = {
  INVALID_PATTERN: "search_and_read_invalid_pattern",
  INVALID_PATH: "search_and_read_invalid_path",
  PERMISSION_DENIED: "search_and_read_permission_denied",
  TOO_LARGE: "search_and_read_too_large",
  INVALID_INPUT: "search_and_read_invalid_input",
} as const;

export type SearchAndReadErrorCode =
  (typeof SearchAndReadErrorCode)[keyof typeof SearchAndReadErrorCode];
