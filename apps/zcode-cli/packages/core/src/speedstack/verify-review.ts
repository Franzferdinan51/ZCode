// ============================================================
// Speed Stack: /verify and /review builtin prompt commands
// ============================================================
//
// Prompt builders for the two new builtin slash commands. They expand into
// agent prompts (same pattern as /init): the agent does the work with its
// normal tools, so repo detection stays dynamic.

/** Build the agent prompt for /verify: build + run tests, report pass/fail. */
export function buildVerifyCommandPrompt(args: string): string {
  const scope = args.trim();
  const scopeLine = scope
    ? `Focus scope: ${scope}`
    : "Scope: the whole repository (or the current workspace).";
  return [
    "You are running ZCode's built-in /verify command.",
    "",
    scopeLine,
    "",
    "Process:",
    "1. Detect the repo's build and test commands from package.json / workspace",
    "   config (do not guess blindly; inspect first).",
    "2. Run the build, then the test suite for the scope.",
    "3. Report PASS or FAIL for each step, with the failing output quoted",
    "   when something fails. Do not fix failures unless asked — report them.",
    "4. Keep the report short: one line per step plus the failure excerpt.",
  ].join("\n");
}

/** Build the agent prompt for /review: review recent changes. */
export function buildReviewCommandPrompt(args: string): string {
  const ref = args.trim();
  const rangeLine = ref
    ? `Review changes in: ${ref}`
    : "Review uncommitted changes and the most recent commit (git status + git diff HEAD).";
  return [
    "You are running ZCode's built-in /review command.",
    "",
    rangeLine,
    "",
    "Process:",
    "1. Collect the change set (git status, git diff; use the given ref when provided).",
    "2. Review for: correctness bugs, missed edge cases, type-safety gaps,",
    "   security issues (injection, secrets, permissions), and style drift",
    "   from the repo's conventions.",
    "3. Report findings as a short list ordered by severity, each with the",
    "   file and line. Say explicitly when there is nothing worth flagging.",
    "4. Do not change code — this command only reports.",
  ].join("\n");
}
