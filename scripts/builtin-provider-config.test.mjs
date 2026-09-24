import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(repoRoot, "config/provider/zcode-builtin.json");

const doc = JSON.parse(await readFile(configPath, "utf8"));
const templates = doc.config.providerConfigRules.templateRules;
const modelRules = doc.config.modelConfigRules.templateModelRules;

function metaTemplate() {
  const t = templates.find((entry) => entry.templateId === "meta");
  assert.ok(t, "meta template must exist in the built-in provider config");
  return t;
}

test("meta template routes Muse calls through the official Model API Responses endpoint", () => {
  const meta = metaTemplate();
  // Official integration per dev.meta.ai/docs/sdks and /docs/coding-agents:
  // drive Muse Spark over the Responses API via the OpenAI/AI-SDK provider.
  // Chat Completions rejects reasoning-model params (stop, logit_bias,
  // logprobs) with HTTP 400 and drops cross-turn reasoning; Responses keeps
  // tool calling, streaming, structured output, and reasoning replay.
  assert.equal(meta.config.api.type, "openai-responses");
  assert.equal(meta.config.api.baseUrl, "https://api.meta.ai/v1");
});

test("meta template points API key management at the current developer console", () => {
  const meta = metaTemplate();
  assert.equal(meta.config.access.type, "api-key");
  assert.equal(meta.config.access.apiKeyManagementUrl, "https://dev.meta.ai/");
});

test("meta template lists current Muse Spark models", () => {
  const meta = metaTemplate();
  assert.ok(
    meta.config.builtinModelIds.includes("muse-spark-1.3"),
    "muse-spark-1.3 must be offered by the meta template",
  );
});

test("muse-spark-1.3 stays enabled with tool-call and structured-output support", () => {
  const rule = modelRules.find(
    (entry) => entry.templateId === "meta" && entry.modelId === "muse-spark-1.3",
  );
  assert.ok(rule, "muse-spark-1.3 model rule must exist");
  assert.equal(rule.config.enabled, true);
  assert.equal(rule.config.properties.supportsToolCall, true);
  assert.equal(rule.config.properties.supportsJsonSchemaOutput, true);
});

test("built-in config revision is a positive integer", () => {
  assert.ok(Number.isInteger(doc.revision) && doc.revision > 0);
});
