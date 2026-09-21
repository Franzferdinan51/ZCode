import assert from "node:assert/strict";
import test from "node:test";
import { hidesPaidPlanUpsells } from "../src/lib/localFork.js";
import { normalizeZCodeProductFlavor, ZCODE_PRODUCT_FLAVOR } from "../../shared/src/env.js";
import { shouldOfferQuotaBannerUpgrade } from "../src/v4/sessionQuotaBannerState.js";

test("local flavor hides paid-plan upsells, official flavors keep them", () => {
  assert.equal(hidesPaidPlanUpsells("local"), true);
  assert.equal(hidesPaidPlanUpsells(" local "), true);
  assert.equal(hidesPaidPlanUpsells("LOCAL"), true);
  assert.equal(hidesPaidPlanUpsells("production"), false);
  assert.equal(hidesPaidPlanUpsells("preview"), false);
  assert.equal(hidesPaidPlanUpsells(""), false);
});

test("product flavor resolution honors the local identity", () => {
  assert.equal(normalizeZCodeProductFlavor("local", "test"), "local");
  assert.equal(normalizeZCodeProductFlavor("local", "production"), "local");
  assert.equal(normalizeZCodeProductFlavor(undefined, "test"), "preview");
  assert.equal(normalizeZCodeProductFlavor(undefined, "production"), "production");
  assert.equal(normalizeZCodeProductFlavor("production", "test"), "production");
  assert.equal(normalizeZCodeProductFlavor("bogus", "test"), "preview");
});

test("unbundled imports fall back to official semantics (upsells visible)", () => {
  // No __ZCODE_PRODUCT_FLAVOR__ define outside real builds, so the raw module
  // resolves to preview and the fork gates stay off: official behavior is the default.
  assert.equal(ZCODE_PRODUCT_FLAVOR, "preview");
  assert.equal(hidesPaidPlanUpsells(ZCODE_PRODUCT_FLAVOR), false);
});

test("quota banner upgrade offers keep existing semantics off-fork", () => {
  // mcp-quota-exhausted never offers (upgrade can't fix a daily reset); every other
  // kind does. In the local fork the caller-level flag forces all of these false.
  assert.equal(shouldOfferQuotaBannerUpgrade("mcp-quota-exhausted"), false);
  assert.equal(shouldOfferQuotaBannerUpgrade("mcp-plan-required"), true);
  assert.equal(shouldOfferQuotaBannerUpgrade(null), true);
});
