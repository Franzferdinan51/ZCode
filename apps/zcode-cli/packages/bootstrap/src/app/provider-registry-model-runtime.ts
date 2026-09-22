import type { AiSdkModelAdapter } from "@zcode/adapters/model";
import { isModelFailoverCooledDown, withModelFailover } from "@zcode/adapters/model";
import type { Model } from "@zcode/contracts";
import type { AgentRuntimeDeps } from "@zcode/core";
import {
  type ModelSelection,
  type ModelSelectionValidation,
  type Provider,
  type ProviderModel,
  type ProviderRegistryView,
} from "@zcode/provider";
import { createRegistrySelectionProtocolError } from "./provider-registry-selection.js";

export type RuntimeModelFactory = NonNullable<AgentRuntimeDeps["modelFactory"]>;

export interface ProviderRegistryModelSource {
  getView(): ProviderRegistryView;
  getProvider(providerId: string): Provider | undefined;
  getModel(providerId: string, modelId: string): ProviderModel | undefined;
  validateSelection(selection: ModelSelection): ModelSelectionValidation;
  onDidChange(listener: () => void): () => void;
}

type ApiProviderModelAdapter = Pick<AiSdkModelAdapter, "createModel">;

interface ApiProviderModelRuntimeOptions {
  readonly registry: ProviderRegistryModelSource;
  readonly modelAdapter: ApiProviderModelAdapter;
}

/**
 * 从业务 Registry 精确查找一次完整事实，并直接创建冻结静态配置的 Model。
 */
export class ApiProviderModelRuntime {
  readonly #registry: ProviderRegistryModelSource;
  readonly #modelAdapter: ApiProviderModelAdapter;
  #started = false;

  constructor(options: ApiProviderModelRuntimeOptions) {
    this.#registry = options.registry;
    this.#modelAdapter = options.modelAdapter;
  }

  readonly modelFactory: RuntimeModelFactory = (target): Model => {
    if (!this.#started) throw new Error("ApiProviderModelRuntime 必须先 start() 再创建 Model");
    const validation = this.#registry.validateSelection(target.selection);
    if (!validation.ok) throw createRegistrySelectionProtocolError(validation);
    const providerId = target.selection.providerId;
    const modelId = target.selection.modelId;
    const provider = this.#registry.getProvider(providerId);
    if (!provider) throw new Error("Registry Selection 校验与 Provider 索引结果不一致");
    const registryModel = this.#registry.getModel(providerId, modelId);
    if (!registryModel) throw new Error("Registry Selection 校验与 Model 索引结果不一致");
    const model = this.#createRegistryModel(provider, registryModel, target);
    // External-harness turns spawn user-consented CLIs; never auto-swap them.
    if (provider.config.access.type === "external-harness") return model;
    return withModelFailover(model, {
      resolveNext: (failed) => this.#resolveFailoverSibling(provider, failed, target),
    });
  };

  /**
   * Same-provider enabled siblings only: same account/billing, so a swap
   * cannot surprise-spend on another provider. Skips the just-failed model
   * and cooled-down entries; returns null when the chain is spent.
   */
  #resolveFailoverSibling(
    provider: Provider,
    failed: { providerId: string; modelId: string },
    target: Parameters<RuntimeModelFactory>[0],
  ): Model | null {
    if (failed.providerId !== provider.providerId) return null;
    for (const sibling of provider.models) {
      if (sibling.modelId === failed.modelId) continue;
      if (sibling.config.enabled === false) continue;
      if (isModelFailoverCooledDown(provider.providerId, sibling.modelId)) continue;
      try {
        return this.#createRegistryModel(provider, sibling, target);
      } catch {
        continue;
      }
    }
    return null;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
  }

  dispose(): void {
    this.#started = false;
  }

  #createRegistryModel(
    provider: Provider,
    registryModel: ProviderModel,
    target: Parameters<RuntimeModelFactory>[0],
  ): Model {
    const config = registryModel.config;
    // 输出预算属于单次请求，由 Agent 执行链显式决定，不能在 ModelFactory 中静默绑定。
    // Selection 已在上面的 Registry 边界完成校验，Factory 不再承担任何缺省修复。
    const normalReasoningLevel = target.selection.options!.reasoningLevel!;
    return this.#modelAdapter.createModel({
      providerId: provider.providerId,
      modelId: registryModel.modelId,
      providerConfig: provider.config,
      modelConfig: config,
      ...(provider.config.access.type === "zhipu-account" &&
      provider.config.access.mode === "off-peak"
        ? {
            requestDependencies: {
              requestAuth: {
                source: target.requestDependencies?.requestAuth?.source,
              },
            },
          }
        : {}),
      options: {
        reasoningLevel: normalReasoningLevel,
      },
    });
  }
}
