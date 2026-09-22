import type { ZCodeProductFlavor } from "./env.js";

/**
 * ZCode Local fork update sources.
 *
 * Every update path in this fork (CLI installer index, desktop Electron
 * manifest) defaults to OUR GitHub releases. Official Z.ai endpoints must
 * never be an update source here: an official payload would not understand
 * the fork layout and would break the installation.
 */

/**
 * Flavors with an enabled auto-updater. `production` keeps the official feed;
 * `local` (this fork's default identity) uses our GitHub releases manifest.
 * `preview` stays update-less on both.
 */
export function isUpdaterEnabledFlavor(flavor: ZCodeProductFlavor): boolean {
  return flavor === "production" || flavor === "local";
}
export const LOCAL_UPDATE_GITHUB_REPO = "Franzferdinan51/ZCode";

/** Stable base for "latest published release" assets. No trailing slash. */
export const LOCAL_UPDATE_BASE_URL = `https://github.com/${LOCAL_UPDATE_GITHUB_REPO}/releases/latest/download`;

/** CLI/TUI version index consumed by install.sh update/reinstall flows. */
export const LOCAL_CLI_UPDATE_INDEX_URL = `${LOCAL_UPDATE_BASE_URL}/latest.json`;

/** Electron auto-update manifest (electron-updater YAML) for desktop builds. */
export const LOCAL_ELECTRON_MANIFEST_FILE = "electron-manifest.yml";
export const LOCAL_ELECTRON_MANIFEST_URL = `${LOCAL_UPDATE_BASE_URL}/${LOCAL_ELECTRON_MANIFEST_FILE}`;

/**
 * True when `value` addresses our Electron manifest (query strings ignored:
 * the manifest provider appends platform/channel params to any feed URL).
 */
export function isLocalUpdateManifestUrl(value: string | URL): boolean {
  try {
    const parsed = typeof value === "string" ? new URL(value) : value;
    const expected = new URL(LOCAL_ELECTRON_MANIFEST_URL);
    return parsed.origin === expected.origin && parsed.pathname === expected.pathname;
  } catch {
    return false;
  }
}
