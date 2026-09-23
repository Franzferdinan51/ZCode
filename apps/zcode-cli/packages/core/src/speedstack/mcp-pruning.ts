// ============================================================
// Speed Stack: per-session MCP tool pruning
// ============================================================
//
// Let a session specify an MCP server/tool allowlist so only task-relevant
// tools are attached. Motivation: on-demand tool loading measured ~46.9%
// token reduction (Cursor's finding, cited as theirs).
//
// Opt-in: an undefined/empty allowlist means "no pruning" and the default
// behavior is completely unchanged.

/**
 * Normalize an allowlist: undefined, empty, or blank-only -> undefined
 * (no pruning). Otherwise the trimmed, non-blank entries.
 */
export function normalizeMcpAllowlist(
  allowlist: readonly string[] | undefined,
): string[] | undefined {
  if (!allowlist) return undefined;
  const entries = allowlist
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : undefined;
}

/**
 * Keep only allowlisted MCP servers. Pure function over a plain record so
 * callers can pass whatever server-config map they assemble.
 */
export function pruneMcpServerMap<T>(
  servers: Record<string, T>,
  allowlist: readonly string[] | undefined,
): Record<string, T> {
  const normalized = normalizeMcpAllowlist(allowlist);
  if (!normalized) return servers;
  const allowed = new Set(normalized.map((name) => name.toLowerCase()));
  return Object.fromEntries(
    Object.entries(servers).filter(([name]) => allowed.has(name.toLowerCase())),
  );
}

export interface PrunableMcpTool {
  readonly name: string;
  /** Owning MCP server name, when known. */
  readonly serverName?: string;
}

/**
 * Keep only allowlisted tools. Allowlist entries are `server.tool` or bare
 * `tool` names; a bare name matches any server. Case-insensitive.
 */
export function pruneMcpTools<T extends PrunableMcpTool>(
  tools: readonly T[],
  allowlist: readonly string[] | undefined,
): T[] {
  const normalized = normalizeMcpAllowlist(allowlist);
  if (!normalized) return [...tools];
  const serverScoped = new Set<string>();
  const bare = new Set<string>();
  for (const entry of normalized) {
    const dot = entry.indexOf(".");
    if (dot > 0) {
      serverScoped.add(
        `${entry.slice(0, dot).toLowerCase()}.${entry.slice(dot + 1).toLowerCase()}`,
      );
    } else {
      bare.add(entry.toLowerCase());
    }
  }
  return tools.filter((tool) => {
    const toolName = tool.name.toLowerCase();
    if (bare.has(toolName)) return true;
    const serverName = tool.serverName?.toLowerCase() ?? "";
    return serverName.length > 0 && serverScoped.has(`${serverName}.${toolName}`);
  });
}
