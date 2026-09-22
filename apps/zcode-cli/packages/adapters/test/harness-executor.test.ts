import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HARNESS_DRIVERS } from "@zcode/shared/harness-drivers";
import type { ModelEvent, ModelExecutionRequest } from "@zcode/contracts";
import { createHarnessExecutor } from "../src/model/harness/executor.js";
import { HarnessSessionStore } from "../src/model/harness/session-store.js";

const GRANT_ALL = { isGranted: () => true };
const DENY_ALL = { isGranted: () => false };

function stubBinary(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-stub-"));
  const path = join(dir, "fake-harness");
  writeFileSync(path, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return path;
}

function userRequest(text: string, extra?: Partial<ModelExecutionRequest>): ModelExecutionRequest {
  return {
    messages: [{ role: "user", content: text }],
    options: { reasoningLevel: "default", maxOutputTokens: 1000 },
    ...extra,
  };
}

async function drain(executor: ReturnType<typeof createHarnessExecutor>, request: ModelExecutionRequest) {
  const events: ModelEvent[] = [];
  for await (const event of executor.streamText(request)) {
    events.push(event);
  }
  return events;
}

function eventTypes(events: ModelEvent[]): string[] {
  return events.map((event) => event.type);
}

test("streams codex JSONL into text, session capture and finish", async () => {
  const binary = stubBinary(`cat <<'EOF'
{"type":"thread.started","thread_id":"thread-1"}
{"type":"turn.started"}
{"type":"item.completed","item":{"type":"agent_message","text":"Hel"}}
{"type":"item.completed","item":{"type":"agent_message","text":"lo"}}
{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}
EOF`);
  const sessions = new HarnessSessionStore();
  const executor = createHarnessExecutor({
    driver: HARNESS_DRIVERS.codex,
    sessions,
    consent: GRANT_ALL,
    binaryPath: binary,
  });
  const events = await drain(executor, userRequest("hi"));
  assert.deepEqual(eventTypes(events), [
    "start",
    "text_start",
    "text_delta",
    "text_delta",
    "text_end",
    "finish",
  ]);
  assert.equal(sessions.get("codex"), "thread-1");
  const finish = events[events.length - 1];
  assert.ok(finish.type === "finish" && finish.finishReason === "stop");
  assert.deepEqual(finish.usage, { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
});

test("routes progress frames to the reasoning channel", async () => {
  const binary = stubBinary(`echo '{"type":"item.completed","item":{"type":"command_execution","command":"ls"}}'`);
  const executor = createHarnessExecutor({
    driver: HARNESS_DRIVERS.codex,
    sessions: new HarnessSessionStore(),
    consent: GRANT_ALL,
    binaryPath: binary,
  });
  const events = await drain(executor, userRequest("hi"));
  assert.deepEqual(eventTypes(events), ["start", "reasoning_start", "reasoning_delta", "reasoning_end", "finish"]);
  const delta = events[2];
  assert.ok(delta.type === "reasoning_delta" && delta.text.includes("ran: ls"));
});

test("reuses the stored harness session for resume-capable drivers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-args-"));
  const seenPath = join(dir, "argv.txt");
  const binary = stubBinary(`echo "$@" > "${seenPath}"\necho '{"type":"turn.completed","usage":{}}'`);
  const sessions = new HarnessSessionStore();
  sessions.set("codex", "thread-9");
  const executor = createHarnessExecutor({
    driver: HARNESS_DRIVERS.codex,
    sessions,
    consent: GRANT_ALL,
    binaryPath: binary,
  });
  await drain(executor, userRequest("again"));
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(seenPath, "utf8"), /exec resume --json thread-9 again/);
});

test("denies runs without consent", async () => {
  const executor = createHarnessExecutor({
    driver: HARNESS_DRIVERS.codex,
    sessions: new HarnessSessionStore(),
    consent: DENY_ALL,
    binaryPath: "/nonexistent",
  });
  await assert.rejects(() => drain(executor, userRequest("hi")), /needs consent/);
});

test("fails clearly when the binary is missing", async () => {
  const executor = createHarnessExecutor({
    driver: HARNESS_DRIVERS.codex,
    sessions: new HarnessSessionStore(),
    consent: GRANT_ALL,
    env: { ...process.env, PATH: "/nonexistent-dir" },
  });
  await assert.rejects(() => drain(executor, userRequest("hi")), /was not found on PATH/);
});

test("fails with stderr tail on nonzero exit", async () => {
  const binary = stubBinary(`echo "auth broken" >&2\nexit 3`);
  const executor = createHarnessExecutor({
    driver: HARNESS_DRIVERS.codex,
    sessions: new HarnessSessionStore(),
    consent: GRANT_ALL,
    binaryPath: binary,
  });
  await assert.rejects(() => drain(executor, userRequest("hi")), /exited with code 3[\s\S]*auth broken/);
});

test("fails loudly on unrecognized output instead of an empty turn", async () => {
  const binary = stubBinary(`echo "hello human"\necho "more prose"`);
  const executor = createHarnessExecutor({
    driver: HARNESS_DRIVERS.codex,
    sessions: new HarnessSessionStore(),
    consent: GRANT_ALL,
    binaryPath: binary,
  });
  await assert.rejects(() => drain(executor, userRequest("hi")), /unrecognized format/);
});

test("abort stops the run without an error event", async () => {
  const binary = stubBinary(`echo '{"type":"turn.started"}'\nsleep 30`);
  const executor = createHarnessExecutor({
    driver: HARNESS_DRIVERS.codex,
    sessions: new HarnessSessionStore(),
    consent: GRANT_ALL,
    binaryPath: binary,
    timeoutMs: 60_000,
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const events = await drain(executor, userRequest("hi", { abortSignal: controller.signal }));
  assert.deepEqual(eventTypes(events), ["start"]);
});

test("timeout kills the run and reports it", async () => {
  const binary = stubBinary(`sleep 30`);
  const executor = createHarnessExecutor({
    driver: HARNESS_DRIVERS.codex,
    sessions: new HarnessSessionStore(),
    consent: GRANT_ALL,
    binaryPath: binary,
    timeoutMs: 300,
  });
  await assert.rejects(() => drain(executor, userRequest("hi")), /exceeded .*s and was stopped/);
});

test("generateText collects streamed text", async () => {
  const binary = stubBinary(`echo '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'`);
  const executor = createHarnessExecutor({
    driver: HARNESS_DRIVERS.codex,
    sessions: new HarnessSessionStore(),
    consent: GRANT_ALL,
    binaryPath: binary,
  });
  const result = await executor.generateText(userRequest("hi"));
  assert.equal(result.text, "done");
  assert.equal(result.finishReason, "stop");
});

test("usage-file drivers capture session and usage from the side-channel report", async () => {
  const binary = stubBinary(`prev=""
for a in "$@"; do
  if [ "$prev" = "--usage-file" ]; then echo '{"session_id":"h-1","input_tokens":7,"output_tokens":1}' > "$a"; fi
  prev="$a"
done
echo "Hello"
echo "world"`);
  const sessions = new HarnessSessionStore();
  const executor = createHarnessExecutor({
    driver: HARNESS_DRIVERS.hermes,
    sessions,
    consent: GRANT_ALL,
    binaryPath: binary,
  });
  const events = await drain(executor, userRequest("hi"));
  assert.equal(sessions.get("hermes"), "h-1");
  const finish = events[events.length - 1];
  assert.ok(finish.type === "finish");
  assert.deepEqual(finish.usage, { inputTokens: 7, outputTokens: 1, totalTokens: 8 });
  assert.deepEqual(finish.providerMetadata, { harnessSessionId: "h-1" });
  const result = await executor.generateText(userRequest("hi"));
  assert.equal(result.text, "Hello\nworld");
});

test("usage-file drivers still succeed when the report is missing", async () => {
  const binary = stubBinary(`echo "plain text"`);
  const sessions = new HarnessSessionStore();
  const executor = createHarnessExecutor({
    driver: HARNESS_DRIVERS.hermes,
    sessions,
    consent: GRANT_ALL,
    binaryPath: binary,
  });
  const result = await executor.generateText(userRequest("hi"));
  assert.equal(result.text, "plain text");
  assert.equal(sessions.get("hermes"), undefined);
});

test("fatal frames fail with the harness message plus stderr tail", async () => {
  const binary = stubBinary(`echo '{"type":"result","is_error":true,"result":"boom"}'
echo "traceback detail" >&2`);
  const executor = createHarnessExecutor({
    driver: HARNESS_DRIVERS["grok-local"],
    sessions: new HarnessSessionStore(),
    consent: GRANT_ALL,
    binaryPath: binary,
  });
  await assert.rejects(() => drain(executor, userRequest("hi")), /boom.*traceback detail/s);
});

test("session store holds one harness session per driver", () => {
  const store = new HarnessSessionStore();
  assert.equal(store.get("codex"), undefined);
  store.set("codex", "t-1");
  assert.equal(store.get("codex"), "t-1");
  const minted = store.getOrMint("muse");
  assert.match(minted, /^[0-9a-f-]{36}$/);
  assert.equal(store.getOrMint("muse"), minted);
  store.clear("codex");
  assert.equal(store.get("codex"), undefined);
});
