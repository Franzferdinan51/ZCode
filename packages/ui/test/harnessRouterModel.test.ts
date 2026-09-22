import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelectionView } from "@zcode/services";
import {
  buildHarnessProviderGroups,
  describeRouteTarget,
  isPreferredRoute,
  resolveHarnessRouteOption,
} from "../src/harness-router/harnessRouterModel.js";

function makeView(overrides: Partial<ModelSelectionView> = {}): ModelSelectionView {
  return {
    revision: 1,
    providers: [
      {
        providerId: "lm-studio",
        providerName: "LM Studio",
        templateId: "openai",
        config: {},
        models: [
          { modelId: "local-model", config: { enabled: true } },
          { modelId: "old-model", config: { enabled: false } },
        ],
      },
      {
        providerId: "custom",
        providerName: "",
        templateId: "openai",
        config: {},
        models: [],
      },
    ],
    ...overrides,
  } as ModelSelectionView;
}

test("groups providers with enabled flags and routed markers", () => {
  const groups = buildHarnessProviderGroups(
    makeView({ preferredSelection: { providerId: "lm-studio", modelId: "local-model" } }),
  );
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.providerName, "LM Studio");
  assert.equal(groups[0]?.hasRoutedModel, true);
  assert.deepEqual(
    groups[0]?.models.map((model) => [model.modelId, model.enabled, model.isRouted]),
    [
      ["local-model", true, true],
      ["old-model", false, false],
    ],
  );
  assert.equal(groups[1]?.providerName, "custom");
  assert.equal(groups[1]?.hasRoutedModel, false);
});

test("empty view yields no groups", () => {
  assert.deepEqual(buildHarnessProviderGroups(null), []);
  assert.deepEqual(buildHarnessProviderGroups(makeView({ providers: [] })), []);
});

test("isPreferredRoute matches provider and model", () => {
  assert.equal(
    isPreferredRoute({ providerId: "a", modelId: "b" }, "a", "b"),
    true,
  );
  assert.equal(isPreferredRoute({ providerId: "a", modelId: "b" }, "a", "c"), false);
  assert.equal(isPreferredRoute(undefined, "a", "b"), false);
});

test("describeRouteTarget formats selection", () => {
  assert.equal(describeRouteTarget({ providerId: "a", modelId: "b" }), "a/b");
  assert.equal(describeRouteTarget(undefined), null);
});

test("resolveHarnessRouteOption reads enabled, routed, and consent state", () => {
  const view = makeView({
    providers: [
      {
        providerId: "external:codex",
        providerName: "Codex CLI",
        config: {
          access: { type: "external-harness", driverId: "codex", consentGranted: true },
        },
        models: [{ modelId: "external-codex", config: { enabled: true } }],
      },
    ],
    preferredSelection: { providerId: "external:codex", modelId: "external-codex" },
  });
  assert.deepEqual(resolveHarnessRouteOption(view, "external:codex", "external-codex"), {
    providerId: "external:codex",
    modelId: "external-codex",
    enabled: true,
    isRouted: true,
    consentGranted: true,
  });
  assert.equal(resolveHarnessRouteOption(view, "external:codex", "nope"), null);
  assert.equal(resolveHarnessRouteOption(view, "external:muse", "external-muse"), null);
  assert.equal(resolveHarnessRouteOption(null, "external:codex", "external-codex"), null);
});

test("resolveHarnessRouteOption is consent-false without granted flag", () => {
  const view = makeView({
    providers: [
      {
        providerId: "external:codex",
        providerName: "Codex CLI",
        config: { access: { type: "external-harness", driverId: "codex" } },
        models: [{ modelId: "external-codex", config: { enabled: false } }],
      },
    ],
  });
  assert.deepEqual(resolveHarnessRouteOption(view, "external:codex", "external-codex"), {
    providerId: "external:codex",
    modelId: "external-codex",
    enabled: false,
    isRouted: false,
    consentGranted: false,
  });
});
