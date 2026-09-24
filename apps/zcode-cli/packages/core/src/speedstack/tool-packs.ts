/* eslint-disable max-lines -- label table + shortlist computation for JIT tool packs; declarative table is the config surface, splitting it adds indirection, not clarity. */
// ============================================================
// Speed Stack: label-driven per-task tool packs (JIT tool selection)
// ============================================================
//
// Rank 1 of the 3.25.0 agent-flow program: stop re-sending every tool
// schema on every model step. The SystemOne route decision already carries
// `taskLabels` (parsed and logged, previously unused); this module turns
// those labels -- plus keyword signals from the task text, because the
// shim's label vocabulary is sparse -- into a per-task tool shortlist.
//
// Design (see 3.25-agent-flow-research.md Rank 1):
//   - Always-on core tools: Read, Write, Edit, Bash, Glob, Grep,
//     TodoRead, TodoWrite. These cover the overwhelmingly common cases.
//   - Actor-protocol tools (submit_result, escalate, TaskOutput, TaskStop,
//     RespondToCoordinator) are never pruned: an actor that cannot submit
//     its result is broken, and these schemas are small.
//   - Everything else is kept only when an active label's rule names it.
//     MCP tools are pruned only when their server positively matches a
//     known-irrelevant capability; unknown servers fail open (kept).
//   - Suppression happens BEFORE request construction (the win is not
//     sending the schemas), in runtime/methods/turn-loop.ts.
//   - Fail-open everywhere: kill switches, missing route, low confidence,
//     or any error -> the full tool list, i.e. today's behavior.
//
// This module is intentionally pure (no runtime imports) so it stays
// runnable under plain `node --test` type-stripping like its speedstack
// siblings. The label table is the config surface: extend
// TOOL_PACK_LABEL_TABLE when new capabilities/servers appear. A
// ranking-based successor is planned later; keep this layer clean.
//
// No model IDs appear anywhere here: pruning is model-agnostic.

/** Env kill-switch shared with the Z2 MCP attach policy. */
const TOOL_PACK_PRUNE_KILL_SWITCH_ENV = "ZCODE_SPEEDSTACK_PRUNE";
// NOTE: the canonical export lives in ./systemone-route.ts as
// SYSTEMONE_PRUNE_KILL_SWITCH_ENV; the literal is duplicated here so this
// module keeps zero runtime imports (node --test type-stripping).

/**
 * Minimum route confidence for label-driven pruning. Deliberately lower
 * than the Z2 whole-MCP skip threshold (0.8): suppressing schemas has a
 * cheap, automatic recovery path (tool-miss -> retry with the full set),
 * while not starting MCP servers does not.
 */
export const TOOL_PACK_PRUNE_CONFIDENCE_THRESHOLD = 0.6;

/** Always-on core tools (report Rank 1). Exact registry names. */
export const TOOL_PACK_CORE_TOOLS: readonly string[] = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "TodoRead",
  "TodoWrite",
];

/**
 * Actor-protocol tools: never pruned. Small schemas (~0.1-0.4K tokens
 * each); removing them breaks actor completion with no recovery except the
 * wasteful miss-retry this module is trying to avoid.
 */
export const TOOL_PACK_PROTOCOL_TOOLS: readonly string[] = [
  "submit_result",
  "escalate",
  "TaskOutput",
  "TaskStop",
  "RespondToCoordinator",
];

/** One label -> capability rule. Extend this table, not the code below. */
export interface ToolPackLabelRule {
  /** Canonical label (lowercase). */
  readonly label: string;
  /** Alternate spellings that map to this label. */
  readonly aliases?: readonly string[];
  /**
   * Task-text signals implying this label. Single alphanumeric tokens
   * match on word boundaries; anything else matches as a substring.
   * Case-insensitive.
   */
  readonly keywords?: readonly string[];
  /** Built-in tool names to keep when this label is active. */
  readonly keepTools?: readonly string[];
  /** MCP server-name substrings to keep when this label is active. */
  readonly keepServers?: readonly string[];
}

function compileKeyword(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = /^[a-z0-9]+$/i.test(keyword) ? `\\b${escaped}\\b` : escaped;
  return new RegExp(pattern, "i");
}

export interface CompiledToolPackLabelRule extends ToolPackLabelRule {
  readonly keywordPatterns: readonly RegExp[];
}

function defineRule(rule: ToolPackLabelRule): CompiledToolPackLabelRule {
  return {
    ...rule,
    keywordPatterns: (rule.keywords ?? []).map(compileKeyword),
  };
}

/**
 * Label -> capability mapping table. Labels come from the route's
 * `taskLabels` (normalized, aliases resolved) unioned with labels inferred
 * from task-text keywords. Keep it declarative: one rule per capability.
 */
export const TOOL_PACK_LABEL_TABLE: readonly CompiledToolPackLabelRule[] = [
  defineRule({
    label: "files",
    aliases: ["file"],
    keywords: [
      "file", "files", "directory", "directories", "folder", "rename",
      "move", "copy", "delete", "path",
    ],
    keepTools: ["Read", "Write", "Edit", "Glob", "SearchAndRead"],
    keepServers: ["filesystem", "file"],
  }),
  defineRule({
    label: "search",
    keywords: ["search", "find", "grep", "locate", "look for", "where is"],
    // Rank 7: SearchAndRead composes Grep+Read into one call — include it
    // wherever the search primitives are kept. JIT only: other packs still
    // prune it.
    keepTools: ["Grep", "Glob", "Read", "WebSearch", "SearchAndRead"],
    keepServers: [],
  }),
  defineRule({
    label: "code",
    aliases: ["coding", "programming", "dev"],
    keywords: [
      "code", "function", "class", "refactor", "bug", "debug", "compile",
      "script", "test", "tests", "repo", "repository", "import",
      "typescript", "python",
    ],
    // Rank 7: SearchAndRead (search->read in one call) and ApplyPatchSet
    // (atomic multi-file edit) live here — code tasks are their home pack.
    keepTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "SearchAndRead", "ApplyPatchSet"],
    keepServers: [],
  }),
  defineRule({
    label: "writing",
    keywords: ["write", "draft", "create", "compose", "document", "readme"],
    keepTools: ["Write", "Edit", "Read"],
    keepServers: [],
  }),
  defineRule({
    label: "media",
    keywords: ["image", "images", "video", "photo", "audio", "picture"],
    keepTools: ["Read", "Write", "Bash"],
    keepServers: ["media"],
  }),
  defineRule({
    label: "web",
    aliases: ["internet", "online"],
    keywords: [
      "web", "website", "url", "http", "fetch", "download", "news",
      "search the web", "look up", "online",
    ],
    keepTools: ["WebFetch", "WebSearch"],
    keepServers: ["browser", "fetch", "web", "http"],
  }),
  defineRule({
    label: "browser",
    keywords: ["browser", "webpage", "screenshot", "click", "navigate"],
    keepTools: [],
    keepServers: ["browser", "playwright", "puppeteer", "chrome"],
  }),
  defineRule({
    label: "shell",
    aliases: ["terminal", "command", "cli"],
    keywords: [
      "run", "execute", "command", "terminal", "shell", "install", "npm",
      "pnpm", "git",
    ],
    keepTools: ["Bash"],
    keepServers: [],
  }),
  defineRule({
    label: "summarize",
    aliases: ["summary", "tldr"],
    keywords: ["summar", "tldr", "explain", "recap"],
    // Rank 7: summarizing usually means finding the content first — keep
    // SearchAndRead so the search->read chain collapses into one call.
    keepTools: ["Read", "SearchAndRead"],
    keepServers: [],
  }),
  defineRule({
    label: "plan",
    aliases: ["planning", "todo", "todos"],
    keywords: ["plan", "todo", "task list", "steps", "roadmap"],
    keepTools: ["TodoRead", "TodoWrite", "EnterPlanMode", "ExitPlanMode"],
    keepServers: [],
  }),
  defineRule({
    label: "delegate",
    aliases: ["subagent", "subagents"],
    keywords: ["subagent", "delegate", "parallel", "concurrently", "agent"],
    keepTools: ["Agent", "Task", "TaskOutput", "TaskStop"],
    keepServers: [],
  }),
  defineRule({
    label: "ask",
    keywords: ["ask me", "confirm with me", "clarif", "question for me"],
    keepTools: ["AskUserQuestion"],
    keepServers: [],
  }),
  defineRule({
    label: "skill",
    keywords: ["skill", "skills"],
    keepTools: ["Skill"],
    keepServers: [],
  }),
  defineRule({
    label: "schedule",
    aliases: ["cron"],
    keywords: [
      "cron", "schedul", "recurring", "daily", "reminder", "every day",
      "every morning",
    ],
    keepTools: [
      "CronCreate", "CronList", "CronUpdate", "CronDelete",
      "OffPeakCreate", "OffPeakList",
    ],
    keepServers: [],
  }),
  defineRule({
    label: "message",
    aliases: ["notify"],
    keywords: [
      "message", "notify", "notification", "send", "telegram", "dm",
      "text me",
    ],
    keepTools: ["SendMessage"],
    keepServers: [],
  }),
  defineRule({
    label: "memory",
    keywords: ["memory", "remember", "session context"],
    keepTools: ["ReadSessionContext"],
    keepServers: ["memory"],
  }),
  defineRule({
    label: "workflow",
    keywords: ["workflow", "workflows"],
    keepTools: [
      "CreateWorkflow", "AmendWorkflow", "SaveWorkflow",
      "EvalWorkflowSnippet", "ListWorkflowRuns", "GetWorkflowRun",
      "ResumeWorkflowRun", "ResolveWorkflowQuestion", "ListSavedWorkflows",
      "ListModels",
    ],
    keepServers: [],
  }),
  defineRule({
    label: "repl",
    keywords: ["node repl", "eval js", "javascript snippet"],
    keepTools: ["js"],
    keepServers: [],
  }),
  defineRule({
    label: "ops",
    aliases: ["devops"],
    keywords: ["deploy", "server", "crash", "logs", "docker", "ci"],
    // Rank 7: crash/log investigation is search-then-read; SearchAndRead
    // collapses that chain.
    keepTools: ["Bash", "Read", "Glob", "Grep", "SearchAndRead"],
    keepServers: [],
  }),
];

/** alias (lowercase) -> canonical label. */
const TOOL_PACK_LABEL_ALIASES: ReadonlyMap<string, string> = new Map(
  TOOL_PACK_LABEL_TABLE.flatMap((rule) =>
    (rule.aliases ?? []).map(
      (alias): [string, string] => [alias.toLowerCase(), rule.label],
    ),
  ),
);

/** Every server-name substring any rule knows about (for MCP fail-open). */
const TOOL_PACK_KNOWN_SERVER_SUBSTRINGS: readonly string[] = [
  ...new Set(
    TOOL_PACK_LABEL_TABLE.flatMap((rule) =>
      (rule.keepServers ?? []).map((s) => s.toLowerCase()),
    ),
  ),
];

function normalizeLabel(label: string): string {
  const normalized = label.trim().toLowerCase();
  return TOOL_PACK_LABEL_ALIASES.get(normalized) ?? normalized;
}

/**
 * Active labels for a task: the route's taskLabels (normalized, aliases
 * resolved) unioned with labels inferred from task-text keywords. Pure.
 */
export function resolveActiveLabels(
  taskLabels: readonly string[] | undefined,
  taskText: string | undefined,
): string[] {
  const labels = new Set<string>();
  for (const label of taskLabels ?? []) {
    if (typeof label !== "string") continue;
    const normalized = normalizeLabel(label);
    if (normalized.length > 0) labels.add(normalized);
  }
  if (taskText && taskText.trim().length > 0) {
    for (const rule of TOOL_PACK_LABEL_TABLE) {
      if (rule.keywordPatterns.some((pattern) => pattern.test(taskText))) {
        labels.add(rule.label);
      }
    }
  }
  return [...labels];
}

/** Minimal structural view of a route decision (avoids cross-module types). */
export interface ToolPackRouteView {
  readonly tier: string;
  readonly confidence: number;
  readonly taskLabels?: readonly string[] | undefined;
  /**
   * True when the shim flagged the route as uncertain (Phase 3): no
   * pruning at all — the full tool surface stays available.
   */
  readonly uncertain?: boolean | undefined;
  /**
   * Shim-scored tool/MCP relevance ranking (Phase 3, advisory): entries
   * are keep-signals only, never prune-signals. Absent on older shims.
   */
  readonly rankedTools?: readonly ToolPackRankedTool[] | undefined;
  /**
   * Preserved per-tier scores / top-1-vs-top-2 margin (see
   * SystemOneRouteDecision). Optional: informational only, never gated on.
   */
  readonly tierScores?: Readonly<Record<string, number>> | undefined;
  readonly margin?: number | undefined;
}

/** One advisory keep-signal from the shim's ranked_tools surface. */
export interface ToolPackRankedTool {
  readonly id: string;
  readonly relevance: number;
  readonly kind?: string | undefined;
}

/** Minimal structural view of the session config pruning flag. */
export interface ToolPackConfigView {
  readonly mcpPruning?: boolean | undefined;
}

/** A tool with just enough shape for schema-token estimation. */
export interface ToolSchemaDescriptor {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema?: unknown;
}

/** Heuristic for schema-token estimation: ~4 chars per token. */
export const TOOL_PACK_CHARS_PER_TOKEN = 4;

/**
 * Normalize a tool/server/ranked id for fuzzy matching: lowercase,
 * separators stripped, so "browser-claw" matches "browserclaw".
 */
function normalizeRankName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Advisory keep-signal match (Phase 3): a shim-ranked tool id matches a
 * local tool/server name when either normalized form contains the other.
 * Minimum length 3 on both sides so junk ids never match. Pure.
 */
export function rankedToolMatchesName(rankedId: string, name: string): boolean {
  try {
    const id = normalizeRankName(rankedId);
    const target = normalizeRankName(name);
    return (
      id.length >= 3 && target.length >= 3 && (id.includes(target) || target.includes(id))
    );
  } catch {
    return false;
  }
}

/** Collect the ranked tool ids worth treating as keep-signals. */
function collectRankedToolIds(
  route: ToolPackRouteView | undefined,
): Set<string> {
  const ids = new Set<string>();
  try {
    for (const ranked of route?.rankedTools ?? []) {
      const id = ranked?.id;
      if (typeof id === "string" && id.trim().length > 0) {
        ids.add(id.trim());
      }
    }
  } catch {
    // Fail-open: no ranked keeps.
  }
  return ids;
}

/**
 * Estimate the tokens a tool list costs as provider `tools` schemas.
 * Deterministic; the same heuristic is used before/after so the DELTA is
 * what matters, not the absolute number.
 */
export function estimateToolSchemaTokens(
  tools: readonly ToolSchemaDescriptor[],
): number {
  let chars = 0;
  for (const tool of tools) {
    chars += tool.name.length;
    chars += tool.description?.length ?? 0;
    if (tool.inputSchema !== undefined) {
      try {
        chars += JSON.stringify(tool.inputSchema)?.length ?? 0;
      } catch {
        // Circular schema: count nothing rather than throw (fail-open).
      }
    }
  }
  return Math.round(chars / TOOL_PACK_CHARS_PER_TOKEN);
}

export interface ComputeToolShortlistInput {
  readonly route: ToolPackRouteView | undefined;
  readonly config?: ToolPackConfigView | undefined;
  readonly taskText?: string | undefined;
  readonly tools: readonly ToolSchemaDescriptor[];
  /**
   * When set, skip pruning and return the full tool list with this reason.
   * Used for turn-scoped tool-miss recovery (fail open to the full set for
   * the rest of the turn).
   */
  readonly forceFullReason?: string | undefined;
  /**
   * Returns true for MCP-registered tools. When omitted every tool is
   * treated as built-in (strict allowlist); the turn-loop passes the
   * registry-backed implementation so unknown MCP servers fail open.
   */
  readonly isMcpTool?: ((name: string) => boolean) | undefined;
  /** Owning MCP server name for a tool, when known. */
  readonly mcpServerOf?:
    | ((name: string) => string | undefined)
    | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export interface ToolShortlist {
  /** False -> keep everything (fail-open); the caller sends the full list. */
  readonly pruned: boolean;
  readonly keepNames: ReadonlySet<string>;
  readonly disallowedNames: ReadonlySet<string>;
  readonly labels: readonly string[];
  readonly confidence: number | undefined;
  /** Preserved route score signals (informational; see ToolPackRouteView). */
  readonly tierScores?: Readonly<Record<string, number>> | undefined;
  readonly margin?: number | undefined;
  readonly reason: string;
  readonly schemaTokensBefore: number;
  readonly schemaTokensAfter: number;
}

function fullAttach(
  tools: readonly ToolSchemaDescriptor[],
  reason: string,
  route: ToolPackRouteView | undefined,
  labels: readonly string[],
): ToolShortlist {
  const keepNames = new Set(tools.map((tool) => tool.name));
  const schemaTokens = estimateToolSchemaTokens(tools);
  return {
    pruned: false,
    keepNames,
    disallowedNames: new Set(),
    labels,
    confidence: route?.confidence,
    tierScores: route?.tierScores,
    margin: route?.margin,
    reason,
    schemaTokensBefore: schemaTokens,
    schemaTokensAfter: schemaTokens,
  };
}

/**
 * Compute the per-task tool shortlist. Never throws: any internal error
 * fails open to the full tool list.
 */
export function computeToolShortlist(
  input: ComputeToolShortlistInput,
): ToolShortlist {
  try {
    const env = input.env ?? process.env;
    const tools = input.tools;
    if (input.forceFullReason) {
      return fullAttach(tools, input.forceFullReason, input.route, []);
    }
    if (env[TOOL_PACK_PRUNE_KILL_SWITCH_ENV] === "0") {
      return fullAttach(
        tools,
        `kill-switch: ${TOOL_PACK_PRUNE_KILL_SWITCH_ENV}=0`,
        input.route,
        [],
      );
    }
    if (input.config?.mcpPruning === false) {
      return fullAttach(
        tools,
        "kill-switch: SpeedStackSessionConfig.mcpPruning=false",
        input.route,
        [],
      );
    }
    const route = input.route;
    if (!route) {
      return fullAttach(tools, "no route decision (fail-open)", undefined, []);
    }
    if (route.uncertain === true) {
      // Phase-3 uncertain rule: an uncertain route NEVER prunes tools.
      return fullAttach(
        tools,
        "route uncertain=true: no tool pruning (fail-open)",
        route,
        [],
      );
    }
    if (
      typeof route.confidence !== "number" ||
      route.confidence < TOOL_PACK_PRUNE_CONFIDENCE_THRESHOLD
    ) {
      return fullAttach(
        tools,
        `route confidence ${route.confidence} below prune threshold ${TOOL_PACK_PRUNE_CONFIDENCE_THRESHOLD} (fail-open)`,
        route,
        [],
      );
    }
    const labels = resolveActiveLabels(route.taskLabels, input.taskText);
    const activeRules = new Map<string, CompiledToolPackLabelRule>();
    for (const rule of TOOL_PACK_LABEL_TABLE) {
      if (labels.includes(rule.label)) activeRules.set(rule.label, rule);
    }
    const keepTools = new Set<string>();
    for (const name of TOOL_PACK_CORE_TOOLS) keepTools.add(name.toLowerCase());
    for (const name of TOOL_PACK_PROTOCOL_TOOLS) {
      keepTools.add(name.toLowerCase());
    }
    const keepServerSubstrings = new Set<string>();
    for (const rule of activeRules.values()) {
      for (const name of rule.keepTools ?? []) {
        keepTools.add(name.toLowerCase());
      }
      for (const substring of rule.keepServers ?? []) {
        keepServerSubstrings.add(substring.toLowerCase());
      }
    }
    const keepNames = new Set<string>();
    const disallowedNames = new Set<string>();
    // Phase 3: shim-ranked tools are advisory keep-signals. A ranked id
    // matching a tool (or its MCP server) keeps it; ranked ids NEVER
    // prune — anything they don't name still goes through the label path.
    const rankedToolIds = collectRankedToolIds(route);
    let rankedKeptCount = 0;
    for (const tool of tools) {
      const lowerName = tool.name.toLowerCase();
      if (keepTools.has(lowerName)) {
        keepNames.add(tool.name);
        continue;
      }
      if (rankedToolIds.size > 0) {
        const serverName = input.mcpServerOf?.(tool.name);
        let matched = false;
        for (const rankedId of rankedToolIds) {
          if (
            rankedToolMatchesName(rankedId, tool.name) ||
            (serverName !== undefined &&
              serverName.length > 0 &&
              rankedToolMatchesName(rankedId, serverName))
          ) {
            matched = true;
            break;
          }
        }
        if (matched) {
          keepNames.add(tool.name);
          rankedKeptCount++;
          continue;
        }
      }
      const serverName = input.mcpServerOf?.(tool.name);
      const isMcp = serverName !== undefined || input.isMcpTool?.(tool.name) === true;
      if (isMcp && serverName) {
        const lowerServer = serverName.toLowerCase();
        // Fail-open per server: prune only when the server positively
        // matches a capability this task does NOT need.
        const matchesKept = [...keepServerSubstrings].some((substring) =>
          lowerServer.includes(substring),
        );
        const matchesKnownIrrelevant = TOOL_PACK_KNOWN_SERVER_SUBSTRINGS.some(
          (substring) =>
            !keepServerSubstrings.has(substring) &&
            lowerServer.includes(substring),
        );
        if (matchesKept || !matchesKnownIrrelevant) {
          keepNames.add(tool.name);
          continue;
        }
      } else if (isMcp) {
        // MCP tool whose server is unknown: fail open, keep it.
        keepNames.add(tool.name);
        continue;
      }
      disallowedNames.add(tool.name);
    }
    const keptTools = tools.filter((tool) => keepNames.has(tool.name));
    return {
      pruned: disallowedNames.size > 0,
      keepNames,
      disallowedNames,
      labels,
      confidence: route.confidence,
      tierScores: route.tierScores,
      margin: route.margin,
      reason:
        `route tier=${route.tier} confidence=${route.confidence} ` +
        `labels=[${labels.join(",")}] rankedKeeps=${rankedKeptCount} ` +
        `kept=${keepNames.size}/${tools.length}`,
      schemaTokensBefore: estimateToolSchemaTokens(tools),
      schemaTokensAfter: estimateToolSchemaTokens(keptTools),
    };
  } catch {
    return fullAttach(input.tools, "tool-pack computation threw (fail-open)", input.route, []);
  }
}

export interface ComputeServerShortlistInput {
  readonly route: ToolPackRouteView | undefined;
  readonly config?: ToolPackConfigView | undefined;
  readonly taskText?: string | undefined;
  readonly serverNames: readonly string[];
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export interface ServerShortlist {
  /** False -> start every server (fail-open). */
  readonly pruned: boolean;
  readonly keepServers: readonly string[];
  readonly prunedServers: readonly string[];
  readonly labels: readonly string[];
  readonly reason: string;
}

/**
 * Per-server shortlist for MCP startup: which configured servers are worth
 * starting for this task. Same gating as computeToolShortlist; servers that
 * match no known capability fail open (kept).
 */
export function computeServerShortlist(
  input: ComputeServerShortlistInput,
): ServerShortlist {
  try {
    const env = input.env ?? process.env;
    if (env[TOOL_PACK_PRUNE_KILL_SWITCH_ENV] === "0") {
      return {
        pruned: false,
        keepServers: [...input.serverNames],
        prunedServers: [],
        labels: [],
        reason: `kill-switch: ${TOOL_PACK_PRUNE_KILL_SWITCH_ENV}=0`,
      };
    }
    if (input.config?.mcpPruning === false) {
      return {
        pruned: false,
        keepServers: [...input.serverNames],
        prunedServers: [],
        labels: [],
        reason: "kill-switch: SpeedStackSessionConfig.mcpPruning=false",
      };
    }
    const route = input.route;
    if (!route) {
      return {
        pruned: false,
        keepServers: [...input.serverNames],
        prunedServers: [],
        labels: [],
        reason: "no route decision (fail-open)",
      };
    }
    if (route.uncertain === true) {
      // Phase-3 uncertain rule: an uncertain route NEVER prunes servers.
      return {
        pruned: false,
        keepServers: [...input.serverNames],
        prunedServers: [],
        labels: [],
        reason: "route uncertain=true: no MCP server pruning (fail-open)",
      };
    }
    if (
      typeof route.confidence !== "number" ||
      route.confidence < TOOL_PACK_PRUNE_CONFIDENCE_THRESHOLD
    ) {
      return {
        pruned: false,
        keepServers: [...input.serverNames],
        prunedServers: [],
        labels: [],
        reason: `route confidence ${route.confidence} below prune threshold (fail-open)`,
      };
    }
    const labels = resolveActiveLabels(route.taskLabels, input.taskText);
    const keepServerSubstrings = new Set<string>();
    for (const rule of TOOL_PACK_LABEL_TABLE) {
      if (!labels.includes(rule.label)) continue;
      for (const substring of rule.keepServers ?? []) {
        keepServerSubstrings.add(substring.toLowerCase());
      }
    }
    const keepServers: string[] = [];
    const prunedServers: string[] = [];
    // Phase 3: shim-ranked tools are advisory keep-signals for servers
    // too — a ranked id matching a server name keeps that server.
    const rankedToolIds = collectRankedToolIds(route);
    for (const serverName of input.serverNames) {
      const lowerServer = serverName.toLowerCase();
      const matchesKept = [...keepServerSubstrings].some((substring) =>
        lowerServer.includes(substring),
      );
      const matchesRanked = [...rankedToolIds].some((rankedId) =>
        rankedToolMatchesName(rankedId, serverName),
      );
      const matchesKnownIrrelevant = TOOL_PACK_KNOWN_SERVER_SUBSTRINGS.some(
        (substring) =>
          !keepServerSubstrings.has(substring) && lowerServer.includes(substring),
      );
      if (matchesKept || matchesRanked || !matchesKnownIrrelevant) {
        keepServers.push(serverName);
      } else {
        prunedServers.push(serverName);
      }
    }
    return {
      pruned: prunedServers.length > 0,
      keepServers,
      prunedServers,
      labels,
      reason:
        `route tier=${route.tier} confidence=${route.confidence} ` +
        `labels=[${labels.join(",")}] rankedToolIds=${rankedToolIds.size} ` +
        `kept servers=${keepServers.length}/${input.serverNames.length}`,
    };
  } catch {
    return {
      pruned: false,
      keepServers: [...input.serverNames],
      prunedServers: [],
      labels: [],
      reason: "server shortlist computation threw (fail-open)",
    };
  }
}

/**
 * Detect model tool calls that hit the tool-pack disallowlist: the model
 * called a tool whose schema was NOT sent this step. Returns the missed
 * tool names (deduped). Pure; the caller owns the recovery policy.
 */
export function detectToolPackMissedCalls(
  toolCalls: readonly { readonly name: string }[],
  sentTools: readonly { readonly name: string }[],
  packDisallowedNames: ReadonlySet<string> | undefined,
): string[] {
  if (!packDisallowedNames || packDisallowedNames.size === 0) return [];
  const sent = new Set(sentTools.map((tool) => tool.name));
  const missed = new Set<string>();
  for (const toolCall of toolCalls) {
    const name = toolCall.name?.trim();
    if (!name) continue;
    if (!sent.has(name) && packDisallowedNames.has(name)) missed.add(name);
  }
  return [...missed];
}

/**
 * System reminder injected when a tool-miss triggers fail-open recovery:
 * the next step sends the full tool set, so tell the model the tools are
 * available now.
 */
export function buildToolPackRecoveryReminderBody(
  missedToolNames: readonly string[],
): string {
  const names = missedToolNames.join(", ");
  return (
    `Note: the following tools were not listed in your available tools on the ` +
    `previous step but are available now: ${names}. If you still need one of ` +
    `them, call it again with the correct input schema.`
  );
}
