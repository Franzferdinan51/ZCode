// Tests for speedstack/mcp-pruning.ts — node:test, no external deps.
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMcpAllowlist,
  pruneMcpServerMap,
  pruneMcpTools,
} from "./mcp-pruning.ts";

test("normalizeMcpAllowlist is opt-in: undefined/empty/blank -> undefined", () => {
  assert.equal(normalizeMcpAllowlist(undefined), undefined);
  assert.equal(normalizeMcpAllowlist([]), undefined);
  assert.equal(normalizeMcpAllowlist(["", "   "]), undefined);
});

test("normalizeMcpAllowlist trims and drops blanks", () => {
  assert.deepEqual(normalizeMcpAllowlist([" fs ", "", 42 as never]), ["fs"]);
});

test("pruneMcpServerMap keeps only allowlisted servers", () => {
  const servers = { fs: { a: 1 }, git: { b: 2 }, browser: { c: 3 } };
  assert.deepEqual(pruneMcpServerMap(servers, ["fs", "GIT"]), {
    fs: { a: 1 },
    git: { b: 2 },
  });
});

test("pruneMcpServerMap leaves everything when no allowlist", () => {
  const servers = { fs: { a: 1 } };
  assert.deepEqual(pruneMcpServerMap(servers, undefined), servers);
  assert.deepEqual(pruneMcpServerMap(servers, []), servers);
});

const TOOLS = [
  { name: "read", serverName: "fs" },
  { name: "write", serverName: "fs" },
  { name: "read", serverName: "git" },
  { name: "commit", serverName: "git" },
];

test("pruneMcpTools supports server.tool and bare tool entries", () => {
  const pruned = pruneMcpTools(TOOLS, ["fs.read", "commit"]);
  assert.deepEqual(
    pruned.map((tool) => `${tool.serverName}.${tool.name}`),
    ["fs.read", "git.commit"],
  );
});

test("pruneMcpTools bare name matches across servers", () => {
  const pruned = pruneMcpTools(TOOLS, ["read"]);
  assert.equal(pruned.length, 2);
});

test("pruneMcpTools leaves everything when no allowlist", () => {
  assert.deepEqual(pruneMcpTools(TOOLS, undefined), TOOLS);
});
