// Composed at module load from the dynamic-workflow facade so the model always
// sees the current API surface — same construction as CreateWorkflow's description.

import { FACADE_DTS } from "@zcode/dynamic-workflow";
import { SAVED_WORKFLOW_GLOBAL_DIR, SAVED_WORKFLOW_PROJECT_DIR } from "@zcode/contracts";

const INTRO = [
  "Save a dynamic-workflow script so it can be run again later by name. The required `scope` field decides where it lives.",
  `Project definitions go in \`${SAVED_WORKFLOW_PROJECT_DIR}/<name>.dwf.ts\`, committed with the repository and visible only inside it. Global definitions go in \`~/${SAVED_WORKFLOW_GLOBAL_DIR}/<name>.dwf.ts\` and are available from every project on this machine. Run either with CreateWorkflow's \`saved\` source; discover them with ListSavedWorkflows.`,
].join(" ");

/**
 * 提示策略。这段是本工具描述里**最重要**的部分，所以写在最前、用最直白的祈使句。
 *
 * 理由：保存会在用户的仓库里留下一个文件，而模型对「这个 workflow 看起来挺通用」的判断
 * 远比用户宽松。一个会自作主张保存的 agent 会在几轮对话里往 `.zcode/workflows` 里堆满
 * 半成品，而那些文件此后会出现在每一次 ListSavedWorkflows 里。所以门槛不是"别乱存"这种
 * 程度副词，而是一条硬规则：先用散文建议，等用户点头，再调用。
 */
const HINT_POLICY = [
  "When to call it — read this before you call it:",
  "- NEVER call this tool unsolicited. Saving writes a file into the user's repository; that is their decision, not yours.",
  "- When a workflow you just built looks reusable, SUGGEST it in prose first — one sentence naming what you would save and why — and stop and wait. Call SaveWorkflow only after the user agrees.",
  '- If the user asks directly ("save this workflow", "保存这个工作流"), that is agreement: call it.',
  "- Worth suggesting only when it would plausibly run again with different inputs. A one-off script tailored to a single question is not — suggesting it wastes attention and clutters the project.",
].join("\n");

const FILE_FORMAT = [
  "File format:",
  "- The saved file is valid TypeScript: a `/* zcode-workflow` block comment carrying YAML metadata, followed by the script verbatim.",
  "- `description` is required and shows wherever the workflow is listed. `whenToUse` is optional guidance for whoever picks it later — write for a reader who has not seen this conversation.",
  // 保存一份刚跑过的草稿是最常见的场景，而重新吐一遍脚本是这里唯一一笔可以省掉的大代价。
  "- `script_path` saves a working draft without re-emitting it: pass the file a CreateWorkflow or AmendWorkflow result named instead of `script` (a `/* zcode-workflow` block in that file is dropped — metadata comes from the fields here).",
  "- Saving over an existing name REPLACES it. The confirmation window says whether this is new or an overwrite — pick the name deliberately.",
].join("\n");

const ARGS = [
  "Arguments:",
  "- Declare `args` when the workflow should be reusable with different inputs. Each gives a `type` (`string`, `number`, `boolean`, or `json`), optionally `description`, `required: true`, `default`.",
  "- Declared arguments are the calling convention CreateWorkflow validates against (unknown keys, missing required values, wrong types rejected). Declare exactly what would change between runs — every argument is one more thing a future caller must get right.",
].join("\n");

const RULES = [
  "Authoring rules — same compiler and facade as CreateWorkflow, so the same rules:",
  "- Plain TypeScript with plain `interface`/`type` result types; `strict` (indexing needs no guard; `.find()`/`.match()`/optional properties still yield `T | undefined`/`null` — guard before use).",
  "- No `declare`, `export`, or `import`; no Node/web APIs (`process`, `fetch`, `fs` fail typechecking).",
  '- `phase("...")` markers exactly as CreateWorkflow requires — phase names are all a future caller gets, so write them for a stranger.',
  "- The script is typechecked BEFORE the user is asked. Compilation errors come back as diagnostics and nothing is written: fix the script and call the tool again.",
].join("\n");

export const SAVE_WORKFLOW_TOOL_DESCRIPTION = [
  INTRO,
  "",
  HINT_POLICY,
  "",
  FILE_FORMAT,
  "",
  ARGS,
  "",
  "The script is checked against these facade declarations:",
  "```ts",
  FACADE_DTS.trim(),
  "```",
  "",
  RULES,
].join("\n");
