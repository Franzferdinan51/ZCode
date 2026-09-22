/**
 * Optional smart model routing. Pure string/signal logic (no Node imports) so
 * the UI and backend share one decision function.
 *
 * The default scorer is a deterministic heuristic: hard capability filters
 * (attachments, tools, JSON schema, context fit, harness consent) plus soft
 * task signals (code, long context, analysis). It costs nothing to run and
 * never overrides an explicit user route — callers apply it only when no
 * configured default or recent selection wins.
 *
 * Classifier extension point: pass a custom `AutoRouteScorer` to
 * `suggestRoute`. A SystemOne/Laya-style "System 1" decision maps directly
 * onto the `choice` primitive — state = signals.textSample, options =
 * candidate "providerId/modelId" labels — with per-option probabilities as
 * scores. That tier is intentionally not bundled: it needs a Python ML
 * runtime (torch/MLX + weights) that this repo does not ship or verify.
 */

export interface AutoRouteCandidate {
  readonly providerId: string;
  readonly modelId: string;
  /** Registry order; lower wins ties so user ordering stays meaningful. */
  readonly order: number;
  readonly enabled: boolean;
  readonly accessType: string;
  readonly consentGranted: boolean;
  readonly contextWindow: number;
  readonly supportsImage: boolean;
  readonly supportsVideo: boolean;
  readonly supportsAudio: boolean;
  readonly supportsPdf: boolean;
  readonly supportsToolCall: boolean;
  readonly supportsJsonSchemaOutput: boolean;
}

export type AutoRouteAttachmentKind = "image" | "video" | "audio" | "pdf";

export interface AutoRouteSignals {
  /** Bounded sample of the outgoing message (callers cap ~4000 chars). */
  readonly textSample?: string;
  readonly attachmentKinds?: readonly AutoRouteAttachmentKind[];
  readonly needsTools?: boolean;
  readonly needsJsonSchema?: boolean;
  /** Approximate full input size in chars for context-fit filtering. */
  readonly approxInputChars?: number;
}

export interface AutoRouteScoredCandidate {
  readonly candidate: AutoRouteCandidate;
  readonly score: number;
  readonly reasons: readonly string[];
}

export type AutoRouteScorer = (
  candidates: readonly AutoRouteCandidate[],
  signals: AutoRouteSignals,
) => readonly AutoRouteScoredCandidate[];

export type AutoRouteConfidence = "high" | "medium";

export interface AutoRouteAlternative {
  readonly providerId: string;
  readonly modelId: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface AutoRouteSuggestion {
  readonly providerId: string;
  readonly modelId: string;
  readonly confidence: AutoRouteConfidence;
  readonly reasons: readonly string[];
  /**
   * Ranked runner-ups (best first, capped). Execution failover is not
   * implemented — callers surface these so a failed top pick has an
   * obvious manual fallback. (Hermes-agent fallback-chain cherry-pick,
   * data half.)
   */
  readonly alternatives: readonly AutoRouteAlternative[];
}

const MAX_ALTERNATIVES = 3;

const MAX_REASONS = 3;
const CHARS_PER_TOKEN = 4;
const OUTPUT_HEADROOM_TOKENS = 4000;

const CODE_FENCE = /```[\s\S]*?```/;
const FILE_PATH = /(?:^|[\s"'(`])[\w@~.-]+\/[\w@~./-]+\.\w{1,5}\b/;
const STACK_TRACE = /\b(?:Traceback|Error|Exception|at\s+[\w$.]+\s*\(|^\s*at\s+\S+:\d+)/m;
const CODE_VERBS =
  /\b(fix|refactor|implement|debug|compile|test|migrate|rewrite|optimize|typecheck|lint)\b/i;
const ANALYSIS_WORDS = /\b(analy[sz]e|compare|evaluate|plan|design|review|explain|investigate)\b/i;

function capabilityLabel(kind: AutoRouteAttachmentKind): string {
  switch (kind) {
    case "image":
      return "image input";
    case "video":
      return "video input";
    case "audio":
      return "audio input";
    case "pdf":
      return "PDF input";
  }
}

function candidateSupports(
  candidate: AutoRouteCandidate,
  kind: AutoRouteAttachmentKind,
): boolean {
  switch (kind) {
    case "image":
      return candidate.supportsImage;
    case "video":
      return candidate.supportsVideo;
    case "audio":
      return candidate.supportsAudio;
    case "pdf":
      return candidate.supportsPdf;
  }
}

/** Deterministic heuristic scorer. See module doc for semantics. */
export function heuristicAutoRouteScorer(
  candidates: readonly AutoRouteCandidate[],
  signals: AutoRouteSignals,
): readonly AutoRouteScoredCandidate[] {
  const text = (signals.textSample ?? "").slice(0, 4000);
  const attachmentKinds = signals.attachmentKinds ?? [];
  const approxTokens =
    signals.approxInputChars === undefined
      ? undefined
      : Math.ceil(signals.approxInputChars / CHARS_PER_TOKEN) + OUTPUT_HEADROOM_TOKENS;
  const isCodeTask =
    CODE_FENCE.test(text) || FILE_PATH.test(text) || STACK_TRACE.test(text) || CODE_VERBS.test(text);
  const isAnalysisTask = ANALYSIS_WORDS.test(text);
  const isLongInput = (signals.approxInputChars ?? 0) > 60_000;

  const scored: AutoRouteScoredCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.enabled) continue;
    const missing = attachmentKinds.filter((kind) => !candidateSupports(candidate, kind));
    if (missing.length > 0) continue;
    if (signals.needsTools === true && !candidate.supportsToolCall) continue;
    if (signals.needsJsonSchema === true && !candidate.supportsJsonSchemaOutput) continue;
    if (
      approxTokens !== undefined &&
      candidate.contextWindow > 0 &&
      candidate.contextWindow < approxTokens
    ) {
      continue;
    }
    if (candidate.accessType === "external-harness" && !candidate.consentGranted) continue;

    let score = 0;
    const reasons: string[] = [];
    if (isCodeTask && candidate.supportsToolCall) {
      score += 3;
      reasons.push("code task prefers tool-capable models");
    }
    if (isLongInput && candidate.contextWindow >= 128_000) {
      score += 2;
      reasons.push("long input prefers large context");
    }
    if (isAnalysisTask && candidate.supportsToolCall) {
      score += 1;
      reasons.push("analysis task prefers tool-capable models");
    }
    if (missing.length === 0 && attachmentKinds.length > 0) {
      score += 2;
      reasons.push(`supports ${attachmentKinds.map(capabilityLabel).join(", ")}`);
    }
    if (candidate.accessType === "external-harness") {
      // Consented harnesses stay eligible but never win by default: spawning
      // an external CLI is a deliberate user action, not an auto-pick.
      score -= 2;
      reasons.push("external harness deprioritized for auto-picks");
    }
    scored.push({ candidate, score, reasons: reasons.slice(0, MAX_REASONS) });
  }
  return scored;
}

function uniqueHardFilterWin(
  scored: readonly AutoRouteScoredCandidate[],
  totalEnabled: number,
): boolean {
  return scored.length === 1 && totalEnabled > 1;
}

/**
 * Best auto-route pick, or null when no candidate survives the hard filters
 * or no signal distinguishes one (caller keeps its existing fallback).
 * Pure and deterministic: same inputs always yield the same suggestion.
 */
export function suggestRoute(
  candidates: readonly AutoRouteCandidate[],
  signals: AutoRouteSignals = {},
  scorer: AutoRouteScorer = heuristicAutoRouteScorer,
): AutoRouteSuggestion | null {
  const enabled = candidates.filter((candidate) => candidate.enabled);
  const scored = [...scorer(candidates, signals)].sort(
    (a, b) => b.score - a.score || a.candidate.order - b.candidate.order,
  );
  const winner = scored[0];
  if (!winner || winner.score <= 0) return null;
  const runnerUp = scored[1];
  const confidence: AutoRouteConfidence =
    uniqueHardFilterWin(scored, enabled.length) ||
    (runnerUp !== undefined && winner.score - runnerUp.score >= 3)
      ? "high"
      : "medium";
  return {
    providerId: winner.candidate.providerId,
    modelId: winner.candidate.modelId,
    confidence,
    reasons: winner.reasons.length > 0 ? winner.reasons : ["best capability match"],
    alternatives: scored
      .slice(1, 1 + MAX_ALTERNATIVES)
      .filter((entry) => entry.score > 0)
      .map((entry) => ({
        providerId: entry.candidate.providerId,
        modelId: entry.candidate.modelId,
        score: entry.score,
        reasons: entry.reasons,
      })),
  };
}

/** Structural view shape so UI and backend adapt without type cycles. */
export interface AutoRouteSelectionViewLike {
  readonly providers: readonly {
    readonly providerId: string;
    readonly config: {
      readonly visibility?: string | null;
      readonly access?: { readonly type?: string; readonly consentGranted?: boolean | null } | null;
    };
    readonly models: readonly {
      readonly modelId: string;
      readonly config: {
        readonly enabled?: boolean | null;
        readonly properties?: {
          readonly contextWindow?: number | null;
          readonly inputFormat?: {
            readonly supportsImage?: boolean | null;
            readonly supportsVideo?: boolean | null;
            readonly supportsAudio?: boolean | null;
            readonly supportsPdf?: boolean | null;
          } | null;
          readonly supportsToolCall?: boolean | null;
          readonly supportsJsonSchemaOutput?: boolean | null;
        } | null;
      };
    }[];
  }[];
}

export function candidatesFromSelectionView(view: AutoRouteSelectionViewLike): AutoRouteCandidate[] {
  const candidates: AutoRouteCandidate[] = [];
  let order = 0;
  for (const provider of view.providers) {
    if (provider.config.visibility === "hidden") continue;
    const accessType = provider.config.access?.type ?? "";
    const consentGranted = provider.config.access?.consentGranted === true;
    for (const model of provider.models) {
      const properties = model.config.properties;
      const inputFormat = properties?.inputFormat;
      candidates.push({
        providerId: provider.providerId,
        modelId: model.modelId,
        order: order++,
        enabled: model.config.enabled !== false,
        accessType,
        consentGranted,
        contextWindow: properties?.contextWindow ?? 0,
        supportsImage: inputFormat?.supportsImage === true,
        supportsVideo: inputFormat?.supportsVideo === true,
        supportsAudio: inputFormat?.supportsAudio === true,
        supportsPdf: inputFormat?.supportsPdf === true,
        supportsToolCall: properties?.supportsToolCall === true,
        supportsJsonSchemaOutput: properties?.supportsJsonSchemaOutput === true,
      });
    }
  }
  return candidates;
}
