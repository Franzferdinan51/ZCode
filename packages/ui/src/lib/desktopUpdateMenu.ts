import {
  ZCODE_PRODUCT_FLAVOR,
  isUpdaterEnabledFlavor,
  type ZCodeProductFlavor,
  type UpdateStatePayload,
} from "@zcode/shared";

// The update entry follows product identity, not backend env: preview identity
// (including production-backend preview) disables the updater.
export function shouldShowDesktopUpdateEntry(
  flavor: ZCodeProductFlavor = ZCODE_PRODUCT_FLAVOR,
): boolean {
  return isUpdaterEnabledFlavor(flavor);
}

export function getUpdateMenuLabelId(state: UpdateStatePayload | null) {
  switch (state?.kind) {
    case "checking":
      return "desktopMenu.help.checkingForUpdates";
    case "update-available":
      return "desktopMenu.help.updateAvailableVersion";
    case "download-progress":
      return "desktopMenu.help.downloadingUpdateProgress";
    case "update-downloaded":
      return "desktopMenu.help.restartToUpdate";
    case "idle":
    default:
      return "titleBar.menu.help.checkForUpdates";
  }
}

export function getUpdateMenuLabelValues(
  state: UpdateStatePayload | null,
): Record<string, string> | undefined {
  switch (state?.kind) {
    case "update-available":
    case "update-downloaded":
      return { version: state.version };
    case "download-progress":
      return { progress: state.progress };
    default:
      return undefined;
  }
}
