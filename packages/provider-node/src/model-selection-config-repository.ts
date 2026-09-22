import type { ModelSelection, PersonalProviderConfigRepository } from "@zcode/provider";

export interface NodeModelSelectionConfigRepositoryOptions {
  readonly personalRepository: PersonalProviderConfigRepository;
}

/** The default selection is just one field of the Personal file; IO, locking, and invalidation notices are owned by the same Repository. */
export class NodeModelSelectionConfigRepository {
  readonly #personal: PersonalProviderConfigRepository;
  readonly #subscriptions = new Set<() => void>();
  #disposed = false;

  constructor(options: NodeModelSelectionConfigRepositoryOptions) {
    this.#personal = options.personalRepository;
  }

  async read(): Promise<ModelSelection | undefined> {
    this.#assertNotDisposed();
    return (await this.#personal.read()).defaultModelSelection;
  }

  async saveDefault(
    selection: ModelSelection | undefined,
  ): Promise<ModelSelection | undefined> {
    return this.saveConfiguredDefault(selection);
  }

  async saveConfiguredDefault(
    selection: ModelSelection | undefined,
  ): Promise<ModelSelection | undefined> {
    this.#assertNotDisposed();
    const snapshot = await this.#personal.update((current) => ({
      ...current,
      defaultModelSelection: selection,
    }));
    return snapshot.defaultModelSelection;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    const unsubscribe = this.#personal.onDidChange(listener);
    const dispose = () => {
      this.#subscriptions.delete(dispose);
      unsubscribe();
    };
    this.#subscriptions.add(dispose);
    return dispose;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const dispose of this.#subscriptions) dispose();
    // Do not destroy the shared Personal Repository; its lifetime is still managed by the Config Runtime.
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("NodeModelSelectionConfigRepository disposed");
  }
}
