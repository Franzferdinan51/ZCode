// ============================================================
// Speed Stack eval harness: measure built-in tool schema sizes
// ============================================================
//
// Generates eval/tool-schema-sizes.json from the REAL built-in tool
// entries (name + description + inputSchema char counts), so the
// harness's schema-token deltas are measured, not invented.
//
// Usage (from apps/zcode-cli/packages/core):
//   tsx src/speedstack/eval/measure-tool-schemas.ts [--out <file>]
//
// The JSON is checked in; re-run after touching tool descriptions or
// schemas. The harness loads it via --schema-sizes (default: the
// checked-in file).

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtInTools } from "../../tool/handlers/index.js";

const here = dirname(fileURLToPath(import.meta.url));

interface ToolSchemaSize {
  name: string;
  chars: number;
  descriptionChars: number;
  schemaChars: number;
}

function main(): void {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath =
    outIndex >= 0 && args[outIndex + 1]
      ? args[outIndex + 1]
      : join(here, "tool-schema-sizes.json");

  const sizes: ToolSchemaSize[] = builtInTools.map((entry) => {
    const name: string = entry.metadata.name;
    const description: string = entry.metadata.description ?? "";
    let schemaChars = 0;
    try {
      schemaChars = JSON.stringify(entry.inputSchema)?.length ?? 0;
    } catch {
      schemaChars = 0;
    }
    return {
      name,
      chars: name.length + description.length + schemaChars,
      descriptionChars: description.length,
      schemaChars,
    };
  });
  sizes.sort((a, b) => a.name.localeCompare(b.name));

  const totalChars = sizes.reduce((sum, tool) => sum + tool.chars, 0);
  const payload = {
    generated: new Date().toISOString(),
    generator: "speedstack/eval/measure-tool-schemas.ts",
    toolCount: sizes.length,
    totalChars,
    approxTokens: Math.round(totalChars / 4),
    tools: sizes,
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");
  console.log(
    `wrote ${sizes.length} tools, ${totalChars} chars (~${payload.approxTokens} tokens) -> ${outPath}`,
  );
}

main();
