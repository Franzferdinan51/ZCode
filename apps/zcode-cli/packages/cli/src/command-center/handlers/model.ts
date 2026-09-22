import type { TuiSubmitPromptResult } from "@zcode/tui";
import { parseModelPickerValue, type ModelSelection } from "@zcode/shared/model-selection";
import { listAppEffortOptions } from "../effort-options.js";
import { rememberCurrentModelSelection } from "../model-selection.js";
import type { CommandCenterDeps, CommandCenterModelOption } from "../types.js";

export async function handleModelCommand(
  args: string,
  deps: CommandCenterDeps,
  selectedRef?: ModelSelection,
): Promise<TuiSubmitPromptResult> {
  const app = await deps.getApp();
  const current = app.getModel?.();
  const options = app.listModels ? await app.listModels() : undefined;

  if (!app.getModel || !app.listModels || !app.setModel || !options) {
    return {
      mode: deps.getMode?.(),
      response: "Model selection is not available in this client.",
    };
  }

  if (!selectedRef && (args.length === 0 || args === "list")) {
    const effortOptions = await listAppEffortOptions(app);
    return {
      ...(effortOptions ? { effortOptions } : {}),
      mode: deps.getMode?.(),
      model: current,
      modelOptions: options,
      response: formatModelList(current, options),
      thoughtLevel: app.getThoughtLevel?.(),
    };
  }

  try {
    const selection = resolveTuiModelSelection(args, options, selectedRef);
    const result = await app.setModel(selection);
    const persistenceWarning = await rememberCurrentModelSelection(app, deps);
    const effortOptions = await listAppEffortOptions(app);
    return {
      ...(effortOptions ? { effortOptions } : {}),
      mode: deps.getMode?.(),
      model: result.model,
      modelOptions: options,
      loginRequired: false,
      response: `Model switched to ${result.model} (${selection.options!.reasoningLevel}).${persistenceWarning}`,
      thoughtLevel: result.thoughtLevel ?? app.getThoughtLevel?.(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: deps.getMode?.(),
      response: `Unable to switch model: ${message}`,
      model: current,
      modelOptions: options,
      thoughtLevel: app.getThoughtLevel?.(),
    };
  }
}

/** A deliberate new selection uses the catalog default; restored selections never pass here. */
function resolveTuiModelSelection(
  args: string,
  options: readonly CommandCenterModelOption[],
  selectedRef?: ModelSelection,
): ModelSelection {
  // Exact catalog matching preserves literal slashes and dollar signs in model IDs.
  const requested =
    selectedRef ??
    options.find((option) => `${option.ref.providerId}/${option.ref.modelId}` === args)?.ref ??
    parseModelPickerValue(args);
  const option = options.find(
    ({ ref }) => ref.providerId === requested.providerId && ref.modelId === requested.modelId,
  );
  if (!option) throw new Error(`Model is not available: ${args}`);
  if (option.disabledReason) throw new Error(option.disabledReason);
  const reasoningLevel = requested.options?.reasoningLevel ?? option.reasoning?.defaultLevel;
  if (
    !reasoningLevel ||
    !option.reasoning?.levels.some((level) => level.value === reasoningLevel)
  ) {
    throw new Error(
      `Select a supported reasoning effort: ${option.reasoning?.levels.map((level) => level.value).join(", ") || "none available"}`,
    );
  }
  return {
    providerId: requested.providerId,
    modelId: requested.modelId,
    options: { reasoningLevel },
  };
}

function formatModelList(current: string | undefined, options: CommandCenterModelOption[]): string {
  const currentLine = `Current model: ${current || "not selected"}.`;
  if (options.length === 0) {
    return `${currentLine}\nNo selectable models are configured.`;
  }

  const groups = new Map<string, CommandCenterModelOption[]>();
  for (const option of options) {
    const provider = option.providerLabel ?? option.ref.providerId;
    const group = groups.get(provider);
    if (group) group.push(option);
    else groups.set(provider, [option]);
  }
  const lines: string[] = [];
  for (const [provider, group] of groups) {
    lines.push(`${provider}:`);
    for (const option of group) {
      const id = `${option.ref.providerId}/${option.ref.modelId}`;
      const marker = id === current ? " (current)" : "";
      const specs: string[] = [];
      if (typeof option.contextWindow === "number" && option.contextWindow > 0) {
        specs.push(formatListContextWindow(option.contextWindow));
      }
      if (option.reasoning) specs.push("reasons");
      const detail = option.description?.trim() ? ` — ${option.description.trim()}` : "";
      const disabled = option.disabledReason ? ` [disabled: ${option.disabledReason}]` : "";
      const specText = specs.length > 0 ? ` [${specs.join(", ")}]` : "";
      lines.push(`  - ${id}${marker}${specText}${detail}${disabled}`);
    }
  }

  return [
    currentLine,
    `Available models (${options.length}):`,
    ...lines,
    "Use /model <provider/model> to select a model, then /effort <level> to change reasoning effort.",
  ].join("\n");
}

function formatListContextWindow(window: number): string {
  if (window >= 1_000_000) return `${Math.round((window / 1_000_000) * 10) / 10}M ctx`;
  if (window >= 1_000) return `${Math.round(window / 1_000)}k ctx`;
  return `${window} ctx`;
}
