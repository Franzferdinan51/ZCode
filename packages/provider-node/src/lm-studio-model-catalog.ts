import {
  DEFAULT_LM_STUDIO_API_KEY,
  lmStudioV0ModelsUrl,
  lmStudioV1ModelsUrl,
  mergeLmStudioModelCatalog,
  resolveLmStudioBaseUrl,
} from "@zcode/provider";

export interface FetchLmStudioModelCatalogOptions {
  readonly baseUrl?: string;
  readonly apiKey?: string | null;
  readonly request?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 1500;

function authorizationHeader(apiKey?: string | null): Record<string, string> {
  const token =
    apiKey?.trim() || process.env.LM_STUDIO_API_KEY?.trim() || DEFAULT_LM_STUDIO_API_KEY;
  return { Authorization: `Bearer ${token}` };
}

async function readJson(
  url: string,
  request: typeof fetch,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(url, { headers, signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load the LM Studio picker catalog from `/api/v0/models` when present, then `/v1/models`.
 * Does not start or load models; missing endpoints fall through to the next.
 */
export async function fetchLmStudioModelCatalog(
  options: FetchLmStudioModelCatalogOptions = {},
): Promise<readonly string[]> {
  const baseUrl = resolveLmStudioBaseUrl(options.baseUrl);
  const request = options.request ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = authorizationHeader(options.apiKey);
  const v0 = await readJson(lmStudioV0ModelsUrl(baseUrl), request, headers, timeoutMs);
  const v1 = await readJson(lmStudioV1ModelsUrl(baseUrl), request, headers, timeoutMs);
  return mergeLmStudioModelCatalog({
    ...(v0 === undefined ? {} : { v0 }),
    ...(v1 === undefined ? {} : { v1 }),
  });
}
