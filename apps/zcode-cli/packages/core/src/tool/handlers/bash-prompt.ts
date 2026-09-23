export function createBashProviderDescription(input: {
  defaultTimeoutMs: number;
  embeddedSearchEnabled?: boolean;
  maxTimeoutMs: number;
}): string {
  const avoidCommands = input.embeddedSearchEnabled
    ? "`cat`, `head`, `tail`, `sed`, `awk`, or `echo`"
    : "`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo`";

  return [
    "Executes a bash command and returns its output.",
    "",
    "- Prefer absolute paths; `cd` in a compound command can trigger a permission prompt. Working directory persists between calls, but shell state (env vars, functions) does not — the shell is initialized from the user's profile.",
    `- IMPORTANT: do not run ${avoidCommands} here — a dedicated tool (Glob, Grep, Read) does it better and integrates with the permission UI. Use Bash only after verifying no dedicated tool can do the task.`,
    "- `timeout` is in milliseconds: default ${input.defaultTimeoutMs}, max ${input.maxTimeoutMs}.",
    "- `run_in_background` runs the command detached: it keeps running across turns and re-invokes you when it exits. No `&` needed.",
    "",
    "# Git",
    "- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.",
    "- Use the `gh` CLI for GitHub operations (PRs, issues, API).",
    "- Commit or push only when the user asks. If on the default branch, branch first.",
  ].join("\n");
}
