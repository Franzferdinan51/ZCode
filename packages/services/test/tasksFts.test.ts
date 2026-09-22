import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildTasksFtsQuery, ensureTasksFts } from "../src/session/tasksFts.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

test("buildTasksFtsQuery quotes terms and punts CJK to LIKE", () => {
  assert.equal(buildTasksFtsQuery("  "), null);
  assert.equal(buildTasksFtsQuery(""), null);
  assert.equal(buildTasksFtsQuery("中文搜索"), null);
  assert.equal(buildTasksFtsQuery("mixed 中文 query"), null);
  assert.equal(buildTasksFtsQuery("refund invoice"), '"refund" AND "invoice"');
  // Quotes/control chars cannot break out of the quoted term.
  assert.equal(buildTasksFtsQuery('a"b OR c'), '"ab" AND "OR" AND "c"');
});

test("task search uses the FTS index and matches title or body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-tasks-fts-"));
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  try {
    await repo.syncTaskMeta({
      meta: {
        taskId: "t-refund",
        traceId: "trace-1",
        title: "Duplicate charge on invoice",
        workspacePath: "/example/workspace",
        createdAt: 1,
        updatedAt: 2,
        mode: "build",
      },
      searchableText: "customer billed twice for March, please refund the duplicate",
    });
    await repo.syncTaskMeta({
      meta: {
        taskId: "t-unrelated",
        traceId: "trace-2",
        title: "Weekend hiking plans",
        workspacePath: "/example/workspace",
        createdAt: 3,
        updatedAt: 4,
        mode: "build",
      },
      searchableText: "trail map and lunch menu",
    });

    const scopes = [{ workspacePath: "/example/workspace" }];
    const bodyHit = await repo.queryTaskList({
      kind: "timeline",
      workspaceScopes: scopes,
      sortBy: "updated",
      search: "refund duplicate",
    });
    assert.equal(bodyHit.total, 1);
    assert.equal(bodyHit.items[0]?.taskId, "t-refund");

    const titleHit = await repo.queryTaskList({
      kind: "timeline",
      workspaceScopes: scopes,
      sortBy: "updated",
      search: "invoice",
    });
    assert.equal(titleHit.total, 1);
    assert.equal(titleHit.items[0]?.taskId, "t-refund");

    const miss = await repo.queryTaskList({
      kind: "timeline",
      workspaceScopes: scopes,
      sortBy: "updated",
      search: "quarterly earnings",
    });
    assert.equal(miss.total, 0);

    // CJK still works via the LIKE fallback path.
    const cjk = await repo.queryTaskList({
      kind: "timeline",
      workspaceScopes: scopes,
      sortBy: "updated",
      search: "中文",
    });
    assert.equal(cjk.total, 0);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureTasksFts backfills pre-index rows via the rebuild marker", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const dir = await mkdtemp(join(tmpdir(), "zcode-tasks-fts-rebuild-"));
  try {
    // Seed rows through the repo (creates schema + FTS), then simulate a
    // pre-index database by dropping the FTS table and re-running ensure.
    const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
    await repo.syncTaskMeta({
      meta: {
        taskId: "t-old",
        traceId: "trace-1",
        title: "Legacy row title",
        workspacePath: "/example/workspace",
        createdAt: 1,
        updatedAt: 2,
        mode: "build",
      },
      searchableText: "legacy row body text",
    });
    repo.close();
    const raw = new DatabaseSync(join(dir, "tasks.sqlite"));
    try {
      raw.exec("DROP TABLE tasks_fts");
      assert.equal(ensureTasksFts(raw), true);
      const row = raw
        .prepare("SELECT COUNT(1) AS total FROM tasks_fts WHERE tasks_fts MATCH '\"legacy\"'")
        .get() as { total: number };
      assert.equal(row.total, 1);
    } finally {
      raw.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
