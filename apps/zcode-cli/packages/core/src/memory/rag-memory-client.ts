/**
 * duckbot-rag-memory backend client (opt-in RAG memory alternative).
 *
 * Speaks MCP JSON-RPC over NDJSON stdio to a persistent
 * `python -m src.mcp_server` process (duckbot exposes no HTTP API).
 * Used for session-init orientation recall and post-extraction mirroring.
 * Everything fails soft: callers catch `RagMemoryError` and continue with
 * the default Markdown memory (or no memory when that is off too).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";

export interface RagMemoryConfig {
  readonly enabled: boolean;
  readonly repoPath?: string;
  readonly persistDir?: string;
  readonly embedding?: string;
  readonly pythonPath?: string;
  readonly timeoutMs?: number;
}

export interface RagMemoryHit {
  readonly text: string;
  readonly source?: string;
  readonly tier?: string;
  readonly score?: number;
}

export interface RagMemoryRememberResult {
  readonly chunkId?: string;
  readonly tier?: string;
}

export class RagMemoryError extends Error {
  readonly detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = "RagMemoryError";
    this.detail = detail;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const INIT_TIMEOUT_MS = 60_000;
const MAX_STDERR_CHARS = 2000;

export function isRagMemoryConfigured(config: RagMemoryConfig | undefined): config is RagMemoryConfig {
  return !!config?.enabled && !!config.repoPath?.trim();
}

function timeoutMsOf(config: RagMemoryConfig): number {
  const value = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
}

export function expandRagPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return homedir() + trimmed.slice(1);
  return trimmed;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface McpProcess {
  child: ChildProcess;
  tail: string;
  nextId: number;
  pending: Map<number, PendingCall>;
  ready: Promise<void>;
  stderrTail: string;
  exited: boolean;
}

const processes = new Map<string, McpProcess>();

function processKey(config: RagMemoryConfig): string {
  return JSON.stringify({
    repo: config.repoPath,
    python: config.pythonPath || "python3",
    persist: config.persistDir ?? "",
    embedding: config.embedding ?? "auto",
  });
}

function failPending(proc: McpProcess, error: Error): void {
  for (const [, pending] of proc.pending) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  proc.pending.clear();
}

function pumpStdout(proc: McpProcess, chunk: Buffer): void {
  const parts = `${proc.tail}${chunk.toString("utf8")}`.split("\n");
  proc.tail = parts.pop() ?? "";
  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
    try {
      message = JSON.parse(trimmed) as { id?: unknown; result?: unknown; error?: { message?: unknown } };
    } catch {
      continue;
    }
    if (typeof message.id !== "number") continue;
    const pending = proc.pending.get(message.id);
    if (!pending) continue;
    proc.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const detail =
        typeof message.error.message === "string" ? message.error.message : "MCP error";
      pending.reject(new Error(detail));
    } else {
      pending.resolve(message.result ?? null);
    }
  }
}

function killProcess(key: string, proc: McpProcess): void {
  processes.delete(key);
  proc.exited = true;
  failPending(proc, new Error("RAG memory server exited"));
  try {
    proc.child.kill();
  } catch {
    // Already dead.
  }
}

/** Stop all cached RAG server processes (shutdown/tests). */
export function disposeRagMemoryClients(): void {
  for (const [key, proc] of processes) killProcess(key, proc);
}

async function getProcess(config: RagMemoryConfig, env: NodeJS.ProcessEnv): Promise<McpProcess> {
  const key = processKey(config);
  const existing = processes.get(key);
  if (existing && !existing.exited) {
    await existing.ready;
    return existing;
  }
  const rawRepo = config.repoPath?.trim();
  if (!rawRepo) throw new RagMemoryError("RAG memory repo path is not configured");
  const repoPath = expandRagPath(rawRepo);
  const pythonPath = config.pythonPath?.trim() || "python3";
  const childEnv: NodeJS.ProcessEnv = { ...env };
  if (config.persistDir?.trim()) childEnv.DUCKBOT_CHROMA_DIR = expandRagPath(config.persistDir);
  if (config.embedding && config.embedding !== "auto") {
    childEnv.DUCKBOT_EMBEDDING = config.embedding;
  }
  let child: ChildProcess;
  try {
    child = spawn(pythonPath, ["-m", "src.mcp_server"], {
      cwd: repoPath,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new RagMemoryError(
      `RAG memory server spawn failed: ${pythonPath} -m src.mcp_server`,
      error instanceof Error ? error.message : String(error),
    );
  }
  const proc: McpProcess = {
    child,
    tail: "",
    nextId: 1,
    pending: new Map(),
    ready: Promise.resolve(),
    stderrTail: "",
    exited: false,
  };
  processes.set(key, proc);
  child.stdout?.on("data", (chunk: Buffer) => pumpStdout(proc, chunk));
  child.stderr?.on("data", (chunk: Buffer) => {
    proc.stderrTail = `${proc.stderrTail}${chunk.toString("utf8")}`.slice(-MAX_STDERR_CHARS);
  });
  const onDead = (message: string): void => {
    if (processes.get(key) !== proc) return;
    killProcess(key, proc);
    void message;
  };
  child.on("error", (error: Error) => onDead(error.message));
  child.on("exit", (code: number | null) => onDead(`exit ${code ?? "?"}`));

  proc.ready = (async () => {
    try {
      await callRaw(proc, key, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "zcode", version: "rag-memory-1" },
      }, INIT_TIMEOUT_MS);
      // Initialized notification: no id, no response expected.
      proc.child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
    } catch (error) {
      killProcess(key, proc);
      throw new RagMemoryError(
        "RAG memory server handshake failed",
        `${error instanceof Error ? error.message : String(error)}${proc.stderrTail ? ` — ${proc.stderrTail.slice(-500)}` : ""}`,
      );
    }
  })();
  await proc.ready;
  return proc;
}

function callRaw(
  proc: McpProcess,
  key: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  if (proc.exited || !proc.child.stdin?.writable) {
    return Promise.reject(new Error("RAG memory server is not running"));
  }
  const id = proc.nextId++;
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.pending.delete(id);
      killProcess(key, proc);
      reject(new Error(`RAG memory call timed out: ${method}`));
    }, timeoutMs);
    proc.pending.set(id, { resolve, reject, timer });
    proc.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function toolTextPayload(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0] as { type?: unknown; text?: unknown };
  if (first?.type !== "text" || typeof first.text !== "string") return null;
  try {
    return JSON.parse(first.text) as unknown;
  } catch {
    return first.text;
  }
}

async function callTool(
  config: RagMemoryConfig,
  name: string,
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const proc = await getProcess(config, env);
  const key = processKey(config);
  let result: unknown;
  try {
    result = await callRaw(proc, key, "tools/call", { name, arguments: args }, timeoutMsOf(config));
  } catch (error) {
    throw new RagMemoryError(
      `RAG memory tool failed: ${name}`,
      error instanceof Error ? error.message : String(error),
    );
  }
  return toolTextPayload(result);
}

/**
 * Hybrid recall over the RAG store. Resolves with hits (possibly empty);
 * throws RagMemoryError when the backend is unreachable or misconfigured.
 */
export async function recallRagMemory(
  config: RagMemoryConfig,
  query: string,
  options: { k?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RagMemoryHit[]> {
  const payload = (await callTool(
    config,
    "recall",
    { query, k: options.k ?? 5 },
    options.env ?? process.env,
  )) as { results?: unknown; error?: unknown } | null;
  if (!payload || typeof payload !== "object") return [];
  if (typeof payload.error === "string") {
    throw new RagMemoryError("RAG memory recall failed", payload.error);
  }
  if (!Array.isArray(payload.results)) return [];
  const hits: RagMemoryHit[] = [];
  for (const entry of payload.results) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.text !== "string" || !record.text.trim()) continue;
    hits.push({
      text: record.text,
      ...(typeof record.source === "string" ? { source: record.source } : {}),
      ...(typeof record.tier === "string" ? { tier: record.tier } : {}),
      ...(typeof record.score === "number" ? { score: record.score } : {}),
    });
  }
  return hits;
}

/** Persist one text to the RAG store (auto-chunked/tiered by the server). */
export async function rememberRagMemory(
  config: RagMemoryConfig,
  text: string,
  options: { source?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RagMemoryRememberResult | null> {
  if (!text.trim()) return null;
  const payload = (await callTool(
    config,
    "remember",
    { text, source_path: options.source ?? "<zcode>" },
    options.env ?? process.env,
  )) as Record<string, unknown> | null;
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.error === "string") {
    throw new RagMemoryError("RAG memory remember failed", payload.error);
  }
  return {
    ...(typeof payload.chunk_id === "string" ? { chunkId: payload.chunk_id } : {}),
    ...(typeof payload.tier === "string" ? { tier: payload.tier } : {}),
  };
}
