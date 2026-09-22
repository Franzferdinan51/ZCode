// Smart auto-routing preference: when enabled, new drafts without a recent or
// explicitly configured route get a heuristic suggestion from the draft text
// instead of plain registry order. Workspace-scoped, off by default.
const AUTO_ROUTE_KEY_PREFIX = "zcode-auto-route-enabled-v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function resolveAutoRouteKey(workspacePath: string, workspaceIdentity?: string): string {
  return `${AUTO_ROUTE_KEY_PREFIX}:${workspaceIdentity?.trim() || workspacePath}`;
}

export function readAutoRouteEnabled(
  workspacePath: string,
  workspaceIdentity?: string,
  storage: StorageLike | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(resolveAutoRouteKey(workspacePath, workspaceIdentity)) === "1";
  } catch {
    return false;
  }
}

export function writeAutoRouteEnabled(
  workspacePath: string,
  enabled: boolean,
  workspaceIdentity?: string,
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(resolveAutoRouteKey(workspacePath, workspaceIdentity), enabled ? "1" : "0");
  } catch {
    // Preference write is best-effort; the toggle still applies in-memory.
  }
}
