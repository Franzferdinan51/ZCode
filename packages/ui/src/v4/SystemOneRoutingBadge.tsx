import React from "react";
import type { SystemOneRoutingInfo } from "@zcode/shared/zcode-protocol-v4";

/**
 * Shows the session's last SystemOne routing decision (routed model +
 * applied effort). Session-level: the snapshot only retains the most recent
 * routing; the badge updates live as new turns route.
 */
export function SystemOneRoutingBadge({
  routing,
}: {
  routing: SystemOneRoutingInfo | null | undefined;
}) {
  if (!routing) return null;
  const label = routing.modelId || routing.tier;
  const effort = routing.effort ? ` · ${routing.effort}` : "";
  const routed = routing.retargeted ? " (retargeted)" : "";
  const title =
    `SystemOne routed this response: ${label}${effort}${routed}` +
    `\nconfidence: ${Math.round(routing.confidence * 100)}%`;
  return (
    <span
      data-testid="systemone-routing-badge"
      title={title}
      className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] leading-4 text-emerald-600 dark:text-emerald-400"
    >
      <span aria-hidden>⚡</span>
      <span className="max-w-[220px] truncate">
        {label}
        {effort}
      </span>
    </span>
  );
}
