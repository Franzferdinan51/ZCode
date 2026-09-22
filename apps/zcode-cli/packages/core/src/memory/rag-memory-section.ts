/**
 * RAG memory context section (duckbot-rag-memory, opt-in).
 *
 * Session-init orientation recall: one bounded hybrid query surfaces who
 * the user is, active projects, and durable facts. Appended to the memory
 * index content with a clear delimiter — works whether the default
 * Markdown memory is on or off. All failures resolve to undefined.
 */

import type { RagMemoryRuntimeConfig } from "../runtime/types.js";
import {
  isRagMemoryConfigured,
  recallRagMemory,
  type RagMemoryConfig,
} from "./rag-memory-client.js";

const ORIENTATION_QUERY =
  "who is the user, active projects, preferences, and durable facts to remember";
const ORIENTATION_K = 5;
const HIT_CHARS = 600;
const SECTION_CHARS = 4000;

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** Explicit runtime config wins; env vars allow config-file-free CLI use. */
export function resolveRagMemoryConfig(
  runtime: RagMemoryRuntimeConfig | undefined,
): RagMemoryConfig | undefined {
  const enabled = runtime?.enabled === true || readEnv("ZCODE_RAG_MEMORY") === "1";
  if (!enabled) return undefined;
  const repoPath = runtime?.repoPath?.trim() || readEnv("ZCODE_RAG_MEMORY_REPO");
  if (!repoPath) return undefined;
  const embedding = runtime?.embedding ?? readEnv("ZCODE_RAG_EMBEDDING");
  return {
    enabled: true,
    repoPath,
    persistDir: runtime?.persistDir?.trim() || readEnv("ZCODE_RAG_MEMORY_DIR"),
    embedding:
      embedding === "openai" ||
      embedding === "minimax" ||
      embedding === "lmstudio" ||
      embedding === "local"
        ? embedding
        : "auto",
    pythonPath: runtime?.pythonPath?.trim() || readEnv("ZCODE_RAG_MEMORY_PYTHON"),
  };
}

export async function loadRagMemoryOrientationSection(
  runtime: RagMemoryRuntimeConfig | undefined,
): Promise<string | undefined> {
  const config = resolveRagMemoryConfig(runtime);
  if (!config || !isRagMemoryConfigured(config)) return undefined;
  let hits;
  try {
    hits = await recallRagMemory(config, ORIENTATION_QUERY, { k: ORIENTATION_K });
  } catch {
    return undefined;
  }
  if (hits.length === 0) return undefined;
  const lines = hits.map((hit) => {
    const tag = hit.tier ? ` [${hit.tier}]` : "";
    const text = hit.text.replace(/\s+/g, " ").trim().slice(0, HIT_CHARS);
    return `- (${hit.source ?? "memory"}${tag}) ${text}`;
  });
  const section = ["[RAG memory orientation]", ...lines].join("\n");
  return section.slice(0, SECTION_CHARS);
}
