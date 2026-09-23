// ============================================================
// Speed Stack: Ralph loop
// ============================================================
//
// Re-run a task in fresh sessions until a DONE marker appears in the
// iteration output (or the iteration reports tests passing via the marker).
// Guards: max-iteration cap + no-progress detector (identical output twice
// -> stop). Progress is persisted to a file so a fresh context can resume.
//
// The iteration function is injected: unit tests never spawn processes, and
// the caller wires the real session runner (expected to start each iteration
// with a fresh session to defeat context rot).

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_RALPH_MAX_ITERATIONS = 10;
export const DEFAULT_RALPH_DONE_MARKER = "<ralph-done>";
/** How many trailing identical outputs count as "no progress". */
const NO_PROGRESS_REPEAT_COUNT = 2;

export interface RalphLoopConfig {
  /** Hard cap on iterations. Default 10. */
  maxIterations?: number;
  /** Marker in iteration output that means the task is done. */
  doneMarker?: string;
  /** File the loop appends timestamped progress entries to. Required. */
  progressFile: string;
  /** Stop when the last two outputs are identical. Default true. */
  stopOnNoProgress?: boolean;
  /** Label used in progress-file entries. */
  taskLabel?: string;
}

export type RalphStopReason =
  | "done-marker"
  | "max-iterations"
  | "no-progress"
  | "iteration-error";

export interface RalphLoopOutcome {
  readonly stopReason: RalphStopReason;
  readonly iterations: number;
  readonly lastOutput: string;
}

/** Normalize output for comparison: trim + collapse whitespace. */
export function normalizeRalphOutput(output: string): string {
  return output.trim().replace(/\s+/g, " ");
}

/**
 * No-progress detector: the trailing outputs (default: last two) are
 * identical after normalization -> the loop is stuck, stop it.
 */
export function detectNoProgress(
  outputs: readonly string[],
  repeatCount: number = NO_PROGRESS_REPEAT_COUNT,
): boolean {
  if (outputs.length < repeatCount) return false;
  const tail = outputs.slice(-repeatCount).map(normalizeRalphOutput);
  return tail.every((output) => output === tail[0]);
}

/** Append a timestamped entry to the progress file (creates dirs). */
export async function appendRalphProgress(
  progressFile: string,
  entry: string,
): Promise<void> {
  await mkdir(dirname(progressFile), { recursive: true });
  const line = `[${new Date().toISOString()}] ${entry}\n`;
  await appendFile(progressFile, line, "utf8");
}

function resolveRalphConfig(config: RalphLoopConfig): Required<
  Omit<RalphLoopConfig, "taskLabel" | "progressFile">
> & { progressFile: string; taskLabel: string } {
  const maxIterations =
    Number.isFinite(config.maxIterations) && (config.maxIterations ?? 0) > 0
      ? Math.floor(config.maxIterations!)
      : DEFAULT_RALPH_MAX_ITERATIONS;
  return {
    maxIterations,
    doneMarker: config.doneMarker?.trim() || DEFAULT_RALPH_DONE_MARKER,
    progressFile: config.progressFile,
    stopOnNoProgress: config.stopOnNoProgress ?? true,
    taskLabel: config.taskLabel?.trim() || "ralph-task",
  };
}

/**
 * Run the loop. `runIteration` performs ONE attempt (fresh session) and
 * returns its output text; include the done marker when the task (or its
 * test gate) passes. Returns when the marker appears, the cap is hit, or
 * no progress is detected.
 */
export async function runRalphLoop(
  config: RalphLoopConfig,
  runIteration: (iteration: number, previousOutput: string | undefined) => Promise<string>,
): Promise<RalphLoopOutcome> {
  const resolved = resolveRalphConfig(config);
  if (!resolved.progressFile.trim()) {
    throw new Error("ralph loop requires a progressFile");
  }
  const outputs: string[] = [];
  let previousOutput: string | undefined;
  await appendRalphProgress(
    resolved.progressFile,
    `start task="${resolved.taskLabel}" maxIterations=${resolved.maxIterations}`,
  );
  for (let iteration = 1; iteration <= resolved.maxIterations; iteration++) {
    let output: string;
    try {
      output = await runIteration(iteration, previousOutput);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendRalphProgress(
        resolved.progressFile,
        `iteration=${iteration} error=${message}`,
      );
      return { stopReason: "iteration-error", iterations: iteration, lastOutput: message };
    }
    outputs.push(output);
    previousOutput = output;
    await appendRalphProgress(
      resolved.progressFile,
      `iteration=${iteration} outputChars=${output.length}`,
    );
    if (output.includes(resolved.doneMarker)) {
      await appendRalphProgress(resolved.progressFile, `stop reason=done-marker`);
      return { stopReason: "done-marker", iterations: iteration, lastOutput: output };
    }
    if (resolved.stopOnNoProgress && detectNoProgress(outputs)) {
      await appendRalphProgress(resolved.progressFile, `stop reason=no-progress`);
      return { stopReason: "no-progress", iterations: iteration, lastOutput: output };
    }
  }
  await appendRalphProgress(resolved.progressFile, `stop reason=max-iterations`);
  return {
    stopReason: "max-iterations",
    iterations: resolved.maxIterations,
    lastOutput: previousOutput ?? "",
  };
}
