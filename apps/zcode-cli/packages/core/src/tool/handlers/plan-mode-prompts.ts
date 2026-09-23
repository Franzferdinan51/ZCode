// ============================================================
// Plan Mode Tool Provider Prompts
// ============================================================

export function createEnterPlanModeProviderDescription(options: {
  embeddedSearchEnabled?: boolean;
} = {}): string {
  const explorationTools = options.embeddedSearchEnabled
    ? "`find`/Glob, `grep`/Grep, and Read"
    : "Glob, Grep, and Read";

  return `Enter plan mode before a non-trivial implementation task: explore the codebase with ${explorationTools}, design the approach, then get user sign-off via ExitPlanMode before writing code.

Use for real implementation work — new features, multi-file changes, refactors, or tasks with genuinely multiple approaches. Sign-off first prevents wasted effort.

Do NOT use for: single-line fixes, typos, obvious bugs, small tweaks, or pure research/understanding tasks (for those just explore — no plan approval needed). If the user gave very specific detailed instructions, follow them instead of planning.

In plan mode: clarify open questions with AskUserQuestion BEFORE finalizing, then call ExitPlanMode with the complete plan for approval.`;
}

export const ENTER_PLAN_MODE_PROVIDER_DESCRIPTION = createEnterPlanModeProviderDescription();

export const EXIT_PLAN_MODE_MODEL_INSTRUCTIONS = [
  `Leave plan mode by submitting your complete implementation plan for user approval.

- Call only after exploring and finalizing the plan. Pass the FULL plan in the "plan" parameter — the user reviews that content before approving.
- For implementation plans only — not for research/understanding tasks.
- Resolve open questions with AskUserQuestion BEFORE calling this. Do not ask "is this plan okay?" with AskUserQuestion — requesting approval is this tool's job.
`,
] as const;
