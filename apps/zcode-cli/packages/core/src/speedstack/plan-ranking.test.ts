// Tests for speedstack/plan-ranking.ts — node:test, no external deps.
//
// Covers the Phase-3 plan-ranking surface:
// - candidate prompt asks for N marked candidates
// - candidate parsing (markers -> candidates; unparseable -> single plan)
// - rank-plans response parsing, including old-schema (no ranking key)
// - winner selection: highest score wins, ties/missing scores fail open
//   to the first candidate
// - pinned/deterministic config forces a single candidate, no ranking
// - fetch fail-open: kill switch, bad endpoint, < 2 plans
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPlannerCandidatesPrompt,
  DEFAULT_PLAN_CANDIDATE_COUNT,
  fetchSystemOnePlanRanking,
  isPlanPinned,
  MAX_PLAN_CANDIDATE_COUNT,
  parseCandidatePlans,
  parsePlanRanking,
  resolvePlanCandidateCount,
  selectRankedPlan,
  type PlanCandidate,
  type PlanRanking,
} from "./plan-ranking.ts";

const CANDIDATES: PlanCandidate[] = [
  { id: "plan_1", text: "First plan: do the simple thing." },
  { id: "plan_2", text: "Second plan: do the thorough thing." },
  { id: "plan_3", text: "Third plan: do the clever thing." },
];

function rankingPayload(entries: unknown[]): unknown {
  return {
    task: "fix the bug",
    tier: "balanced",
    ranking: entries,
  };
}

test("prompt asks for N marked candidates with the marker format", () => {
  const prompt = buildPlannerCandidatesPrompt("migrate the db", 3);
  assert.ok(prompt.includes("3 DISTINCT candidate"));
  assert.ok(prompt.includes("=== CANDIDATE k ==="));
  assert.ok(prompt.includes("Task: migrate the db"));
});

test("parseCandidatePlans splits on markers", () => {
  const text = [
    "=== CANDIDATE 1 ===",
    "1. Read the code.",
    "2. Fix it.",
    "=== CANDIDATE 2 ===",
    "1. Rewrite everything.",
    "2. Test it.",
  ].join("\n");
  const parsed = parseCandidatePlans(text);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.id, "plan_1");
  assert.ok(parsed[0]?.text.includes("Read the code."));
  assert.equal(parsed[1]?.id, "plan_2");
  assert.ok(parsed[1]?.text.includes("Rewrite everything."));
});

test("parseCandidatePlans fails open to a single plan without markers", () => {
  const parsed = parseCandidatePlans("Just one plan, no markers.");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.id, "plan_1");
  assert.equal(parsed[0]?.text, "Just one plan, no markers.");
});

test("parseCandidatePlans with one marker still yields a single plan", () => {
  const parsed = parseCandidatePlans("=== CANDIDATE 1 ===\nOnly one.");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.id, "plan_1");
});

test("parseCandidatePlans returns [] for empty input", () => {
  assert.deepEqual(parseCandidatePlans("   "), []);
});

test("selectRankedPlan picks the highest score", () => {
  const ranking: PlanRanking = {
    task: "t",
    ranking: [
      { id: "plan_1", score: 0.2 },
      { id: "plan_2", score: 0.9 },
      { id: "plan_3", score: 0.5 },
    ],
  };
  const selected = selectRankedPlan(CANDIDATES, ranking);
  assert.equal(selected?.index, 1);
  assert.equal(selected?.plan.id, "plan_2");
  assert.equal(selected?.reason, "ranked-winner");
  assert.deepEqual(selected?.rankedIds, ["plan_1", "plan_2", "plan_3"]);
});

test("selectRankedPlan breaks ties deterministically (first wins)", () => {
  const ranking: PlanRanking = {
    task: "t",
    ranking: [
      { id: "plan_1", score: 0.7 },
      { id: "plan_2", score: 0.7 },
    ],
  };
  const selected = selectRankedPlan(CANDIDATES.slice(0, 2), ranking);
  assert.equal(selected?.index, 0);
  assert.equal(selected?.reason, "ranked-winner");
});

test("selectRankedPlan fails open to the first plan on null scores", () => {
  const ranking: PlanRanking = {
    task: "t",
    ranking: [
      { id: "plan_1", score: null },
      { id: "plan_2", score: null },
    ],
  };
  const selected = selectRankedPlan(CANDIDATES.slice(0, 2), ranking);
  assert.equal(selected?.index, 0);
  assert.equal(selected?.reason, "no-usable-scores");
});

test("selectRankedPlan ignores ranking entries for unknown plan ids", () => {
  const ranking: PlanRanking = {
    task: "t",
    ranking: [
      { id: "plan_9", score: 0.99 },
      { id: "plan_1", score: 0.1 },
    ],
  };
  const selected = selectRankedPlan(CANDIDATES.slice(0, 2), ranking);
  assert.equal(selected?.index, 0);
  assert.equal(selected?.reason, "ranked-winner");
});

test("selectRankedPlan without ranking runs the first candidate", () => {
  const selected = selectRankedPlan(CANDIDATES, undefined);
  assert.equal(selected?.index, 0);
  assert.equal(selected?.reason, "no-ranking");
});

test("selectRankedPlan with a single plan is a no-op", () => {
  const selected = selectRankedPlan(CANDIDATES.slice(0, 1), undefined);
  assert.equal(selected?.reason, "single-plan");
  assert.equal(selected?.index, 0);
});

test("selectRankedPlan returns undefined with no candidates", () => {
  assert.equal(selectRankedPlan([], undefined), undefined);
});

test("parsePlanRanking parses the full shim payload", () => {
  const parsed = parsePlanRanking(
    rankingPayload([
      { id: "plan_1", score: 0.8, p_success: 0.85, cost_penalty: 0.05, est_steps: 4 },
      { id: "plan_2", score: 0.4 },
    ]),
  );
  assert.equal(parsed?.task, "fix the bug");
  assert.equal(parsed?.tier, "balanced");
  assert.equal(parsed?.ranking.length, 2);
  assert.equal(parsed?.ranking[0]?.pSuccess, 0.85);
  assert.equal(parsed?.ranking[0]?.costPenalty, 0.05);
  assert.equal(parsed?.ranking[0]?.estSteps, 4);
});

test("parsePlanRanking: old-schema responses (no ranking key) are undefined", () => {
  assert.equal(parsePlanRanking({ task: "t", route: {} }), undefined);
  assert.equal(parsePlanRanking(null), undefined);
  assert.equal(parsePlanRanking("garbage"), undefined);
  assert.equal(parsePlanRanking({ ranking: [] }), undefined);
});

test("parsePlanRanking: entries without ids are skipped, bad scores become null", () => {
  const parsed = parsePlanRanking(
    rankingPayload([
      { score: 0.9 },
      { id: "plan_1", score: "high" },
      { id: "plan_2", score: NaN },
      { id: "plan_3", score: 0.3 },
    ]),
  );
  assert.equal(parsed?.ranking.length, 3);
  assert.equal(parsed?.ranking[0]?.id, "plan_1");
  assert.equal(parsed?.ranking[0]?.score, null);
  assert.equal(parsed?.ranking[2]?.score, 0.3);
});

test("isPlanPinned honors env and config", () => {
  assert.equal(isPlanPinned({ ZCODE_PLAN_PIN: "1" }), true);
  assert.equal(isPlanPinned({ ZCODE_PLAN_PIN: "true" }), true);
  assert.equal(isPlanPinned({ ZCODE_PLAN_PIN: "0" }), false);
  assert.equal(isPlanPinned({ ZCODE_PLAN_PIN: "banana" }), false);
  assert.equal(isPlanPinned({}, { planPin: true }), true);
  assert.equal(isPlanPinned({}, { planPin: false }), false);
  assert.equal(isPlanPinned({}), false);
});

test("resolvePlanCandidateCount defaults to 2, pin forces 1", () => {
  assert.equal(resolvePlanCandidateCount({}, {}), DEFAULT_PLAN_CANDIDATE_COUNT);
  assert.equal(resolvePlanCandidateCount({ planPin: true }, {}), 1);
  assert.equal(resolvePlanCandidateCount({}, { ZCODE_PLAN_PIN: "1" }), 1);
});

test("resolvePlanCandidateCount honors env then config, capped", () => {
  assert.equal(resolvePlanCandidateCount({}, { ZCODE_PLAN_CANDIDATES: "4" }), 4);
  assert.equal(
    resolvePlanCandidateCount({ planCandidates: 3 }, { ZCODE_PLAN_CANDIDATES: "4" }),
    4,
  );
  assert.equal(resolvePlanCandidateCount({ planCandidates: 3 }, {}), 3);
  assert.equal(
    resolvePlanCandidateCount({}, { ZCODE_PLAN_CANDIDATES: "99" }),
    MAX_PLAN_CANDIDATE_COUNT,
  );
  assert.equal(
    resolvePlanCandidateCount({}, { ZCODE_PLAN_CANDIDATES: "banana" }),
    DEFAULT_PLAN_CANDIDATE_COUNT,
  );
  assert.equal(
    resolvePlanCandidateCount({}, { ZCODE_PLAN_CANDIDATES: "0" }),
    DEFAULT_PLAN_CANDIDATE_COUNT,
  );
});

test("fetchSystemOnePlanRanking honors the master kill switch", async () => {
  const result = await fetchSystemOnePlanRanking("task", CANDIDATES.slice(0, 2), {
    env: { ZCODE_SYSTEMONE: "0" },
  });
  assert.equal(result, undefined);
});

test("fetchSystemOnePlanRanking fails open on a dead endpoint", async () => {
  const result = await fetchSystemOnePlanRanking("task", CANDIDATES.slice(0, 2), {
    endpoint: "http://127.0.0.1:9/v1/systemone/rank-plans",
    timeoutMs: 500,
  });
  assert.equal(result, undefined);
});

test("fetchSystemOnePlanRanking skips < 2 plans and empty tasks", async () => {
  assert.equal(
    await fetchSystemOnePlanRanking("task", CANDIDATES.slice(0, 1)),
    undefined,
  );
  assert.equal(
    await fetchSystemOnePlanRanking("   ", CANDIDATES.slice(0, 2)),
    undefined,
  );
});
