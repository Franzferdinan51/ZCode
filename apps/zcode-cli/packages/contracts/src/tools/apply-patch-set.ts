// ============================================================
// ApplyPatchSet Tool - Workflow Tool (atomic multi-file edit)
// ============================================================
// Applies a set of exact-string patches across multiple files as ONE
// tool call. Validation is atomic: every patch is validated against
// live file content BEFORE any write happens, so a bad patch fails
// the whole set instead of leaving half-applied edits behind.
//
// Each patch has the same semantics as the Edit tool (exact
// old_string match). Additive: Edit remains available for
// single-file edits.

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

export const ApplyPatchSetPatchSchema = z
  .object({
    /** Target file path. */
    file_path: z.string().describe("File to patch."),
    /** Exact string to replace. Must match the live file content. */
    old_string: z.string().describe("Exact text to replace (must match live content)."),
    /** Replacement text. */
    new_string: z.string().describe("Replacement text."),
    /**
     * Replace all occurrences instead of exactly one.
     * When false (default), more than one occurrence is an error.
     */
    replace_all: z
      .boolean()
      .optional()
      .describe("Replace all occurrences. Default false (exactly one expected)."),
  })
  .strict();

export type ApplyPatchSetPatch = z.infer<typeof ApplyPatchSetPatchSchema>;

export const ApplyPatchSetInputSchema = z
  .object({
    /**
     * Patches to apply. Validated atomically: if ANY patch fails
     * validation, NOTHING is written.
     */
    patches: z
      .array(ApplyPatchSetPatchSchema)
      .min(1)
      .max(20)
      .describe("Patches to apply (1-20). Atomic: all-or-nothing."),
    /**
     * Validate all patches against live content without writing.
     * Defaults to false.
     */
    dry_run: z
      .boolean()
      .optional()
      .describe("Validate only, write nothing. Defaults to false."),
  })
  .strict();

export type ApplyPatchSetInput = z.infer<typeof ApplyPatchSetInputSchema>;
export const ApplyPatchSetInputJsonSchema = toToolJsonSchema(ApplyPatchSetInputSchema);

// -----------------------------------------------
// Output Schema
// -----------------------------------------------

export const ApplyPatchSetPatchResultSchema = z
  .object({
    file_path: z.string(),
    /** True when this patch was applied (or validated in dry_run). */
    ok: z.boolean(),
    /** Machine-readable failure code when ok is false. */
    errorCode: z.string().optional(),
    /** Human-readable failure detail when ok is false. */
    message: z.string().optional(),
    /** True when this patch's write was rolled back after a later write failed. */
    rolledBack: z.boolean().optional(),
  })
  .strict();

export type ApplyPatchSetPatchResult = z.infer<typeof ApplyPatchSetPatchResultSchema>;

export const ApplyPatchSetOutputSchema = z
  .object({
    /** False when validation failed (nothing was written). */
    ok: z.boolean(),
    dry_run: z.boolean(),
    /** Patches applied. */
    applied: z.number().int().nonnegative(),
    /** Patches submitted. */
    total: z.number().int().nonnegative(),
    results: z.array(ApplyPatchSetPatchResultSchema),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();

export type ApplyPatchSetOutput = z.infer<typeof ApplyPatchSetOutputSchema>;
export const ApplyPatchSetOutputJsonSchema = toToolJsonSchema(ApplyPatchSetOutputSchema);

// -----------------------------------------------
// Tool Call Structure
// -----------------------------------------------

export interface ApplyPatchSetToolCall {
  id: ToolCallId;
  name: "ApplyPatchSet";
  input: ApplyPatchSetInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface ApplyPatchSetToolResult {
  toolCallId: ToolCallId;
  output: ApplyPatchSetOutput;
  traceId: TraceId;
  durationMs: number;
}

// -----------------------------------------------
// ApplyPatchSet Errors
// -----------------------------------------------

export const ApplyPatchSetErrorCode = {
  VALIDATION_FAILED: "apply_patch_set_validation_failed",
  INVALID_PATH: "apply_patch_set_invalid_path",
  PERMISSION_DENIED: "apply_patch_set_permission_denied",
  PATCH_TOO_LARGE: "apply_patch_set_patch_too_large",
  INVALID_INPUT: "apply_patch_set_invalid_input",
  DUPLICATE_TARGET: "apply_patch_set_duplicate_target",
  WRITE_FAILED: "apply_patch_set_write_failed",
  ROLLBACK_FAILED: "apply_patch_set_rollback_failed",
  NOT_APPLIED: "apply_patch_set_not_applied",
} as const;

export type ApplyPatchSetErrorCode =
  (typeof ApplyPatchSetErrorCode)[keyof typeof ApplyPatchSetErrorCode];
