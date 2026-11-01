import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle, Check, ChevronDown, ChevronRight, FileCode2, ListChecks, Loader2, ShieldCheck, Terminal, Wrench, X } from "lucide-react";
import { message, type Json } from "./api";

function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener">{children}</a> }}>{text}</ReactMarkdown></div>;
}
function output(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value, null, 2);
}
function UserText({ part }: { part: Json }) {
  const text = part.text as string;
  const elements = part.text_elements || part.textElements;
  if (!Array.isArray(elements) || !elements.length) return <span>{text}</span>;
  const bytes = new TextEncoder().encode(text), decoder = new TextDecoder(), content: ReactNode[] = [];
  const ranges = [...elements].sort((a, b) => (a.byte_range || a.byteRange)?.start - (b.byte_range || b.byteRange)?.start);
  let cursor = 0;
  for (const element of ranges) {
    const range = element.byte_range || element.byteRange;
    if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < cursor || range.end <= range.start || range.end > bytes.length) continue;
    if (range.start > cursor) content.push(decoder.decode(bytes.subarray(cursor, range.start)));
    const literal = decoder.decode(bytes.subarray(range.start, range.end));
    content.push(<span className="message-mention" key={range.start} title={literal}>{typeof element.placeholder === "string" ? element.placeholder : literal}</span>);
    cursor = range.end;
  }
  if (cursor < bytes.length) content.push(decoder.decode(bytes.subarray(cursor)));
  return <span>{content}</span>;
}
const Item = memo(function Item({ item }: { item: Json }) {
  switch (item.type) {
    case "userMessage": {
      const content: Json[] = item.content || [];
      const richText = content.some(part => part.text_elements?.length || part.textElements?.length);
      const text = content.map(part => part.text || "").join("\n");
      return <div className="message user-message"><div className="message-label">你</div><div className="user-bubble">{content.map((part, i) => {
        if (typeof part.text === "string") return <UserText key={i} part={part} />;
        if (part.type === "mention" || part.type === "skill") return richText || text.includes("@" + part.name) || text.includes("$" + part.name) ? null : <span className="message-mention" key={i} title={part.path}>@{part.name}</span>;
        return <span className="muted" key={i}>[{part.type || "附件"}]</span>;
      })}</div></div>;
    }
    case "agentMessage":
      return <div className="message agent-message"><div className="message-label"><span className="codex-mark">✳</span> Codex</div><Markdown text={item.text || ""} /></div>;
    case "plan":
      return <section className="message plan-message" aria-label="Codex 计划"><div className="message-label"><ListChecks size={15} />计划</div><Markdown text={typeof item.text === "string" ? item.text : ""} /></section>;
    case "reasoning": {
      const text = item.text || [...(item.summary || []), ...(item.content || [])].map((entry: string | Json) => typeof entry === "string" ? entry : entry.text || "").join("\n");
      return text ? <details className="reasoning"><summary><ChevronDown size={13} />思考过程</summary><Markdown text={text} /></details> : null;
    }
    case "commandExecution":
      return <details className="tool-card" open={item.status === "inProgress"}><summary><Terminal size={14} /><span className="tool-title">{item.command || "执行命令"}</span><span className="tool-status">{item.status === "inProgress" ? <Loader2 size={13} className="spin" /> : item.exitCode === 0 ? <Check size={13} /> : item.exitCode != null ? `退出 ${item.exitCode}` : item.status}</span></summary><div className="tool-body"><div className="micro muted">{item.cwd}</div><pre>{item.aggregatedOutput || "等待命令输出…"}</pre></div></details>;
    case "fileChange":
      return <details className="tool-card"><summary><FileCode2 size={14} /><span className="tool-title">文件变更 · {item.changes?.length || 0}</span><span className="tool-status">{item.status === "completed" ? <Check size={13} /> : item.status}</span></summary><div className="tool-body">{(item.changes || []).map((change: Json, i: number) => <div key={i}><div className="file-path">{change.path}</div><pre className="diff">{change.diff || output(change.kind)}</pre></div>)}</div></details>;
    case "mcpToolCall":
    case "dynamicToolCall":
    case "webSearch":
    case "imageView":
    case "collabAgentToolCall":
      return <details className="tool-card"><summary><Wrench size={14} /><span className="tool-title">{item.tool || item.query || item.type}{item.server ? ` · ${item.server}` : ""}</span><span className="tool-status">{item.status}</span></summary><div className="tool-body"><pre>{output(item.arguments || item.action || item.path)}</pre><pre>{output(item.result || item.error)}</pre></div></details>;
    default:
      return <details className="tool-card"><summary><Wrench size={14} /><span className="tool-title">{item.type || "执行事件"}</span></summary><div className="tool-body"><pre>{output(item)}</pre></div></details>;
  }
});
function finiteMilliseconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function turnTimestamp(ms: unknown, seconds: unknown): number | null {
  const precise = finiteMilliseconds(ms), unix = finiteMilliseconds(seconds);
  return precise ?? (unix == null ? null : unix * 1000);
}
function elapsedTime(turn: Json, active: boolean, now: number): { ms: number | null; estimated: boolean } {
  const duration = finiteMilliseconds(turn.durationMs);
  if (!active && duration != null) return { ms: duration, estimated: false };
  const start = turnTimestamp(turn.startedAtMs, turn.startedAt);
  const end = turnTimestamp(turn.completedAtMs, turn.completedAt);
  if (start != null && end != null && end >= start) return { ms: end - start, estimated: false };
  const observedStart = finiteMilliseconds(turn.relayTiming?.startedAtMs);
  const observedEnd = finiteMilliseconds(turn.relayTiming?.completedAtMs);
  if (observedStart != null && observedEnd != null && observedEnd >= observedStart) return { ms: observedEnd - observedStart, estimated: true };
  const liveStart = observedStart ?? start;
  if (active && liveStart != null) return { ms: Math.max(0, now - liveStart), estimated: true };
  return { ms: null, estimated: false };
}
function formatElapsed(ms: number): string {
  if (ms < 1000) return "<1s";
  const total = Math.floor(ms / 1000), hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, seconds = total % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", seconds || (!hours && !minutes) ? `${seconds}s` : ""].filter(Boolean).join(" ");
}
const Turn = memo(function Turn({ turn, running }: { turn: Json; running: boolean }) {
  const active = running && turn.status === "inProgress";
  const [expanded, setExpanded] = useState(active);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { setExpanded(active); }, [active]);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const items: Json[] = turn.items || [];
  const users = items.filter(item => item.type === "userMessage");
  const answers = new Set(items.filter(item => item.type === "plan" || (
    item.type === "agentMessage" && ["partial_answer", "final_answer", "final"].includes(item.phase)
  )));
  // Older history may omit phase. Only promote a trailing reply after successful completion.
  if (!items.some(item => item.type === "agentMessage" && ["partial_answer", "final_answer", "final"].includes(item.phase)) && turn.status === "completed") {
    const last = items[items.length - 1];
    if (last?.type === "agentMessage" && !last.phase && typeof last.text === "string" && last.text.trim()) answers.add(last);
  }
  const process = items.filter(item => item.type !== "userMessage" && !answers.has(item));
  const results = items.filter(item => answers.has(item));
  const elapsed = elapsedTime(turn, active, now);
  const duration = elapsed.ms == null ? "用时未知" : `${elapsed.estimated ? "约 " : ""}${formatElapsed(elapsed.ms)}`;
  const label = active ? `处理中${elapsed.ms == null ? "" : ` · ${duration}`}` : elapsed.ms == null ? "处理过程 · 用时未知" : `用时 ${duration}`;
  const timingHint = elapsed.ms == null ? "此记录未提供完整计时数据" : elapsed.estimated ? "按本次连接收到的开始和结束时间估算" : "使用会话返回的处理用时";
  return <section className="turn">
    {users.map(item => <Item key={item.id} item={item} />)}
    {process.length > 0 ? <details className="turn-process" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary className="turn-process-summary" title={`${timingHint}；点击展开或收起处理过程`}><span>{active && <Loader2 size={14} className="spin" />}{label}</span><ChevronRight size={14} className="turn-process-chevron" /></summary>
      {expanded && <div className="turn-process-body">{process.map(item => <Item key={item.id} item={item} />)}</div>}
    </details> : <div className="turn-duration" title={timingHint}>{active && <Loader2 size={14} className="spin" />}{label}</div>}
    {results.map(item => <Item key={item.id} item={item} />)}
    {turn.status === "completed" && !results.length && !!process.length && <div className="turn-note">此回合没有最终答复，可展开处理过程查看。</div>}
    {turn.error && <div className="inline-error"><AlertCircle size={15} />{turn.error.message || output(turn.error)}</div>}
    {turn.status === "failed" && !turn.error && <div className="inline-error"><AlertCircle size={15} />此回合执行失败，可展开处理过程查看详情。</div>}
    {turn.status === "interrupted" && <div className="turn-note">此回合已停止或连接已结束。</div>}
  </section>;
});
export function Transcript({ thread, running, older, hasOlder, loading }: { thread: Json; running: boolean; older: () => void; hasOlder: boolean; loading: boolean }) {
  const bottom = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (follow.current) bottom.current?.scrollIntoView({ block: "end", behavior: "auto" });
  }, [thread]);
  useEffect(() => { follow.current = true; bottom.current?.scrollIntoView({ block: "end" }); }, [thread.id]);
  return <div className="transcript" ref={scroll} onScroll={() => { const el = scroll.current; if (el) follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 160; }}>
    <div className="transcript-inner">
      {hasOlder && <button className="load-older" disabled={loading} onClick={() => { follow.current = false; older(); }}>{loading ? "正在读取…" : "加载更早的回合"}</button>}
      {(thread.turns || []).map((turn: Json) => <Turn key={`${thread.id}:${turn.id}`} turn={turn} running={running && turn.status === "inProgress"} />)}
      {running && !(thread.turns || []).some((turn: Json) => turn.status === "inProgress") && <div className="working-indicator"><span className="pulse-dot" />Codex 正在处理</div>}
      {thread.interrupted && <div className="inline-error"><AlertCircle size={15} />进程连接已结束，请刷新会话确认最终状态。</div>}
      <div ref={bottom} />
    </div>
  </div>;
}

export function Approval({ request, deviceName, resolve }: { request: Json; deviceName: string; resolve: (id: string, result: Json) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const method = request.method;
  const input = method === "item/tool/requestUserInput";
  const known = input || method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval";
  const p = request.params || {};
  const submit = async (result: Json) => {
    setBusy(true); setError("");
    try { await resolve(request.id, result); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  };
  return <section className="approval-card" aria-label="待处理审批">
    <div className="approval-heading"><ShieldCheck size={18} /><div><strong>{input ? "Codex 需要你的补充" : known ? "需要你的确认" : "收到未支持的审批请求"}</strong><p>将在 {deviceName} 上继续</p></div></div>
    {p.reason && <p>{p.reason}</p>}
    {p.command && <pre>{Array.isArray(p.command) ? p.command.join(" ") : p.command}</pre>}
    {p.cwd && <div className="micro muted">{p.cwd}</div>}
    {p.grantRoot && <p className="file-path">修改范围：{p.grantRoot}</p>}
    {!input && <details><summary>请求详情</summary><pre>{output(p)}</pre></details>}
    {input && (p.questions || []).map((question: Json) => <fieldset key={question.id} className="question"><legend>{question.header || "补充信息"}</legend><p>{question.question}</p>{question.options?.length > 0 && <div className="question-options">{question.options.map((option: Json) => <label className={answers[question.id] === option.label ? "selected" : ""} key={option.label}><input type="radio" name={`${request.id}-${question.id}`} value={option.label} checked={answers[question.id] === option.label} onChange={() => setAnswers(previous => ({ ...previous, [question.id]: option.label }))} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>)}</div>}{(!question.options?.length || question.isOther) && <input type={question.isSecret ? "password" : "text"} placeholder="输入你的回答" value={answers[question.id] || ""} onChange={event => setAnswers(previous => ({ ...previous, [question.id]: event.target.value }))} />}</fieldset>)}
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="approval-actions">
      {input ? <button className="primary small" disabled={busy || !(p.questions || []).every((q: Json) => answers[q.id]?.trim())} onClick={() => void submit({ answers: Object.fromEntries((p.questions || []).map((q: Json) => [q.id, { answers: [answers[q.id]] }])) })}>{busy ? "正在提交…" : "提交回答"}</button> : known ? <><button className="secondary small" disabled={busy} onClick={() => void submit({ decision: "decline" })}>拒绝</button><button className="primary small" disabled={busy} onClick={() => void submit({ decision: "accept" })}>{busy ? "正在提交…" : "允许这一次"}</button></> : <p className="muted micro">此请求保持待处理。可停止当前回合，并更新 Relay 以支持该审批类型。</p>}
    </div>
  </section>;
}
export function Inspector({ thread, close }: { thread: Json | undefined; close: () => void }) {
  const changes: Json[] = (thread?.turns || []).flatMap((turn: Json) => (turn.items || []).filter((item: Json) => item.type === "fileChange").flatMap((item: Json) => item.changes || []));
  const diffs: string[] = (thread?.turns || []).filter((turn: Json) => turn.diff).map((turn: Json) => turn.diff);
  return <aside className="inspector" id="file-inspector" aria-label="文件变更"><div className="inspector-heading"><h2>文件变更</h2><span className="count">{changes.length}</span><button className="icon-button" title="关闭文件变更" aria-label="关闭文件变更" onClick={close}><X size={17} /></button></div>{!changes.length && !diffs.length ? <div className="inspector-empty"><FileCode2 size={26} strokeWidth={1.3} /><p>变更会显示在这里</p><small>Codex 修改文件后，可查看路径与差异。</small></div> : <div className="inspector-content">{changes.map((change, i) => <details key={i}><summary><FileCode2 size={14} /><span title={change.path}>{change.path}</span></summary><pre className="diff">{change.diff || output(change.kind)}</pre></details>)}{diffs.map((diff, i) => <details key={`diff-${i}`}><summary>回合差异 {i + 1}</summary><pre className="diff">{diff}</pre></details>)}</div>}</aside>;
}
