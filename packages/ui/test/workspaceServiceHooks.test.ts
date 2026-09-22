import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const HOOK_FILES = [
  "useZCodeSessionService.ts",
  "useZCodeAgentService.ts",
  "useZCodeTaskService.ts",
] as const;

function readHookSource(fileName: string): string {
  const url = new URL(`../src/hooks/${fileName}`, import.meta.url);
  const source = readFileSync(url, "utf8");
  // Strip comments so prose mentioning hooks cannot trip the pattern checks.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

test("workspace service hooks call hooks unconditionally", () => {
  for (const fileName of HOOK_FILES) {
    const source = readHookSource(fileName);
    assert.doesNotMatch(
      source,
      /[?:]\s*use[A-Z]\w*\(/,
      `${fileName} must not call hooks inside ternary branches (workspacePath flips async and shifts hook order)`,
    );
    assert.doesNotMatch(
      source,
      /&&\s*use[A-Z]\w*\(/,
      `${fileName} must not call hooks inside && branches`,
    );
  }
});

test("workspace service hooks subscribe to both service sources", () => {
  for (const fileName of HOOK_FILES) {
    const source = readHookSource(fileName);
    assert.ok(
      source.includes("useWorkspaceServices("),
      `${fileName} must subscribe to scoped workspace services`,
    );
    assert.ok(
      source.includes("useServices("),
      `${fileName} must subscribe to context services`,
    );
  }
});
