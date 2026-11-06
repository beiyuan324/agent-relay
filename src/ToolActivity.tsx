import { AlertCircle, ChevronDown, FileCode2, Globe2, Image, Loader2, Terminal, Users, Wrench } from "lucide-react";
import type { Json } from "./api";
import { displayText as text } from "./message-text";

function commandText(item: Json): string {
  return Array.isArray(item.command) ? item.command.join(" ") : text(item.command);
}
// Decode one POSIX-quoted argv value, not the PowerShell source inside it.
// Adjacent fragments such as 'before'"'"'after' represent a literal apostrophe.
function shellArgument(source: string): string | null {
  const input = source.trim();
  if (input[0] !== "'" && input[0] !== '"') return null;
  let value = "", quote = "";
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (quote === "'") {
      if (character === "'") quote = "";
      else value += character;
    } else if (quote === '"') {
      if (character === '"') quote = "";
      else if (character === "\\" && /[$`"\\\n]/.test(input[index + 1] || "")) {
        const escaped = input[++index];
        if (escaped !== "\n") value += escaped;
      } else value += character;
    } else if (/\s/.test(character)) {
      // More than one argument means this is not a quoted script payload.
      return null;
    } else if (character === "'" || character === '"') quote = character;
    else if (character === "\\") {
      if (++index === input.length) return null;
      if (input[index] !== "\n") value += input[index];
    } else value += character;
  }
  return quote ? null : value;
}
function shellCommand(item: Json): string {
  const command = commandText(item);
  if (Array.isArray(item.command)) {
    // Structured argv is already decoded. Joining it first loses that distinction.
    const executable = item.command[0];
    if (typeof executable !== "string" || !/(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(executable)) return command;
    const commandIndex = item.command.findIndex((argument: unknown) => typeof argument === "string" && /^-(?:Command|c)$/i.test(argument));
    return commandIndex > 0 && commandIndex < item.command.length - 1 ? item.command.slice(commandIndex + 1).join(" ") : command;
  }
  const executable = /^(?:"(?:[^"\r\n]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"|'(?:[^'\r\n]*[\\/])?(?:powershell|pwsh)(?:\.exe)?'|(?:[^\s"']*[\\/])?(?:powershell|pwsh)(?:\.exe)?)\s+/i.exec(command.trim());
  if (!executable) return command;
  const wrapped = /^(?:[\s\S]*?\s)?-(?:Command|c)\s+([\s\S]+)$/i.exec(command.trim().slice(executable[0].length));
  if (!wrapped) return command;
  const inner = wrapped[1].trim();
  return shellArgument(inner) ?? inner;
}
function toolArguments(item: Json): Json {
  if (item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments)) return item.arguments;
  try {
    const parsed: unknown = JSON.parse(item.arguments);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Json : {};
  } catch { return {}; }
}
function toolDescription(item: Json): string | undefined {
  const args = toolArguments(item);
  return [item.title, args.title, args.description].find(value => typeof value === "string" && value.trim())?.trim();
}
function toolName(item: Json): string {
  const description = toolDescription(item);
  if (item.type === "webSearch") {
    const action = item.action || {};
    const queries = [item.query, ...(Array.isArray(action.queries) ? action.queries : []), action.query]
      .filter((query): query is string => typeof query === "string" && !!query.trim());
    const detail = [...new Set(queries)].join("；") || action.url || "";
    const label = action.type === "openPage" ? "打开网页" : action.type === "findInPage" ? "查找网页" : "搜索网页";
    return label + (detail ? " · " + detail : "");
  }
  if (description) return description;
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

function activityState(item: Json, active: boolean) {
  const command = item.type === "commandExecution";
  const hasExitCode = command && typeof item.exitCode === "number" && Number.isFinite(item.exitCode);
  // A process can finish with no matches (exit 1) or no stdout. Keep its exit code in the details.
  const failed = !!item.error || (command
    ? !hasExitCode && (item.success === false || item.status === "error" || item.status === "failed")
    : item.success === false || item.status === "error" || item.status === "failed");
  const rejected = item.status === "declined" || item.status === "denied";
  const interrupted = item.status === "interrupted";
  const completed = item.status === "completed" || item.success === true || hasExitCode;
  const running = active && !completed && !failed && !rejected && !interrupted && (item.status === "inProgress" || item.status === "running" || (item.status == null && item.success == null));
  const ended = !active && !completed && (item.status === "inProgress" || item.status === "running");
  const state = failed ? "失败" : running ? "进行中" : rejected ? "已拒绝" : ended ? "已结束" : item.status === "interrupted" ? "已停止" : completed ? "已完成" : "已记录";
  return { failed, rejected, interrupted, running, ended, state };
}

function activityCategory(item: Json): string {
  switch (item.type) {
    case "commandExecution": return "运行命令";
    case "fileChange": return "修改文件";
    case "webSearch": return "搜索网页";
    case "imageView": return "查看图片";
    case "collabToolCall":
    case "collabAgentToolCall": return "执行协作任务";
    default: {
      const server = typeof item.server === "string" ? item.server.trim()
        : typeof item.tool === "string" ? /^mcp__(.+?)__/.exec(item.tool)?.[1] : "";
      return server ? "使用 " + server.replace(/[_-]/g, " ").replace(/\b[a-z]/g, character => character.toUpperCase()) + " 集成" : "调用工具";
    }
  }
}

function runningActivityLabel(item: Json): string {
  if (item.type === "commandExecution") {
    const description = toolDescription(item);
    const command = shellCommand(item).trim().replace(/\s+/g, " ");
    return description ? "正在" + description : "正在运行" + (command ? " " + command : "命令");
  }
  if (item.type === "fileChange") {
    const paths = (item.changes || []).map((change: Json) => change.path).filter((path: unknown): path is string => typeof path === "string" && !!path.trim());
    return "正在修改" + (paths.length ? " " + [...new Set(paths)].join("、") : "文件");
  }
  if (item.type === "webSearch" || item.type === "imageView") return "正在" + toolName(item);
  const category = activityCategory(item);
  return category === "调用工具" ? "正在调用 " + toolName(item) : "正在" + category + " · " + toolName(item);
}

export function ToolActivityGroup({ items, active }: { items: Json[]; active: boolean }) {
  const states = items.map(item => activityState(item, active));
  const runningCount = states.filter(state => state.running).length;
  const running = runningCount > 0;
  // Follow the newest running call, including when several tools execute in parallel.
  let currentIndex = -1;
  for (let index = states.length - 1; index >= 0; index--) {
    if (states[index].running) { currentIndex = index; break; }
  }
  const currentItem = currentIndex >= 0 ? items[currentIndex] : null;
  const failed = states.filter(state => state.failed).length;
  const rejected = states.filter(state => state.rejected).length;
  const interrupted = states.filter(state => state.interrupted).length;
  const summaryLabel = "已" + [...new Set(items.map(activityCategory))].join("、");
  const label = currentItem ? runningActivityLabel(currentItem) : summaryLabel;
  const status = [running ? (runningCount > 1 ? `${runningCount} 项进行中` : "进行中") : "", failed ? `${failed} 项失败` : "", rejected ? `${rejected} 项已拒绝` : "", interrupted ? `${interrupted} 项已停止` : ""].filter(Boolean).join(" · ");
  const title = `${label} · ${items.length} 次调用${status ? " · " + status : ""}`;
  return <details className={"tool-activity-group" + (running ? " is-running" : "") + (failed ? " is-failed" : "")}>
    <summary title={title} aria-label={title}>
      {running ? <Loader2 size={14} className="spin" /> : failed ? <AlertCircle size={14} /> : <Wrench size={14} />}
      <span className="activity-title activity-group-title"><span key={currentItem ? `running:${currentItem.id ?? currentIndex}` : "summary"} className="activity-group-label">{label}</span></span>
      <span className="activity-group-count">{items.length} 次调用</span>
      {status && <span className={"activity-group-status" + (failed ? " is-failed" : "")}>{status}</span>}
      <ChevronDown size={12} className="activity-chevron" />
    </summary>
    <div className="activity-group-items">{items.map((item, index) => <ToolActivity key={item.id ?? index} item={item} active={active} />)}</div>
  </details>;
}

export function ToolActivity({ item, active }: { item: Json; active: boolean }) {
  const command = item.type === "commandExecution", files = item.type === "fileChange";
  const { failed, rejected, running, ended, state } = activityState(item, active);
  const fullCommand = commandText(item), visibleCommand = shellCommand(item);
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
        <pre className="activity-command"><span className="activity-prompt" aria-hidden="true" />{visibleCommand || "未提供命令"}</pre>
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
