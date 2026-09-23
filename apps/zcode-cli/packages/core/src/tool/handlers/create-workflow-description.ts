// Composed at module load from the dynamic-workflow facade so the model always
// sees the current API surface.

import { FACADE_DTS } from "@zcode/dynamic-workflow";
import { SAVED_WORKFLOW_PROJECT_DIR, WORKFLOW_DRAFTS_DIR } from "@zcode/contracts";

const INTRO = [
  "Create and run a dynamic workflow: a TypeScript script, written against the facade below, that orchestrates multiple model-driven subagents with plain control flow (loops, conditionals, fan-out) and typed intermediate results.",
  "Typechecked first; on a clean compile the user confirms, then the run starts in the background \u2014 you are notified with the final return value when it settles. Compilation errors come back as diagnostics: fix and resubmit.",
].join(" ");

/**
 * 三条来源。写在 WHEN_TO_USE 之前，因为「先看看有没有现成的」是模型在写第一行脚本之前就
 * 该做的判断——放在后面它已经开始写了。
 *
 * 两句「回路」紧跟其后：模型默认会把改过的
 * 脚本整段重贴，而那正是这个特性要消灭的三笔代价——两万 token 重流一遍（有的 provider 直接卡
 * 死在上面）、被 compaction 丢掉的脚本、以及为了改一行而重新生成整段。
 */
const SOURCES = [
  "Three ways to pass the workflow \u2014 exactly one:",
  "- `script`: a one-off you write inline.",
  `- \`saved\`: a saved project workflow (\`${SAVED_WORKFLOW_PROJECT_DIR}/\`) by name \u2014 \`saved: { name: "pr-review", args: { pr: "123" } }\`.`,
  `- \`path\`: a script file on disk, relative or absolute \u2014 normally the file a previous result named. Pass \`args\` alongside when the file declares them in a \`/* zcode-workflow\` block.`,
  "",
  `An inline \`script\` is saved under \`${WORKFLOW_DRAFTS_DIR}/\` and the result names it either way \u2014 after that, EDIT that file and resubmit with \`path\`. Never paste the script twice: resubmitting 20k tokens is slow and some providers stall on it.`,
  "Before writing from scratch, try ListSavedWorkflows: a saved workflow that fits beats rebuilding \u2014 it is the version the user reviewed and kept, and `saved.args` are validated against its declared arguments before anything runs.",
  "The user confirms the run either way, seeing the actual script. This tool starts a NEW workflow \u2014 to change an existing run (errored, completed, or running and going wrong), call AmendWorkflow with the run\u2019s ID instead of CreateWorkflow again: it stops a running predecessor, reuses untouched finished results at no token cost, and skips reconfirmation for this session\u2019s own runs.",
].join("\n");

/**
 * 工作流只能由 `/workflow` 或明确请求发起，模型不得自行决定开一条。
 * 不能把「多子代理 + 确定性控制流」也列为适用场景——那等于给了模型一条自选入口：
 * 一次编排需求就可能在用户没开口时变成一条要确认、要跑很久的 run。
 */
const WHEN_TO_USE = [
  "When to use:",
  '- The user explicitly asks for a workflow — "use a workflow", "with a workflow", "使用 workflow", "用工作流", or any phrasing that names workflow/工作流 as the means: this tool is mandatory. Do not substitute the Agent/Task subagent tools, do not do the work inline yourself, and do not judge the task too small for a workflow — the user chose the tool, and that choice is theirs. Size only decides how many subagents the script gets, never whether it is written.',
  "- Without such an explicit request, do not start a workflow: delegate with the Agent tool or do the work yourself, even for multi-step or multi-subagent tasks.",
].join("\n");

const RULES = [
  "Authoring rules:",
  "- Plain TypeScript. Define result types with a plain `interface`/`type` and pass them as `ask<T>` type arguments.",
  "- Compiled under `strict` (noUncheckedIndexedAccess off): `items[i]` needs no guard, but `.find()`, `.match()`, `Map.get()` and optional properties still yield `T | undefined`/`null` \u2014 guard before use.",
  "- No `declare` and no `export`: the script compiles inside a function body (ambient declarations are illegal there), and its output is the final `return`.",
  "- Top-level `await` and a final `return` are allowed; the returned value is exactly what your completion notification carries.",
  "- No `import` statements. No Node/web APIs: `process`, `fetch`, `fs` do not exist and fail typechecking.",
  "- `world.run` executes a real command as a compile-time string literal \u2014 interpolate runtime values into the args array, never into the command name. A nonzero exit comes back as `{ exitCode, stdout, stderr }`, not an exception: branch on `exitCode`. Default timeout 300s, override per call with `timeoutMs`; spawn failures, timeouts, and stdout/stderr over 256KB each reject.",
  "- Choose the gate from the repository, not from habit: find the checks the project already defines (package.json scripts, a Makefile, CI, the README\u2019s verify command) and let the strongest one the request implies run at least once before the final `return`, with the `timeoutMs` it needs. A check that exists and was skipped is unverified work \u2014 say so in the report, not `notCovered`.",
  "- Verify in proportion to what a wrong claim costs: findings the user will act on get an independent confirmer or a deciding `world.run`; creative or subjective output gets at most one independent read. A gate suite runs once, by the script \u2014 say so in the asks so subagents do not each rerun it.",
  "- `Promise.all` only where the next step needs every item. For one-to-one stages (a reviewer per file), chain inside the fan-out callback and join once at the end, so confirmation starts as each result lands instead of after the slowest item.",
  "- Test fixed logic (parsers, glob patterns, gate predicates) with `EvalWorkflowSnippet` before submitting: a passing snippet pastes into the workflow verbatim.",
  "- The final `return` is the report the main agent hands back: conclusion, findings with evidence and confirmation status, what was verified and how, what was not covered \u2014 a report shape, not a bare array. The dynamic-workflows skill carries the interface to copy.",
  "- Publish user-facing deliverables with `artifact.*`: files subagents wrote, markdown you composed, or dashboards declared once at the top and fed by `report()`. Mark one `primary: true` per run. Ids and report tags are compile-time literals. A publish that rejects (missing file, too large) is the moment to hand the gap back to a subagent.",
  "- The final `return` stays the model-facing result; artifacts are the user-facing deliverable \u2014 never the same content in both.",
  "- Model-side errors never reach the script: the runtime retries rate limits, overload, network errors and timeouts without limit while adapting fan-out; deterministic failures (expired sign-in, model not in plan, quota cap, invalid request) stop the run as `stopped` for the user to fix and resume. So no retry loops or `try`/`catch` for provider errors \u2014 reserve them for logic failures (a subagent result that failed validation, a gate that did not pass, a world read over its cap, an artifact publish whose source file is missing, or a `ContextLimit`: split the work or send less).",
  "- Concurrency is the runtime\u2019s decision, not the script\u2019s. Set `max_concurrency` only when the user asks to limit parallelism \u2014 never in response to provider errors.",
  "- `subagent_model` moves only the workflow\u2019s subagents (ListModels lists what this host has configured); you stay on the session model either way. Set it only when the user asks.",
  "- On diagnostics, edit the file the result names and call the tool again with `path`; never paste the script a second time.",
].join("\n");

const PHASES = [
  "Phases — required in every script, not optional:",
  '- Cover the whole script with `phase("...")` markers, one at the head of each stage, top to bottom. The confirmation graph the user approves draws one node per phase; without markers they get one card per step and no story. That graph is the user\'s entire experience of a workflow — supplying phases is part of writing one.',
  '- Name each phase for the user, in the language the user is speaking in this session: a short natural phrase saying what this stage accomplishes ("Research each changed file in parallel", "汇总并产出最终报告"). Orchestration vocabulary the user never chose — "fan-out", "gate", "aggregate" — is not a phase name; the user approves stages by what they do. Say it the way you would tell a colleague what is happening: "Check that the tests still pass" / "确认测试仍然通过", not "Gate: test verification" / "执行测试验证任务".',
  "- Mechanics: the name must be a compile-time string literal (no interpolation), and the call must be a standalone statement — the marker claims the rest of its enclosing block, nested blocks and inlined helper calls included, so a marker inside an `if` covers that branch only. Two markers with the same name are one phase, which is how a retry loop stays two nodes instead of per-round sprawl.",
  "- Every phase must contain at least one subagent `ask` or one `world.run`. A phase is a stage the user can watch progress through; plain script logic between two asks — reading `args`, shaping a prompt, building the final `return` — runs in a flash and shows no progress, so it is not a stage. Fold that logic into the phase before or after it. Do not open a phase for the setup at the top or the `return` at the bottom.",
].join("\n");

/**
 * 子代理名的命名规则。图精炼（模型事后改名的侧路调用）已撤回，图上的名字只剩脚本里的原词，
 * 所以可读性要在写脚本时一次到位——阶段名早有这条规则，这里推广到 `agent("…")`。
 */
const NAMES = [
  "Subagent names:",
  '- The confirmation graph draws one card per subagent, and the card text is the name you pass to `agent("...")`. Write it for the user, in the language the user is speaking in this session: a short concrete phrase saying what that subagent does in this script ("代码评审员", "Benchmark runner") — the way a colleague would refer to that role. A variable-style token or a number ("w1", "planner_2", "节点3", "子代理A") says nothing to the user.',
  "- A name is also an identity: it must be unique within the run, and a revised re-run matches its cached results by it. Keep names stable across revisions of the same script, and give duplicates in a loop their own computed names (see the facade).",
].join("\n");

export const CREATE_WORKFLOW_TOOL_DESCRIPTION = [
  INTRO,
  "",
  SOURCES,
  "",
  WHEN_TO_USE,
  "",
  "The script is checked against these facade declarations:",
  "```ts",
  FACADE_DTS.trim(),
  "```",
  "",
  RULES,
  "",
  PHASES,
  "",
  NAMES,
].join("\n");
