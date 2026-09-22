/**
 * Fuzzy model matching for the `/model` suggestion panel (local-grok-cli
 * port: nucleo-style subsequence scoring with match highlighting).
 *
 * Scores are deterministic: substring matches outrank scattered
 * subsequences (preserving the old substring-filter behavior as the top
 * tier), word-boundary and consecutive matches beat scattered ones, and
 * ties fall back to catalog order. Empty query matches everything at
 * score 0 so the panel opens in catalog order.
 */

import { modelOptionValue } from "./app-model-ref.js";
import type { TuiModelOption } from "./types.js";

export interface FuzzyMatchRange {
  readonly start: number;
  /** Exclusive end offset (UTF-16 code units, like String.slice). */
  readonly end: number;
}

export interface FuzzyScore {
  readonly score: number;
  readonly ranges: FuzzyMatchRange[];
}

export interface RankedModelOption {
  readonly model: TuiModelOption;
  readonly score: number;
}

const SEPARATORS = new Set(["/", "-", "_", ".", ":", " ", "(", "["]);

function isSeparator(char: string | undefined): boolean {
  return char !== undefined && SEPARATORS.has(char);
}

/**
 * Score `query` against `text` (case-insensitive subsequence). Returns
 * null when the query is not a subsequence; otherwise the score plus
 * merged highlight ranges over `text`.
 */
export function fuzzyScoreText(text: string, query: string): FuzzyScore | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return { score: 0, ranges: [] };
  const hay = text.toLowerCase();
  if (needle.length > hay.length) return null;

  const indices: number[] = [];
  let from = 0;
  for (const char of needle) {
    const found = hay.indexOf(char, from);
    if (found < 0) return null;
    indices.push(found);
    from = found + 1;
  }

  const trimmedQuery = query.trim();
  let score = 0;
  let previous = -2;
  indices.forEach((index, order) => {
    score += 1;
    if (index === 0) score += 7;
    else if (isSeparator(hay[index - 1])) score += 5;
    if (index === previous + 1) score += 3;
    if (text[index] === trimmedQuery[order]) score += 1;
    previous = index;
  });
  if (hay.includes(needle)) score += 10;
  // Prefer shorter candidates on ties (exact-ish names first).
  score -= Math.min(4, Math.floor(text.length / 16));

  const merged: Array<{ start: number; end: number }> = [];
  for (const index of indices) {
    const last = merged[merged.length - 1];
    if (last && last.end === index) last.end = index + 1;
    else merged.push({ start: index, end: index + 1 });
  }
  return { score, ranges: merged };
}

const FIELD_WEIGHTS: ReadonlyArray<{ weight: number; pick: (model: TuiModelOption) => string }> = [
  { weight: 1, pick: (model) => modelOptionValue(model) },
  { weight: 1, pick: (model) => model.label || model.ref.modelId },
  { weight: 0.6, pick: (model) => model.providerLabel || model.ref.providerId },
];

const RECENT_BOOSTS = [20, 12, 6];

/**
 * Rank models for a query. Recents (provider/model values, most recent
 * first) float to the top; remaining ties keep catalog order (stable).
 */
export function rankModelOptions(
  models: readonly TuiModelOption[],
  query: string,
  recents: readonly string[] = [],
): RankedModelOption[] {
  const trimmed = query.trim();
  const recentBoost = new Map<string, number>();
  recents.forEach((value, index) => {
    if (!recentBoost.has(value)) {
      recentBoost.set(value, RECENT_BOOSTS[Math.min(index, RECENT_BOOSTS.length - 1)] ?? 0);
    }
  });
  const ranked: RankedModelOption[] = [];
  for (const model of models) {
    if (!trimmed) {
      ranked.push({ model, score: recentBoost.get(modelOptionValue(model)) ?? 0 });
      continue;
    }
    let best: number | null = null;
    for (const field of FIELD_WEIGHTS) {
      const match = fuzzyScoreText(field.pick(model), trimmed);
      if (!match) continue;
      const weighted = match.score * field.weight;
      if (best === null || weighted > best) best = weighted;
    }
    if (best === null) continue;
    ranked.push({ model, score: best + (recentBoost.get(modelOptionValue(model)) ?? 0) });
  }
  // Array.prototype.sort is stable: equal scores keep catalog order.
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/** Highlight ranges for already-fitted row text (re-derived post-truncate). */
export function highlightRangesForRowText(rowText: string, query: string): FuzzyMatchRange[] {
  if (!query.trim()) return [];
  return fuzzyScoreText(rowText, query)?.ranges ?? [];
}
