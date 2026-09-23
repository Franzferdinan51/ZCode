import { z } from "zod";

/**
 * Wire-level speed-stack routing knobs carried by turn intents and protocol
 * payloads (3.24.0).
 *
 * - `modelRouting`: true = the SystemOne route may retarget the session
 *   model per task ("Auto (SystemOne)" in the desktop model picker).
 * - `thinkingMode`: "off" disables thinking, an effort tier pins it,
 *   "auto" lets the route decide per task.
 *
 * Values are validated strictly on the core side
 * (normalizeSpeedStackSessionConfig); the wire stays tolerant so older
 * clients never break the protocol parse.
 */
export const speedStackWireConfigSchema = z.object({
  effortTier: z.string().optional(),
  modelRouting: z.boolean().optional(),
  thinkingMode: z.string().optional(),
  planThenExecute: z.boolean().optional(),
  mcpServerAllowlist: z.array(z.string()).optional(),
  mcpToolAllowlist: z.array(z.string()).optional(),
  mcpPruning: z.boolean().optional(),
});

export type SpeedStackWireConfig = z.infer<typeof speedStackWireConfigSchema>;
