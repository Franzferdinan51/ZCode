import test from "node:test";
import assert from "node:assert/strict";
import {
  desktopProductIdentities,
  isOfficialIdentityRequested,
  isPreviewIdentityRequested,
  resolveDesktopArtifactSuffix,
  resolveDesktopIconBaseName,
  resolveDesktopIconsDirName,
  resolveDesktopProductFlavor,
  resolveDesktopProductIdentity,
  resolveWindowsAppUserModelId,
  resolveWindowsAppUserModelIdForFlavor,
} from "./desktop-product-identity.mjs";

test("fork builds default to the local identity on any backend env", () => {
  assert.equal(resolveDesktopProductFlavor({}), "local");
  assert.equal(resolveDesktopProductFlavor({ ZCODE_ENV: "production" }), "local");
  assert.equal(resolveDesktopProductFlavor({ ZCODE_ENV: "test" }), "local");
  const identity = resolveDesktopProductIdentity({});
  assert.equal(identity.flavor, "local");
  assert.equal(identity.productName, "ZCode Local");
  assert.equal(identity.appId, "dev.zcode.app.local");
  assert.equal(identity.linuxExecutableName, "zcode-local");
  assert.equal(identity.linuxPackageName, "zcode-local");
  assert.equal(identity.cuaHelperInstallVariant, "local");
});

test("local identity never collides with official production/preview identities", () => {
  const { production, preview, local } = desktopProductIdentities;
  for (const key of ["appId", "productName", "linuxExecutableName", "linuxPackageName"]) {
    assert.notEqual(local[key], production[key], key);
    assert.notEqual(local[key], preview[key], key);
  }
});

test("explicit official opt-in restores the legacy production/preview resolution", () => {
  assert.equal(
    resolveDesktopProductFlavor({ ZCODE_OFFICIAL_IDENTITY: "1", ZCODE_ENV: "production" }),
    "production",
  );
  assert.equal(
    resolveDesktopProductFlavor({
      ZCODE_OFFICIAL_IDENTITY: "1",
      ZCODE_ENV: "production",
      ZCODE_PREVIEW_IDENTITY: "1",
    }),
    "preview",
  );
  assert.equal(
    resolveDesktopProductFlavor({ ZCODE_OFFICIAL_IDENTITY: "1", ZCODE_ENV: "test" }),
    "preview",
  );
  assert.equal(isOfficialIdentityRequested({}), false);
  assert.equal(isOfficialIdentityRequested({ ZCODE_OFFICIAL_IDENTITY: "0" }), false);
  assert.throws(() => isOfficialIdentityRequested({ ZCODE_OFFICIAL_IDENTITY: "true" }));
  assert.throws(() => isPreviewIdentityRequested({ ZCODE_PREVIEW_IDENTITY: "yes" }));
});

test("windows AUMID follows the local app id when packaged", () => {
  assert.equal(
    resolveWindowsAppUserModelIdForFlavor("local", { isPackaged: true }),
    "dev.zcode.app.local",
  );
  assert.equal(
    resolveWindowsAppUserModelIdForFlavor("preview", { isPackaged: true }),
    "dev.zcode.app.preview",
  );
  assert.equal(resolveWindowsAppUserModelId({}, { isPackaged: true }), "dev.zcode.app.local");
  assert.equal(
    resolveWindowsAppUserModelIdForFlavor("local", { isPackaged: false }),
    "cn.aminer.zcode",
  );
});

test("local identity uses the inverted icon set, official keeps the original", () => {
  assert.equal(resolveDesktopIconBaseName({}), "icon-local");
  assert.equal(resolveDesktopIconsDirName({}), "icons-local");
  assert.equal(
    resolveDesktopIconBaseName({ ZCODE_OFFICIAL_IDENTITY: "1", ZCODE_ENV: "production" }),
    "icon",
  );
  assert.equal(
    resolveDesktopIconsDirName({ ZCODE_OFFICIAL_IDENTITY: "1", ZCODE_ENV: "production" }),
    "icons",
  );
  assert.equal(
    resolveDesktopIconBaseName({
      ZCODE_OFFICIAL_IDENTITY: "1",
      ZCODE_ENV: "production",
      ZCODE_PREVIEW_IDENTITY: "1",
    }),
    "icon",
  );
});

test("artifact suffix still marks backend env, not identity", () => {
  assert.equal(resolveDesktopArtifactSuffix({ ZCODE_ENV: "production" }), "");
  assert.equal(resolveDesktopArtifactSuffix({}), "_TEST");
});
