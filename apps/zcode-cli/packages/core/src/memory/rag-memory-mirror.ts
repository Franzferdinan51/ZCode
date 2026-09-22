/**
 * Mirror Markdown memory files into duckbot-rag-memory (opt-in write path).
 *
 * After a successful extraction run, new/changed `.md` fact files are sent
 * to RAG `remember()` (auto-chunked/tiered server-side). Content-hash
 * dedupe (`<memoryRoot>/.rag-mirrored.json`) guarantees each version is
 * remembered once. Fail-soft: any error resolves silently.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RagMemoryRuntimeConfig } from "../runtime/types.js";
import {
  isRagMemoryConfigured,
  rememberRagMemory,
} from "./rag-memory-client.js";
import { resolveRagMemoryConfig } from "./rag-memory-section.js";

const LEDGER_FILE = ".rag-mirrored.json";
const MAX_FILES_PER_RUN = 10;
const MAX_FILE_CHARS = 8000;

async function readLedger(memoryRoot: string): Promise<Set<string>> {
  try {
    const raw = await readFile(join(memoryRoot, LEDGER_FILE), "utf8");
    const parsed = JSON.parse(raw) as { hashes?: unknown };
    if (!Array.isArray(parsed.hashes)) return new Set();
    return new Set(parsed.hashes.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    return new Set();
  }
}

export async function mirrorMemoryRootToRag(options: {
  memoryRoot: string;
  rag: RagMemoryRuntimeConfig | undefined;
  sourceTag: string;
}): Promise<{ remembered: number }> {
  const config = resolveRagMemoryConfig(options.rag);
  if (!config || !isRagMemoryConfigured(config)) return { remembered: 0 };
  let files: string[];
  try {
    files = (await readdir(options.memoryRoot)).filter((file) => file.endsWith(".md")).sort();
  } catch {
    return { remembered: 0 };
  }
  const ledger = await readLedger(options.memoryRoot);
  let remembered = 0;
  let dirty = false;
  for (const file of files.slice(0, MAX_FILES_PER_RUN)) {
    let content: string;
    try {
      content = (await readFile(join(options.memoryRoot, file), "utf8")).slice(0, MAX_FILE_CHARS);
    } catch {
      continue;
    }
    if (!content.trim()) continue;
    const hash = createHash("sha256").update(content).digest("hex");
    if (ledger.has(hash)) continue;
    try {
      await rememberRagMemory(config, content, { source: `${options.sourceTag}:${file}` });
    } catch {
      // Backend hiccup: stop this run, retry fresh files next time.
      break;
    }
    ledger.add(hash);
    dirty = true;
    remembered += 1;
  }
  if (dirty) {
    try {
      await mkdir(options.memoryRoot, { recursive: true });
      await writeFile(join(options.memoryRoot, LEDGER_FILE), JSON.stringify({ hashes: [...ledger] }));
    } catch {
      // Ledger write is best-effort; worst case a file is remembered twice.
    }
  }
  return { remembered };
}
