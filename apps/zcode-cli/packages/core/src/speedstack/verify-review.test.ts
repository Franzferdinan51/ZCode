// Tests for speedstack/verify-review.ts — node:test, no external deps.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewCommandPrompt,
  buildVerifyCommandPrompt,
} from "./verify-review.ts";

test("buildVerifyCommandPrompt instructs build+tests with pass/fail report", () => {
  const prompt = buildVerifyCommandPrompt("");
  assert.ok(prompt.includes("/verify"));
  assert.ok(prompt.toLowerCase().includes("build"));
  assert.ok(prompt.toLowerCase().includes("test"));
  assert.ok(prompt.includes("PASS") && prompt.includes("FAIL"));
});

test("buildVerifyCommandPrompt carries the scope", () => {
  assert.ok(buildVerifyCommandPrompt("packages/core").includes("packages/core"));
});

test("buildReviewCommandPrompt defaults to uncommitted changes", () => {
  const prompt = buildReviewCommandPrompt("");
  assert.ok(prompt.includes("/review"));
  assert.ok(prompt.includes("git diff"));
});

test("buildReviewCommandPrompt carries an explicit ref", () => {
  assert.ok(buildReviewCommandPrompt("HEAD~3").includes("HEAD~3"));
});
