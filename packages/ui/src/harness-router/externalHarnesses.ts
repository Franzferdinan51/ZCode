/**
 * External agent-harness catalog for the Harness Router side tab.
 *
 * Launch commands follow the backend builders in the harnessrouter runner
 * (https://github.com/Franzferdinan51/harnessrouter runner/server.py):
 * each entry names the harness binary plus its interactive entrypoint, so the
 * tab can detect installed CLIs on PATH and open them in a workspace terminal.
 * API-key providers (MiniMax, Z.AI, LM Studio, ...) are covered by the
 * built-in provider templates in config/provider/zcode-builtin.json and appear
 * in the routed provider list once configured in Settings.
 */

export interface ExternalHarness {
  /** Stable catalog id. */
  id: string;
  /** Display name. */
  name: string;
  /** Binary probed on PATH. */
  binary: string;
  /** Interactive command typed into the launched terminal. */
  launchCommand: string;
  /** Short hint shown under the name. */
  hint: string;
  /** The built-in ZCode agent runtime (current session). Never launched. */
  builtin?: boolean;
}

export const EXTERNAL_HARNESSES: readonly ExternalHarness[] = [
  {
    id: "zcode",
    name: "ZCode Agent",
    binary: "zcode",
    launchCommand: "zcode",
    hint: "Built-in runtime driving this workspace",
    builtin: true,
  },
  {
    id: "codex",
    name: "Codex",
    binary: "codex",
    launchCommand: "codex",
    hint: "OpenAI Codex CLI",
  },
  {
    id: "pi",
    name: "Pi",
    binary: "pi",
    launchCommand: "pi",
    hint: "Pi coding agent",
  },
  {
    id: "grok",
    name: "Grok",
    binary: "grok",
    launchCommand: "grok agent",
    hint: "xAI Grok agent (agent-managed auth)",
  },
  {
    id: "grok-local",
    name: "Grok Local",
    binary: "grok-local",
    launchCommand: "grok-local agent",
    hint: "Grok agent against LM Studio, no credential",
  },
  {
    id: "muse",
    name: "Muse",
    binary: "muse",
    launchCommand: "muse",
    hint: "Meta Muse Code CLI (agent-managed auth)",
  },
  {
    id: "claude",
    name: "Claude Code",
    binary: "claude",
    launchCommand: "claude",
    hint: "Anthropic Claude Code CLI",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    binary: "gemini",
    launchCommand: "gemini",
    hint: "Google Gemini CLI",
  },
  {
    id: "qwen",
    name: "Qwen Code",
    binary: "qwen",
    launchCommand: "qwen",
    hint: "Alibaba Qwen coding CLI",
  },
  {
    id: "kimi",
    name: "Kimi",
    binary: "kimi",
    launchCommand: "kimi",
    hint: "Moonshot Kimi CLI",
  },
  {
    id: "opencode",
    name: "OpenCode",
    binary: "opencode",
    launchCommand: "opencode",
    hint: "OpenCode agent CLI",
  },
  {
    id: "aider",
    name: "Aider",
    binary: "aider",
    launchCommand: "aider",
    hint: "Aider pair-programming CLI",
  },
  {
    id: "omp",
    name: "OMP",
    binary: "omp",
    launchCommand: "omp",
    hint: "OMP agent CLI",
  },
  {
    id: "goose",
    name: "Goose",
    binary: "goose",
    launchCommand: "goose",
    hint: "Block Goose agent CLI",
  },
  {
    id: "cline",
    name: "Cline",
    binary: "cline",
    launchCommand: "cline",
    hint: "Cline agent CLI",
  },
  {
    id: "minimax",
    name: "MiniMax",
    binary: "mmx",
    launchCommand: "mmx",
    hint: "MiniMax platform CLI (npm mmx-cli)",
  },
];

/** Binaries to probe, deduplicated, in catalog order. */
export function externalHarnessBinaries(
  harnesses: readonly ExternalHarness[] = EXTERNAL_HARNESSES,
): string[] {
  const seen = new Set<string>();
  const binaries: string[] = [];
  for (const harness of harnesses) {
    if (seen.has(harness.binary)) {
      continue;
    }
    seen.add(harness.binary);
    binaries.push(harness.binary);
  }
  return binaries;
}

export type ExternalHarnessStatus = "builtin" | "installed" | "missing" | "unknown";

export function resolveExternalHarnessStatus(
  harness: ExternalHarness,
  resolvedPath: string | null | undefined,
  detectionAvailable: boolean,
): ExternalHarnessStatus {
  if (harness.builtin) {
    return "builtin";
  }
  if (!detectionAvailable) {
    return "unknown";
  }
  return resolvedPath ? "installed" : "missing";
}
