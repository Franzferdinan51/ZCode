import {
  getCapturedZCodeCuaBrokerCredentials,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZCODE_PLUGIN_ID_ENV_KEY,
} from "@zcode/shared";
import { registerMcpTools, traceContextToLogContext } from "../deps.js";
import {
  pruneMcpServerMap,
  pruneMcpTools,
} from "../../speedstack/mcp-pruning.js";
import { resolveMcpAttachPolicy } from "../../speedstack/systemone-route.js";
import type { McpConnectionSnapshot, McpServerConfig, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

const MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS = 15_000;

/**
 * 只有同时携带 resolver 注入的官方 plugin id 和本进程私有 authority 的 server 才能共享
 * Computer Use 项目授权。server 名、tool 名和 manifest env 都可被第三方仿造，不能单独作为信任依据。
 */
export function computeOfficialCuaServerNames(
  servers: Record<string, McpServerConfig>,
  trustedServerNames: ReadonlySet<string>,
): Set<string> {
  const expectedAuthority = getCapturedZCodeCuaBrokerCredentials().pluginAuthority;
  const names = new Set<string>();
  if (!expectedAuthority) return names;

  for (const [name, config] of Object.entries(servers)) {
    if (!trustedServerNames.has(name)) continue;
    if (config.type !== "stdio") continue;
    if (
      config.env?.[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase() !==
        ZCODE_CUA_OFFICIAL_PLUGIN_ID ||
      config.env?.[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]?.trim() !== expectedAuthority
    ) {
      continue;
    }
    names.add(name);
  }
  return names;
}

export function startMcpStartup(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<McpConnectionSnapshot> | undefined {
  if (this.mcpInitialized) return this.mcpStartupPromise;
  this.mcpInitialized = true;

  if (!this.mcpPort || this.config.mcp?.enabled === false) {
    this.mcpToolsRegistered = true;
    return undefined;
  }

  // Z2: route-driven MCP attach policy. The session's route decision is
  // settled before the first turn reaches MCP startup (executeTurnCommand
  // awaits it); a missing decision fails open to full attach.
  // Kill-switches: ZCODE_SPEEDSTACK_PRUNE=0 env, or
  // SpeedStackSessionConfig.mcpPruning=false. Every pruning decision is
  // logged below with the skipped servers and the reason.
  const configuredServers = this.config.mcp?.servers ?? {};
  const mcpPolicy = resolveMcpAttachPolicy(this.systemOneRouteValue, this.speedStackConfig, {
    serverNames: Object.keys(configuredServers),
    taskText: this.systemOneRouteTaskText,
  });
  let servers = configuredServers;
  if (!mcpPolicy.attachMcp) {
    const skippedServers = Object.keys(configuredServers);
    this.logger?.info("MCP servers skipped by SystemOne route decision", {
      ...traceContextToLogContext(traceContext),
      event: "mcp.servers.pruned",
      module: "core.runtime",
      reason: mcpPolicy.reason,
      skippedServers,
    });
    servers = {};
  } else {
    const prunedServers = pruneMcpServerMap(
      configuredServers,
      this.speedStackConfig.mcpServerAllowlist,
    );
    const skippedServers = Object.keys(configuredServers).filter(
      (name) => !(name in prunedServers),
    );
    if (skippedServers.length > 0) {
      this.logger?.info("MCP servers pruned by session allowlist", {
        ...traceContextToLogContext(traceContext),
        event: "mcp.servers.pruned",
        module: "core.runtime",
        reason: "SpeedStackSessionConfig.mcpServerAllowlist",
        skippedServers,
      });
    }
    servers = prunedServers;
  }
  // Z1 tool-pack subset: with a confident route, skip starting MCP servers
  // whose capability the task labels don't need. Unknown servers fail open
  // (kept). Pruned servers are recorded for on-demand startup if a later
  // tool-miss needs them (ensureToolPackPrunedMcpServersStarted).
  if (mcpPolicy.attachMcp && mcpPolicy.toolPolicy.mode === "subset") {
    const keepServers = new Set(mcpPolicy.toolPolicy.keepServers ?? []);
    const subsetSkipped = Object.keys(servers).filter((name) => !keepServers.has(name));
    if (subsetSkipped.length > 0) {
      this.systemOneToolPackPrunedServers = subsetSkipped;
      this.logger?.info("MCP servers skipped by tool-pack subset policy", {
        ...traceContextToLogContext(traceContext),
        event: "mcp.servers.pruned",
        module: "core.runtime",
        reason: mcpPolicy.toolPolicy.reason,
        skippedServers: subsetSkipped,
      });
      servers = Object.fromEntries(
        Object.entries(servers).filter(([name]) => keepServers.has(name)),
      );
    }
  }
  if (Object.keys(servers).length === 0) {
    const startup = Promise.all([this.mcpPort.status(), this.mcpPort.listTools()])
      .then(([statuses, tools]) => ({ statuses, tools }))
      .catch((error) => {
        this.logger?.warn("MCP existing tool discovery failed", {
          ...traceContextToLogContext(traceContext),
          error: error instanceof Error ? error.message : String(error),
          event: "mcp.existing_tools.failed",
          module: "core.runtime",
          status: "failed",
        });
        return { statuses: {}, tools: [] };
      });
    this.mcpStartupPromise = this.trackResidencyBlockingWork(startup);
    return this.mcpStartupPromise;
  }

  const startedAt = Date.now();
  const startup = this.mcpPort
    .connectConfiguredServers(servers, {
      // authorization_code MCP 无人完成浏览器授权时，session 启动过去会等默认 5 分钟，
      // 导致模型请求迟迟不发出；session 只等 15s，授权入口由设置页 mcp/list 展示。
      oauthAuthorizationTimeoutMs: MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS,
      trace: traceContext,
      workingDirectory: this.workingDirectory,
      workspaceIdentity: this.config.workspaceIdentity?.toString(),
    })
    .then((snapshot) => {
      const statusCounts = Object.values(snapshot.statuses).reduce<Record<string, number>>(
        (counts, status) => {
          counts[status.status] = (counts[status.status] ?? 0) + 1;
          return counts;
        },
        {},
      );
      this.logger?.info("MCP startup completed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        event: "mcp.startup.completed",
        module: "core.runtime",
        serverCount: Object.keys(servers).length,
        status: "completed",
        statusCounts,
        toolCount: snapshot.tools.length,
      });
      return snapshot;
    })
    .catch((error) => {
      this.logger?.warn("MCP startup failed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.startup.failed",
        module: "core.runtime",
        status: "failed",
      });
      return { statuses: {}, tools: [] };
    });
  this.mcpStartupPromise = this.trackResidencyBlockingWork(startup);
  this.logger?.debug("MCP startup scheduled", {
    ...traceContextToLogContext(traceContext),
    event: "mcp.startup.scheduled",
    module: "core.runtime",
    serverCount: Object.keys(servers).length,
    status: "started",
  });
  return this.mcpStartupPromise;
}

export async function initializeMcp(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  if (this.mcpToolsRegistered) return;

  const startup = this.startMcpStartup(traceContext);
  const mcpPort = this.mcpPort;
  if (!startup || !mcpPort) {
    this.mcpToolsRegistered = true;
    return;
  }
  const serverCount = Object.keys(this.config.mcp?.servers ?? {}).length;

  try {
    const snapshot = await startup;
    // Z2: session tool allowlist ("server.tool" or bare "tool" names);
    // undefined/empty = attach all (today's behavior).
    const prunableTools = snapshot.tools.map((tool, index) => ({
      index,
      name: tool.name ?? tool.toolName,
      serverName: tool.serverName,
    }));
    const keptIndexes = new Set(
      pruneMcpTools(prunableTools, this.speedStackConfig.mcpToolAllowlist).map(
        (tool) => tool.index,
      ),
    );
    const attachTools = snapshot.tools.filter((_, index) => keptIndexes.has(index));
    if (attachTools.length !== snapshot.tools.length) {
      this.logger?.info("MCP tools pruned by session allowlist", {
        ...traceContextToLogContext(traceContext),
        event: "mcp.tools.pruned",
        module: "core.runtime",
        prunedCount: snapshot.tools.length - attachTools.length,
        reason: "SpeedStackSessionConfig.mcpToolAllowlist",
      });
    }
    const registered = registerMcpTools(this.registry, mcpPort, attachTools, {
      allowedTools: this.config.toolAllowlist,
      disallowedTools: this.config.toolDisallowlist,
      officialCuaServerNames: computeOfficialCuaServerNames(
        this.config.mcp?.servers ?? {},
        new Set(this.config.mcp?.trustedOfficialCuaServerNames ?? []),
      ),
    });
    if (registered.length > 0) {
      this.invalidateToolCache();
    }
    this.logger?.info("MCP tools registered", {
      ...traceContextToLogContext(traceContext),
      event: "mcp.tools.registered",
      module: "core.runtime",
      registeredToolCount: registered.length,
      serverCount,
      status: "completed",
    });
  } catch (error) {
    this.mcpToolsRegistered = true;
    this.logger?.warn("MCP initialization failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.initialization.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
  this.mcpToolsRegistered = true;
}

/**
 * Z1 tool-miss recovery: start the MCP servers the tool-pack subset policy
 * pruned at startup, and register their tools (honoring the session
 * mcpToolAllowlist). One-shot per session: the pruned list is cleared before
 * connecting so a failure can't wedge retries. Never throws.
 */
export async function ensureToolPackPrunedMcpServersStarted(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  const prunedServers = this.systemOneToolPackPrunedServers;
  if (!prunedServers || prunedServers.length === 0) return;
  const mcpPort = this.mcpPort;
  if (!mcpPort) return;
  this.systemOneToolPackPrunedServers = undefined;
  const configuredServers = this.config.mcp?.servers ?? {};
  try {
    const snapshot = await mcpPort.connectConfiguredServers(configuredServers, {
      oauthAuthorizationTimeoutMs: MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS,
      trace: traceContext,
      workingDirectory: this.workingDirectory,
      workspaceIdentity: this.config.workspaceIdentity?.toString(),
    });
    const prunedSet = new Set(prunedServers);
    const freshTools = snapshot.tools.filter((tool) => prunedSet.has(tool.serverName));
    const prunableTools = freshTools.map((tool, index) => ({
      index,
      name: tool.name ?? tool.toolName,
      serverName: tool.serverName,
    }));
    const keptIndexes = new Set(
      pruneMcpTools(prunableTools, this.speedStackConfig.mcpToolAllowlist).map(
        (tool) => tool.index,
      ),
    );
    const attachTools = freshTools.filter((_, index) => keptIndexes.has(index));
    const registered = registerMcpTools(this.registry, mcpPort, attachTools, {
      allowedTools: this.config.toolAllowlist,
      disallowedTools: this.config.toolDisallowlist,
      officialCuaServerNames: computeOfficialCuaServerNames(
        this.config.mcp?.servers ?? {},
        new Set(this.config.mcp?.trustedOfficialCuaServerNames ?? []),
      ),
    });
    if (registered.length > 0) {
      this.invalidateToolCache();
    }
    this.logger?.info("Tool-pack recovery: pruned MCP servers started", {
      ...traceContextToLogContext(traceContext),
      event: "mcp.servers.tool_pack_recovered",
      module: "core.runtime",
      registeredToolCount: registered.length,
      serverCount: prunedServers.length,
      status: "completed",
    });
  } catch (error) {
    this.logger?.warn("Tool-pack MCP recovery failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.servers.tool_pack_recovery_failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}
