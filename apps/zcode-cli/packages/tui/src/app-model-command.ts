import React from "react";
import {
  filterModelOptions,
  modelCommandQuery,
  reconcileModelCommandSelection,
  selectedModelOption,
} from "./app-input.js";
import type { ModelCommandSelectionState } from "./app-model.js";
import { modelOptionValue } from "./app-model-ref.js";
import type { TuiModelOption, TuiOptions } from "./types.js";

const MODEL_RECENT_PICKS_LIMIT = 8;

export function useModelCommandController(
  draft: string,
  options: Pick<TuiOptions, "modelOptions" | "initialResult" | "listModelOptions">,
): {
  filteredOptions: readonly TuiModelOption[];
  reconcileDraft: (value: string) => ModelCommandSelectionState | undefined;
  selectedOption: (submittedValue: string) => TuiModelOption | undefined;
  selection: ModelCommandSelectionState | undefined;
  setSelection: React.Dispatch<React.SetStateAction<ModelCommandSelectionState | undefined>>;
  setModelOptions: React.Dispatch<React.SetStateAction<readonly TuiModelOption[]>>;
} {
  const [modelOptions, setModelOptions] = React.useState<readonly TuiModelOption[]>(
    () => options.initialResult?.modelOptions ?? options.modelOptions ?? [],
  );
  const listModelOptions = options.listModelOptions;
  const [selection, setSelection] = React.useState<ModelCommandSelectionState | undefined>();
  const selectionRef = React.useRef(selection);
  selectionRef.current = selection;
  // Session-local recency: picks made this session float to the top.
  const recentsRef = React.useRef<readonly string[]>([]);
  const active = modelCommandQuery(draft) !== undefined;
  React.useEffect(() => {
    if (!active || !listModelOptions) return;
    let cancelled = false;
    void listModelOptions()
      .then((models) => {
        if (!cancelled) setModelOptions(models);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [active, listModelOptions]);
  // Opening from an empty catalog must admit selection when the fresh catalog arrives.
  React.useEffect(() => {
    setSelection((current) =>
      active && modelOptions.length > 0 ? (current ?? { selectedIndex: 0 }) : undefined,
    );
  }, [active, modelOptions]);
  // Bump to recompute the ranked list when session recency changes.
  const [recentsVersion, setRecentsVersion] = React.useState(0);
  const filteredOptions = React.useMemo(
    () => filterModelOptions(draft, modelOptions, recentsRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recentsVersion stands in for the ref.
    [draft, modelOptions, recentsVersion],
  );
  const reconcileDraft = React.useCallback(
    (value: string) => {
      const nextSelection = reconcileModelCommandSelection(value, modelOptions);
      if (nextSelection) {
        // Carry the highlighted option across keystrokes when it survives
        // the new filter instead of snapping back to the top row.
        const current = selectionRef.current;
        if (current) {
          const previous = selectedModelOption(
            draft,
            current,
            filterModelOptions(draft, modelOptions, recentsRef.current),
          );
          if (previous) {
            const carried = filterModelOptions(value, modelOptions, recentsRef.current).findIndex(
              (option) => modelOptionValue(option) === modelOptionValue(previous),
            );
            if (carried >= 0) {
              const carriedSelection = { selectedIndex: carried };
              setSelection(carriedSelection);
              return carriedSelection;
            }
          }
        }
      }
      setSelection(nextSelection);
      return nextSelection;
    },
    [draft, modelOptions],
  );
  const selectedOption = React.useCallback(
    (submittedValue: string) => {
      const picked = selectedModelOption(submittedValue, selection, filteredOptions);
      if (picked) {
        const value = modelOptionValue(picked);
        recentsRef.current = [value, ...recentsRef.current.filter((entry) => entry !== value)].slice(
          0,
          MODEL_RECENT_PICKS_LIMIT,
        );
        setRecentsVersion((version) => version + 1);
      }
      return picked;
    },
    [filteredOptions, selection],
  );

  return {
    filteredOptions,
    reconcileDraft,
    selectedOption,
    selection,
    setSelection,
    setModelOptions,
  };
}
