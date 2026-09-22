import assert from "node:assert/strict";
import test from "node:test";
import {
  HARNESS_DRIVERS,
  getHarnessDriver,
  requireHarnessDriver,
  type HarnessDriverId,
  type HarnessFrame,
} from "../src/harness-drivers.js";

function runAll(id: HarnessDriverId, lines: string[]): HarnessFrame[] {
  const parser = HARNESS_DRIVERS[id].createParser();
  return lines.flatMap((line) => parser.push(line));
}

function kinds(frames: HarnessFrame[]): string[] {
  return frames.map((frame) => frame.kind);
}

test("driver registry covers the eight headless-capable harnesses", () => {
  const ids = (Object.keys(HARNESS_DRIVERS) as HarnessDriverId[]).sort();
  assert.deepEqual(ids, [
    "claude",
    "codex",
    "gemini",
    "grok-local",
    "hermes",
    "mcode",
    "muse",
    "opencode",
  ]);
  assert.equal(HARNESS_DRIVERS.codex.binary, "codex");
  assert.equal(HARNESS_DRIVERS.claude.binary, "claude");
  assert.equal(HARNESS_DRIVERS.gemini.binary, "gemini");
  assert.equal(HARNESS_DRIVERS.opencode.binary, "opencode");
  assert.equal(HARNESS_DRIVERS.muse.binary, "muse");
  assert.equal(HARNESS_DRIVERS["grok-local"].binary, "grok-local");
  assert.equal(HARNESS_DRIVERS.mcode.binary, "mcode");
  assert.equal(HARNESS_DRIVERS.hermes.binary, "hermes");
  assert.equal(getHarnessDriver("codex")?.id, "codex");
  assert.equal(getHarnessDriver("nope"), undefined);
  assert.equal(requireHarnessDriver("muse").id, "muse");
  assert.throws(() => requireHarnessDriver("nope"), /Unknown harness driver: nope/);
});

test("arg builders match each CLI's verified headless invocation", () => {
  assert.deepEqual(HARNESS_DRIVERS.codex.buildArgs({ prompt: "hi" }), ["exec", "--json", "hi"]);
  assert.deepEqual(HARNESS_DRIVERS.codex.buildArgs({ prompt: "hi", resumeSessionId: "t1" }), [
    "exec",
    "resume",
    "--json",
    "t1",
    "hi",
  ]);
  assert.deepEqual(HARNESS_DRIVERS.claude.buildArgs({ prompt: "hi" }), [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "hi",
  ]);
  assert.deepEqual(HARNESS_DRIVERS.claude.buildArgs({ prompt: "hi", resumeSessionId: "s1" }), [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--resume",
    "s1",
    "hi",
  ]);
  assert.deepEqual(HARNESS_DRIVERS.gemini.buildArgs({ prompt: "hi" }), [
    "--output-format",
    "stream-json",
    "-p",
    "hi",
  ]);
  assert.deepEqual(HARNESS_DRIVERS.opencode.buildArgs({ prompt: "hi" }), [
    "run",
    "--format",
    "json",
    "hi",
  ]);
  assert.deepEqual(HARNESS_DRIVERS.opencode.buildArgs({ prompt: "hi", resumeSessionId: "ses_1" }), [
    "run",
    "--session",
    "ses_1",
    "--format",
    "json",
    "hi",
  ]);
  assert.deepEqual(HARNESS_DRIVERS.muse.buildArgs({ prompt: "hi", resumeSessionId: "uuid-1" }), [
    "exec",
    "--json",
    "--session-id",
    "uuid-1",
    "hi",
  ]);
  assert.throws(() => HARNESS_DRIVERS.muse.buildArgs({ prompt: "hi" }), /session id/);
  assert.deepEqual(HARNESS_DRIVERS["grok-local"].buildArgs({ prompt: "hi" }), [
    "-p",
    "hi",
    "--output-format",
    "streaming-messages-json",
  ]);
  assert.deepEqual(
    HARNESS_DRIVERS["grok-local"].buildArgs({ prompt: "hi", resumeSessionId: "s1" }),
    ["-r", "s1", "-p", "hi", "--output-format", "streaming-messages-json"],
  );
  assert.deepEqual(HARNESS_DRIVERS.mcode.buildArgs({ prompt: "hi" }), [
    "exec",
    "--output-format",
    "stream-json",
    "hi",
  ]);
  assert.deepEqual(HARNESS_DRIVERS.mcode.buildArgs({ prompt: "hi", resumeSessionId: "mvs_1" }), [
    "exec",
    "--session",
    "mvs_1",
    "--output-format",
    "stream-json",
    "hi",
  ]);
  assert.deepEqual(HARNESS_DRIVERS.hermes.buildArgs({ prompt: "hi" }), ["-z", "hi"]);
  assert.deepEqual(HARNESS_DRIVERS.hermes.buildArgs({ prompt: "hi", resumeSessionId: "s1" }), [
    "--resume",
    "s1",
    "-z",
    "hi",
  ]);
});

test("codex parser handles a real successful run", () => {
  const frames = runAll("codex", [
    '{"type":"thread.started","thread_id":"thread-1"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"skills note"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"PONG"}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
  ]);
  assert.deepEqual(kinds(frames), ["session", "progress", "text", "usage", "done"]);
  const session = frames[0];
  assert.equal(session.kind === "session" && session.id, "thread-1");
  const text = frames[2];
  assert.equal(text.kind === "text" && text.delta, "PONG");
});

test("codex parser reports tool activity and failed turns", () => {
  const frames = runAll("codex", [
    '{"type":"item.completed","item":{"type":"command_execution","command":"ls","status":"completed"}}',
    '{"type":"item.completed","item":{"type":"file_change","path":"a.ts"}}',
    '{"type":"turn.failed","message":"boom"}',
  ]);
  assert.equal(frames.length, 3);
  assert.match(
    frames[0].kind === "progress" ? frames[0].text : "",
    /ran: ls/,
  );
  assert.match(
    frames[1].kind === "progress" ? frames[1].text : "",
    /edited: a\.ts/,
  );
  const error = frames[2];
  assert.ok(error.kind === "error" && error.fatal && error.message === "boom");
});

test("claude parser handles init, assistant deltas and results", () => {
  const frames = runAll("claude", [
    '{"type":"system","subtype":"init","session_id":"sess-9","cwd":"/tmp"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Hel"},{"type":"text","text":"lo"}]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"Hello","usage":{"input_tokens":5,"output_tokens":1}}',
  ]);
  assert.deepEqual(kinds(frames), ["session", "text", "text", "progress", "usage", "done"]);
});

test("claude parser surfaces harness failures and skips hook noise", () => {
  const frames = runAll("claude", [
    '{"type":"system","subtype":"hook_started","session_id":"sess-9"}',
    '{"type":"result","subtype":"success","is_error":true,"result":"bad model (404)"}',
  ]);
  assert.deepEqual(kinds(frames), ["session", "error"]);
  const error = frames[1];
  assert.ok(error.kind === "error" && error.fatal);
});

test("gemini parser follows the upstream stream-json schema", () => {
  const frames = runAll("gemini", [
    '{"type":"init","timestamp":"t","session_id":"g-1","model":"m"}',
    '{"type":"message","timestamp":"t","role":"assistant","content":"Hi","delta":true}',
    '{"type":"tool_use","timestamp":"t","tool_name":"read","tool_id":"1","parameters":{}}',
    '{"type":"tool_result","timestamp":"t","tool_id":"1","status":"success","output":"ok"}',
    '{"type":"error","timestamp":"t","severity":"warning","message":"slow"}',
    '{"type":"result","timestamp":"t","status":"success","stats":{"input_tokens":3,"output_tokens":1}}',
  ]);
  assert.deepEqual(kinds(frames), [
    "session",
    "text",
    "progress",
    "progress",
    "progress",
    "usage",
    "done",
  ]);
});

test("gemini parser reports failed results", () => {
  const frames = runAll("gemini", [
    '{"type":"result","timestamp":"t","status":"error","error":{"type":"auth","message":"nope"}}',
  ]);
  assert.deepEqual(kinds(frames), ["error"]);
});

test("opencode parser handles text, reasoning, tools and errors", () => {
  const frames = runAll("opencode", [
    '{"type":"text","timestamp":1,"sessionID":"ses_1","part":{"type":"text","text":"Hi"}}',
    '{"type":"reasoning","timestamp":2,"sessionID":"ses_1","part":{"type":"reasoning","text":"hmm"}}',
    '{"type":"tool_use","timestamp":3,"sessionID":"ses_1","part":{"type":"tool","tool":"bash"}}',
    '{"type":"step_start","timestamp":4,"sessionID":"ses_1","part":{}}',
  ]);
  assert.deepEqual(kinds(frames), ["session", "text", "progress", "progress"]);
  const errors = runAll("opencode", [
    '{"type":"error","timestamp":5,"sessionID":"ses_1","error":{"message":"quota out"}}',
  ]);
  assert.deepEqual(kinds(errors), ["session", "error"]);
});

test("muse parser streams deltas and dedupes the terminal repeat", () => {
  const frames = runAll("muse", [
    '{"stream":{"kind":"session","id":"ms-1"},"payload_type":"run.output.delta","payload":{"text":"PO"}}',
    '{"stream":{"kind":"session","id":"ms-1"},"payload_type":"run.output.delta","payload":{"text":"NG"}}',
    '{"stream":{"kind":"session","id":"ms-1"},"payload_type":"run.terminal.completed","payload":{"terminal":"completed","text":"PONG"}}',
  ]);
  assert.deepEqual(kinds(frames), ["session", "text", "text", "done"]);
  const terminalOnly = runAll("muse", [
    '{"stream":{"kind":"session","id":"ms-2"},"payload_type":"run.terminal.completed","payload":{"terminal":"completed","text":"late"}}',
  ]);
  assert.deepEqual(kinds(terminalOnly), ["session", "text", "done"]);
});

test("grok-local parser handles init, assistant blocks and results", () => {
  const frames = runAll("grok-local", [
    '{"type":"system","subtype":"init","session_id":"gl-1","model":"ornith-1.5-9b"}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"let me think"},{"type":"text","text":"WORLD"}]}}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"read_file"}]}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"WORLD","usage":{"input_tokens":14365,"output_tokens":28}}',
  ]);
  assert.deepEqual(kinds(frames), [
    "session",
    "progress",
    "text",
    "progress",
    "usage",
    "done",
  ]);
  const usage = frames[4];
  assert.ok(
    usage.kind === "usage" && usage.inputTokens === 14365 && usage.outputTokens === 28,
  );
});

test("grok-local parser surfaces failed results", () => {
  const frames = runAll("grok-local", [
    '{"type":"result","subtype":"success","is_error":true,"result":"model overloaded"}',
  ]);
  assert.deepEqual(kinds(frames), ["error"]);
  assert.ok(frames[0].kind === "error" && frames[0].fatal);
  const objectResult = runAll("grok-local", [
    '{"type":"result","is_error":true,"result":{"message":"bad request"}}',
  ]);
  assert.ok(
    objectResult[0].kind === "error" && objectResult[0].message === "bad request",
  );
  const topLevel = runAll("grok-local", [
    '{"type":"error","message":"context exceeded"}',
  ]);
  assert.deepEqual(kinds(topLevel), ["error"]);
  assert.ok(topLevel[0].kind === "error" && topLevel[0].fatal);
});

test("mcode parser streams item deltas and dedupes completion summaries", () => {
  const frames = runAll("mcode", [
    '{"schemaVersion":1,"sequence":1,"sessionId":"mvs_1","turnId":"t1","type":"exec.started"}',
    '{"schemaVersion":1,"sequence":2,"sessionId":"mvs_1","turnId":"t1","type":"turn.started"}',
    '{"schemaVersion":1,"sequence":3,"sessionId":"mvs_1","turnId":"t1","type":"item.started","item":{"id":"a:reasoning","type":"reasoning","contentDelta":"hmm"}}',
    '{"schemaVersion":1,"sequence":4,"sessionId":"mvs_1","turnId":"t1","type":"item.updated","item":{"id":"b:message","type":"agent_message","contentDelta":"PI"}}',
    '{"schemaVersion":1,"sequence":5,"sessionId":"mvs_1","turnId":"t1","type":"item.updated","item":{"id":"b:message","type":"agent_message","contentDelta":"NG"}}',
    '{"schemaVersion":1,"sequence":6,"sessionId":"mvs_1","turnId":"t1","type":"item.completed","item":{"id":"b:message","type":"agent_message","content":"PING"}}',
    '{"schemaVersion":1,"sequence":7,"sessionId":"mvs_1","turnId":"t1","type":"turn.completed","usage":{"inputTokens":14031,"outputTokens":31}}',
    '{"schemaVersion":1,"sequence":8,"sessionId":"mvs_1","turnId":"t1","type":"exec.completed","result":{"type":"exec.result","status":"succeeded","output":"PING","usage":{"inputTokens":14031,"outputTokens":31}}}',
  ]);
  assert.deepEqual(kinds(frames), [
    "session",
    "progress",
    "text",
    "text",
    "usage",
    "usage",
    "done",
  ]);
  const text = frames
    .filter((frame) => frame.kind === "text")
    .map((frame) => (frame.kind === "text" ? frame.delta : ""))
    .join("");
  assert.equal(text, "PING");
});

test("mcode parser emits completion-only output and reports failures", () => {
  const completedOnly = runAll("mcode", [
    '{"schemaVersion":1,"type":"exec.result","sessionId":"mvs_2","status":"succeeded","output":"late","usage":{"inputTokens":1,"outputTokens":1}}',
  ]);
  assert.deepEqual(kinds(completedOnly), ["session", "text", "usage", "done"]);
  const failed = runAll("mcode", [
    '{"schemaVersion":1,"sessionId":"mvs_3","type":"turn.failed","status":"failed","error":{"category":"runtime","message":"invalid api key"}}',
  ]);
  assert.deepEqual(kinds(failed), ["session", "error"]);
  assert.ok(failed[1].kind === "error" && failed[1].fatal);
});

test("hermes parser passes final text through and parses usage reports", () => {
  const frames = runAll("hermes", ["Hello", "", "world"]);
  assert.deepEqual(kinds(frames), ["text", "text", "text"]);
  assert.equal(
    frames
      .map((frame) => (frame.kind === "text" ? frame.delta : ""))
      .join(""),
    "Hello\n\nworld",
  );
  const parse = HARNESS_DRIVERS.hermes.usageFile?.parseReport;
  assert.ok(parse);
  assert.deepEqual(parse({ session_id: "s-1", input_tokens: 10, output_tokens: 3 }), {
    sessionId: "s-1",
    inputTokens: 10,
    outputTokens: 3,
  });
  assert.deepEqual(parse(null), {});
  assert.deepEqual(parse({ session_id: 42 }), {});
});

test("parsers never throw on garbage and truncate long progress", () => {
  for (const id of Object.keys(HARNESS_DRIVERS) as HarnessDriverId[]) {
    // Hermes one-shot prints only final text: every line is content, so the
    // passthrough parser is exempt from JSON garbage-skipping by design.
    if (id === "hermes") continue;
    const frames = runAll(id, ["", "   ", "not json", "[1,2,3]", '{"type":null}', "null"]);
    assert.deepEqual(frames, [], `${id} must skip garbage silently`);
  }
  const long = "x".repeat(2000);
  const frames = runAll("codex", [
    `{"type":"item.completed","item":{"type":"error","message":"${long}"}}`,
  ]);
  assert.equal(frames.length, 1);
  const first = frames[0];
  assert.ok(first.kind === "progress" && first.text.length <= 501);
});
