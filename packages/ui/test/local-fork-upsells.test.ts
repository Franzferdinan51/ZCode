import assert from "node:assert/strict";
import test from "node:test";
import { normalizeZCodeProductFlavor, ZCODE_PRODUCT_FLAVOR } from "../../shared/src/env.js";

test("product flavor resolution honors the local identity", () => {
  assert.equal(normalizeZCodeProductFlavor("local", "test"), "local");
  assert.equal(normalizeZCodeProductFlavor("local", "production"), "local");
  assert.equal(normalizeZCodeProductFlavor(undefined, "test"), "preview");
  assert.equal(normalizeZCodeProductFlavor(undefined, "production"), "production");
  assert.equal(normalizeZCodeProductFlavor("production", "test"), "production");
  assert.equal(normalizeZCodeProductFlavor("bogus", "test"), "preview");
});

test("unbundled imports fall back to the official flavor", () => {
  // No __ZCODE_PRODUCT_FLAVOR__ define outside real builds, so the raw module
  // resolves to preview. The paid-plan upsell flag and quota-banner upgrade
  // offers were deleted with the purchase UI; nothing references them anymore.
  assert.equal(ZCODE_PRODUCT_FLAVOR, "preview");
});
