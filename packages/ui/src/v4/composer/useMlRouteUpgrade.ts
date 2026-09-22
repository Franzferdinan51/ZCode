import { useEffect, useRef } from "react";
import type { ModelSelectionView } from "@zcode/services";
import { completeNewModelSelection } from "@zcode/provider";
import type { ModelSelection } from "@zcode/shared";
import { candidatesFromSelectionView } from "@zcode/shared/auto-router";
import { useServices } from "@/hooks/useServices.js";
import { readComposerRecent } from "@/lib/composerRecent.js";
import {
  mlRoutePreferenceToBackendConfig,
  readMlRoutePreference,
} from "@/lib/mlRoutePreference.js";
import { logger } from "@/logger.js";

/**
 * One-shot async ML upgrade for new-task drafts. The sync heuristic already
 * picked instantly at init; when the user opted into local ML routing in
 * Settings, this effect asks the host sidecar to re-rank and applies the ML
 * pick only if the user has not touched the selection since (same
 * no-explicit-override rule as the heuristic). Any failure is silent — the
 * heuristic pick stands.
 */
export function useMlRouteUpgrade(params: {
  scopeKey: string;
  initializeAsNewTask: boolean;
  draftText: string;
  draftSelection: ModelSelection | undefined;
  modelSelectionView: ModelSelectionView | null;
  workspacePath: string;
  workspaceIdentity: string | undefined;
  updateModelSelection: (selection: ModelSelection) => void;
}): void {
  const {
    scopeKey,
    initializeAsNewTask,
    draftText,
    draftSelection,
    modelSelectionView,
    workspacePath,
    workspaceIdentity,
    updateModelSelection,
  } = params;
  const { systemService } = useServices();
  const attemptedRef = useRef<string | null>(null);
  const liveRef = useRef({
    scopeKey,
    draftSelection,
    modelSelectionView,
    updateModelSelection,
  });
  liveRef.current = { scopeKey, draftSelection, modelSelectionView, updateModelSelection };

  const hasText = draftText.trim().length > 0;
  const selectionKey = draftSelection
    ? `${draftSelection.providerId}::${draftSelection.modelId}`
    : "";

  useEffect(() => {
    if (!initializeAsNewTask || !hasText || !modelSelectionView) return;
    if (!readMlRoutePreference().enabled) return;
    if (!systemService) return;
    // Same explicit-wins gates as the sync heuristic path.
    if (modelSelectionView.preferredSource === "configured-default") return;
    if (readComposerRecent(workspacePath, workspaceIdentity)?.modelSelection) return;
    const attemptKey = `${scopeKey}::${selectionKey}`;
    if (attemptedRef.current === attemptKey) return;
    attemptedRef.current = attemptKey;

    const view = modelSelectionView;
    const selectionAtFire = selectionKey;
    const preference = readMlRoutePreference();
    void (async () => {
      let response;
      try {
        response = await systemService.suggestMlRoute({
          candidates: candidatesFromSelectionView(view),
          signals: { textSample: draftText.slice(0, 4000), approxInputChars: draftText.length },
          backend: mlRoutePreferenceToBackendConfig(preference),
        });
      } catch (error) {
        logger.debug("[ml-route] sidecar request failed, keeping heuristic pick", {
          error: String(error),
        });
        return;
      }
      const live = liveRef.current;
      if (live.scopeKey !== scopeKey) return;
      if (response.agreement) {
        logger.info("[ml-route] agreement", {
          backend: response.backend,
          agree: response.agreement.agree,
          heuristic: response.agreement.heuristicPick,
          ml: response.agreement.mlPick,
          confidence: response.agreement.mlConfidence,
          reason: response.reason,
        });
      }
      if (!response.suggestion) return;
      const current = live.draftSelection;
      const currentKey = current ? `${current.providerId}::${current.modelId}` : "";
      // User re-picked while the sidecar thought: their intent wins.
      if (currentKey !== selectionAtFire) return;
      if (
        current?.providerId === response.suggestion.providerId &&
        current?.modelId === response.suggestion.modelId
      ) {
        return;
      }
      const completed = completeNewModelSelection(live.modelSelectionView ?? view, {
        providerId: response.suggestion.providerId,
        modelId: response.suggestion.modelId,
      });
      if (!completed) return;
      logger.info("[ml-route] applied ML pick", {
        backend: response.backend,
        providerId: response.suggestion.providerId,
        modelId: response.suggestion.modelId,
      });
      live.updateModelSelection(completed);
    })();
  }, [
    initializeAsNewTask,
    hasText,
    modelSelectionView,
    scopeKey,
    selectionKey,
    draftText,
    systemService,
    workspacePath,
    workspaceIdentity,
  ]);
}
