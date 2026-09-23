/**
 * Rank 7 workflow tool tests (SearchAndRead, ApplyPatchSet).
 *
 * Exercises: contract validation, handler behavior with a mocked
 * FileSystemPort, read-state stamping, atomicity (ApplyPatchSet writes
 * nothing on validation failure), the ZCODE_WORKFLOW_TOOLS kill switch,
 * permission metadata, and P1 tool-pack mappings.
 *
 * Run with `npx tsx --test src/speedstack/workflow-tools.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ApplyPatchSetInputSchema,
  SearchAndReadInputSchema,
} from "@zcode/contracts";
import { searchAndReadToolEntry, truncateUtf8ToByteBound } from "../tool/handlers/search-and-read.ts";
import { applyPatchSetToolEntry } from "../tool/handlers/apply-patch-set.ts";
import {
  builtInTools,
  isWorkflowToolEnabled,
  registerBuiltInTools,
} from "../tool/handlers/index.ts";
import { computeToolShortlist } from "./tool-packs.ts";
import { PermissionService } from "../permission/service.ts";
import type { ToolEntry, ToolExecutionContext } from "../tool/types.ts";

// ---------------------------------------------------------------------------
// Fake FileSystemPort
// ---------------------------------------------------------------------------

type FakeFile = { content: string; mtimeMs: number };

function makeFakeFileSystemPort(
  files: Record<string, FakeFile>,
  options: { failWriteAt?: readonly number[]; statReturnsUndefined?: boolean } = {},
) {
  const writes: Array<{ path: string; content: string }> = [];
  let writeCount = 0;
  return {
    port: {
      async searchText(args: { pattern: string; beforeContext?: number; afterContext?: number }) {
        const entries: Array<{
          path: string;
          lineNumber: number;
          line: string;
          beforeContext: string[];
          afterContext: string[];
        }> = [];
        const regex = new RegExp(args.pattern);
        for (const [path, file] of Object.entries(files)) {
          const lines = file.content.split("\n");
          lines.forEach((line, index) => {
            if (regex.test(line)) {
              entries.push({
                path,
                lineNumber: index + 1,
                line,
                beforeContext: [],
                afterContext: [],
              });
            }
          });
        }
        return {
          mode: "content" as const,
          durationMs: 1,
          numFiles: entries.length > 0 ? 1 : 0,
          filenames: [],
          truncated: false,
          appliedLimit: 100,
          appliedOffset: 0,
          entries,
          numMatches: entries.length,
        };
      },
      async searchFiles(args: { pattern: string }) {
        const needle = args.pattern.replace(/\*/g, "");
        const matched = Object.keys(files).filter((path) => path.includes(needle));
        return {
          path: args.pattern,
          pattern: args.pattern,
          durationMs: 1,
          files: matched,
          numFiles: matched.length,
          truncated: false,
        };
      },
      async stat(args: { path: string }) {
        if (options.statReturnsUndefined) return undefined;
        const file = files[args.path];
        if (!file) return null;
        return {
          isFile: true,
          isDirectory: false,
          sizeBytes: Buffer.byteLength(file.content, "utf8"),
          mtimeMs: file.mtimeMs,
          revision: { id: `rev-${file.mtimeMs}`, mtimeMs: file.mtimeMs },
        };
      },
      async readTextFileRange(args: { path: string; offsetLine: number; limitLines: number }) {
        const file = files[args.path];
        if (!file) throw new Error(`ENOENT: ${args.path}`);
        const lines = file.content.split("\n");
        const slice = lines.slice(args.offsetLine, args.offsetLine + args.limitLines);
        return {
          content: slice.join("\n"),
          encoding: "utf-8" as const,
          revision: { id: `rev-${file.mtimeMs}`, mtimeMs: file.mtimeMs },
          sizeBytes: Buffer.byteLength(file.content, "utf8"),
        };
      },
      async readTextFile(args: { path: string }) {
        const file = files[args.path];
        if (!file) throw new Error(`ENOENT: ${args.path}`);
        return {
          content: file.content,
          encoding: "utf-8" as const,
          revision: { id: `rev-${file.mtimeMs}`, mtimeMs: file.mtimeMs },
          sizeBytes: Buffer.byteLength(file.content, "utf8"),
        };
      },
      async writeTextFile(args: { path: string; content: string }) {
        writeCount += 1;
        if (options.failWriteAt?.includes(writeCount)) {
          throw new Error(`EIO: simulated write failure #${writeCount} (${args.path})`);
        }
        writes.push({ path: args.path, content: args.content });
        const mtimeMs = Date.now();
        files[args.path] = { content: args.content, mtimeMs };
        return { revision: { id: `rev-${mtimeMs}`, mtimeMs } };
      },
    },
    writes,
  };
}

function makeContext(fake: ReturnType<typeof makeFakeFileSystemPort>): ToolExecutionContext {
  return {
    workingDirectory: "/work",
    workspaceRoot: "/work",
    toolCallId: "test-call",
    fileSystemPort: fake.port,
    readFileState: new Map(),
  } as unknown as ToolExecutionContext;
}

const SAMPLE_FILES: Record<string, FakeFile> = {
  "/work/a.ts": { content: "export const alpha = 1;\nexport const beta = 2;\n", mtimeMs: 1000 },
  "/work/b.ts": { content: "import { alpha } from \"./a\";\nconsole.log(alpha);\n", mtimeMs: 1000 },
};

// ---------------------------------------------------------------------------
// Contract validation
// ---------------------------------------------------------------------------

test("SearchAndRead contract: content mode requires pattern", () => {
  assert.ok(SearchAndReadInputSchema.safeParse({ mode: "content", pattern: "alpha" }).success);
  assert.ok(!SearchAndReadInputSchema.safeParse({ mode: "content" }).success);
  // glob doubles as a file filter in content mode, so pattern+glob is valid.
  assert.ok(
    SearchAndReadInputSchema.safeParse({ mode: "content", pattern: "x", glob: "*.ts" }).success,
  );
});

test("SearchAndRead contract: files mode requires glob", () => {
  assert.ok(SearchAndReadInputSchema.safeParse({ mode: "files", glob: "*.ts" }).success);
  assert.ok(!SearchAndReadInputSchema.safeParse({ mode: "files" }).success);
});

test("SearchAndRead contract: strict — unknown keys rejected", () => {
  assert.ok(!SearchAndReadInputSchema.safeParse({ mode: "content", pattern: "x", bogus: 1 }).success);
});

test("SearchAndRead contract: bounds enforced", () => {
  assert.ok(!SearchAndReadInputSchema.safeParse({ mode: "content", pattern: "x", context: 99 }).success);
  assert.ok(!SearchAndReadInputSchema.safeParse({ mode: "files", glob: "*", max_files: 99 }).success);
  assert.ok(SearchAndReadInputSchema.safeParse({ mode: "files", glob: "*", max_files: 25 }).success);
});

test("ApplyPatchSet contract: 1-20 patches, strict", () => {
  const patch = { file_path: "/work/a.ts", old_string: "x", new_string: "y" };
  assert.ok(ApplyPatchSetInputSchema.safeParse({ patches: [patch] }).success);
  assert.ok(!ApplyPatchSetInputSchema.safeParse({ patches: [] }).success);
  assert.ok(
    !ApplyPatchSetInputSchema.safeParse({
      patches: Array.from({ length: 21 }, () => ({ ...patch })),
    }).success,
  );
  assert.ok(!ApplyPatchSetInputSchema.safeParse({ patches: [patch], dry_run: "yes" }).success);
  assert.ok(!ApplyPatchSetInputSchema.safeParse({ patches: [patch], bogus: 1 }).success);
});

// ---------------------------------------------------------------------------
// SearchAndRead handler
// ---------------------------------------------------------------------------

test("SearchAndRead content mode: windows with line numbers, read state stamped", async () => {
  const fake = makeFakeFileSystemPort({ ...SAMPLE_FILES });
  const context = makeContext(fake);
  const output = (await searchAndReadToolEntry.handler(
    { mode: "content", pattern: "alpha", context_lines: 1 },
    context,
  )) as { mode: string; results: Array<{ path: string; content: string }> };

  assert.equal(output.mode, "content");
  assert.equal(output.results.length, 2);
  for (const result of output.results) {
    assert.match(result.content, /^\d+\t/m);
  }
  const state = context.readFileState!;
  assert.equal(state.size, 2);
  for (const entry of state.values()) {
    assert.equal(entry.sourceTool, "SearchAndRead");
    assert.equal(entry.isPartialView, true);
  }
});

test("SearchAndRead files mode: full content stamped as full read", async () => {
  const fake = makeFakeFileSystemPort({ ...SAMPLE_FILES });
  const context = makeContext(fake);
  const output = (await searchAndReadToolEntry.handler(
    { mode: "files", glob: ".ts", max_files: 5 },
    context,
  )) as { mode: string; results: Array<{ path: string; content: string; tooLarge: boolean }> };

  assert.equal(output.mode, "files");
  assert.equal(output.results.length, 2);
  assert.equal(output.results[0].content, SAMPLE_FILES["/work/a.ts"].content);
  for (const entry of context.readFileState!.values()) {
    assert.equal(entry.isPartialView, false);
  }
});

test("SearchAndRead files mode: oversized file is skipped, not read", async () => {
  const big = "x".repeat(300 * 1024);
  const fake = makeFakeFileSystemPort({
    "/work/big.ts": { content: big, mtimeMs: 1000 },
  });
  const context = makeContext(fake);
  const output = (await searchAndReadToolEntry.handler(
    { mode: "files", glob: ".ts" },
    context,
  )) as { results: Array<{ tooLarge: boolean; content: string }> };

  assert.equal(output.results.length, 1);
  assert.equal(output.results[0].tooLarge, true);
  assert.match(output.results[0].content, /too large to inline/);
});

test("SearchAndRead metadata: read-only, no approval, registered name", () => {
  assert.equal(searchAndReadToolEntry.metadata.name, "SearchAndRead");
  assert.equal(searchAndReadToolEntry.metadata.readOnly, true);
  assert.equal(searchAndReadToolEntry.metadata.needsApproval, false);
  assert.equal(searchAndReadToolEntry.permission.permission, "read");
  assert.equal(searchAndReadToolEntry.permission.needsApproval, false);
  assert.deepEqual(searchAndReadToolEntry.permission.patternSources, ["path", "input"]);
});

// ---------------------------------------------------------------------------
// truncateUtf8ToByteBound (Gap 3: true byte-bound truncation)
// ---------------------------------------------------------------------------

test("truncateUtf8ToByteBound: under the bound returns input untouched", () => {
  const { text, truncated } = truncateUtf8ToByteBound("hello", 100);
  assert.equal(truncated, false);
  assert.equal(text, "hello");
});

test("truncateUtf8ToByteBound: ASCII cuts at exactly maxBytes", () => {
  const { text, truncated } = truncateUtf8ToByteBound("abcdef", 4);
  assert.equal(truncated, true);
  assert.equal(text, "abcd");
  assert.equal(Buffer.byteLength(text, "utf8"), 4);
});

test("truncateUtf8ToByteBound: never splits a multi-byte character", () => {
  // "あ" is 3 UTF-8 bytes. Bound 10 lands 1 byte into the 4th char.
  const input = "あ".repeat(6);
  const { text, truncated } = truncateUtf8ToByteBound(input, 10);
  assert.equal(truncated, true);
  assert.equal(text, "あ".repeat(3));
  assert.equal(Buffer.byteLength(text, "utf8"), 9);
  assert.ok(!text.includes("�"), "no replacement character emitted");
});

test("truncateUtf8ToByteBound: cut exactly on a char boundary keeps the char", () => {
  // "é" is 2 bytes; bound 4 lands exactly after the 2nd char.
  const { text, truncated } = truncateUtf8ToByteBound("ééé", 4);
  assert.equal(truncated, true);
  assert.equal(text, "éé");
  assert.equal(Buffer.byteLength(text, "utf8"), 4);
});

test("truncateUtf8ToByteBound: 4-byte emoji dropped when the bound cuts inside", () => {
  // "🦆" is 4 bytes; bound 6 = 1 full emoji + 2 bytes of the next.
  const { text, truncated } = truncateUtf8ToByteBound("🦆🦆", 6);
  assert.equal(truncated, true);
  assert.equal(text, "🦆");
  assert.equal(Buffer.byteLength(text, "utf8"), 4);
  assert.ok(!text.includes("�"), "no replacement character emitted");
});

test("truncateUtf8ToByteBound: multi-byte text cannot exceed the byte budget", () => {
  // The old char-count slice(0, n) returned 40_000 chars = 120_000 bytes
  // here — 1.2x over the budget.
  const input = "あ".repeat(40_000);
  const { text, truncated } = truncateUtf8ToByteBound(input, 100_000);
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(text, "utf8") <= 100_000, "byte bound enforced");
  assert.ok(!text.includes("�"), "no replacement character emitted");
});

test("SearchAndRead files mode: multi-byte content truncated to a UTF-8 byte bound", async () => {
  // stat is unavailable (statQuietly path): the byte truncation is the only
  // guard. 40_000 "あ" = 120_000 bytes — the old char-count slice would
  // have returned all 120_000 bytes, over the 100_000 inline budget.
  const content = "あ".repeat(40_000);
  const fake = makeFakeFileSystemPort(
    { "/work/wide.ts": { content, mtimeMs: 1000 } },
    { statReturnsUndefined: true },
  );
  const context = makeContext(fake);
  const output = (await searchAndReadToolEntry.handler(
    { mode: "files", glob: ".ts" },
    context,
  )) as { results: Array<{ tooLarge: boolean; truncated: boolean; content: string }> };

  assert.equal(output.results.length, 1);
  assert.equal(output.results[0].tooLarge, false);
  assert.equal(output.results[0].truncated, true);
  assert.ok(
    Buffer.byteLength(output.results[0].content, "utf8") <= 100_000,
    "byte bound enforced",
  );
  assert.ok(!output.results[0].content.includes("�"), "valid UTF-8, no split chars");
});

// ---------------------------------------------------------------------------
// ApplyPatchSet handler
// ---------------------------------------------------------------------------

test("ApplyPatchSet: all valid patches are applied", async () => {
  const fake = makeFakeFileSystemPort({
    "/work/a.ts": { content: "export const alpha = 1;\n", mtimeMs: 1000 },
    "/work/b.ts": { content: "import { alpha } from \"./a\";\n", mtimeMs: 1000 },
  });
  const context = makeContext(fake);
  const output = (await applyPatchSetToolEntry.handler(
    {
      patches: [
        { file_path: "/work/a.ts", old_string: "alpha = 1", new_string: "alpha = 10" },
        { file_path: "/work/b.ts", old_string: "{ alpha }", new_string: "{ alpha as alphaRenamed }" },
      ],
    },
    context,
  )) as { ok: boolean; applied: number; total: number; results: Array<{ ok: boolean }> };

  assert.equal(output.ok, true);
  assert.equal(output.applied, 2);
  assert.equal(output.total, 2);
  assert.equal(fake.writes.length, 2);
  assert.ok(fake.writes[0].content.includes("alpha = 10"));
  assert.ok(fake.writes[1].content.includes("alphaRenamed"));
});

test("ApplyPatchSet: one bad patch => atomic, nothing written", async () => {
  const fake = makeFakeFileSystemPort({
    "/work/a.ts": { content: "export const alpha = 1;\n", mtimeMs: 1000 },
    "/work/b.ts": { content: "import { alpha } from \"./a\";\n", mtimeMs: 1000 },
  });
  const context = makeContext(fake);
  const output = (await applyPatchSetToolEntry.handler(
    {
      patches: [
        { file_path: "/work/a.ts", old_string: "alpha = 1", new_string: "alpha = 10" },
        { file_path: "/work/b.ts", old_string: "does not exist", new_string: "nope" },
      ],
    },
    context,
  )) as { ok: boolean; applied: number; results: Array<{ ok: boolean; errorCode?: string; message?: string }> };

  assert.equal(output.ok, false);
  assert.equal(output.applied, 0);
  assert.equal(fake.writes.length, 0);
  assert.equal(output.results[0].ok, false);
  assert.equal(output.results[1].ok, false);
  assert.ok(output.results[1].errorCode);
});

test("ApplyPatchSet: duplicate target paths rejected, nothing written", async () => {
  const fake = makeFakeFileSystemPort({
    "/work/a.ts": { content: "export const alpha = 1;\n", mtimeMs: 1000 },
  });
  const context = makeContext(fake);
  const output = (await applyPatchSetToolEntry.handler(
    {
      patches: [
        { file_path: "/work/a.ts", old_string: "alpha = 1", new_string: "alpha = 10" },
        { file_path: "/work/a.ts", old_string: "alpha = 1", new_string: "alpha = 20" },
      ],
    },
    context,
  )) as {
    ok: boolean;
    applied: number;
    results: Array<{ ok: boolean; errorCode?: string }>;
  };

  assert.equal(output.ok, false);
  assert.equal(output.applied, 0);
  assert.equal(fake.writes.length, 0);
  assert.equal(context.readFileState!.size, 0);
  assert.equal(output.results.length, 2);
  for (const result of output.results) {
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "apply_patch_set_duplicate_target");
  }
});

test("ApplyPatchSet: write failure on a later patch rolls back earlier writes", async () => {
  const originalA = "export const alpha = 1;\n";
  const fake = makeFakeFileSystemPort(
    {
      "/work/a.ts": { content: originalA, mtimeMs: 1000 },
      "/work/b.ts": { content: "import { alpha } from \"./a\";\n", mtimeMs: 1000 },
    },
    { failWriteAt: [2] },
  );
  const context = makeContext(fake);
  const output = (await applyPatchSetToolEntry.handler(
    {
      patches: [
        { file_path: "/work/a.ts", old_string: "alpha = 1", new_string: "alpha = 10" },
        { file_path: "/work/b.ts", old_string: "{ alpha }", new_string: "{ alpha as renamed }" },
      ],
    },
    context,
  )) as {
    ok: boolean;
    applied: number;
    results: Array<{ ok: boolean; errorCode?: string; rolledBack?: boolean }>;
  };

  assert.equal(output.ok, false);
  assert.equal(output.applied, 0);
  // a.ts was written once, then restored once; the b.ts write failed.
  assert.equal(fake.writes.filter((w) => w.path === "/work/a.ts").length, 2);
  assert.equal(fake.writes.filter((w) => w.path === "/work/b.ts").length, 0);
  assert.equal(output.results[0].rolledBack, true);
  assert.equal(output.results[0].errorCode, undefined);
  assert.equal(output.results[1].errorCode, "apply_patch_set_write_failed");
  // File content is back to the original and no read state was stamped.
  const restored = await fake.port.readTextFile({ path: "/work/a.ts" });
  assert.equal(restored.content, originalA);
  assert.equal(context.readFileState!.size, 0);
});

test("ApplyPatchSet: failed rollback is reported, applied stays 0", async () => {
  const fake = makeFakeFileSystemPort(
    {
      "/work/a.ts": { content: "export const alpha = 1;\n", mtimeMs: 1000 },
      "/work/b.ts": { content: "import { alpha } from \"./a\";\n", mtimeMs: 1000 },
    },
    { failWriteAt: [2, 3] },
  );
  const context = makeContext(fake);
  const output = (await applyPatchSetToolEntry.handler(
    {
      patches: [
        { file_path: "/work/a.ts", old_string: "alpha = 1", new_string: "alpha = 10" },
        { file_path: "/work/b.ts", old_string: "{ alpha }", new_string: "{ alpha as renamed }" },
      ],
    },
    context,
  )) as {
    ok: boolean;
    applied: number;
    results: Array<{ ok: boolean; errorCode?: string; rolledBack?: boolean }>;
  };

  assert.equal(output.ok, false);
  assert.equal(output.applied, 0);
  assert.equal(output.results[0].rolledBack, false);
  assert.equal(output.results[0].errorCode, "apply_patch_set_rollback_failed");
  assert.equal(output.results[1].errorCode, "apply_patch_set_write_failed");
  // The partially-applied write was NOT reverted, but read state stayed clean.
  const current = await fake.port.readTextFile({ path: "/work/a.ts" });
  assert.ok(current.content.includes("alpha = 10"));
  assert.equal(context.readFileState!.size, 0);
});

test("ApplyPatchSet: successful apply stamps read state only on commit", async () => {
  const fake = makeFakeFileSystemPort({
    "/work/a.ts": { content: "export const alpha = 1;\n", mtimeMs: 1000 },
  });
  const context = makeContext(fake);
  await applyPatchSetToolEntry.handler(
    {
      patches: [{ file_path: "/work/a.ts", old_string: "alpha = 1", new_string: "alpha = 10" }],
    },
    context,
  );

  const state = context.readFileState!;
  assert.equal(state.size, 1);
  const entry = [...state.values()][0];
  assert.equal(entry.path, "/work/a.ts");
  assert.equal(entry.sourceTool, "ApplyPatchSet");
  assert.equal(entry.isPartialView, false);
});

test("permission ruleSubjects: ApplyPatchSet exposes nested patches[].file_path", () => {
  const ruleSubjects = (
    PermissionService.prototype as unknown as Record<string, (input: unknown, toolName: string) => string[]>
  ).ruleSubjects;
  const subjects = ruleSubjects.call({}, {
    patches: [
      { file_path: "/work/a.ts", old_string: "x", new_string: "y" },
      { file_path: "/work/b.ts", old_string: "x", new_string: "y" },
      { file_path: "", old_string: "x", new_string: "y" },
    ],
  }, "ApplyPatchSet");
  assert.deepEqual(subjects, ["/work/a.ts", "/work/b.ts"]);

  // Other tools keep the legacy flat extraction.
  const flat = ruleSubjects.call({}, { file_path: "/work/c.ts" }, "Edit");
  assert.deepEqual(flat, ["/work/c.ts"]);
});

test("ApplyPatchSet: dry run validates but writes nothing", async () => {
  const fake = makeFakeFileSystemPort({
    "/work/a.ts": { content: "export const alpha = 1;\n", mtimeMs: 1000 },
  });
  const context = makeContext(fake);
  const output = (await applyPatchSetToolEntry.handler(
    {
      dry_run: true,
      patches: [{ file_path: "/work/a.ts", old_string: "alpha = 1", new_string: "alpha = 10" }],
    },
    context,
  )) as { ok: boolean; dry_run: boolean; applied: number };

  assert.equal(output.ok, true);
  assert.equal(output.dry_run, true);
  assert.equal(output.applied, 0);
  assert.equal(fake.writes.length, 0);
});

test("ApplyPatchSet: dry run reports duplicate targets instead of ok", async () => {
  const fake = makeFakeFileSystemPort({
    "/work/a.ts": { content: "export const alpha = 1;\n", mtimeMs: 1000 },
  });
  const context = makeContext(fake);
  const output = (await applyPatchSetToolEntry.handler(
    {
      dry_run: true,
      patches: [
        { file_path: "/work/a.ts", old_string: "alpha = 1", new_string: "alpha = 10" },
        { file_path: "/work/a.ts", old_string: "export const", new_string: "export let" },
      ],
    },
    context,
  )) as { ok: boolean; applied: number; results: Array<{ ok: boolean; errorCode?: string }> };

  assert.equal(output.ok, false);
  assert.equal(output.applied, 0);
  assert.ok(
    output.results.every((r) => r.errorCode === "apply_patch_set_duplicate_target"),
    JSON.stringify(output.results),
  );
  assert.equal(fake.writes.length, 0);
});

test("ApplyPatchSet metadata: edit-class permission, approval required", () => {
  assert.equal(applyPatchSetToolEntry.metadata.name, "ApplyPatchSet");
  assert.equal(applyPatchSetToolEntry.metadata.readOnly, false);
  assert.equal(applyPatchSetToolEntry.metadata.needsApproval, true);
  assert.equal(applyPatchSetToolEntry.permission.permission, "edit");
  assert.equal(applyPatchSetToolEntry.permission.needsApproval, true);
  assert.deepEqual(applyPatchSetToolEntry.permission.patternSources, ["path"]);
  assert.equal(applyPatchSetToolEntry.permission.denyPriority, "beforeAsk");
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

test("isWorkflowToolEnabled: kill switch", () => {
  assert.equal(isWorkflowToolEnabled({} as NodeJS.ProcessEnv), true);
  assert.equal(isWorkflowToolEnabled({ ZCODE_WORKFLOW_TOOLS: "1" } as NodeJS.ProcessEnv), true);
  assert.equal(isWorkflowToolEnabled({ ZCODE_WORKFLOW_TOOLS: "0" } as NodeJS.ProcessEnv), false);
});

test("builtInTools: workflow tools registered by name", () => {
  const names = builtInTools.map((entry) => entry.metadata.name);
  assert.ok(names.includes("SearchAndRead"));
  assert.ok(names.includes("ApplyPatchSet"));
});

test("registerBuiltInTools: ZCODE_WORKFLOW_TOOLS=0 removes both workflow tools", () => {
  const registered: ToolEntry[] = [];
  const previous = process.env.ZCODE_WORKFLOW_TOOLS;
  process.env.ZCODE_WORKFLOW_TOOLS = "0";
  try {
    registerBuiltInTools({ register: (entry: ToolEntry) => void registered.push(entry) });
  } finally {
    if (previous === undefined) delete process.env.ZCODE_WORKFLOW_TOOLS;
    else process.env.ZCODE_WORKFLOW_TOOLS = previous;
  }
  const names = registered.map((entry) => entry.metadata.name);
  assert.ok(!names.includes("SearchAndRead"));
  assert.ok(!names.includes("ApplyPatchSet"));
  // Primitives survive the kill switch.
  assert.ok(names.includes("Grep"));
  assert.ok(names.includes("Read"));
  assert.ok(names.includes("Edit"));
});

// ---------------------------------------------------------------------------
// Tool-pack mappings
// ---------------------------------------------------------------------------

function descriptor(name: string) {
  return { name, description: "d".repeat(100), inputSchema: { pad: "x" } };
}

const WORKFLOW_BUILTINS = [
  "Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch",
  "SearchAndRead", "ApplyPatchSet",
].map(descriptor);

function keptForLabel(label: string): ReadonlySet<string> {
  const shortlist = computeToolShortlist({
    route: { tier: "balanced", confidence: 0.9, taskLabels: [label] },
    tools: WORKFLOW_BUILTINS,
  });
  return shortlist.keepNames;
}

test("tool packs: SearchAndRead kept under search/code/ops, pruned elsewhere", () => {
  assert.ok(keptForLabel("search").has("SearchAndRead"));
  assert.ok(keptForLabel("code").has("SearchAndRead"));
  assert.ok(keptForLabel("code").has("ApplyPatchSet"));
  assert.ok(keptForLabel("ops").has("SearchAndRead"));
  assert.ok(!keptForLabel("media").has("SearchAndRead"));
  assert.ok(!keptForLabel("media").has("ApplyPatchSet"));
});
