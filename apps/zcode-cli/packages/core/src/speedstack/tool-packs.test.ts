/**
 * Label-driven tool-pack policy tests (speedstack/tool-packs.ts).
 *
 * Pure logic: no model, no shim, no registry. Run with
 * `node --test src/speedstack/tool-packs.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildToolPackRecoveryReminderBody,
  computeServerShortlist,
  computeToolShortlist,
  detectToolPackMissedCalls,
  estimateToolSchemaTokens,
  resolveActiveLabels,
  TOOL_PACK_CHARS_PER_TOKEN,
  TOOL_PACK_CORE_TOOLS,
  TOOL_PACK_LABEL_TABLE,
  TOOL_PACK_PRUNE_CONFIDENCE_THRESHOLD,
  type ToolSchemaDescriptor,
} from "./tool-packs.ts";

const HIGH_CONF = { tier: "balanced", confidence: 0.9, taskLabels: [] as string[] };
const LOW_CONF = { tier: "balanced", confidence: 0.2, taskLabels: [] as string[] };

function descriptor(name: string, schemaChars = 400): ToolSchemaDescriptor {
  return {
    name,
    description: "d".repeat(100),
    inputSchema: { pad: "x".repeat(Math.max(0, schemaChars - 100)) },
  };
}

const BUILTINS = [
  "Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch",
  "TodoRead", "TodoWrite", "AskUserQuestion", "Skill", "Agent", "Task",
  "CronCreate", "CreateWorkflow", "SaveWorkflow", "SendMessage", "js",
  "SearchAndRead", "ApplyPatchSet",
  "submit_result", "escalate", "TaskOutput", "TaskStop", "RespondToCoordinator",
].map((name) => descriptor(name));

test("fail-open: no route decision keeps every tool", () => {
  const shortlist = computeToolShortlist({ route: undefined, tools: BUILTINS });
  assert.equal(shortlist.pruned, false);
  assert.equal(shortlist.disallowedNames.size, 0);
  assert.equal(shortlist.keepNames.size, BUILTINS.length);
  assert.match(shortlist.reason, /fail-open/);
});

test("fail-open: low route confidence keeps every tool", () => {
  const shortlist = computeToolShortlist({ route: LOW_CONF, tools: BUILTINS });
  assert.equal(shortlist.pruned, false);
  assert.equal(shortlist.keepNames.size, BUILTINS.length);
  assert.match(shortlist.reason, /below prune threshold/);
});

test("fail-open: ZCODE_SPEEDSTACK_PRUNE=0 keeps every tool", () => {
  const shortlist = computeToolShortlist({
    route: { ...HIGH_CONF, taskLabels: ["files"] },
    tools: BUILTINS,
    env: { ZCODE_SPEEDSTACK_PRUNE: "0" } as NodeJS.ProcessEnv,
  });
  assert.equal(shortlist.pruned, false);
  assert.match(shortlist.reason, /kill-switch/);
});

test("fail-open: mcpPruning=false keeps every tool", () => {
  const shortlist = computeToolShortlist({
    route: { ...HIGH_CONF, taskLabels: ["files"] },
    config: { mcpPruning: false },
    tools: BUILTINS,
  });
  assert.equal(shortlist.pruned, false);
  assert.match(shortlist.reason, /mcpPruning=false/);
});

test("file task keeps Read/Write/Edit/Glob/SearchAndRead, prunes workflow + ask tools", () => {
  const shortlist = computeToolShortlist({
    route: { ...HIGH_CONF, taskLabels: ["files"] },
    taskText: "rename report.txt to final.txt",
    tools: BUILTINS,
  });
  assert.equal(shortlist.pruned, true);
  for (const name of ["Read", "Write", "Edit", "Glob", "Bash", "Grep", "SearchAndRead"]) {
    assert.ok(shortlist.keepNames.has(name), `expected ${name} kept`);
  }
  for (const name of ["CreateWorkflow", "SaveWorkflow", "AskUserQuestion", "Skill", "CronCreate"]) {
    assert.ok(shortlist.disallowedNames.has(name), `expected ${name} pruned`);
  }
  // Actor-protocol tools are never pruned.
  for (const name of ["submit_result", "escalate", "TaskOutput", "TaskStop", "RespondToCoordinator"]) {
    assert.ok(shortlist.keepNames.has(name), `expected protocol tool ${name} kept`);
  }
  assert.ok(shortlist.schemaTokensAfter < shortlist.schemaTokensBefore);
});

test("summarize label keeps SearchAndRead (search->read collapses to one call)", () => {
  const shortlist = computeToolShortlist({
    route: { ...HIGH_CONF, taskLabels: ["summarize"] },
    taskText: "summarize the architecture doc",
    tools: BUILTINS,
  });
  assert.ok(shortlist.labels.includes("summarize"), `labels were ${shortlist.labels}`);
  assert.ok(shortlist.keepNames.has("Read"), "expected Read kept");
  assert.ok(shortlist.keepNames.has("SearchAndRead"), "expected SearchAndRead kept");
  assert.ok(shortlist.disallowedNames.has("ApplyPatchSet"), "expected ApplyPatchSet pruned");
});

test("keyword-inferred labels work when the shim returns no labels", () => {
  const shortlist = computeToolShortlist({
    route: HIGH_CONF,
    taskText: "search the web for local LLM news",
    tools: BUILTINS,
  });
  assert.ok(shortlist.labels.includes("web"), `labels were ${shortlist.labels}`);
  assert.ok(shortlist.keepNames.has("WebFetch"));
  assert.ok(shortlist.keepNames.has("WebSearch"));
  assert.ok(shortlist.disallowedNames.has("CreateWorkflow"));
});

test("schedule keywords keep the cron tools", () => {
  const shortlist = computeToolShortlist({
    route: HIGH_CONF,
    taskText: "create a cron job that backs up daily",
    tools: BUILTINS,
  });
  assert.ok(shortlist.labels.includes("schedule"));
  assert.ok(shortlist.keepNames.has("CronCreate"));
});

test("shim label aliases resolve (file -> files)", () => {
  const labels = resolveActiveLabels(["file"], undefined);
  assert.ok(labels.includes("files"));
});

test("MCP tools fail open for unknown servers, prune for known-irrelevant ones", () => {
  const tools: ToolSchemaDescriptor[] = [
    ...BUILTINS,
    descriptor("mcp__browser__navigate"),
    descriptor("mcp__custom__thing"),
  ];
  const shortlist = computeToolShortlist({
    route: { ...HIGH_CONF, taskLabels: ["files"] },
    taskText: "rename a file",
    tools,
    isMcpTool: (name) => name.startsWith("mcp__"),
    mcpServerOf: (name) =>
      name === "mcp__browser__navigate" ? "browser-use" : "my-custom-server",
  });
  assert.ok(
    shortlist.disallowedNames.has("mcp__browser__navigate"),
    "browser MCP tool should prune on a files task",
  );
  assert.ok(
    shortlist.keepNames.has("mcp__custom__thing"),
    "unknown MCP server should fail open (kept)",
  );
});

test("MCP tool kept when its server matches an active label", () => {
  const tools = [...BUILTINS, descriptor("mcp__browser__navigate")];
  const shortlist = computeToolShortlist({
    route: HIGH_CONF,
    taskText: "take a screenshot of the page in the browser",
    tools,
    isMcpTool: (name) => name.startsWith("mcp__"),
    mcpServerOf: () => "browser-use",
  });
  assert.ok(shortlist.labels.includes("browser"));
  assert.ok(shortlist.keepNames.has("mcp__browser__navigate"));
});

test("computeServerShortlist prunes known-irrelevant servers, keeps unknown ones", () => {
  const shortlist = computeServerShortlist({
    route: { ...HIGH_CONF, taskLabels: ["files"] },
    taskText: "rename a file",
    serverNames: ["browser-use", "my-custom-server", "filesystem-local"],
  });
  assert.equal(shortlist.pruned, true);
  assert.ok(shortlist.prunedServers.includes("browser-use"));
  assert.ok(shortlist.keepServers.includes("my-custom-server"));
  assert.ok(shortlist.keepServers.includes("filesystem-local"));
});

test("computeServerShortlist fails open without a route", () => {
  const shortlist = computeServerShortlist({
    route: undefined,
    serverNames: ["browser-use"],
  });
  assert.equal(shortlist.pruned, false);
  assert.deepEqual(shortlist.keepServers, ["browser-use"]);
});

test("estimateToolSchemaTokens is deterministic and ~chars/4", () => {
  const tools = [descriptor("Read", 400), descriptor("Bash", 800)];
  const first = estimateToolSchemaTokens(tools);
  const second = estimateToolSchemaTokens(tools);
  assert.equal(first, second);
  // name(4+4) + desc(200) + schema json overhead ~1200+ chars total
  assert.ok(first > 200 && first < 600, `got ${first}`);
  assert.equal(estimateToolSchemaTokens([]), 0);
  void TOOL_PACK_CHARS_PER_TOKEN;
});

test("core tools list matches the report's always-on set", () => {
  assert.deepEqual([...TOOL_PACK_CORE_TOOLS].sort(), [
    "Bash", "Edit", "Glob", "Grep", "Read", "TodoRead", "TodoWrite", "Write",
  ].sort());
});

test("label table has no duplicate canonical labels", () => {
  const labels = TOOL_PACK_LABEL_TABLE.map((rule) => rule.label);
  assert.equal(new Set(labels).size, labels.length);
});

test("prune threshold is documented and sane (0.6 < 0.8 MCP-skip)", () => {
  assert.equal(TOOL_PACK_PRUNE_CONFIDENCE_THRESHOLD, 0.6);
});

test("detectToolPackMissedCalls finds calls to pruned-but-not-sent tools", () => {
  const missed = detectToolPackMissedCalls(
    [{ name: "Read" }, { name: "AskUserQuestion" }, { name: "Bash" }],
    [{ name: "Read" }, { name: "Bash" }],
    new Set(["AskUserQuestion", "Skill"]),
  );
  assert.deepEqual(missed, ["AskUserQuestion"]);
});

test("detectToolPackMissedCalls ignores unknown/hallucinated tool names", () => {
  const missed = detectToolPackMissedCalls(
    [{ name: "HallucinatedTool" }],
    [{ name: "Read" }],
    new Set(["Skill"]),
  );
  assert.deepEqual(missed, []);
});

test("detectToolPackMissedCalls is inert without a disallow set", () => {
  assert.deepEqual(
    detectToolPackMissedCalls([{ name: "X" }], [], undefined),
    [],
  );
});

test("recovery reminder names the missed tools", () => {
  const body = buildToolPackRecoveryReminderBody(["AskUserQuestion", "Skill"]);
  assert.match(body, /AskUserQuestion/);
  assert.match(body, /Skill/);
  assert.match(body, /available now/);
});

test("computeToolShortlist echoes preserved route scores on pruned and fail-open paths", () => {
  const route = {
    tier: "balanced",
    confidence: 0.9,
    taskLabels: ["files"],
    tierScores: { economy: 0.18, balanced: 0.54, heavy: 0.28 },
    margin: 0.26,
  };
  const pruned = computeToolShortlist({ route, taskText: "rename a file", tools: BUILTINS });
  assert.deepEqual(pruned.tierScores, { economy: 0.18, balanced: 0.54, heavy: 0.28 });
  assert.equal(pruned.margin, 0.26);

  const failOpen = computeToolShortlist({
    route: { tier: "balanced", confidence: 0.2, tierScores: { balanced: 0.5, heavy: 0.4 }, margin: 0.1 },
    taskText: "rename a file",
    tools: BUILTINS,
  });
  assert.equal(failOpen.pruned, false);
  assert.deepEqual(failOpen.tierScores, { balanced: 0.5, heavy: 0.4 });
  assert.equal(failOpen.margin, 0.1);

  const noRoute = computeToolShortlist({ route: undefined, tools: BUILTINS });
  assert.equal(noRoute.tierScores, undefined);
  assert.equal(noRoute.margin, undefined);
});
