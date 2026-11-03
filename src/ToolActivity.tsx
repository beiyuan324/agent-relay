import { AlertCircle, ChevronDown, FileCode2, Globe2, Image, Loader2, Terminal, Users, Wrench } from "lucide-react";
import type { Json } from "./api";

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value, null, 2);
}
function commandText(item: Json): string {
  return Array.isArray(item.command) ? item.command.join(" ") : text(item.command);
}
function shellCommand(command: string): string {
  const wrapped = /(?:powershell|pwsh)(?:\.exe)?["']?\s+.*?-(?:Command|c)\s+([\s\S]+)$/i.exec(command);
  if (!wrapped) return command;
  const inner = wrapped[1].trim();
  return inner.length > 1 && (inner[0] === '"' || inner[0] === "'") && inner[inner.length - 1] === inner[0] ? inner.slice(1, -1) : inner;
}
function toolArguments(item: Json): Json {
  if (item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments)) return item.arguments;
  try {
    const parsed: unknown = JSON.parse(item.arguments);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Json : {};
  } catch { return {}; }
}
function toolName(item: Json): string {
  const args = toolArguments(item);
  if (item.type === "webSearch") {
    const action = item.action || {};
    const queries = [item.query, ...(Array.isArray(action.queries) ? action.queries : []), action.query]
      .filter((query): query is string => typeof query === "string" && !!query.trim());
    const detail = [...new Set(queries)].join("；") || action.url || "";
    const label = action.type === "openPage" ? "打开网页" : action.type === "findInPage" ? "查找网页" : "搜索网页";
    return label + (detail ? " · " + detail : "");
  }
  for (const candidate of [item.title, args.title, args.description]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  if (item.type === "imageView") return "查看图片" + (typeof item.path === "string" ? " · " + item.path : "");
  if (item.type === "collabToolCall" || item.type === "collabAgentToolCall") return "协作 · " + (item.tool || "代理任务");
  if (item.type === "functionCallOutput") return "工具输出";
  const name = typeof item.tool === "string" ? item.tool.replace(/^.*__/, "") : "";
  return name ? name.replace(/_/g, " ").replace(/\b[a-z]/g, character => character.toUpperCase()) : item.type || "工具调用";
}
function resultText(item: Json): string {
  const result = item.result ?? item.contentItems ?? item.output;
  const blocks = Array.isArray(result) ? result : result && typeof result === "object" && Array.isArray(result.content) ? result.content : null;
  if (blocks) return blocks.map((block: unknown) => {
    if (!block || typeof block !== "object") return text(block);
    const content = block as Json;
    return typeof content.text === "string" ? content.text : text(content);
  }).join("\n\n");
  return text(result);
}

export function ToolActivity({ item, active }: { item: Json; active: boolean }) {
  const command = item.type === "commandExecution", files = item.type === "fileChange";
  const hasExitCode = command && typeof item.exitCode === "number" && Number.isFinite(item.exitCode);
  // A process can finish with no matches (exit 1) or no stdout. Keep its exit code in the details.
  const failed = !!item.error || (command
    ? !hasExitCode && (item.success === false || item.status === "error" || item.status === "failed")
    : item.success === false || item.status === "error" || item.status === "failed");
  const rejected = item.status === "declined" || item.status === "denied";
  const interrupted = item.status === "interrupted";
  const running = active && !failed && !rejected && !interrupted && !hasExitCode && (item.status === "inProgress" || item.status === "running" || (item.status == null && item.success == null));
  const ended = !active && !hasExitCode && (item.status === "inProgress" || item.status === "running");
  const completed = item.status === "completed" || item.success === true || hasExitCode;
  const state = failed ? "失败" : running ? "进行中" : rejected ? "已拒绝" : ended ? "已结束" : item.status === "interrupted" ? "已停止" : completed ? "已完成" : "已记录";
  const fullCommand = commandText(item), visibleCommand = shellCommand(fullCommand);
  const summaryCommand = visibleCommand.trim().replace(/\s+/g, " ");
  const commandState = failed ? "运行失败" : running ? "正在运行" : rejected ? "已拒绝" : ended ? "已结束" : item.status === "interrupted" ? "已停止" : "已运行";
  const title = command ? commandState + (summaryCommand ? " " + summaryCommand : "命令")
    : files ? "文件变更" + (item.changes?.length ? " · " + item.changes.length + " 个文件" : "") : toolName(item);
  const Icon = command ? Terminal : files ? FileCode2 : item.type === "webSearch" ? Globe2 : item.type === "imageView" ? Image : item.type === "collabToolCall" || item.type === "collabAgentToolCall" ? Users : Wrench;
  const known = command || files || ["mcpToolCall", "dynamicToolCall", "webSearch", "imageView", "collabToolCall", "collabAgentToolCall", "functionCallOutput"].includes(item.type);
  const input = item.arguments ?? item.action ?? item.path;
  const result = resultText(item);
  if (item.type === "webSearch") return <div className={"tool-activity web-search-activity" + (running ? " is-running" : "")} title={title} aria-label={title + "，" + state}>
    {running ? <Loader2 size={14} className="spin" /> : <Globe2 size={14} />}
    <span className="activity-title">{title}</span>
  </div>;
  return <details className={"tool-activity" + (failed ? " is-failed" : "") + (running ? " is-running" : "")}>
    <summary title={title + (item.server ? " · " + item.server : "")} aria-label={title + "，" + state}>
      {running ? <Loader2 size={14} className="spin" /> : failed ? <AlertCircle size={14} /> : <Icon size={14} />}
      <span className="activity-title">{command ? <><span className="activity-command-collapsed">{title}</span><span className="activity-command-expanded">{failed ? "命令运行失败" : running ? "正在运行命令" : rejected ? "已拒绝命令" : ended ? "命令已结束" : item.status === "interrupted" ? "命令已停止" : "已运行命令"}</span></> : title}</span><ChevronDown size={12} className="activity-chevron" />
    </summary>
    <div className="activity-panel">
      <div className="activity-panel-heading"><span>{command ? "Shell" : files ? "文件变更" : item.server || "工具详情"}</span>{running && <span>进行中</span>}</div>
      {command ? <>
        <pre className="activity-command"><span className="activity-prompt">$ </span>{visibleCommand || "未提供命令"}</pre>
        {item.cwd && <div className="activity-cwd" title={item.cwd}>{item.cwd}</div>}
        <pre className={!item.aggregatedOutput ? "activity-empty" : undefined}>{text(item.aggregatedOutput) || (running ? "等待输出…" : "无输出")}</pre>
        {visibleCommand !== fullCommand && <details className="activity-raw"><summary>完整启动命令</summary><pre>{fullCommand}</pre></details>}
      </> : files ? (item.changes || []).map((change: Json, index: number) => <div key={index}><div className="file-path">{change.path}</div><pre className="diff">{change.diff || text(change.kind)}</pre></div>)
        : known ? <>{input != null && <><div className="activity-section-label">输入</div><pre>{text(input)}</pre></>}<div className="activity-section-label">输出</div><pre className={!result ? "activity-empty" : undefined}>{result || (running ? "等待输出…" : item.error ? "未返回结果" : "无输出")}</pre></>
          : <pre>{text(item)}</pre>}
      {item.error && <pre className="activity-error">{text(item.error)}</pre>}
      <div className="activity-footer"><span>{typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs >= 0 ? (item.durationMs < 1000 ? "<1 秒" : (item.durationMs / 1000).toFixed(1) + " 秒") : ""}</span><span>{command && typeof item.exitCode === "number" ? "退出码 " + item.exitCode : state}</span></div>
    </div>
  </details>;
}
