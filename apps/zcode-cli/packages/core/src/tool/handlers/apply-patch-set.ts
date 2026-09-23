// ============================================================
// ApplyPatchSet Tool Handler
// ============================================================
// Rank 7 workflow tool: applies a set of exact-string patches across
// multiple files as ONE tool call. The win over N x Edit is twofold:
// fewer model round trips (each a full local-inference step), and
// atomic validation — every patch is validated against LIVE file
// content BEFORE any write happens, so one bad patch fails the whole
// set instead of leaving half-applied edits behind.
//
// Each patch has Edit's exact-match semantics. The read-before-edit
// state check is intentionally skipped (see ValidateEditPatchOptions):
// validation matches every old_string against live content immediately
// before writing, which subsumes the check's purpose — the model cannot
// write stale content it never saw, because the exact text it supplies
// must exist in the current file.

import {
  ApplyPatchSetErrorCode,
  ApplyPatchSetInputJsonSchema,
  ApplyPatchSetInputSchema,
  ApplyPatchSetOutputJsonSchema,
  ApplyPatchSetOutputSchema,
  CoreErrorType,
  createCoreError,
  type ApplyPatchSetInput,
  type ApplyPatchSetOutput,
  type ApplyPatchSetPatchResult,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { validateEditPatch, writeEditResult, type ValidatedEditPatch } from "./edit.js";
import { createReadFileStateKey } from "../read-file-state.js";

const APPLY_PATCH_SET_PROVIDER_DESCRIPTION = [
  "Apply an atomic set of exact-string patches across up to 20 files in one call — all validated before any write; one bad patch fails the whole set with nothing written.",
  "",
  "- Each patch has Edit's exact-match semantics (unique old_string unless replace_all).",
  "- Atomic validation: every old_string is matched against LIVE content first; NOTHING is written if any patch fails.",
  "- Prefer this over N x Edit when changing the same text across multiple files (renames, signature changes).",
  "- Do NOT use for a single-file edit (use Edit), or to create files from scratch (use Write).",
  "- No read-before-edit requirement: old_string IS the freshness proof (it must match live content).",
].join("\n");

const APPLY_PATCH_SET_TIMEOUT_MS = 30_000;

const applyPatchSetHandler: ToolHandler = async (input, context) => {
  const startedAt = Date.now();
  const parsed = ApplyPatchSetInputSchema.parse(input) as ApplyPatchSetInput;
  const fileSystemPort = context.fileSystemPort;

  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for ApplyPatchSet tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "ApplyPatchSet",
        },
        recoverable: false,
      },
    );
  }

  const total = parsed.patches.length;
  const dryRun = parsed.dry_run === true;

  // Phase 1: validate EVERY patch against live content. Nothing is written yet.
  const validated: ValidatedEditPatch[] = [];
  const failures: Array<{ index: number; file_path: string; errorCode: string; message: string }> =
    [];
  for (let index = 0; index < total; index++) {
    const patch = parsed.patches[index];
    const validation = await validateEditPatch(patch, context, {
      skipReadStateCheck: true,
      toolName: "ApplyPatchSet",
    });
    if (validation.ok) {
      validated.push(validation.patch);
    } else {
      failures.push({
        index,
        file_path: patch.file_path,
        errorCode: `edit_error_${validation.failure.errorCode}`,
        message: validation.failure.message,
      });
    }
  }

  const finish = (
    body: Omit<ApplyPatchSetOutput, "durationMs">,
  ): ApplyPatchSetOutput => ({
    ...body,
    durationMs: Date.now() - startedAt,
  });

  if (failures.length > 0) {
    // Atomic: any validation failure => nothing is written.
    return finish({
      ok: false,
      dry_run: dryRun,
      applied: 0,
      total,
      results: parsed.patches.map((patch, index) => {
        const failure = failures.find((item) => item.index === index);
        if (failure) {
          return {
            file_path: patch.file_path,
            ok: false,
            errorCode: failure.errorCode,
            message: failure.message,
          } satisfies ApplyPatchSetPatchResult;
        }
        return {
          file_path: patch.file_path,
          ok: false,
          errorCode: ApplyPatchSetErrorCode.VALIDATION_FAILED,
          message:
            "Not applied: another patch in this set failed validation (atomic all-or-nothing).",
        } satisfies ApplyPatchSetPatchResult;
      }),
    });
  }

  // Phase 1b: reject duplicate targets. Two patches for the same file
  // would each validate against the same original content and then
  // overwrite each other — that is not atomic composition, it is a caller
  // error. Compare resolved paths so spelling variants collide too.
  // Runs before the dry-run short-circuit: a dry run must report the
  // duplicates the real run would reject.
  const seenTargets = new Set<string>();
  const duplicateTargets = new Set<string>();
  for (const patch of validated) {
    if (seenTargets.has(patch.filePath)) duplicateTargets.add(patch.filePath);
    seenTargets.add(patch.filePath);
  }
  if (duplicateTargets.size > 0) {
    const sorted = [...duplicateTargets].sort();
    return finish({
      ok: false,
      dry_run: dryRun,
      applied: 0,
      total,
      results: parsed.patches.map(
        (patch) =>
          ({
            file_path: patch.file_path,
            ok: false,
            errorCode: ApplyPatchSetErrorCode.DUPLICATE_TARGET,
            message: `Duplicate target in patch set: ${sorted.join(", ")}. One patch per file.`,
          }) satisfies ApplyPatchSetPatchResult,
      ),
    });
  }

  if (dryRun) {
    return finish({
      ok: true,
      dry_run: true,
      applied: 0,
      total,
      results: parsed.patches.map((patch) => ({
        file_path: patch.file_path,
        ok: true,
      })),
    });
  }

  // Phase 2: apply with rollback. Writes are sequential; if any write
  // fails, every completed write is restored from its captured original
  // (reverse order) and read state is restored to the pre-commit
  // snapshot, so the transaction stays all-or-nothing on IO failure too.
  const readStateSnapshot = context.readFileState
    ? new Map(context.readFileState)
    : undefined;
  const completed: ValidatedEditPatch[] = [];
  let failedIndex = -1;
  let writeError: unknown;
  for (let index = 0; index < validated.length; index++) {
    const patch = validated[index];
    try {
      await writeEditResult(patch);
      completed.push(patch);
    } catch (error) {
      failedIndex = index;
      writeError = error;
      break;
    }
  }

  if (failedIndex >= 0) {
    const rollbackErrors: string[] = [];
    for (let r = completed.length - 1; r >= 0; r--) {
      const patch = completed[r];
      try {
        // Raw restore: no memory-origin stamping, byte-identical original.
        await fileSystemPort.writeTextFile({
          path: patch.filePath,
          content: patch.originalFile,
        });
      } catch (error) {
        rollbackErrors.push(
          `${patch.inputFilePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const rollbackOk = rollbackErrors.length === 0;
    if (context.readFileState) {
      context.readFileState.clear();
      if (readStateSnapshot) {
        for (const [key, entry] of readStateSnapshot) context.readFileState.set(key, entry);
      }
    }
    const failedPatch = validated[failedIndex];
    return finish({
      ok: false,
      dry_run: false,
      applied: 0,
      total,
      results: parsed.patches.map((patch, index) => {
        if (index < failedIndex) {
          return (
            rollbackOk
              ? {
                  file_path: patch.file_path,
                  ok: false,
                  rolledBack: true,
                  message: "Rolled back: a later patch in this set failed to write.",
                }
              : {
                  file_path: patch.file_path,
                  ok: false,
                  rolledBack: false,
                  errorCode: ApplyPatchSetErrorCode.ROLLBACK_FAILED,
                  message: `Rollback failed (${rollbackErrors.join("; ")}); file may be partially updated.`,
                }
          ) satisfies ApplyPatchSetPatchResult;
        }
        if (index === failedIndex) {
          return {
            file_path: patch.file_path,
            ok: false,
            errorCode: ApplyPatchSetErrorCode.WRITE_FAILED,
            message: writeError instanceof Error ? writeError.message : String(writeError),
          } satisfies ApplyPatchSetPatchResult;
        }
        return {
          file_path: patch.file_path,
          ok: false,
          errorCode: ApplyPatchSetErrorCode.NOT_APPLIED,
          message: `Not applied: patch for ${failedPatch.inputFilePath} failed to write; the set was rolled back.`,
        } satisfies ApplyPatchSetPatchResult;
      }),
    });
  }

  // Success: every patch landed. Relabel the read-state entries stamped
  // by writeEditResult (sourceTool "Edit") so provenance is truthful.
  if (context.readFileState) {
    for (const patch of validated) {
      const key = createReadFileStateKey(patch.filePath, 1, undefined);
      const entry = context.readFileState.get(key);
      if (entry) entry.sourceTool = "ApplyPatchSet";
    }
  }

  return finish({
    ok: true,
    dry_run: false,
    applied: total,
    total,
    results: validated.map(
      (patch) =>
        ({
          file_path: patch.inputFilePath,
          ok: true,
        }) satisfies ApplyPatchSetPatchResult,
    ),
  });
};

function formatApplyPatchSetModelContent(output: unknown): string {
  const parsed = ApplyPatchSetOutputSchema.safeParse(output);
  if (!parsed.success) {
    return typeof output === "string" ? output : (JSON.stringify(output) ?? String(output));
  }
  const data = parsed.data;
  const lines = [
    data.ok
      ? `ApplyPatchSet: ${data.applied}/${data.total} patches applied${data.dry_run ? " (dry run — nothing written)" : ""}.`
      : `ApplyPatchSet FAILED validation: 0/${data.total} applied (atomic — nothing was written).`,
  ];
  for (const result of data.results) {
    lines.push(
      result.ok
        ? `- ${result.file_path}: ok`
        : `- ${result.file_path}: FAILED [${result.errorCode}] ${result.message}`,
    );
  }
  return lines.join("\n");
}

export const applyPatchSetToolEntry: ToolEntry = {
  capability: "Apply a set of exact-string patches across files atomically (all-or-nothing)",
  metadata: {
    name: "ApplyPatchSet",
    description: APPLY_PATCH_SET_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: APPLY_PATCH_SET_TIMEOUT_MS,
    maxOutputBytes: 100_000,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: applyPatchSetHandler,
  formatModelContent: formatApplyPatchSetModelContent,
  inputSchema: ApplyPatchSetInputJsonSchema,
  outputSchema: ApplyPatchSetOutputJsonSchema,
  runtimeInputSchema: ApplyPatchSetInputSchema,
  runtimeOutputSchema: ApplyPatchSetOutputSchema,
  permission: {
    permission: "edit",
    reason:
      "ApplyPatchSet modifies file contents through the file-system adapter (same operation class as Edit)",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["path"],
    alwaysAllowPatternSources: ["path"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 100_000,
    maxModelBytes: 20_000,
    strategy: "truncate",
    preview: {
      maxBytes: 20_000,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: APPLY_PATCH_SET_TIMEOUT_MS,
    maxMs: APPLY_PATCH_SET_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "ApplyPatchSet was cancelled before all patches were applied",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
