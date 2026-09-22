import { useCallback, useState } from "react";
import { CheckIcon, Loader2Icon, RotateCcwIcon, RouteIcon } from "lucide-react";
import type { ModelSelection } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";
import {
  buildHarnessProviderGroups,
  describeRouteTarget,
} from "@/harness-router/harnessRouterModel.js";

interface HarnessRouterSidePaneProps {
  workspacePath: string;
  workspaceIdentity?: string;
  enabled?: boolean;
}

export function HarnessRouterSidePane({
  workspacePath,
  enabled = true,
}: HarnessRouterSidePaneProps) {
  const { intl } = useZCodeIntl();
  const { modelSelectionService } = useServices();
  const { state, reload } = useModelSelectionServiceView(modelSelectionService ?? null, enabled);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const saveRoute = useCallback(
    async (selection: ModelSelection | undefined) => {
      if (!modelSelectionService) {
        return;
      }
      const key = describeRouteTarget(selection) ?? "automatic";
      setPendingKey(key);
      setSaveError(null);
      try {
        await modelSelectionService.saveDefaultModelSelection(selection);
        logger.info("[harness-router] default route saved", {
          route: key,
          workspacePath,
        });
      } catch (error) {
        logger.error("[harness-router] save default route failed", error);
        setSaveError(
          error instanceof Error
            ? error.message
            : intl.formatMessage({ id: "harnessRouter.saveError" }),
        );
      } finally {
        setPendingKey((current) => (current === key ? null : current));
      }
    },
    [intl, modelSelectionService, workspacePath],
  );

  if (state.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-ui-xs text-foreground-subtle">
        <Loader2Icon className="size-3.5 animate-spin" />
        {intl.formatMessage({ id: "harnessRouter.loading" })}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "harnessRouter.loadError" })}
        </p>
        <Button size="sm" variant="outline" onClick={reload}>
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    );
  }

  if (state.status === "unavailable") {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "harnessRouter.unavailable" })}
      </div>
    );
  }

  const groups = buildHarnessProviderGroups(state.view);
  const routed = state.view.preferredSelection;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <RouteIcon className="size-3.5 text-foreground-subtle" />
          <h2 className="text-ui-sm font-medium text-foreground">
            {intl.formatMessage({ id: "sidePane.harnessRouter" })}
          </h2>
        </div>
        <p className="pt-1 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "harnessRouter.description" })}
        </p>
        <p className="pt-1 text-ui-xs text-foreground-subtle">
          {intl.formatMessage(
            { id: "harnessRouter.currentRoute" },
            {
              route: routed
                ? `${routed.providerId}/${routed.modelId}`
                : intl.formatMessage({ id: "harnessRouter.automatic" }),
            },
          )}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <button
          type="button"
          disabled={pendingKey !== null}
          onClick={() => void saveRoute(undefined)}
          className={cn(
            "flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-ui-xs",
            "border-border hover:bg-accent disabled:opacity-60",
            !routed && "border-primary",
          )}
        >
          {pendingKey === "automatic" ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <RotateCcwIcon className="size-3.5 text-foreground-subtle" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-foreground">
              {intl.formatMessage({ id: "harnessRouter.automatic" })}
            </span>
            <span className="block truncate text-foreground-subtle">
              {intl.formatMessage({ id: "harnessRouter.automaticHint" })}
            </span>
          </span>
          {!routed && <CheckIcon className="size-3.5 shrink-0 text-primary" />}
        </button>

        {groups.length === 0 ? (
          <p className="px-1 pt-3 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "harnessRouter.noProviders" })}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.providerId} className="pt-3">
              <h3 className="px-1 pb-1.5 text-ui-xs font-medium text-foreground-subtle">
                {group.providerName}
              </h3>
              <ul className="flex flex-col gap-1">
                {group.models.map((model) => {
                  const key = `${model.providerId}/${model.modelId}`;
                  const pending = pendingKey === key;
                  return (
                    <li key={model.modelId}>
                      <button
                        type="button"
                        disabled={!model.enabled || pendingKey !== null}
                        onClick={() =>
                          void saveRoute({ providerId: model.providerId, modelId: model.modelId })
                        }
                        title={key}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left",
                          "border-border hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60",
                          model.isRouted && "border-primary",
                        )}
                      >
                        {pending ? (
                          <Loader2Icon className="size-3.5 animate-spin" />
                        ) : (
                          <span
                            className={cn(
                              "size-1.5 shrink-0 rounded-full",
                              model.isRouted ? "bg-primary" : "bg-border",
                            )}
                          />
                        )}
                        <span className="min-w-0 flex-1 truncate font-mono text-ui-xs text-foreground">
                          {model.modelId}
                        </span>
                        {!model.enabled && (
                          <span className="shrink-0 text-ui-xs text-foreground-subtle">
                            {intl.formatMessage({ id: "harnessRouter.disabled" })}
                          </span>
                        )}
                        {model.isRouted && (
                          <CheckIcon className="size-3.5 shrink-0 text-primary" />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}

        {saveError && (
          <p className="px-1 pt-3 text-ui-xs text-destructive">{saveError}</p>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-3 py-2">
        <p className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "harnessRouter.footerHint" })}
        </p>
      </div>
    </div>
  );
}
