import type { ModelSelectionView } from "@zcode/services";
import { completeNewModelSelection } from "@zcode/provider";
import {
  candidatesFromSelectionView,
  suggestRoute,
} from "@zcode/shared/auto-router";
import { readComposerRecent, resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";
import { readAutoRouteEnabled } from "@/lib/autoRoutePreference.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";

/** 普通新任务与首次分享导入共用初始化；保留 Recent 原意图，由公共 View 解析有效选择。 */
export function initializeNewTaskDraft(
  draft: V4ComposerDraft,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  view: ModelSelectionView,
): V4ComposerDraft {
  const recent = readComposerRecent(workspacePath, workspaceIdentity);
  return {
    ...draft,
    initializeFromNewTask: undefined,
    mode: recent?.mode === "plan" ? "build" : (recent?.mode ?? "build"),
    planEnabled: false,
    modelSelection:
      recent?.modelSelection ??
      resolveAutoRouteSelection(draft.text, workspacePath, workspaceIdentity, view) ??
      resolveDraftInitialModelSelection(view, null).selection ??
      undefined,
  };
}

/**
 * Optional smart pick for new drafts. Only applies when the toggle is on, no
 * recent selection exists, and the user has no explicit configured default —
 * an explicit route always wins over the heuristic.
 */
function resolveAutoRouteSelection(
  text: string,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  view: ModelSelectionView,
) {
  if (!text.trim()) return undefined;
  if (!readAutoRouteEnabled(workspacePath, workspaceIdentity)) return undefined;
  if (view.preferredSource === "configured-default") return undefined;
  const suggestion = suggestRoute(candidatesFromSelectionView(view), {
    textSample: text.slice(0, 4000),
    approxInputChars: text.length,
  });
  if (!suggestion) return undefined;
  return (
    completeNewModelSelection(view, {
      providerId: suggestion.providerId,
      modelId: suggestion.modelId,
    }) ?? undefined
  );
}

/** 在激活首次导入的 Session 前调用；不依赖模型可执行，也不把原新任务正文带入分享。 */
export function seedImportedSessionDraft(result: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  reused: boolean;
}): void {
  const { workspacePath, workspaceIdentity, sessionId, reused } = result;
  if (reused || readV4ComposerDraft(workspacePath, workspaceIdentity, sessionId)) return;
  const root = readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT);
  // 导入已创建真实 Session，旧初始化把空 snapshot 当成确定选择，跳过了新任务规则。
  // 显式标记首次导入来源，而非按“会话没模型”猜测；Root 的明确空选择也必须保留。
  persistV4ComposerDraft(
    workspacePath,
    workspaceIdentity,
    sessionId,
    root?.mode
      ? {
          text: "",
          mode: root.mode,
          planEnabled: root.planEnabled ?? false,
          modelSelection: root.modelSelection,
        }
      : { text: "", initializeFromNewTask: true },
  );
}
