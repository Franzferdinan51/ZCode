import type { RefObject } from "react";
import type {
  ZCodeProvider,
  SessionCreateSource,
  ZCodeTaskRuntimeStatus,
  ZCodeTaskMeta,
  GitChangeSourceId,
  DesktopWindowChromeState,
  IPlatformService,
  RemoteTarget,
  RemoteWorkspaceSessionEntry,
  UpdateStatePayload,
} from "@zcode/shared";
import type { IFeedbackService, IServiceAccessor } from "@zcode/services";
import type { BrowserNavigationRequest, RecentClosedSidePaneTab } from "@/hooks/useAppPanels.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import type {
  BrowserSidePaneMetadata,
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  OpenSelectionSideChatRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";
import type { TreemappingSidePaneTab } from "@/lib/workspaceSidePane.js";
import type { WorkspaceZCodeUIState } from "@/store/zcodeSessionStore.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import type { Theme } from "@/useTheme.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import type {
  ComposerMentionPrefill,
  GroupedDraftTaskPlacement,
} from "@/store/zcodeSessionStoreTypes.js";
import type { TaskFindDialogProps } from "@/quickpick/TaskFindDialog.js";
import type { AutomationsNavigationTab, OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";

export interface WorkspaceShellZCodeState {
  activeTaskId: WorkspaceZCodeUIState["activeTaskId"];
  draftFocusVersion: WorkspaceZCodeUIState["draftFocusVersion"];
  modelSwitchPending: WorkspaceZCodeUIState["modelSwitchPending"];
  modelSwitchStage: WorkspaceZCodeUIState["modelSwitchStage"];
  selectedProvider: WorkspaceZCodeUIState["selectedProvider"];
  optimisticTaskListByTaskId: WorkspaceZCodeUIState["optimisticTaskListByTaskId"];
  workspaceInit: WorkspaceZCodeUIState["workspaceInit"];
  taskStatus: ZCodeTaskRuntimeStatus;
  taskError: string | null;
}

export interface CreateTaskOptions {
  /** Async prefill may only be committed to the same new-task target the Skill resolved to. */
  expectedWorkspaceKey?: string;
  provider?: ZCodeProvider;
  groupedDraftPlacement?: GroupedDraftTaskPlacement;
  createSource?: SessionCreateSource;
  /** Prefill text for a new draft input; writes the draft only, never auto-sends. */
  initialPrompt?: string;
  /** Structured mention matching the initialPrompt canonical prefix; editor display only. */
  initialPromptMention?: ComposerMentionPrefill;
  /** Which workspace a new task lands in; defaults to the active workspace. */
  targetWorkspace?: { workspacePath: string; workspaceIdentity?: string };
}

export type CreateTaskRequest = ZCodeProvider | CreateTaskOptions;

export interface AppProps {
  services: IServiceAccessor;
  baseFeedbackService: IFeedbackService;
  onConnectRemote: (options: RemoteTarget, requestId?: string) => Promise<string>;
  onSelectRemoteProject: (
    sessionId: string,
    path: string,
    localWorkspacePath?: string,
  ) => Promise<void>;
  onCancelRemoteProject: (sessionId: string) => Promise<void>;
  onReconnectRemoteWorkspace: (workspaceKey: string) => Promise<void>;
  reconnectingRemoteWorkspaceKeys: string[];
  remoteWorkspaceErrorByWorkspaceKey: Record<string, string>;
  reconnectingRemoteWorkspaceLogsByWorkspaceKey?: Record<string, RemoteConnectionLogEntry[]>;
  remoteConnectionLogs?: RemoteConnectionLogEntry[];
  onCreateTask: (request?: CreateTaskRequest) => void;
  onCreateConversationTask?: () => void;
  onResolveConversationWorkspace?: () => Promise<string>;
  onOpenWorkspace: () => void;
  onOpenFolderFromWorkspaceMenu: () => void;
  onOpenRemoteWorkspace?: () => void;
  onCreateScratchWorkspace: (name: string) => Promise<string | null>;
  remoteConnectionInProgress?: boolean;
  onReturnToWorkspace?: () => void;
  allowOpenWorkspace?: boolean;
  allowRemoteWorkspace?: boolean;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  workspaceAbsPath: string;
  workspaceRemoteSessionId?: string;
  workspaceIdentity?: string;
  isWorkspaceVisible?: boolean;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  supportsEmbeddedBrowser?: boolean;
}

export interface GitChangeSummary {
  added: number;
  removed: number;
}

export type WorkspaceMainView = "chat" | "automations" | "plugin-store";

export interface WorkspaceShellLayoutProps extends Omit<AppProps, "baseFeedbackService"> {
  workspaceReadOnlyReason?: string;
  workspaceMainView: WorkspaceMainView;
  pluginStoreOpenVersion: number;
  openAutomationId: string | null;
  openAutomationTab: AutomationsNavigationTab | null;
  onWorkspaceMainViewChange: (view: WorkspaceMainView) => void;
  onOpenAutomationConsumed: () => void;
  handleOpenAutomations: OpenAutomationsMain;
  handleOpenPluginStore: () => void;
  handleManageInstalledPlugins: () => void;
  workspaceShellZCodeState: WorkspaceShellZCodeState;
  theme: Theme;
  isMacFullscreen: boolean;
  desktopWindowChromeState: DesktopWindowChromeState | null;
  macWindowControlsLeftPaddingPx: number;
  windowsWindowControlsRightPaddingPx: number;
  updateReadyVersion: string | null;
  updateState: UpdateStatePayload | null;
  sidebarContainerRef: RefObject<HTMLElement | null>;
  toggleSidebarShortcutLabel: string;
  newTaskShortcutLabel: string;
  goBackShortcutLabel: string;
  goForwardShortcutLabel: string;
  toggleSidePaneShortcutLabel: string;
  canGoBack: boolean;
  canGoForward: boolean;
  canTaskNavBack: boolean;
  canTaskNavForward: boolean;
  isTerminalOpen: boolean;
  isSidebarVisible: boolean;
  isBrowserOpen: boolean;
  supportsEmbeddedBrowser: boolean;
  isGitOpen: boolean;
  isSidePaneOpen: boolean;
  summaryPanelVariantOverride: ChatViewSummaryPanelVariant | null;
  onSummaryPanelVariantOverrideChange: (variant: ChatViewSummaryPanelVariant | null) => void;
  sidePaneState: WorkspaceSidePaneState | null;
  recentClosedSidePaneTabs: RecentClosedSidePaneTab[];
  shellPanelIds: string[];
  projectName: string;
  workspaceTabs: Array<{
    workspacePath: string;
    label: string;
    remoteSessionId?: string;
    remoteTarget?: import("@zcode/shared").RemoteTarget;
    workspaceIdentity?: string;
    workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
    localWorkspacePath?: string;
    availability?: import("@/store/tabStore.js").WorkspaceAvailability;
  }>;
  activeTaskId: string | null;
  /** Conversation-scoped owner id for the side pane: draft state = draftSessionId, committed state = activeTaskId (same value joins both). */
  sidePaneOwnerId: string | null;
  activeTraceId: string | null;
  activeSessionId: string | null;
  activeTaskProvider: ZCodeProvider | null;
  resolvedActiveTaskMeta?: ZCodeTaskMeta | null;
  activeTaskTitle: string;
  activeTaskChangeSummary: ReturnType<
    typeof import("@/lib/taskChangeSummary.js").getTaskChangeSummary
  >;
  gitWorktreeReviewSourceId: GitChangeSourceId | null;
  gitWorktreeChangeSummary: GitChangeSummary;
  activeGitSourceId: GitChangeSourceId;
  gitState: ReturnType<typeof import("@/hooks/useGitRepository.js").useGitRepository>;
  browserNavigationRequest: BrowserNavigationRequest | null;
  browserRestoreUrls: Record<string, string>;
  taskNativeSessionLogFile: ReturnType<
    typeof import("@/hooks/useTaskNativeSessionLogFile.js").useTaskNativeSessionLogFile
  >;
  taskSessionFile: ReturnType<
    typeof import("@/hooks/useTaskSessionFilePath.js").useTaskSessionFilePath
  >;
  testMessages: import("@/lib/taskChatMessageTypes.js").TaskChatMessage[] | null;
  conversationFindActiveIndex: number;
  conversationFindNavigationRequestId: number;
  conversationFindQuery: string;
  onConversationFindMatchStateChange: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
  fileChangeFindActiveIndex: number;
  fileChangeFindNavigationRequestId: number;
  fileChangeFindQuery: string;
  onFileChangeFindMatchCountChange: (count: number) => void;
  appLogoUrl: string;
  platform: IPlatformService;
  reloadSessionDisabled: boolean;
  reloadSessionPending: boolean;
  handleReloadSession: (options?: {
    resumeTaskId?: string | null;
    provider?: ZCodeProvider | null;
  }) => Promise<void>;
  handleSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
    expectedUnreadAt?: number,
  ) => void;
  handleTaskNavBack: () => void;
  handleTaskNavForward: () => void;
  handleStartDraftInWorkspace: (
    targetWorkspacePath: string,
    targetWorkspaceIdentity?: string,
    targetWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose,
    createSource?: SessionCreateSource,
  ) => void;
  handleOpenCommandCenter: () => void;
  handleRefreshGit: () => void;
  handleBrowserUrlChange: (tabId: string, url: string) => void;
  handleBrowserPageMetadataChange: (tabId: string, metadata: BrowserSidePaneMetadata) => void;
  handleToggleSidebar: () => void;
  handleToggleTerminal: () => void;
  handleToggleBrowser: () => void;
  handleOpenBrowserTab: () => void;
  handleOpenTreemapping: (source?: TreemappingSidePaneTab["source"]) => void;
  handleOpenWhiteboard: () => void;
  handleOpenDeveloperTools: () => void;
  handleOpenHarnessRouter: () => void;
  handleOpenTerminalTab: () => void;
  handleToggleGit: () => void;
  handleOpenGitReview: (sourceId?: GitChangeSourceId) => void;
  handleToggleSidePane: () => void;
  handleOpenBrowserUrl: (url: string) => void;
  handleOpenCodeViewer: (source: CodeViewerSource) => void;
  handleAutoOpenAssistantPptx: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  handleOpenBackgroundBash: (request: OpenBackgroundBashSideTabRequest) => void;
  handleOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
  handleOpenSubagentDirectory: (
    request: import("@/lib/workspaceSidePane.js").OpenScopedSubagentDirectorySideTabRequest,
  ) => void;
  handleSyncSubagentSessionTabs: (
    request: import("@/lib/workspaceSidePane.js").SyncSubagentSessionTabsRequest,
  ) => void;
  handleOpenSelectionSideChat: (request: OpenSelectionSideChatRequest) => void;
  handleOpenPlanDetail: (request: OpenScopedPlanDetailSideTabRequest) => void;
  handleOpenWorkflowRun: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  handleOpenWorkflowRunDirectory: (
    request: import("@/lib/workspaceSidePane.js").OpenScopedWorkflowRunDirectorySideTabRequest,
  ) => void;
  handleOpenWorkflowActorSession: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  handleOpenWorkflowWorkspace: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  handleOpenWorkflowArtifact: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  handleCloseCodeViewer: () => void;
  handleCloseGit: () => void;
  handleActivateSidePaneTab: (tabId: string) => void;
  handleReorderSidePaneTab: (activeTabId: string, overTabId: string) => void;
  handleCloseSidePaneTab: (tabId: string) => void;
  handleCloseOtherSidePaneTabs: (tabId: string) => void;
  handleCloseAllSidePaneTabs: () => void;
  handleReopenClosedSidePaneTab: (tabId: string) => void;
  handleBrowserNavigationRequestHandled: (requestId: string) => void;
  setIsTerminalOpen: (open: boolean) => void;
  setGitSelectedSourceId: (value: GitChangeSourceId) => void;
  taskFindDialogProps: TaskFindDialogProps;
}
