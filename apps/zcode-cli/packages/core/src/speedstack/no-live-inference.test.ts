// Regression test for Ryan's rule: the agent-flow/policy layer (speedstack)
// must NEVER send inference requests. Model invocations happen only in the
// turn loop's model client, in direct response to a user turn — never from
// routing, budgets, tool packs, plan-execute gating, doom-loop control,
// eval, or smoke tooling. If the app isn't being used, nothing may touch
// the model server.
//
// The read-only /v1/models probe in eval/harness.ts is allowed: it sends no
// completions and is gated behind ZCODE_EVAL_LIVE=1 (opt-in).
//
// Run: tsx --test src/speedstack/no-live-inference.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Inference endpoints that must never appear in speedstack source.
const FORBIDDEN = ["chat/completions", "/v1/embeddings"];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "dist" || entry === "node_modules") continue;
      yield* walk(full);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      yield full;
    }
  }
}

describe("no live inference from speedstack", () => {
  it("no inference endpoint references in speedstack source", () => {
    const offenders: string[] = [];
    for (const file of walk(here)) {
      const text = readFileSync(file, "utf8");
      for (const needle of FORBIDDEN) {
        if (text.includes(needle)) offenders.push(`${file}: contains ${JSON.stringify(needle)}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("eval smoke probe stays opt-in behind ZCODE_EVAL_LIVE", () => {
    const text = readFileSync(join(here, "eval", "harness.ts"), "utf8");
    assert.ok(
      text.includes('process.env.ZCODE_EVAL_LIVE === "1"'),
      "harness.ts must gate the live model-server probe behind ZCODE_EVAL_LIVE=1",
    );
  });
});
