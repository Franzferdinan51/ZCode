// Local ML routing preference (Jeff-1 / SystemOne / Laya sidecars).
// App-global (one machine, one sidecar), OFF by default: local ML runtimes
// cost significant RAM/CPU (GBs of weights, seconds of cold load), so only
// knowledgeable users should enable this in Settings. When on, new drafts
// are first picked by the instant heuristic, then asynchronously re-ranked
// by the configured backend; any failure keeps the heuristic pick.
import type { MlRouteBackendConfig, MlRouteBackendId } from "@zcode/shared/systemone-scorer";

const ML_ROUTE_KEY = "zcode-ml-route-v1";

const BACKENDS: readonly MlRouteBackendId[] = ["laya", "jeff-1", "systemone", "custom"];

export interface MlRoutePreference {
  enabled: boolean;
  backend: MlRouteBackendId;
  endpoint: string;
  timeoutMs: number;
}

export const DEFAULT_ML_ROUTE_PREFERENCE: MlRoutePreference = {
  enabled: false,
  backend: "laya",
  endpoint: "",
  timeoutMs: 20_000,
};

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

function normalize(raw: unknown): MlRoutePreference {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_ML_ROUTE_PREFERENCE };
  const value = raw as Partial<MlRoutePreference>;
  return {
    enabled: value.enabled === true,
    backend: BACKENDS.includes(value.backend as MlRouteBackendId)
      ? (value.backend as MlRouteBackendId)
      : DEFAULT_ML_ROUTE_PREFERENCE.backend,
    endpoint: typeof value.endpoint === "string" ? value.endpoint.trim().slice(0, 500) : "",
    timeoutMs:
      typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs)
        ? Math.min(180_000, Math.max(2_000, Math.floor(value.timeoutMs)))
        : DEFAULT_ML_ROUTE_PREFERENCE.timeoutMs,
  };
}

export function readMlRoutePreference(
  storage: StorageLike | null = browserStorage(),
): MlRoutePreference {
  if (!storage) return { ...DEFAULT_ML_ROUTE_PREFERENCE };
  try {
    const raw = storage.getItem(ML_ROUTE_KEY);
    if (!raw) return { ...DEFAULT_ML_ROUTE_PREFERENCE };
    return normalize(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_ML_ROUTE_PREFERENCE };
  }
}

export function writeMlRoutePreference(
  preference: MlRoutePreference,
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(ML_ROUTE_KEY, JSON.stringify(normalize(preference)));
  } catch {
    // Preference write is best-effort; the toggle still applies in-memory.
  }
}

export function mlRoutePreferenceToBackendConfig(
  preference: MlRoutePreference,
): MlRouteBackendConfig {
  return {
    backend: preference.backend,
    ...(preference.endpoint ? { endpoint: preference.endpoint } : {}),
    timeoutMs: preference.timeoutMs,
  };
}
