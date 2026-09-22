import React from "react";
import { visibleModelOptionWindow } from "./app-input.js";
import { palette } from "./app-model.js";
import { modelOptionValue } from "./app-model-ref.js";
import { displayWidth, truncateDisplay } from "./app-terminal-width.js";
import { highlightRangesForRowText, type FuzzyMatchRange } from "./model-fuzzy.js";
import type { TuiModelOption } from "./types.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const MODEL_OPTION_VISIBLE_COUNT = 8;
const MODEL_OPTION_PANEL_CHROME_ROWS = 2;
const MODEL_OPTION_ROW_HEIGHT = 1;
const MODEL_ROW_SELECTOR_WIDTH = 2;
const MODEL_ROW_PROVIDER_GAP_WIDTH = 2;
const MODEL_ROW_MIN_CONTENT_WIDTH = 8;
const MODEL_ROW_MIN_MODEL_WIDTH = 8;
const MODEL_ROW_FALLBACK_CONTENT_WIDTH = 80;
const MODEL_ROW_MAX_PROVIDER_RATIO = 0.4;

type ModelOptionDisplayParts = {
  meta: string;
  model: string;
  provider: string;
};

type FittedModelOptionRow = {
  meta: string;
  model: string;
  provider: string;
  providerWidth: number;
};

export function ModelSuggestionPanel({
  contentWidth,
  currentModel,
  models,
  query,
  selectedIndex,
}: {
  contentWidth?: number;
  currentModel: string;
  models: readonly TuiModelOption[];
  query: string;
  selectedIndex: number;
}): React.ReactElement | null {
  const visible = visibleModelOptionWindow(models, selectedIndex, MODEL_OPTION_VISIBLE_COUNT);
  const rowContentWidth = normalizeModelRowContentWidth(contentWidth);
  const rows =
    visible.models.length > 0
      ? visible.models.map((model, index) => {
          const fitted = fitModelOptionRow(
            modelOptionDisplayParts(model, modelOptionValue(model) === currentModel),
            rowContentWidth,
          );
          return {
            fitted,
            highlights: highlightRangesForRowText(fitted.model, query),
            model,
            selected: index === visible.selectedIndex,
          };
        })
      : [];
  const panelHeight =
    MODEL_OPTION_PANEL_CHROME_ROWS + Math.max(1, rows.length) * MODEL_OPTION_ROW_HEIGHT;

  const position =
    rows.length > 0 ? visible.startIndex + visible.selectedIndex + 1 : 0;
  return h(
    "box",
    {
      title: rows.length > 0 ? `Models (${position}/${models.length})` : "Models",
      style: {
        backgroundColor: palette.panel,
        border: true,
        borderColor: palette.border,
        flexDirection: "column",
        height: panelHeight,
        marginBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      },
    },
    rows.length > 0
      ? rows.map((row) =>
          h(ModelSuggestionRow, {
            key: JSON.stringify(row.model.ref),
            fitted: row.fitted,
            highlights: row.highlights,
            selected: row.selected,
          }),
        )
      : h(
          "text",
          {
            style: {
              fg: palette.warning,
              height: MODEL_OPTION_ROW_HEIGHT,
              width: "100%",
            },
          },
          "No matching models.",
        ),
  );
}

function ModelSuggestionRow({
  fitted,
  highlights,
  selected,
}: {
  fitted: FittedModelOptionRow;
  highlights: readonly FuzzyMatchRange[];
  selected: boolean;
}): React.ReactElement {
  return h(
    "box",
    {
      style: {
        alignItems: "center",
        flexDirection: "row",
        height: MODEL_OPTION_ROW_HEIGHT,
        width: "100%",
      },
    },
    h(
      "text",
      {
        style: {
          fg: selected ? palette.accent : palette.muted,
          flexShrink: 0,
          width: MODEL_ROW_SELECTOR_WIDTH,
        },
      },
      selected ? "> " : "  ",
    ),
    h(
      "box",
      {
        style: {
          flexDirection: "row",
          flexShrink: 1,
          minWidth: 1,
        },
      },
      ...modelTextSegments(fitted.model, highlights).map((segment, index) =>
        h(
          "text",
          {
            key: index,
            style: {
              fg: segment.highlighted
                ? palette.success
                : selected
                  ? palette.accent
                  : palette.text,
              flexShrink: 1,
            },
          },
          segment.text,
        ),
      ),
    ),
    fitted.meta
      ? h(
          "text",
          {
            style: {
              fg: palette.muted,
              flexShrink: 0,
            },
          },
          fitted.meta,
        )
      : null,
    h("box", {
      style: {
        flexGrow: 1,
        minWidth: fitted.provider ? MODEL_ROW_PROVIDER_GAP_WIDTH : 0,
      },
    }),
    fitted.provider
      ? h(
          "text",
          {
            style: {
              fg: palette.muted,
              flexShrink: 0,
              width: fitted.providerWidth,
            },
          },
          fitted.provider,
        )
      : null,
  );
}

function modelOptionDisplayParts(model: TuiModelOption, current: boolean): ModelOptionDisplayParts {
  const modelName = model.label || model.ref.modelId;
  const specs: string[] = [];
  if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
    specs.push(formatContextWindow(model.contextWindow));
  }
  if (model.reasoning) specs.push("reasons");
  const meta = [model.disabledReason, current ? "current" : undefined, ...specs]
    .filter(Boolean)
    .join(" | ");
  const description = model.description?.trim();
  return {
    meta,
    model: description ? `${modelName} — ${description}` : modelName,
    provider: model.providerLabel || model.ref.providerId,
  };
}

function formatContextWindow(window: number): string {
  if (window >= 1_000_000) return `${Math.round((window / 1_000_000) * 10) / 10}M ctx`;
  if (window >= 1_000) return `${Math.round(window / 1_000)}k ctx`;
  return `${window} ctx`;
}

function modelTextSegments(
  text: string,
  highlights: readonly FuzzyMatchRange[],
): Array<{ text: string; highlighted: boolean }> {
  if (highlights.length === 0) return [{ text, highlighted: false }];
  const segments: Array<{ text: string; highlighted: boolean }> = [];
  let cursor = 0;
  for (const range of highlights) {
    const start = Math.max(0, Math.min(range.start, text.length));
    const end = Math.max(start, Math.min(range.end, text.length));
    if (start > cursor) segments.push({ text: text.slice(cursor, start), highlighted: false });
    if (end > start) segments.push({ text: text.slice(start, end), highlighted: true });
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), highlighted: false });
  return segments.filter((segment) => segment.text.length > 0);
}

function fitModelOptionRow(
  parts: ModelOptionDisplayParts,
  contentWidth: number,
): FittedModelOptionRow {
  const providerBudget = providerColumnBudget(parts.provider, contentWidth);
  const provider = truncateDisplay(parts.provider, providerBudget);
  const providerWidth = displayWidth(provider);
  const providerGapWidth = provider ? MODEL_ROW_PROVIDER_GAP_WIDTH : 0;
  const leftBudget = Math.max(
    0,
    contentWidth - MODEL_ROW_SELECTOR_WIDTH - providerGapWidth - providerWidth,
  );
  const meta = parts.meta ? `  ${parts.meta}` : "";
  const metaWidth = displayWidth(meta);
  const showMeta = metaWidth > 0 && leftBudget - metaWidth >= MODEL_ROW_MIN_MODEL_WIDTH;
  const modelBudget = Math.max(0, leftBudget - (showMeta ? metaWidth : 0));

  return {
    meta: showMeta ? meta : "",
    model: truncateDisplay(parts.model, modelBudget),
    provider,
    providerWidth,
  };
}

function providerColumnBudget(provider: string, contentWidth: number): number {
  if (!provider) return 0;
  const providerMax = Math.floor(contentWidth * MODEL_ROW_MAX_PROVIDER_RATIO);
  const providerBudget =
    contentWidth -
    MODEL_ROW_SELECTOR_WIDTH -
    MODEL_ROW_PROVIDER_GAP_WIDTH -
    MODEL_ROW_MIN_MODEL_WIDTH;
  return Math.max(0, Math.min(providerMax, providerBudget));
}

function normalizeModelRowContentWidth(contentWidth: number | undefined): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return MODEL_ROW_FALLBACK_CONTENT_WIDTH;
  }
  return Math.max(MODEL_ROW_MIN_CONTENT_WIDTH, Math.floor(contentWidth));
}
