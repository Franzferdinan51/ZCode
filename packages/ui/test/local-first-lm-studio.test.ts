import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createFailClosedAccountProviderConfigSnapshot,
  DEFAULT_LM_STUDIO_BASE_URL,
  LM_STUDIO_PROVIDER_ID,
  mergeLmStudioModelCatalog,
  ModelConfigRules,
  parseLmStudioModelsJson,
  ProviderConfigMap,
  ProviderConfigResolver,
  resolveInitialModelSelection,
} from "../../provider/src/index.js";
import { decodeZCodeBuiltinRelease } from "../../provider-node/src/zcode-builtin-release.js";
import { fetchLmStudioModelCatalog } from "../../provider-node/src/lm-studio-model-catalog.js";
import {
  resolveProviderAvailabilityState,
  shouldOpenProviderLoginEntry,
} from "../src/lib/modelProviderAvailability.js";

const builtinPath = fileURLToPath(
  new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
);

const v0Fixture = {
  data: [
    { id: "embed-nomic", type: "embeddings", state: "loaded" },
    { id: "qwen-unloaded", type: "llm", state: "not-loaded" },
    { id: "qwen-loaded", type: "llm", state: "loaded" },
    { id: "vision-loaded", type: "vlm", state: "loaded" },
  ],
};

const v1Fixture = {
  object: "list",
  data: [
    { id: "qwen-loaded", object: "model" },
    { id: "qwen-unloaded", object: "model" },
    { id: "vision-loaded", object: "model" },
    { id: "text-embedding-foo", object: "model" },
    { id: "only-in-v1", object: "model" },
  ],
};

const expectedPickerIds = ["qwen-loaded", "vision-loaded", "only-in-v1", "qwen-unloaded"];

function loadBuiltinRelease() {
  return decodeZCodeBuiltinRelease(JSON.parse(readFileSync(builtinPath, "utf8")));
}

function resolveBuiltinRegistry(accountFailClosed: boolean) {
  const release = loadBuiltinRelease();
  const config = Object.freeze({
    revision: "test-builtin",
    zcodeBuiltinRevision: String(release.revision),
    personalRevision: "none",
    zcodeBuiltinProviders: release.config.providers,
    zcodeBuiltinProviderTemplates: release.config.providerTemplates,
    personalProviders: ProviderConfigMap.empty(),
    zcodeBuiltinModelRules: release.config.modelConfigRules,
    personalModels: ModelConfigRules.empty(),
  });
  const account = accountFailClosed
    ? createFailClosedAccountProviderConfigSnapshot(config)
    : {
        providers: ProviderConfigMap.empty(),
        basedOnZCodeBuiltinRevision: config.zcodeBuiltinRevision,
        revision: "empty",
      };
  return {
    config,
    account,
    resolution: new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: config.zcodeBuiltinProviders,
      zcodeBuiltinProviderTemplates: config.zcodeBuiltinProviderTemplates,
      personalProviders: config.personalProviders,
      zcodeBuiltinModelRules: config.zcodeBuiltinModelRules,
      personalModels: config.personalModels,
      accountProviders: account.providers,
    }),
  };
}

test("builtin default provider is LM Studio at the local OpenAI-compatible base URL", () => {
  const release = loadBuiltinRelease();
  const lm = release.config.providers.get(LM_STUDIO_PROVIDER_ID);
  assert.ok(lm, "local:lm-studio must be a builtin provider");
  assert.equal(lm.api?.baseUrl, DEFAULT_LM_STUDIO_BASE_URL);
  assert.equal(DEFAULT_LM_STUDIO_BASE_URL, "http://127.0.0.1:1234/v1");
  assert.equal(lm.access?.type, "api-key");
  assert.notEqual(lm.access?.type, "zhipu-account");
  assert.equal(release.config.providers.keys()[0], LM_STUDIO_PROVIDER_ID);
  assert.equal(LM_STUDIO_PROVIDER_ID.startsWith("account:zai-"), false);
  assert.equal(LM_STUDIO_PROVIDER_ID.startsWith("account:bigmodel-"), false);
});

test("fail-closed zhipu overlay does not hide or disable the LM Studio default", () => {
  const { account, resolution } = resolveBuiltinRegistry(true);
  const overlay = account.providers.get(LM_STUDIO_PROVIDER_ID);
  assert.equal(overlay, undefined);
  const zai = account.providers.get("account:zai-individual-coding-plan");
  assert.equal(zai?.access?.type, "zhipu-account");
  assert.equal(zai?.access && "entitled" in zai.access ? zai.access.entitled : undefined, false);

  const lm = resolution.registryProviders.find(
    (provider) => provider.providerId === LM_STUDIO_PROVIDER_ID,
  );
  assert.ok(lm);
  assert.equal(lm.config.api.baseUrl, DEFAULT_LM_STUDIO_BASE_URL);
  assert.equal(lm.config.access.type, "api-key");
  assert.ok(lm.models.length > 0);
  assert.equal(
    resolution.registryProviders.some((provider) => provider.providerId.startsWith("account:zai-")),
    false,
  );
  assert.equal(
    resolution.registryProviders.some((provider) =>
      provider.providerId.startsWith("account:bigmodel-"),
    ),
    false,
  );

  const initial = resolveInitialModelSelection({
    registry: { revision: 1, providers: resolution.registryProviders },
  });
  assert.notEqual(initial.source, "none");
  if (initial.source === "none") throw new Error("expected a default selection");
  assert.equal(initial.selection.providerId, LM_STUDIO_PROVIDER_ID);
  assert.equal(initial.selection.providerId.startsWith("account:zai-"), false);
});

test("LM Studio model list parser puts loaded chat models first and excludes embeddings", () => {
  const parsedV0 = parseLmStudioModelsJson(v0Fixture);
  assert.equal(
    parsedV0.some((entry) => entry.id === "embed-nomic" && entry.embedding),
    true,
  );
  const ids = mergeLmStudioModelCatalog({ v0: v0Fixture, v1: v1Fixture });
  assert.deepEqual([...ids], expectedPickerIds);
  assert.equal(ids.includes("embed-nomic"), false);
  assert.equal(ids.includes("text-embedding-foo"), false);
});

test("fixture LM Studio HTTP catalog is fetched and parsed by the shipped catalog function", async () => {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/api/v0/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(v0Fixture));
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(v1Fixture));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  try {
    const ids = await fetchLmStudioModelCatalog({ baseUrl, timeoutMs: 2000 });
    assert.deepEqual([...ids], expectedPickerIds);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("usable LM Studio registry does not open the Z.ai login wall", () => {
  const { resolution } = resolveBuiltinRegistry(true);
  const availability = resolveProviderAvailabilityState({
    modelSelectionView: {
      providers: resolution.registryProviders.map((provider) => ({
        providerId: provider.providerId,
        models: provider.models,
      })),
    } as never,
  });
  assert.equal(availability.hasUsableProvider, true);
  assert.equal(
    shouldOpenProviderLoginEntry({
      hasUsableProvider: availability.hasUsableProvider,
      hasUser: false,
    }),
    false,
  );
  assert.equal(shouldOpenProviderLoginEntry({ hasUsableProvider: false, hasUser: false }), true);
});
