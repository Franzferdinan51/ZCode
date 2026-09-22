/* oxlint-disable eslint(max-lines) -- Driver table 与逐行 Parser 必须集中维护同一 HarnessDriverId 联合类型；拆文件会让 id/表/解析三处同步更脆弱。 */
/**
 * External harness drivers: how ZCode speaks to third-party coding CLIs in
 * their headless/JSON modes. Pure string/JSON logic (no Node imports) so the
 * backend executor and the UI can share driver metadata.
 *
 * Event shapes are grounded in real CLI output captured locally (codex, muse,
 * grok-local, mcode), real error-path samples (claude, opencode, mcode) and
 * upstream sources (gemini-cli stream-json-formatter types, opencode run.ts
 * emit vocabulary). Parsers are defensive: unknown lines/shapes are skipped,
 * never thrown.
 */

export type HarnessDriverId =
  | "codex"
  | "claude"
  | "gemini"
  | "opencode"
  | "muse"
  | "grok-local"
  | "mcode"
  | "hermes";

export type HarnessFrame =
  | { kind: "text"; delta: string }
  | { kind: "progress"; text: string }
  | { kind: "session"; id: string }
  | { kind: "usage"; inputTokens?: number; outputTokens?: number }
  | { kind: "error"; message: string; fatal: boolean }
  | { kind: "done" };

export interface HarnessArgInput {
  prompt: string;
  resumeSessionId?: string;
}

export interface HarnessParser {
  push(line: string): HarnessFrame[];
}

export interface HarnessUsageReport {
  readonly sessionId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface HarnessDriver {
  readonly id: HarnessDriverId;
  readonly binary: string;
  readonly displayName: string;
  /** Whether turns continue the harness's own session (else every turn is fresh). */
  readonly supportsResume: boolean;
  buildArgs(input: HarnessArgInput): string[];
  createParser(): HarnessParser;
  /**
   * Optional side-channel report: the executor appends `[flag, tmpPath]` to
   * the args and parses the file the CLI writes after the run. Pure parse —
   * file IO stays in the executor so this module keeps no Node imports.
   */
  readonly usageFile?: {
    readonly flag: string;
    parseReport(json: unknown): HarnessUsageReport;
  };
}

const MAX_PROGRESS_CHARS = 500;
const MAX_SESSION_ID_CHARS = 200;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function cleanSessionId(value: unknown): string | null {
  const id = asString(value);
  if (!id || id.length > MAX_SESSION_ID_CHARS) return null;
  return id;
}

function progress(text: string): HarnessFrame {
  return { kind: "progress", text: truncate(text, MAX_PROGRESS_CHARS) };
}

/** Best-effort message from a string-or-object error payload. */
function errorMessage(value: unknown): string | null {
  const direct = asString(value);
  if (direct) return direct;
  const record = asRecord(value);
  if (!record) return null;
  return (
    asString(record.message) ?? asString(record.error) ?? asString(record.text) ?? null
  );
}

/** Portion of a completion summary not already emitted as deltas. */
function unseenSuffix(streamed: string, summary: string | null): string | null {
  if (!summary) return null;
  if (!streamed) return summary;
  if (summary === streamed) return null;
  if (summary.startsWith(streamed)) return summary.slice(streamed.length) || null;
  return summary;
}

// ---------------------------------------------------------------------------
// Codex: `codex exec --json <prompt>`, resume via `codex exec resume <id> --json`.
// Shapes: thread.started, turn.started/completed/failed, item.started/updated/
// completed. Verified against a real local run.
// ---------------------------------------------------------------------------

function parseCodexItemCompleted(item: Record<string, unknown>): HarnessFrame[] {
  const itemType = asString(item.type);
  if (itemType === "agent_message") {
    const text = asString(item.text);
    return text ? [{ kind: "text", delta: text }] : [];
  }
  if (itemType === "reasoning") {
    const text = asString(item.text);
    return text ? [progress(`thinking: ${text}`)] : [];
  }
  if (itemType === "error") {
    const message = asString(item.message) ?? "harness reported an error item";
    return [progress(`note: ${message}`)];
  }
  if (itemType === "command_execution") {
    const command = asString(item.command) ?? asString(item.aggregated_output) ?? "shell";
    const status = asString(item.status);
    return [progress(`ran: ${command}${status ? ` (${status})` : ""}`)];
  }
  if (itemType === "file_change") {
    const path = asString(item.path) ?? "files";
    return [progress(`edited: ${path}`)];
  }
  if (itemType === "mcp_tool_call") {
    const name = asString(item.name) ?? asString(item.server) ?? "mcp tool";
    return [progress(`mcp tool: ${name}`)];
  }
  if (itemType === "web_search") {
    const query = asString(item.query) ?? "web";
    return [progress(`web search: ${query}`)];
  }
  return [];
}

function createCodexParser(): HarnessParser {
  return {
    push(line: string): HarnessFrame[] {
      const event = parseJsonLine(line);
      if (!event) return [];
      const type = asString(event.type);
      if (type === "thread.started") {
        const id = cleanSessionId(event.thread_id);
        return id ? [{ kind: "session", id }] : [];
      }
      if (type === "turn.completed") {
        const frames: HarnessFrame[] = [];
        const usage = asRecord(event.usage);
        if (usage) {
          frames.push({
            kind: "usage",
            inputTokens: asNonNegativeInt(usage.input_tokens),
            outputTokens: asNonNegativeInt(usage.output_tokens),
          });
        }
        frames.push({ kind: "done" });
        return frames;
      }
      if (type === "turn.failed") {
        const message = asString(event.message) ?? asString(event.error) ?? "harness turn failed";
        return [{ kind: "error", message, fatal: true }];
      }
      if (type === "item.completed") {
        const item = asRecord(event.item);
        return item ? parseCodexItemCompleted(item) : [];
      }
      // turn.started / item.started / item.updated carry no terminal content.
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Claude: `claude -p --verbose --output-format stream-json [--resume <id>]`.
// Envelope: system/assistant/user/result. Error path verified locally; success
// envelope follows the long-stable documented stream-json shape.
// ---------------------------------------------------------------------------

function createClaudeParser(): HarnessParser {
  let sawText = false;
  let sawSession = false;
  return {
    push(line: string): HarnessFrame[] {
      const event = parseJsonLine(line);
      if (!event) return [];
      const frames: HarnessFrame[] = [];
      const sessionId = !sawSession ? cleanSessionId(event.session_id) : null;
      if (sessionId) {
        sawSession = true;
        frames.push({ kind: "session", id: sessionId });
      }
      const type = asString(event.type);
      if (type === "assistant") {
        const message = asRecord(event.message);
        const content = message ? message.content : undefined;
        if (!Array.isArray(content)) return frames;
        for (const block of content) {
          const record = asRecord(block);
          if (!record) continue;
          if (record.type === "text") {
            const text = asString(record.text);
            if (text) {
              sawText = true;
              frames.push({ kind: "text", delta: text });
            }
          } else if (record.type === "tool_use") {
            const name = asString(record.name) ?? "tool";
            frames.push(progress(`tool: ${name}`));
          }
        }
        return frames;
      }
      if (type === "result") {
        if (event.is_error === true) {
          const message = errorMessage(event.result) ?? "harness run failed";
          frames.push({ kind: "error", message, fatal: true });
          return frames;
        }
        // result.result repeats streamed assistant text; only emit when the
        // stream carried no text (e.g. tool-only runs with a summary).
        if (!sawText) {
          const text = asString(event.result);
          if (text) frames.push({ kind: "text", delta: text });
        }
        const usage = asRecord(event.usage);
        if (usage) {
          frames.push({
            kind: "usage",
            inputTokens: asNonNegativeInt(usage.input_tokens),
            outputTokens: asNonNegativeInt(usage.output_tokens),
          });
        }
        frames.push({ kind: "done" });
        return frames;
      }
      // system (init/hooks) and user (tool echoes) carry nothing to display.
      return frames;
    },
  };
}

// ---------------------------------------------------------------------------
// Gemini: `gemini --output-format stream-json -p <prompt>`.
// Schema mirrors upstream JsonStreamEvent exactly
// (init/message/tool_use/tool_result/error/result). v1 runs every turn fresh:
// --resume takes latest|index (unsafe across sessions) and --session-id reuse
// semantics are unverified while local auth is dead.
// ---------------------------------------------------------------------------

function createGeminiParser(): HarnessParser {
  return {
    push(line: string): HarnessFrame[] {
      const event = parseJsonLine(line);
      if (!event) return [];
      const type = asString(event.type);
      if (type === "init") {
        const id = cleanSessionId(event.session_id);
        return id ? [{ kind: "session", id }] : [];
      }
      if (type === "message") {
        if (event.role !== "assistant") return [];
        const content = asString(event.content);
        return content ? [{ kind: "text", delta: content }] : [];
      }
      if (type === "tool_use") {
        const name = asString(event.tool_name) ?? "tool";
        return [progress(`tool: ${name}`)];
      }
      if (type === "tool_result") {
        const status = asString(event.status) ?? "done";
        const output = asString(event.output);
        return [progress(output ? `tool result (${status}): ${output}` : `tool result (${status})`)];
      }
      if (type === "error") {
        const message = asString(event.message) ?? "harness error";
        if (event.severity === "warning") return [progress(`warning: ${message}`)];
        return [{ kind: "error", message, fatal: false }];
      }
      if (type === "result") {
        if (event.status === "error") {
          const detail = asRecord(event.error);
          const message = (detail ? asString(detail.message) : null) ?? "harness run failed";
          return [{ kind: "error", message, fatal: true }];
        }
        const frames: HarnessFrame[] = [];
        const stats = asRecord(event.stats);
        if (stats) {
          frames.push({
            kind: "usage",
            inputTokens: asNonNegativeInt(stats.input_tokens),
            outputTokens: asNonNegativeInt(stats.output_tokens),
          });
        }
        frames.push({ kind: "done" });
        return frames;
      }
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// OpenCode: `opencode run [-s <id>] --format json <message>`.
// Vocabulary mirrors upstream run.ts emit(): text/reasoning/tool_use/
// step_start/step_finish/error over a {type, timestamp, sessionID} envelope.
// ---------------------------------------------------------------------------

function createOpencodeParser(): HarnessParser {
  let sawSession = false;
  return {
    push(line: string): HarnessFrame[] {
      const event = parseJsonLine(line);
      if (!event) return [];
      const frames: HarnessFrame[] = [];
      if (!sawSession) {
        const id = cleanSessionId(event.sessionID);
        if (id) {
          sawSession = true;
          frames.push({ kind: "session", id });
        }
      }
      const type = asString(event.type);
      const part = asRecord(event.part);
      if (type === "text") {
        const text = part ? asString(part.text) : null;
        if (text) frames.push({ kind: "text", delta: text });
        return frames;
      }
      if (type === "reasoning") {
        const text = part ? (asString(part.text) ?? asString(part.reasoning)) : null;
        if (text) frames.push(progress(`thinking: ${text}`));
        return frames;
      }
      if (type === "tool_use") {
        const name = part
          ? (asString(part.tool) ?? asString(part.name) ?? asString(part.type) ?? "tool")
          : "tool";
        frames.push(progress(`tool: ${name}`));
        return frames;
      }
      if (type === "error") {
        const detail = asRecord(event.error);
        const message =
          (detail ? (asString(detail.message) ?? asString(detail.data)) : null) ??
          "harness run failed";
        frames.push({ kind: "error", message, fatal: true });
        return frames;
      }
      // step_start/step_finish are orientation noise; the envelope carries no
      // terminal marker, so completion is signaled by process exit.
      return frames;
    },
  };
}

// ---------------------------------------------------------------------------
// Muse: `muse exec --json --session-id <uuid> <prompt>` (uuid minted per ZCode
// session; reuse continues the harness session — verified locally).
// Envelope: {stream: {kind, id}, payload_type, payload}. Deltas stream text;
// the terminal record repeats it, so only one side is emitted.
// ---------------------------------------------------------------------------

function createMuseParser(): HarnessParser {
  let sawText = false;
  let sawSession = false;
  return {
    push(line: string): HarnessFrame[] {
      const event = parseJsonLine(line);
      if (!event) return [];
      const frames: HarnessFrame[] = [];
      if (!sawSession) {
        const stream = asRecord(event.stream);
        const id = stream && stream.kind === "session" ? cleanSessionId(stream.id) : null;
        if (id) {
          sawSession = true;
          frames.push({ kind: "session", id });
        }
      }
      const payloadType = asString(event.payload_type);
      const payload = asRecord(event.payload);
      if (payloadType === "run.output.delta" && payload) {
        const text = asString(payload.text);
        if (text) {
          sawText = true;
          frames.push({ kind: "text", delta: text });
        }
        return frames;
      }
      if (payloadType === "run.terminal.completed" && payload) {
        if (payload.terminal !== "completed") {
          const reason = asString(payload.reason) ?? "harness run did not complete";
          frames.push({ kind: "error", message: reason, fatal: true });
          return frames;
        }
        if (!sawText) {
          const text = asString(payload.text);
          if (text) frames.push({ kind: "text", delta: text });
        }
        frames.push({ kind: "done" });
        return frames;
      }
      return frames;
    },
  };
}

// ---------------------------------------------------------------------------
// Grok Local: `grok-local -p <prompt> --output-format streaming-messages-json`
// (`-r <id>` resumes). Anthropic wire-format NDJSON verified live against LM
// Studio: system/init carries session_id, assistant messages carry whole
// content blocks, result repeats text plus usage. Whole-message granularity
// (no --include-partial-messages): same trade-off as the claude driver.
// ---------------------------------------------------------------------------

function createGrokLocalParser(): HarnessParser {
  let sawText = false;
  let sawSession = false;
  return {
    push(line: string): HarnessFrame[] {
      const event = parseJsonLine(line);
      if (!event) return [];
      const frames: HarnessFrame[] = [];
      if (!sawSession) {
        const id = cleanSessionId(event.session_id);
        if (id) {
          sawSession = true;
          frames.push({ kind: "session", id });
        }
      }
      const type = asString(event.type);
      if (type === "assistant") {
        const message = asRecord(event.message);
        const content = message ? message.content : undefined;
        if (!Array.isArray(content)) return frames;
        for (const block of content) {
          const record = asRecord(block);
          if (!record) continue;
          if (record.type === "text") {
            const text = asString(record.text);
            if (text) {
              sawText = true;
              frames.push({ kind: "text", delta: text });
            }
          } else if (record.type === "thinking") {
            const thinking = asString(record.thinking);
            if (thinking) frames.push(progress(`thinking: ${thinking}`));
          } else if (record.type === "tool_use") {
            const name = asString(record.name) ?? "tool";
            frames.push(progress(`tool: ${name}`));
          }
        }
        return frames;
      }
      if (type === "error") {
        const message = errorMessage(event) ?? "harness run failed";
        frames.push({ kind: "error", message, fatal: true });
        return frames;
      }
      if (type === "result") {
        if (event.is_error === true) {
          const message = errorMessage(event.result) ?? "harness run failed";
          frames.push({ kind: "error", message, fatal: true });
          return frames;
        }
        if (!sawText) {
          const text = asString(event.result);
          if (text) frames.push({ kind: "text", delta: text });
        }
        const usage = asRecord(event.usage);
        if (usage) {
          frames.push({
            kind: "usage",
            inputTokens: asNonNegativeInt(usage.input_tokens),
            outputTokens: asNonNegativeInt(usage.output_tokens),
          });
        }
        frames.push({ kind: "done" });
        return frames;
      }
      return frames;
    },
  };
}

// ---------------------------------------------------------------------------
// MiniMax Code: `mcode exec --output-format stream-json <prompt>`
// (`--session <id>` resumes — verified live). Envelope:
// exec.started/session.started/turn.started, item.started/item.updated with
// {id, type, contentDelta} deltas, item.completed with full content,
// turn.completed/failed, terminal exec.completed carrying exec.result.
// Verified live via BYOK (custom LM Studio provider + minimax_api key path).
// ---------------------------------------------------------------------------

function createMcodeParser(): HarnessParser {
  let sawSession = false;
  let streamedText = "";
  const streamedByItem = new Map<string, string>();
  const seenDeltaItems = new Set<string>();
  return {
    push(line: string): HarnessFrame[] {
      const event = parseJsonLine(line);
      if (!event) return [];
      const frames: HarnessFrame[] = [];
      if (!sawSession) {
        const id = cleanSessionId(event.sessionId);
        if (id) {
          sawSession = true;
          frames.push({ kind: "session", id });
        }
      }
      const type = asString(event.type);
      if (type === "item.started" || type === "item.updated") {
        const item = asRecord(event.item);
        const itemType = item ? asString(item.type) : null;
        const delta = item ? asString(item.contentDelta) : null;
        if (!item || !itemType || !delta) return frames;
        const itemId = asString(item.id) ?? `${itemType}:unkeyed`;
        seenDeltaItems.add(itemId);
        if (itemType === "agent_message") {
          streamedByItem.set(itemId, (streamedByItem.get(itemId) ?? "") + delta);
          streamedText += delta;
          frames.push({ kind: "text", delta });
        } else if (itemType === "reasoning") {
          frames.push(progress(delta));
        }
        // Other item types have no grounded shape yet; their completion
        // summary (if any) surfaces below as progress.
        return frames;
      }
      if (type === "item.completed") {
        const item = asRecord(event.item);
        const itemType = item ? asString(item.type) : null;
        if (!item || !itemType) return frames;
        const itemId = asString(item.id) ?? `${itemType}:unkeyed`;
        if (itemType === "agent_message") {
          const content = asString(item.content);
          // Deltas already streamed; emit only the verified unseen suffix
          // (full content when no deltas arrived, or when the summary
          // diverges from the streamed prefix).
          const unseen = unseenSuffix(streamedByItem.get(itemId) ?? "", content);
          if (unseen) {
            streamedByItem.set(itemId, (streamedByItem.get(itemId) ?? "") + unseen);
            streamedText += unseen;
            frames.push({ kind: "text", delta: unseen });
          }
          return frames;
        }
        if (itemType === "reasoning") {
          if (!seenDeltaItems.has(itemId)) {
            const content = asString(item.content);
            if (content) frames.push(progress(content));
          }
          return frames;
        }
        const summary = asString(item.content) ?? asString(item.title);
        if (summary) frames.push(progress(`${itemType}: ${summary}`));
        return frames;
      }
      if (type === "turn.failed") {
        const detail = asRecord(event.error);
        const message =
          (detail ? asString(detail.message) : null) ?? "harness turn failed";
        frames.push({ kind: "error", message, fatal: true });
        return frames;
      }
      if (type === "turn.completed") {
        const usage = asRecord(event.usage);
        if (usage) {
          frames.push({
            kind: "usage",
            inputTokens: asNonNegativeInt(usage.inputTokens),
            outputTokens: asNonNegativeInt(usage.outputTokens),
          });
        }
        return frames;
      }
      // Terminal record. stream-json nests it as exec.completed.result;
      // accept a bare exec.result line too (json mode emits exactly that).
      const result =
        type === "exec.completed"
          ? asRecord(event.result)
          : type === "exec.result"
            ? event
            : null;
      if (result) {
        if (result.status !== "succeeded") {
          const detail = asRecord(result.error);
          const message =
            (detail ? asString(detail.message) : null) ?? "harness run failed";
          frames.push({ kind: "error", message, fatal: true });
          return frames;
        }
        const output = asString(result.output);
        const unseen = unseenSuffix(streamedText, output);
        if (unseen) {
          streamedText += unseen;
          frames.push({ kind: "text", delta: unseen });
        }
        const usage = asRecord(result.usage);
        if (usage) {
          frames.push({
            kind: "usage",
            inputTokens: asNonNegativeInt(usage.inputTokens),
            outputTokens: asNonNegativeInt(usage.outputTokens),
          });
        }
        frames.push({ kind: "done" });
        return frames;
      }
      return frames;
    },
  };
}

// ---------------------------------------------------------------------------
// Hermes: `hermes -z <prompt>` (`--resume <id>` continues — verified live:
// a resumed one-shot recalled a planted word). One-shot prints ONLY the
// final response text, so the parser passes lines through as text. Session
// and usage arrive via `--usage-file` JSON
// ({session_id, input_tokens, output_tokens, completed, ...}).
// ---------------------------------------------------------------------------

function createHermesParser(): HarnessParser {
  let lineIndex = 0;
  return {
    push(line: string): HarnessFrame[] {
      const index = lineIndex++;
      // Rejoin stdout exactly: every line after the first restores its \n.
      const delta = index === 0 ? line : `\n${line}`;
      if (!delta) return [];
      return [{ kind: "text", delta }];
    },
  };
}

function parseHermesUsageReport(json: unknown): HarnessUsageReport {
  const report = asRecord(json);
  if (!report) return {};
  const sessionId = cleanSessionId(report.session_id);
  const inputTokens = asNonNegativeInt(report.input_tokens);
  const outputTokens = asNonNegativeInt(report.output_tokens);
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

export const HARNESS_DRIVERS: Record<HarnessDriverId, HarnessDriver> = {
  codex: {
    id: "codex",
    binary: "codex",
    displayName: "Codex",
    supportsResume: true,
    buildArgs: ({ prompt, resumeSessionId }) =>
      resumeSessionId
        ? ["exec", "resume", "--json", resumeSessionId, prompt]
        : ["exec", "--json", prompt],
    createParser: createCodexParser,
  },
  claude: {
    id: "claude",
    binary: "claude",
    displayName: "Claude",
    supportsResume: true,
    buildArgs: ({ prompt, resumeSessionId }) => [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
      prompt,
    ],
    createParser: createClaudeParser,
  },
  gemini: {
    id: "gemini",
    binary: "gemini",
    displayName: "Gemini",
    supportsResume: false,
    buildArgs: ({ prompt }) => ["--output-format", "stream-json", "-p", prompt],
    createParser: createGeminiParser,
  },
  opencode: {
    id: "opencode",
    binary: "opencode",
    displayName: "OpenCode",
    supportsResume: true,
    buildArgs: ({ prompt, resumeSessionId }) => [
      "run",
      ...(resumeSessionId ? ["--session", resumeSessionId] : []),
      "--format",
      "json",
      prompt,
    ],
    createParser: createOpencodeParser,
  },
  muse: {
    id: "muse",
    binary: "muse",
    displayName: "Muse",
    supportsResume: true,
    buildArgs: ({ prompt, resumeSessionId }) => {
      if (!resumeSessionId) throw new Error("muse driver requires a session id");
      return ["exec", "--json", "--session-id", resumeSessionId, prompt];
    },
    createParser: createMuseParser,
  },
  "grok-local": {
    id: "grok-local",
    binary: "grok-local",
    displayName: "Grok Local",
    supportsResume: true,
    buildArgs: ({ prompt, resumeSessionId }) => [
      ...(resumeSessionId ? ["-r", resumeSessionId] : []),
      "-p",
      prompt,
      "--output-format",
      "streaming-messages-json",
    ],
    createParser: createGrokLocalParser,
  },
  mcode: {
    id: "mcode",
    binary: "mcode",
    displayName: "MiniMax Code",
    supportsResume: true,
    buildArgs: ({ prompt, resumeSessionId }) => [
      "exec",
      ...(resumeSessionId ? ["--session", resumeSessionId] : []),
      "--output-format",
      "stream-json",
      prompt,
    ],
    createParser: createMcodeParser,
  },
  hermes: {
    id: "hermes",
    binary: "hermes",
    displayName: "Hermes",
    supportsResume: true,
    buildArgs: ({ prompt, resumeSessionId }) => [
      ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
      "-z",
      prompt,
    ],
    createParser: createHermesParser,
    usageFile: { flag: "--usage-file", parseReport: parseHermesUsageReport },
  },
};

export function getHarnessDriver(id: string): HarnessDriver | undefined {
  if (
    id === "codex" ||
    id === "claude" ||
    id === "gemini" ||
    id === "opencode" ||
    id === "muse" ||
    id === "grok-local" ||
    id === "mcode" ||
    id === "hermes"
  ) {
    return HARNESS_DRIVERS[id];
  }
  return undefined;
}

export function requireHarnessDriver(id: string): HarnessDriver {
  const driver = getHarnessDriver(id);
  if (!driver) {
    throw new Error(`Unknown harness driver: ${id}`);
  }
  return driver;
}
