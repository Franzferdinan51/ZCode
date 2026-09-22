import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HarnessDriver,
  HarnessDriverId,
  HarnessFrame,
} from "@zcode/shared/harness-drivers";
import {
  ModelErrorCode,
  ModelFailureReason,
  ModelProtocolError,
  modelMessageContentToText,
  type ModelEvent,
  type ModelInputMessage,
  type ModelResult,
  type ModelUsage,
} from "@zcode/contracts";
import type { ModelExecutionRequest, ModelExecutor } from "../model.js";
import { HarnessSessionStore } from "./session-store.js";

export const HARNESS_DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_REASONING_CHARS_PER_TURN = 20_000;
const MAX_STDERR_CHARS = 1000;
const KILL_GRACE_MS = 5000;

export interface HarnessConsent {
  isGranted(driverId: HarnessDriverId): boolean;
}

export interface HarnessExecutorOptions {
  driver: HarnessDriver;
  sessions: HarnessSessionStore;
  consent: HarnessConsent;
  /** Registry model id; forwarded so drivers can select real CLI models. */
  modelId?: string;
  /** Absolute binary override (e.g. user-configured install path). */
  binaryPath?: string;
  /** Spawn working directory; must be the session workspace. */
  workingDirectory?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  spawnFn?: typeof spawn;
}

function fail(
  code: (typeof ModelErrorCode)[keyof typeof ModelErrorCode],
  message: string,
  options?: {
    reason?: (typeof ModelFailureReason)[keyof typeof ModelFailureReason];
    retryable?: boolean;
    context?: Record<string, unknown>;
  },
): never {
  throw new ModelProtocolError(code, message, {
    reason: options?.reason ?? ModelFailureReason.ProviderNotConfigured,
    retryable: options?.retryable ?? false,
    source: "runtime",
    ...options?.context,
  });
}

function providerContext(driverId: string): Record<string, unknown> {
  return { providerId: `external-${driverId}` };
}

function lastUserText(messages: ModelInputMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === "user") {
      return modelMessageContentToText(message.content).trim();
    }
  }
  return "";
}

function resolveOnPath(binary: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (!/^[\w@+.-]+$/.test(binary)) return null;
  const pathEnv = env.PATH;
  if (!pathEnv) return null;
  const delimiter = platform === "win32" ? ";" : ":";
  const separator = platform === "win32" ? "\\" : "/";
  const extensions =
    platform === "win32" && !binary.includes(".")
      ? (env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT", ".COM"])
      : [""];
  for (const entry of pathEnv.split(delimiter)) {
    if (!entry) continue;
    for (const extension of extensions) {
      const candidate = `${entry}${separator}${binary}${extension}`;
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // keep scanning
      }
    }
  }
  return null;
}

interface CollectedRun {
  text: string;
  usage: ModelUsage;
  harnessSessionId?: string;
  sawContent: boolean;
  fatalError?: string;
}

export function createHarnessExecutor(options: HarnessExecutorOptions): ModelExecutor {
  const {
    driver,
    sessions,
    consent,
    modelId,
    binaryPath,
    workingDirectory,
    timeoutMs = HARNESS_DEFAULT_TIMEOUT_MS,
    env = process.env,
    spawnFn = spawn,
  } = options;

  async function* streamRun(request: ModelExecutionRequest): AsyncGenerator<ModelEvent> {
    if (!consent.isGranted(driver.id)) {
      fail(ModelErrorCode.ProviderNotConfigured, `Routing to ${driver.displayName} needs consent: enable "${driver.displayName} may execute tools" in the Harness Router first.`, {
      context: providerContext(driver.id),
    });
    }
    const prompt = lastUserText(request.messages);
    if (!prompt) {
      fail(ModelErrorCode.InvalidModelRequest, "Routed turn has no user text to send.", {
      reason: ModelFailureReason.InvalidRequest,
      context: providerContext(driver.id),
    });
    }
    const binary = binaryPath ?? resolveOnPath(driver.binary, env, process.platform);
    if (!binary) {
      fail(ModelErrorCode.ProviderNotConfigured, `${driver.displayName} CLI (${driver.binary}) was not found on PATH. Install it or configure an explicit binary path.`, {
      context: providerContext(driver.id),
    });
    }

    // Muse-style drivers need a caller-minted id; the rest resume by captured id.
    const resumeId =
      driver.id === "muse" ? sessions.getOrMint(driver.id) : sessions.get(driver.id);
    const args = driver.buildArgs({
      prompt,
      ...(resumeId === undefined ? {} : { resumeSessionId: resumeId }),
      ...(modelId === undefined ? {} : { modelId }),
    });
    // Side-channel reports (hermes --usage-file): the CLI writes session and
    // usage JSON after the run. A broken tmp dir degrades to no report rather
    // than failing the turn; resume simply won't continue that once.
    let usageReportDir: string | null = null;
    let usageReportPath: string | null = null;
    if (driver.usageFile) {
      try {
        usageReportDir = mkdtempSync(join(tmpdir(), "zcode-harness-"));
        usageReportPath = join(usageReportDir, "usage.json");
        args.push(driver.usageFile.flag, usageReportPath);
      } catch {
        usageReportDir = null;
        usageReportPath = null;
      }
    }

    yield { type: "start" };
    const collected: CollectedRun = { text: "", usage: {}, sawContent: false };
    let textOpen = false;
    let reasoningOpen = false;
    let reasoningChars = 0;
    let reasoningTrimmed = false;
    let nonEmptyLines = 0;

    const child = spawnFn(binary, args, {
      cwd: workingDirectory ?? process.cwd(),
      env: { ...env },
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so abort/timeout kills the whole harness tree,
      // releasing piped stdio readers that grandchildren would otherwise hold.
      detached: process.platform !== "win32",
    });
    const stderrChunks: string[] = [];
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, timeoutMs);
    const onAbort = () => killChild(child);
    request.abortSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      const parser = driver.createParser();
      let buffer = "";
      const stdout = child.stdout;
      if (stdout) {
        try {
          for await (const chunk of stdout as AsyncIterable<Buffer | string>) {
            if (request.abortSignal?.aborted || timedOut || collected.fatalError) break;
            buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
            let newline = buffer.indexOf("\n");
            while (newline >= 0 && !collected.fatalError) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              if (line.trim()) nonEmptyLines += 1;
              for (const frame of parser.push(line)) {
                yield* emitFrame(frame, collected, tracker());
                if (collected.fatalError) break;
              }
              newline = buffer.indexOf("\n");
            }
          }
        } catch (error) {
          // Destroying stdio on abort/timeout tears down the reader mid-flight.
          if (!request.abortSignal?.aborted && !timedOut) throw error;
        }
        if (!request.abortSignal?.aborted && !timedOut && !collected.fatalError && buffer.trim()) {
          nonEmptyLines += 1;
          for (const frame of parser.push(buffer)) {
            yield* emitFrame(frame, collected, tracker());
          }
        }
      }
      if (collected.fatalError) killChild(child);
      const exit = await waitForExit(child);
      if (request.abortSignal?.aborted) {
        yield* closeBlocks();
        return;
      }
      if (timedOut) {
        fail(ModelErrorCode.ModelRequestTimeout, `${driver.displayName} run exceeded ${Math.round(timeoutMs / 1000)}s and was stopped.`, {
          reason: ModelFailureReason.Unknown,
          retryable: true,
          context: providerContext(driver.id),
        });
      }
      if (collected.fatalError) {
        const stderr = stderrChunks.join("").trim().slice(-MAX_STDERR_CHARS);
        fail(ModelErrorCode.ModelRequestFailed, `${driver.displayName}: ${collected.fatalError}.${stderr ? ` Stderr: ${stderr}` : ""}`, {
          reason: ModelFailureReason.Unknown,
          context: providerContext(driver.id),
        });
      }
      if (exit.code !== 0) {
        const stderr = stderrChunks.join("").trim().slice(-MAX_STDERR_CHARS);
        fail(ModelErrorCode.ModelRequestFailed, `${driver.displayName} exited with code ${exit.code ?? "signal"}.${stderr ? ` Stderr: ${stderr}` : ""}`, {
          reason: ModelFailureReason.Unknown,
          context: providerContext(driver.id),
        });
      }
      applyUsageReport(driver, usageReportPath, sessions, collected);
      if (!collected.sawContent && nonEmptyLines === 0) {
        fail(ModelErrorCode.InvalidModelResponse, `${driver.displayName} produced no output. The harness may need interactive setup (auth/login) first.`, {
          reason: ModelFailureReason.Unknown,
          context: providerContext(driver.id),
        });
      }
      if (!collected.sawContent && nonEmptyLines > 0) {
        fail(ModelErrorCode.InvalidModelResponse, `${driver.displayName} output ${nonEmptyLines} line(s) in an unrecognized format; the CLI version may have changed its JSON events.`, {
          reason: ModelFailureReason.Unknown,
          context: providerContext(driver.id),
        });
      }
      yield* closeBlocks();
      yield {
        type: "finish",
        finishReason: "stop",
        usage: collected.usage,
        providerMetadata: collected.harnessSessionId
          ? { harnessSessionId: collected.harnessSessionId }
          : undefined,
      };
    } finally {
      clearTimeout(timer);
      request.abortSignal?.removeEventListener("abort", onAbort);
      killChild(child);
      if (usageReportDir) {
        try {
          rmSync(usageReportDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }

    function tracker() {
      return {
        get textOpen() {
          return textOpen;
        },
        set textOpen(value: boolean) {
          textOpen = value;
        },
        get reasoningOpen() {
          return reasoningOpen;
        },
        set reasoningOpen(value: boolean) {
          reasoningOpen = value;
        },
      };
    }

    function* closeBlocks(): Generator<ModelEvent> {
      if (textOpen) {
        textOpen = false;
        yield { type: "text_end", id: "harness-text" };
      }
      if (reasoningOpen) {
        reasoningOpen = false;
        yield { type: "reasoning_end", id: "harness-progress" };
      }
    }

    function* emitFrame(
      frame: HarnessFrame,
      run: CollectedRun,
      blocks: { textOpen: boolean; reasoningOpen: boolean },
    ): Generator<ModelEvent> {
      switch (frame.kind) {
        case "text": {
          if (!blocks.textOpen) {
            blocks.textOpen = true;
            yield { type: "text_start", id: "harness-text" };
          }
          run.text += frame.delta;
          run.sawContent = true;
          yield { type: "text_delta", text: frame.delta };
          return;
        }
        case "progress": {
          if (!blocks.reasoningOpen) {
            blocks.reasoningOpen = true;
            yield { type: "reasoning_start", id: "harness-progress" };
          }
          if (reasoningChars < MAX_REASONING_CHARS_PER_TURN) {
            const room = MAX_REASONING_CHARS_PER_TURN - reasoningChars;
            const slice = frame.text.length > room ? `${frame.text.slice(0, room)}…` : frame.text;
            reasoningChars += slice.length;
            run.sawContent = true;
            yield { type: "reasoning_delta", text: `${slice}\n` };
          } else if (!reasoningTrimmed) {
            reasoningTrimmed = true;
            yield { type: "reasoning_delta", text: "…[progress trimmed]\n" };
          }
          return;
        }
        case "session": {
          sessions.set(driver.id, frame.id);
          run.harnessSessionId = frame.id;
          run.sawContent = true;
          return;
        }
        case "usage": {
          if (frame.inputTokens !== undefined) run.usage.inputTokens = frame.inputTokens;
          if (frame.outputTokens !== undefined) run.usage.outputTokens = frame.outputTokens;
          if (run.usage.inputTokens !== undefined || run.usage.outputTokens !== undefined) {
            run.usage.totalTokens =
              (run.usage.inputTokens ?? 0) + (run.usage.outputTokens ?? 0);
          }
          run.sawContent = true;
          return;
        }
        case "error": {
          if (frame.fatal) {
            // Record instead of throwing: the run loop stops reading, kills
            // the child, and fails after exit with the stderr tail attached.
            run.fatalError = frame.message;
            return;
          }
          if (!blocks.reasoningOpen) {
            blocks.reasoningOpen = true;
            yield { type: "reasoning_start", id: "harness-progress" };
          }
          run.sawContent = true;
          yield { type: "reasoning_delta", text: `note: ${frame.message}\n` };
          return;
        }
        case "done": {
          run.sawContent = true;
          return;
        }
      }
    }
  }

  return {
    streamText(request: ModelExecutionRequest): AsyncIterable<ModelEvent> {
      return streamRun(request);
    },
    async generateText(request: ModelExecutionRequest): Promise<ModelResult> {
      let text = "";
      let usage: ModelUsage = {};
      for await (const event of streamRun(request)) {
        if (event.type === "text_delta") text += event.text;
        if (event.type === "finish") usage = event.usage;
      }
      return { text, finishReason: "stop", usage };
    },
  };
}

function applyUsageReport(
  driver: HarnessDriver,
  reportPath: string | null,
  sessions: HarnessSessionStore,
  collected: CollectedRun,
): void {
  if (!driver.usageFile || !reportPath) return;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return;
  }
  let report;
  try {
    report = driver.usageFile.parseReport(json);
  } catch {
    return;
  }
  if (report.sessionId) {
    sessions.set(driver.id, report.sessionId);
    collected.harnessSessionId = report.sessionId;
  }
  if (report.inputTokens !== undefined) collected.usage.inputTokens = report.inputTokens;
  if (report.outputTokens !== undefined) collected.usage.outputTokens = report.outputTokens;
  if (collected.usage.inputTokens !== undefined || collected.usage.outputTokens !== undefined) {
    collected.usage.totalTokens =
      (collected.usage.inputTokens ?? 0) + (collected.usage.outputTokens ?? 0);
  }
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Negative pid targets the child's process group (spawned detached on POSIX).
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // fall through to direct kill
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

function killChild(child: ChildProcess): void {
  signalTree(child, "SIGTERM");
  try {
    child.stdout?.destroy();
  } catch {
    // already closed
  }
  try {
    child.stderr?.destroy();
  } catch {
    // already closed
  }
  setTimeout(() => {
    signalTree(child, "SIGKILL");
  }, KILL_GRACE_MS).unref?.();
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code }));
  });
}
