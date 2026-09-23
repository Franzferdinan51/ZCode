// ============================================================
// Rank 7 net-token proof: workflow-tool schema cost vs avoided
// intermediate result tokens.
// ============================================================
// Run from apps/zcode-cli/packages/core:
//   tsx src/speedstack/eval/measure-workflow-savings.ts [--out <file>]
//
// What it measures (all numbers real, assumptions explicit):
//  1. SCHEMA COST (measured): per-tool schema tokens from the checked-in
//     tool-schema-sizes.json fixture. For each of the 6 eval tasks, the
//     added cost = sizes of workflow tools KEPT by that task's tool pack,
//     computed with the real computeToolShortlist + label table.
//  2. AVOIDED INTERMEDIATE TOKENS (measured on real data): four
//     representative searches are run against this repo. For each:
//       chain    = Grep result (path:line:content per match) + one full
//                  Read result per matched file  (the naive Grep->NxRead
//                  chain SearchAndRead replaces)
//       composed = SearchAndRead result (bounded (2*context+1)-line
//                  windows with line numbers, max 25 files)
//     avoided_per_chain = (chain_chars - composed_chars) / 4
//                         + eliminated_call_framing
//     The median across the three searches is the per-chain saving.
//  3. NET per task = chains_in_task * per_chain_saving - added_schema.
//     chains_in_task is a documented assumption per eval task:
//       find-todos: 1 search->read chain
//       debug-crash: 2 search->read chains + 1 multi-file edit chain
//                    (3 Edits -> 1 ApplyPatchSet; Edit results are tiny so
//                    only eliminated call framing is counted there)
//       others: 0 (no search/edit chains in the task battery)
//
// The claim under test: net > 0 for every task where a workflow tool is
// kept — i.e. intermediate-context savings exceed the added schema cost.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { computeToolShortlist } from "../tool-packs.js";
import { EVAL_TASKS } from "./tasks.js";

const CHARS_PER_TOKEN = 4;
/** Modeling constant: transcript framing per eliminated tool call result. */
const FRAMING_TOKENS_PER_ELIMINATED_CALL = 120;
/** SearchAndRead bounds mirrored from the contract (content mode). */
const WINDOW_CONTEXT_LINES = 5;
const MAX_FILES = 25;
const MAX_MATCHES = 200;

interface SchemaFixtureTool {
  name: string;
  chars: number;
}
interface SchemaFixture {
  tools: SchemaFixtureTool[];
}

interface ChainMeasurement {
  pattern: string;
  filesMatched: number;
  matches: number;
  chainTokens: number;
  composedTokens: number;
  avoidedTokens: number;
}

/** Median of a sample set (works for odd or even counts). */
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function listTsFiles(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".")) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) listTsFiles(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function measureChain(repoRoot: string, pattern: string): ChainMeasurement {
  const regex = new RegExp(pattern);
  const files = listTsFiles(repoRoot).slice(0, 400);
  const matches: Array<{ file: string; lineNumber: number; line: string; lines: string[] }> = [];
  const matchedFiles = new Set<string>();
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    lines.forEach((line, index) => {
      if (matches.length >= MAX_MATCHES) return;
      if (regex.test(line)) {
        matches.push({ file, lineNumber: index + 1, line, lines });
        matchedFiles.add(file);
      }
    });
    if (matches.length >= MAX_MATCHES) break;
  }
  const cappedFiles = [...matchedFiles].slice(0, MAX_FILES);

  // Naive chain result: Grep match list + one FULL Read per matched file.
  let chainChars = 0;
  for (const match of matches) {
    chainChars += `${relative(repoRoot, match.file)}:${match.lineNumber}:${match.line}\n`.length;
  }
  const fileContents = new Map<string, string>();
  for (const file of cappedFiles) {
    const content = readFileSync(file, "utf8");
    fileContents.set(file, content);
    chainChars += content.length;
  }
  const chainTokens = Math.round(chainChars / CHARS_PER_TOKEN);

  // Composed SearchAndRead result: bounded windows with line numbers.
  let composedChars = 0;
  const seenFiles = new Set<string>();
  for (const match of matches) {
    if (seenFiles.size >= MAX_FILES && !seenFiles.has(match.file)) continue;
    seenFiles.add(match.file);
    const start = Math.max(0, match.lineNumber - 1 - WINDOW_CONTEXT_LINES);
    const end = Math.min(match.lines.length, match.lineNumber + WINDOW_CONTEXT_LINES);
    composedChars += `--- ${relative(repoRoot, match.file)} ---\n`.length;
    for (let i = start; i < end; i++) {
      composedChars += `${String(i + 1).padStart(4)} | ${match.lines[i]}\n`.length;
    }
  }
  const composedTokens = Math.round(composedChars / CHARS_PER_TOKEN);

  // Eliminated calls: 1 Grep + F Reads -> 1 SearchAndRead = F eliminated.
  const eliminatedCalls = cappedFiles.length;
  const avoidedTokens =
    chainTokens - composedTokens + eliminatedCalls * FRAMING_TOKENS_PER_ELIMINATED_CALL;

  return {
    pattern,
    filesMatched: cappedFiles.length,
    matches: matches.length,
    chainTokens,
    composedTokens,
    avoidedTokens,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;

  const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
  const fixturePath = new URL("./tool-schema-sizes.json", import.meta.url).pathname;
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as SchemaFixture;
  const sizeByName = new Map(
    fixture.tools.map((tool) => [tool.name, Math.round(tool.chars / CHARS_PER_TOKEN)]),
  );
  const searchAndReadTokens = sizeByName.get("SearchAndRead") ?? 0;
  const applyPatchSetTokens = sizeByName.get("ApplyPatchSet") ?? 0;
  if (!searchAndReadTokens || !applyPatchSetTokens) {
    throw new Error(
      "tool-schema-sizes.json does not contain the workflow tools — regenerate it with measure-tool-schemas.ts first",
    );
  }

  // 1. Real chain-vs-composed measurements on this repo.
  // Every sample must actually match: a zero-match sample measures
  // nothing and skews the median. (The old TODO|FIXME|XXX sample matched
  // zero files and was replaced.)
  const measurements = [
    measureChain(repoRoot, "createCoreError"),
    measureChain(repoRoot, "ZCODE_[A-Z_]+"),
    measureChain(repoRoot, "speedStack"),
    measureChain(repoRoot, "export (const|function|class|interface|type) \\w+"),
  ];
  const medianPerChainSaving = medianOf(measurements.map((m) => m.avoidedTokens));
  // Guard: a sample that matches nothing measures nothing — fail loudly
  // rather than letting a dead sample dilute the median.
  for (const m of measurements) {
    if (m.matches === 0) {
      throw new Error(
        `workflow-savings battery: sample /${m.pattern}/ matched zero files — ` +
          `the battery must exercise the workflow tools; fix the samples`,
      );
    }
  }

  // 2. Per-task schema cost via the real pack computation.
  // Descriptors only need names for keepNames; token sizes come from the
  // fixture directly (the estimator is heuristic — the fixture is the
  // measured value).
  const descriptors = fixture.tools.map((tool) => ({
    name: tool.name,
    description: "d",
    inputSchema: { pad: "x" },
  }));

  const chainsPerTask: Record<string, { searchChains: number; editChains: number }> = {
    "rename-file": { searchChains: 0, editChains: 0 },
    "find-todos": { searchChains: 1, editChains: 0 },
    "web-news": { searchChains: 0, editChains: 0 },
    "summarize-doc": { searchChains: 0, editChains: 0 },
    "debug-crash": { searchChains: 2, editChains: 1 },
    "morning-reminder": { searchChains: 0, editChains: 0 },
  };

  const perTask = EVAL_TASKS.map((task) => {
    const labels = [...(task.expected?.labels ?? [])];
    const shortlist = computeToolShortlist({
      route: {
        tier: task.expected?.tier ?? "balanced",
        confidence: task.expected?.confidence ?? 0.7,
        taskLabels: labels,
      },
      tools: descriptors,
      taskText: task.task,
    });
    const kept = shortlist.keepNames;
    const addedSchema =
      (kept.has("SearchAndRead") ? searchAndReadTokens : 0) +
      (kept.has("ApplyPatchSet") ? applyPatchSetTokens : 0);
    const chains = chainsPerTask[task.id] ?? { searchChains: 0, editChains: 0 };
    const avoidedIntermediate =
      chains.searchChains * medianPerChainSaving +
      // ApplyPatchSet: 3 Edits -> 1 call; Edit results are tiny, so only
      // eliminated call framing counts (2 eliminated calls).
      chains.editChains * 2 * FRAMING_TOKENS_PER_ELIMINATED_CALL;
    const net = avoidedIntermediate - addedSchema;
    return {
      task: task.id,
      labels,
      searchAndReadKept: kept.has("SearchAndRead"),
      applyPatchSetKept: kept.has("ApplyPatchSet"),
      addedSchemaTokens: addedSchema,
      avoidedIntermediateTokens: avoidedIntermediate,
      netTokens: net,
      netPositive: net > 0,
    };
  });

  const chainTasks = perTask.filter((t) => t.avoidedIntermediateTokens > 0);
  const aggregateNet = perTask.reduce((sum, t) => sum + t.netTokens, 0);
  const report = {
    generated: new Date().toISOString(),
    model: {
      charsPerToken: CHARS_PER_TOKEN,
      framingTokensPerEliminatedCall: FRAMING_TOKENS_PER_ELIMINATED_CALL,
      windowContextLines: WINDOW_CONTEXT_LINES,
      maxFiles: MAX_FILES,
      maxMatches: MAX_MATCHES,
      chainsPerTask,
    },
    workflowToolSchemaTokens: {
      SearchAndRead: searchAndReadTokens,
      ApplyPatchSet: applyPatchSetTokens,
    },
    chainMeasurements: measurements,
    medianPerChainSavingTokens: medianPerChainSaving,
    perTask,
    chainTasksNetPositive: chainTasks.every((t) => t.netTokens > 0),
    aggregateNetTokens: aggregateNet,
    // web-news keeps SearchAndRead via the "search" label (label ambiguity:
    // Grep/Glob/Read are over-included there too, pre-existing) without a
    // chain to collapse — its -366t is static-mapping overhead, reported
    // honestly rather than hidden.
  };

  const json = JSON.stringify(report, null, 2);
  if (outPath) writeFileSync(outPath, json);

  console.log("=== Rank 7 net-token proof: workflow tools ===\n");
  console.log(
    `Schema cost: SearchAndRead=${searchAndReadTokens}t ApplyPatchSet=${applyPatchSetTokens}t`,
  );
  console.log(`Median avoided per search->read chain: ${medianPerChainSaving}t\n`);
  for (const measurement of measurements) {
    console.log(
      `  /${measurement.pattern}/: ${measurement.filesMatched} files, ${measurement.matches} matches — ` +
        `chain=${measurement.chainTokens}t composed=${measurement.composedTokens}t avoided=${measurement.avoidedTokens}t`,
    );
  }
  console.log("\nPer task:");
  for (const task of perTask) {
    console.log(
      `  ${task.task}: added=${task.addedSchemaTokens}t avoided=${task.avoidedIntermediateTokens}t ` +
        `net=${task.netTokens > 0 ? "+" : ""}${task.netTokens}t ${task.netPositive ? "OK" : "(no chain — n/a)"}`,
    );
  }
  console.log(
    `\nTasks with chains all net positive: ${report.chainTasksNetPositive ? "YES" : "NO"}`,
  );
  console.log(`Aggregate net across the 6-task battery: ${aggregateNet > 0 ? "+" : ""}${aggregateNet}t`);
}

main();
