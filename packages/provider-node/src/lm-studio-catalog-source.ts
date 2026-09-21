import {
  applyLmStudioCatalogToProviderLayer,
  LM_STUDIO_PROVIDER_ID,
  preferLmStudioModelId,
  type ProviderConfigLayerSnapshot,
  type ProviderSource,
} from "@zcode/provider";
import { fetchLmStudioModelCatalog } from "./lm-studio-model-catalog.js";

export type LmStudioCatalogFetcher = typeof fetchLmStudioModelCatalog;

export interface LmStudioCatalogOverlaySourceOptions {
  readonly inner: ProviderSource<ProviderConfigLayerSnapshot>;
  readonly fetchCatalog?: LmStudioCatalogFetcher;
  /** 目录缓存有效期；默认 30 秒。传 0 关闭缓存（测试/调试用）。 */
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

const DEFAULT_CACHE_TTL_MS = 30_000;

interface CatalogCacheEntry {
  readonly key: string;
  readonly modelIds: readonly string[];
  readonly storedAt: number;
}

/**
 * Overlay live LM Studio model IDs onto the builtin local provider without mutating
 * the bundled JSON. Fetch failures keep the bundled fallback model.
 * 成功结果按 baseUrl+apiKey 缓存（默认 30 秒），并发 read 共用一次在途请求，
 * 避免每次配置读取都打两次本地 HTTP。
 */
export class LmStudioCatalogOverlaySource implements ProviderSource<ProviderConfigLayerSnapshot> {
  readonly #inner: ProviderSource<ProviderConfigLayerSnapshot>;
  readonly #fetchCatalog: LmStudioCatalogFetcher;
  readonly #cacheTtlMs: number;
  readonly #now: () => number;
  #cached: CatalogCacheEntry | null = null;
  #inflight: Promise<readonly string[]> | null = null;

  constructor(options: LmStudioCatalogOverlaySourceOptions) {
    this.#inner = options.inner;
    this.#fetchCatalog = options.fetchCatalog ?? fetchLmStudioModelCatalog;
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#now = options.now ?? Date.now;
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
      const modelIds = await this.#readCatalog(baseUrl, apiKey);
      const ordered = preferLmStudioModelId(modelIds, process.env.LM_STUDIO_MODEL);
      return applyLmStudioCatalogToProviderLayer(snapshot, ordered);
    } catch {
      return snapshot;
    }
  }

  async #readCatalog(baseUrl?: string, apiKey?: string): Promise<readonly string[]> {
    const key = `${baseUrl ?? ""}\0${apiKey ?? ""}`;
    const cached = this.#cached;
    if (
      cached &&
      cached.key === key &&
      this.#cacheTtlMs > 0 &&
      this.#now() - cached.storedAt < this.#cacheTtlMs
    ) {
      return cached.modelIds;
    }
    if (!this.#inflight) {
      this.#inflight = this.#fetchCatalog({ baseUrl, apiKey }).finally(() => {
        this.#inflight = null;
      });
    }
    const modelIds = await this.#inflight;
    if (this.#cacheTtlMs > 0) {
      this.#cached = { key, modelIds, storedAt: this.#now() };
    }
    return modelIds;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    return this.#inner.onDidChange(listener);
  }
}
