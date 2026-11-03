import { useId } from "react";
import type { Json } from "./api";

export function ContextUsage({ usage }: { usage?: Json | null }) {
  const tooltipId = useId();
  const capacity = usage?.modelContextWindow;
  const lastTokens = usage?.last?.totalTokens;
  if (typeof capacity !== "number" || !Number.isFinite(capacity) || capacity <= 0
    || typeof lastTokens !== "number" || !Number.isFinite(lastTokens) || lastTokens < 0) return null;

  // Match Codex: the most recent request measures context occupancy, not lifetime usage.
  const used = Math.min(lastTokens, capacity);
  const percent = used / capacity * 100;
  const rounded = Math.round(percent);
  const tokens = (value: number) => Math.round(value).toLocaleString("zh-CN");
  return <span className={"context-usage" + (percent >= 90 ? " is-full" : "")} tabIndex={0} role="img"
    aria-label={`上下文已使用 ${rounded}%`} aria-describedby={tooltipId}>
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle className="context-usage-track" cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2.5" />
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2.5" pathLength="100"
        strokeDasharray={`${percent} 100`} transform="rotate(-90 10 10)" />
    </svg>
    <span className="context-usage-tooltip" id={tooltipId} role="tooltip">
      <strong>上下文窗口</strong>
      <span>已使用 {rounded}% · 剩余 {100 - rounded}%</span>
      <span>{tokens(used)} / {tokens(capacity)} tokens</span>
    </span>
  </span>;
}
