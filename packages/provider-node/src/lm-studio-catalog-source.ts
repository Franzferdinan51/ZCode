import {
  applyLmStudioCatalogToProviderLayer,
  LM_STUDIO_PROVIDER_ID,
  type ProviderConfigLayerSnapshot,
  type ProviderSource,
} from "@zcode/provider";
import { fetchLmStudioModelCatalog } from "./lm-studio-model-catalog.js";

export type LmStudioCatalogFetcher = typeof fetchLmStudioModelCatalog;

export interface LmStudioCatalogOverlaySourceOptions {
  readonly inner: ProviderSource<ProviderConfigLayerSnapshot>;
  readonly fetchCatalog?: LmStudioCatalogFetcher;
}

/**
 * Overlay live LM Studio model IDs onto the builtin local provider without mutating
 * the bundled JSON. Fetch failures keep the bundled fallback model.
 */
export class LmStudioCatalogOverlaySource implements ProviderSource<ProviderConfigLayerSnapshot> {
  readonly #inner: ProviderSource<ProviderConfigLayerSnapshot>;
  readonly #fetchCatalog: LmStudioCatalogFetcher;

  constructor(options: LmStudioCatalogOverlaySourceOptions) {
    this.#inner = options.inner;
    this.#fetchCatalog = options.fetchCatalog ?? fetchLmStudioModelCatalog;
  }

  async read(): Promise<ProviderConfigLayerSnapshot> {
    const snapshot = await this.#inner.read();
    const provider = snapshot.providers.get(LM_STUDIO_PROVIDER_ID);
    if (!provider) return snapshot;
    const baseUrl = provider.api?.baseUrl ?? undefined;
    const rawKey =
      provider.access && "apiKey" in provider.access ? provider.access.apiKey : undefined;
    const apiKey = rawKey ?? undefined;
    try {
      const modelIds = await this.#fetchCatalog({ baseUrl, apiKey });
      return applyLmStudioCatalogToProviderLayer(snapshot, modelIds);
    } catch {
      return snapshot;
    }
  }

  onDidChange(listener: (reason: string) => void): () => void {
    return this.#inner.onDidChange(listener);
  }
}
