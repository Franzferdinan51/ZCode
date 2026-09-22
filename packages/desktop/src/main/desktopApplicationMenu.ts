import { app, BrowserWindow, Menu } from "electron";
import {
  DesktopCommandIds,
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  isValidShortcutBinding,
  isUpdaterEnabledFlavor,
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
  type DesktopCommandId,
  type Locale,
} from "@zcode/shared";
import { readZCodeStdioTapDevState } from "@zcode/services/node";
import { CHECK_FOR_UPDATE_MENU_ID, setAutoUpdaterMenuLocale } from "./autoUpdater.js";
import {
  DESKTOP_ZOOM_MAX_LEVEL,
  DESKTOP_ZOOM_MIN_LEVEL,
  clampDesktopZoomLevel,
} from "./desktopZoom.js";
import {
  HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID,
  HELP_TOGGLE_DEV_TOOLS_MENU_ID,
} from "./desktopCommandHandlers.js";

const HELP_ZCODE_ENDPOINT_PRODUCTION_MENU_ID = "help.zcode-endpoint.production";

export function getDesktopMenuLabel(
  locale: Locale,
  id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds],
) {
  return getDesktopMenuMessage(locale, id);
}

export function resolveSystemApplicationLocale(): Locale {
  // When macOS runs in Chinese, Electron app.getLocale() may still return en-US;
  // prefer the system preferred-language list so "System default" is not misread as English.
  const systemLocale = app.getPreferredSystemLanguages?.()[0] ?? app.getLocale();
  return systemLocale.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function updateZCodeStdioTapDevMenuState() {
  const menu = Menu.getApplicationMenu();
  const item = menu?.getMenuItemById(HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID);
  if (!item) {
    return;
  }
  const state = readZCodeStdioTapDevState();
  item.checked = state.enabled;
  item.visible = state.visible;
}

/** Shared options type for menu-channel command shortcuts (shortcutBindings are user overrides from setting.json). */
interface ApplicationMenuShortcutOptions {
  shortcutBindings?: Record<string, string[]>;
}

/**
 * Resolve menu accelerators from user overrides: an explicit empty array means "unset"
 * after a binding conflict (no accelerator); all-invalid overrides fall back to the
 * hardcoded default (same semantics as the renderer's effective table). The main
 * process only needs "command -> accelerator string"; full effective-table semantics
 * live in the UI shortcut core. Recording state returns undefined (menu item keeps
 * no accelerator but stays clickable) so recorded keys cannot fire the command.
 */
function resolveMenuAccelerator(
  options: ApplicationMenuShortcutOptions & { disableShortcutAccelerators?: boolean },
  commandId: string,
  fallback: string,
): string | undefined {
  if (options.disableShortcutAccelerators) {
    return undefined;
  }
  // `?.find(isValid) ?? fallback` would collapse "explicit empty array = unset" and
  // "all invalid = fall back to default" into one path, resurrecting the default
  // accelerator of a command that lost a binding conflict: one key firing two actions,
  // contradicting the UI promise that the loser becomes unset.
  const overrideList = options?.shortcutBindings?.[commandId];
  if (overrideList !== undefined) {
    if (overrideList.length === 0) {
      return undefined;
    }
    return overrideList.find((binding) => isValidShortcutBinding(binding)) ?? fallback;
  }
  return fallback;
}

function buildApplicationMenuTemplate(options: {
  currentApplicationLocale: Locale;
  zcodeEndpointSelection?: "production" | "test" | "custom";
  executeDesktopCommand: (
    command: DesktopCommandId,
    senderWindow?: BrowserWindow | null,
  ) => Promise<unknown>;
  currentZoomLevel?: number;
  shortcutBindings?: Record<string, string[]>;
  /** Shortcut settings page recording state: when true, strip all configurable accelerators */
  disableShortcutAccelerators?: boolean;
}): Electron.MenuItemConstructorOptions[] {
  const getLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
    getDesktopMenuLabel(options.currentApplicationLocale, id);
  const getAppLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
    getLabel(id).replaceAll("{appName}", app.name);
  const stdioTapState = readZCodeStdioTapDevState();
  const isLocalDevelopmentRuntime = !app.isPackaged;
  const currentZoomLevel = clampDesktopZoomLevel(options.currentZoomLevel ?? 0);
  const canResetZoom = currentZoomLevel !== 0;
  const canZoomIn = currentZoomLevel < DESKTOP_ZOOM_MAX_LEVEL;
  const canZoomOut = currentZoomLevel > DESKTOP_ZOOM_MIN_LEVEL;
  // When the zoomIn primary binding contains "=", keep a dual entry: visible Plus +
  // hidden "=" (Plus renders better in menus; "=" covers direct no-Shift presses on Windows).
  // Recording state sets accelerator to undefined (strip the binding, keep the item clickable).
  const zoomInBinding = resolveMenuAccelerator(options, "zoomIn", "CmdOrCtrl+=");
  const zoomInVisibleAccelerator = zoomInBinding?.replace("=", "Plus");

  return [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              {
                label: getLabel(desktopMenuMessageIds.helpAbout),
                click: () => void options.executeDesktopCommand(DesktopCommandIds.ShowAbout),
              },
              // The update entry follows product identity: preview disables the updater, production-backend preview included.
              ...(isUpdaterEnabledFlavor(ZCODE_PRODUCT_FLAVOR)
                ? [
                    {
                      id: CHECK_FOR_UPDATE_MENU_ID,
                      label: getLabel(desktopMenuMessageIds.helpCheckForUpdates),
                      click: () =>
                        void options.executeDesktopCommand(DesktopCommandIds.CheckForUpdates),
                    },
                  ]
                : []),
              { type: "separator" as const },
              {
                label: getLabel(desktopMenuMessageIds.appServices),
                role: "services" as const,
              },
              { type: "separator" as const },
              {
                label: getAppLabel(desktopMenuMessageIds.appHide),
                role: "hide" as const,
              },
              {
                label: getLabel(desktopMenuMessageIds.appHideOthers),
                role: "hideOthers" as const,
              },
              {
                label: getLabel(desktopMenuMessageIds.appShowAll),
                role: "unhide" as const,
              },
              { type: "separator" as const },
              {
                label: getAppLabel(desktopMenuMessageIds.appQuit),
                role: "quit" as const,
              },
            ],
          },
        ]
      : []),
    {
      label: getLabel(desktopMenuMessageIds.file),
      submenu: [
        {
          label: getLabel(desktopMenuMessageIds.fileNewTask),
          accelerator: resolveMenuAccelerator(options, "newTask", "CmdOrCtrl+N"),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.NewTask),
        },
        {
          label: getLabel(desktopMenuMessageIds.fileOpenWorkspace),
          accelerator: resolveMenuAccelerator(options, "openWorkspace", "CmdOrCtrl+O"),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenWorkspace),
        },
        { type: "separator" as const },
        {
          label: getLabel(desktopMenuMessageIds.fileCloseWindow),
          accelerator: resolveMenuAccelerator(options, "closeActiveContext", "CmdOrCtrl+W"),
          // Electron's close role closes the window directly in main, giving the renderer
          // no chance to check whether the right side pane has an active tab. Route through
          // a business command instead so the shortcut enters the workspace state machine first.
          click: () => void options.executeDesktopCommand(DesktopCommandIds.CloseActiveContext),
        },
      ],
    },
    {
      label: getLabel(desktopMenuMessageIds.edit),
      // Top-level Electron editMenu/windowMenu roles generate labels from the system/Electron
      // locale, which mixes with the in-app currentApplicationLocale into half-Chinese,
      // half-English menus like "文件 Edit 视图 Window 帮助".
      submenu: [
        { label: getLabel(desktopMenuMessageIds.editUndo), role: "undo" as const },
        { label: getLabel(desktopMenuMessageIds.editRedo), role: "redo" as const },
        { type: "separator" as const },
        { label: getLabel(desktopMenuMessageIds.editCut), role: "cut" as const },
        { label: getLabel(desktopMenuMessageIds.editCopy), role: "copy" as const },
        { label: getLabel(desktopMenuMessageIds.editPaste), role: "paste" as const },
        { type: "separator" as const },
        { label: getLabel(desktopMenuMessageIds.editSelectAll), role: "selectAll" as const },
      ],
    },
    {
      label: getLabel(desktopMenuMessageIds.view),
      submenu: [
        {
          label: getLabel(desktopMenuMessageIds.viewToggleFullScreen),
          role: "togglefullscreen" as const,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ToggleFullScreen),
        },
        { type: "separator" as const },
        // The zoom command accelerator follows user shortcut settings (shortcutBindings overrides).
        {
          label: getLabel(desktopMenuMessageIds.viewZoomIn),
          accelerator: zoomInVisibleAccelerator,
          enabled: canZoomIn,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ZoomIn),
        },
        ...(zoomInVisibleAccelerator !== undefined && zoomInVisibleAccelerator !== zoomInBinding
          ? [
              {
                label: getLabel(desktopMenuMessageIds.viewZoomIn),
                accelerator: zoomInBinding,
                visible: false,
                enabled: canZoomIn,
                click: () => void options.executeDesktopCommand(DesktopCommandIds.ZoomIn),
              },
            ]
          : []),
        {
          label: getLabel(desktopMenuMessageIds.viewZoomOut),
          accelerator: resolveMenuAccelerator(options, "zoomOut", "CmdOrCtrl+-"),
          enabled: canZoomOut,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ZoomOut),
        },
        {
          label: getLabel(desktopMenuMessageIds.viewActualSize),
          accelerator: resolveMenuAccelerator(options, "resetZoom", "CmdOrCtrl+0"),
          enabled: canResetZoom,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ResetZoom),
        },
      ],
    },
    {
      label: getLabel(desktopMenuMessageIds.window),
      submenu: [
        { label: getLabel(desktopMenuMessageIds.windowMinimize), role: "minimize" as const },
        ...(process.platform === "darwin"
          ? [
              { label: getLabel(desktopMenuMessageIds.windowZoom), role: "zoom" as const },
              { type: "separator" as const },
              {
                label: getLabel(desktopMenuMessageIds.windowBringAllToFront),
                role: "front" as const,
              },
            ]
          : []),
      ],
    },
    {
      label: getLabel(desktopMenuMessageIds.help),
      submenu: [
        ...(process.platform !== "darwin"
          ? [
              {
                label: getLabel(desktopMenuMessageIds.helpAbout),
                click: () => void options.executeDesktopCommand(DesktopCommandIds.ShowAbout),
              },
              ...(isUpdaterEnabledFlavor(ZCODE_PRODUCT_FLAVOR)
                ? [
                    {
                      id: CHECK_FOR_UPDATE_MENU_ID,
                      label: getLabel(desktopMenuMessageIds.helpCheckForUpdates),
                      click: () =>
                        void options.executeDesktopCommand(DesktopCommandIds.CheckForUpdates),
                    },
                  ]
                : []),
              { type: "separator" as const },
            ]
          : []),
        {
          label: getLabel(desktopMenuMessageIds.helpWhatsNew),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenChangelog),
        },
        { type: "separator" as const },
        ...(isLocalDevelopmentRuntime && stdioTapState.visible
          ? [
              {
                id: HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID,
                label: getLabel(desktopMenuMessageIds.helpToggleZCodeStdioTap),
                type: "checkbox" as const,
                checked: stdioTapState.enabled,
                click: () =>
                  void options.executeDesktopCommand(DesktopCommandIds.ToggleZCodeStdioTapDevProxy),
              },
              { type: "separator" as const },
            ]
          : []),
        ...(ZCODE_ENV === "test"
          ? [
              {
                label: getLabel(desktopMenuMessageIds.helpZCodeEndpoint),
                submenu: [
                  {
                    id: HELP_ZCODE_ENDPOINT_PRODUCTION_MENU_ID,
                    label: getLabel(desktopMenuMessageIds.helpZCodeEndpointProduction),
                    type: "radio" as const,
                    checked: (options.zcodeEndpointSelection ?? "production") === "production",
                    click: () =>
                      void options.executeDesktopCommand(
                        DesktopCommandIds.SetZCodeEndpointProduction,
                      ),
                  },
                  { type: "separator" as const },
                  {
                    label: getLabel(desktopMenuMessageIds.helpZCodeEndpointCustom),
                    click: () =>
                      void options.executeDesktopCommand(DesktopCommandIds.SetZCodeEndpointCustom),
                  },
                  {
                    label: getLabel(desktopMenuMessageIds.helpZCodeEndpointReset),
                    click: () =>
                      void options.executeDesktopCommand(DesktopCommandIds.ResetZCodeEndpoint),
                  },
                ],
              },
              { type: "separator" as const },
            ]
          : []),
        {
          id: HELP_TOGGLE_DEV_TOOLS_MENU_ID,
          label: getLabel(desktopMenuMessageIds.helpToggleDevTools),
          role: "toggleDevTools" as const,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ToggleDevTools),
        },
        { type: "separator" as const },
        {
          label: getLabel(desktopMenuMessageIds.helpResourceManager),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenResourceManager),
        },
        { type: "separator" as const },
        {
          label: getLabel(desktopMenuMessageIds.helpFeedback),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenFeedback),
        },
        {
          label: getLabel(desktopMenuMessageIds.helpExportLogs),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ExportLogs),
        },
        { type: "separator" as const },
        {
          label: getLabel(desktopMenuMessageIds.helpClearAllData),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ClearAllData),
        },
      ],
    },
  ];
}

export function rebuildApplicationMenu(options: {
  currentApplicationLocale: Locale;
  zcodeEndpointSelection?: "production" | "test" | "custom";
  executeDesktopCommand: (
    command: DesktopCommandId,
    senderWindow?: BrowserWindow | null,
  ) => Promise<unknown>;
  currentZoomLevel?: number;
  shortcutBindings?: Record<string, string[]>;
  /** Shortcut settings page recording state: when true, strip all configurable accelerators */
  disableShortcutAccelerators?: boolean;
}) {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildApplicationMenuTemplate({
        currentApplicationLocale: options.currentApplicationLocale,
        zcodeEndpointSelection: options.zcodeEndpointSelection,
        executeDesktopCommand: options.executeDesktopCommand,
        currentZoomLevel: options.currentZoomLevel,
        shortcutBindings: options.shortcutBindings,
        disableShortcutAccelerators: options.disableShortcutAccelerators,
      }),
    ),
  );
  setAutoUpdaterMenuLocale(options.currentApplicationLocale);
  if (!app.isPackaged) {
    updateZCodeStdioTapDevMenuState();
  }
}
