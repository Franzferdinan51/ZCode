import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_CLI_UPDATE_INDEX_URL,
  LOCAL_ELECTRON_MANIFEST_URL,
  LOCAL_UPDATE_BASE_URL,
  LOCAL_UPDATE_GITHUB_REPO,
  isLocalUpdateManifestUrl,
  isUpdaterEnabledFlavor,
} from "../src/localUpdateFeed.js";

test("fork update constants point at our GitHub releases, never official", () => {
  assert.equal(LOCAL_UPDATE_GITHUB_REPO, "Franzferdinan51/ZCode");
  assert.equal(
    LOCAL_UPDATE_BASE_URL,
    "https://github.com/Franzferdinan51/ZCode/releases/latest/download",
  );
  assert.equal(LOCAL_CLI_UPDATE_INDEX_URL, `${LOCAL_UPDATE_BASE_URL}/latest.json`);
  assert.equal(LOCAL_ELECTRON_MANIFEST_URL, `${LOCAL_UPDATE_BASE_URL}/electron-manifest.yml`);
  for (const url of [LOCAL_UPDATE_BASE_URL, LOCAL_CLI_UPDATE_INDEX_URL, LOCAL_ELECTRON_MANIFEST_URL]) {
    assert.doesNotMatch(url, /z\.ai|bigmodel/i);
  }
});

test("isLocalUpdateManifestUrl matches our manifest with any query string", () => {
  assert.equal(isLocalUpdateManifestUrl(LOCAL_ELECTRON_MANIFEST_URL), true);
  assert.equal(
    isLocalUpdateManifestUrl(`${LOCAL_ELECTRON_MANIFEST_URL}?platform=darwin-arm64&channel=1`),
    true,
  );
  assert.equal(
    isLocalUpdateManifestUrl("https://zcode.z.ai/api/v1/releases/electron/manifest"),
    false,
  );
  assert.equal(isLocalUpdateManifestUrl(LOCAL_CLI_UPDATE_INDEX_URL), false);
  assert.equal(isLocalUpdateManifestUrl("not a url"), false);
});

test("updater is enabled for production and local flavors only", () => {
  assert.equal(isUpdaterEnabledFlavor("production"), true);
  assert.equal(isUpdaterEnabledFlavor("local"), true);
  assert.equal(isUpdaterEnabledFlavor("preview"), false);
});
