import type {
  ModelSelectionModelView,
  ModelSelectionProviderView,
} from "@zcode/provider";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelection } from "@zcode/shared";

export interface HarnessRouteModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  /** Disabled registry models are shown but cannot be routed to. */
  enabled: boolean;
  isRouted: boolean;
}

export interface HarnessProviderGroup {
  providerId: string;
  providerName: string;
  models: HarnessRouteModelOption[];
  hasRoutedModel: boolean;
}

function providerDisplayName(provider: ModelSelectionProviderView): string {
  return provider.providerName?.trim() || provider.providerId;
}

function isModelEnabled(model: ModelSelectionModelView): boolean {
  return model.config.enabled !== false;
}

export function isPreferredRoute(
  preferred: ModelSelection | undefined,
  providerId: string,
  modelId: string,
): boolean {
  return preferred?.providerId === providerId && preferred?.modelId === modelId;
}

export function buildHarnessProviderGroups(
  view: ModelSelectionView | null | undefined,
): HarnessProviderGroup[] {
  if (!view) {
    return [];
  }
  const preferred = view.preferredSelection;
  return view.providers.map((provider) => {
    const models = provider.models.map((model) => ({
      providerId: provider.providerId,
      providerName: providerDisplayName(provider),
      modelId: model.modelId,
      enabled: isModelEnabled(model),
      isRouted: isPreferredRoute(preferred, provider.providerId, model.modelId),
    }));
    return {
      providerId: provider.providerId,
      providerName: providerDisplayName(provider),
      models,
      hasRoutedModel: models.some((model) => model.isRouted),
    };
  });
}

export function describeRouteTarget(selection: ModelSelection | undefined): string | null {
  if (!selection) {
    return null;
  }
  return `${selection.providerId}/${selection.modelId}`;
}

export interface HarnessRouteOption {
  providerId: string;
  modelId: string;
  /** Registry model exists and is enabled. */
  enabled: boolean;
  /** Current default route points here. */
  isRouted: boolean;
  /** Execution consent persisted on the provider access config. */
  consentGranted: boolean;
}

/**
 * Live route option for a routable harness, or null when the matching
 * provider/model is absent from the registry view (e.g. older built-in
 * config). Consent is read from the effective provider access config.
 */
export function resolveHarnessRouteOption(
  view: ModelSelectionView | null | undefined,
  providerId: string,
  modelId: string,
): HarnessRouteOption | null {
  const provider = view?.providers.find((entry) => entry.providerId === providerId);
  const model = provider?.models.find((entry) => entry.modelId === modelId);
  if (!provider || !model) {
    return null;
  }
  const access = provider.config.access;
  return {
    providerId,
    modelId,
    enabled: isModelEnabled(model),
    isRouted: isPreferredRoute(view?.preferredSelection, providerId, modelId),
    consentGranted:
      access?.type === "external-harness" && access.consentGranted === true,
  };
}
