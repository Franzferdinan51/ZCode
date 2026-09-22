import type { ModelSelection } from "@zcode/shared";

/**
 * External session-route requests (Harness Router tab -> open composer).
 *
 * Draft model state lives in per-pane React state inside useDraftConfigControl,
 * which a workspace-global side pane cannot reach through props. Panes publish
 * a request here; each draft control applies the ones matching its scope id
 * through the exact composer-select path. Returns whether any control was
 * listening (false = target session has no open composer).
 */
export interface SessionRouteRequest {
  scopeId: string;
  selection: ModelSelection;
}

type SessionRouteListener = (request: SessionRouteRequest) => void;

const listeners = new Set<SessionRouteListener>();

export function subscribeSessionRouteRequests(listener: SessionRouteListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function requestSessionRoute(request: SessionRouteRequest): boolean {
  if (listeners.size === 0) {
    return false;
  }
  for (const listener of listeners) {
    listener(request);
  }
  return true;
}
