import { createContext, memo, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle, Blocks, ChevronDown, ChevronRight, FileCode2, ListChecks, Loader2, MessageSquare, X } from "lucide-react";
import type { Json } from "./api";
import { messageBody, messageLinks, referenceKind, type MessageReference } from "./message-text";
import { ToolActivity } from "./ToolActivity";
export { Approval } from "./Approval";

const ReferenceContext = createContext<((reference: MessageReference) => void) | undefined>(undefined);
function ReferenceLink({ href, label, children }: MessageReference & { children?: ReactNode }) {
  const open = useContext(ReferenceContext);
  const kind = referenceKind(href);
  if (!kind) return href && defaultUrlTransform(href) ? <a href={href} target="_blank" rel="noreferrer noopener">{children || label}</a> : <>{children || label}</>;
  if (kind === "web") return <a className="message-link" href={href} target="_blank" rel="noreferrer noopener">{children || label}</a>;
  const icon = kind === "thread" ? <MessageSquare size={13} aria-hidden="true" /> : kind === "plugin" || kind === "app" ? <Blocks size={13} aria-hidden="true" /> : <FileCode2 size={13} aria-hidden="true" />;
  const content = <>{icon}<span>{children || label}</span></>;
  if (!open) return <span className="message-reference" title={href}>{content}</span>;
  return <a className="message-reference" href={href} title={kind === "thread" ? "打开引用会话：" + label : "查看引用：" + label} onClick={event => { event.preventDefault(); open({ href, label }); }}>{content}</a>;
}
function linkedText(text: string, key: string): ReactNode[] {
  return messageLinks(text).map((part, index) => typeof part === "string" ? part : <ReferenceLink key={key + ":" + index} {...part} />);
}
function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml
    urlTransform={url => referenceKind(url) ? url : defaultUrlTransform(url)}
    components={{ a: ({ children, href }) => <ReferenceLink href={href || ""} label={typeof children === "string" ? children : href || "引用"}>{children}</ReferenceLink> }}>{text}</ReactMarkdown></div>;
}
function output(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value, null, 2);
}
function UserText({ part }: { part: Json }) {
  const text = part.text as string;
  const body = messageBody(text);
  const elements = part.text_elements || part.textElements;
  const encoder = new TextEncoder(), bytes = encoder.encode(text), decoder = new TextDecoder(), content: ReactNode[] = [];
  const ranges: Json[] = Array.isArray(elements) ? [...elements].sort((a, b) => (a.byte_range || a.byteRange)?.start - (b.byte_range || b.byteRange)?.start) : [];
  // Ranges refer to the original UTF-8 message, including any hidden context.
  let cursor = encoder.encode(text.slice(0, body.offset)).length;
  for (const element of ranges) {
    const range = element.byte_range || element.byteRange;
    if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < cursor || range.end <= range.start || range.end > bytes.length) continue;
    if (range.start > cursor) content.push(...linkedText(decoder.decode(bytes.subarray(cursor, range.start)), "text:" + cursor));
    const literal = decoder.decode(bytes.subarray(range.start, range.end));
    const links = messageLinks(literal);
    const link = links.length === 1 && typeof links[0] !== "string" ? links[0] : null;
    const label = typeof element.placeholder === "string" ? element.placeholder : link?.label || literal;
    const binding = (part.bindings as Json[] | undefined)?.find(binding => label === "@" + binding.name || label === "$" + binding.name);
    const reference = link ? { ...link, label } : binding?.path && referenceKind(binding.path) ? { href: binding.path as string, label } : null;
    content.push(reference ? <ReferenceLink key={range.start} {...reference} /> : <span className="message-mention" key={range.start} title={literal}>{label}</span>);
    cursor = range.end;
  }
  if (cursor < bytes.length) content.push(...linkedText(decoder.decode(bytes.subarray(cursor)), "text:" + cursor));
  return <div className="user-text-part">{content}{body.context && <details className="message-context"><summary>引用上下文</summary><pre>{body.context}</pre></details>}</div>;
}
const Item = memo(function Item({ item, active = false }: { item: Json; active?: boolean }) {
  switch (item.type) {
    case "userMessage": {
      const content: Json[] = item.content || [];
      const richText = content.some(part => part.text_elements?.length || part.textElements?.length);
      const text = content.map(part => part.text || "").join("\n");
      return <div className="message user-message"><div className="message-label">你</div><div className="user-bubble">{content.map((part, i) => {
        if (typeof part.text === "string") return <UserText key={i} part={{ ...part, bindings: content.filter(binding => binding.type === "mention" || binding.type === "skill") }} />;
        if (part.type === "mention" || part.type === "skill") return richText || text.includes("@" + part.name) || text.includes("$" + part.name) ? null : <ReferenceLink key={i} href={part.path || ""} label={(part.type === "skill" ? "$" : "@") + part.name} />;
        return <span className="muted" key={i}>[{part.type || "附件"}]</span>;
      })}</div></div>;
    }
    case "agentMessage":
      return <div className="message agent-message"><div className="message-label"><span className="codex-mark">✳</span> Codex</div><Markdown text={item.text || ""} /></div>;
    case "plan":
      return <section className="message plan-message" aria-label="Codex 计划"><div className="message-label"><ListChecks size={15} />计划</div><Markdown text={typeof item.text === "string" ? item.text : ""} /></section>;
    case "reasoning": {
      const summaries = (item.summary || []).map((entry: string | Json) => typeof entry === "string" ? entry : entry.text || "");
      const text = item.text || [...summaries, ...(item.content || []).map((entry: string | Json) => typeof entry === "string" ? entry : entry.text || "")].join("\n");
      const heading = (summaries.find((entry: string) => entry.trim()) || text).split(/\r?\n/).find((line: string) => line.trim())?.replace(/[*\u0060#]/g, "").trim() || "思考过程";
      return text ? <details className="reasoning"><summary title={heading}><span className="reasoning-title">{heading}</span><ChevronDown size={12} className="activity-chevron" /></summary><div className="reasoning-body"><Markdown text={text} /></div></details> : null;
    }
    default:
      return <ToolActivity item={item} active={active} />;
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
  useEffect(() => { if (turn.status !== "inProgress") setExpanded(false); }, [turn.status]);
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
  const label = turn.status === "inProgress" && !running ? "状态待同步" : active ? `处理中${elapsed.ms == null ? "" : ` · ${duration}`}` : elapsed.ms == null ? "处理过程 · 用时未知" : `用时 ${duration}`;
  const timingHint = elapsed.ms == null ? "此记录未提供完整计时数据" : elapsed.estimated ? "按本次连接收到的开始和结束时间估算" : "使用会话返回的处理用时";
  return <section className="turn">
    {users.map(item => <Item key={item.id} item={item} />)}
    {process.length > 0 ? <details className="turn-process" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary className="turn-process-summary" title={`${timingHint}；点击展开或收起处理过程`}><span>{active && <Loader2 size={14} className="spin" />}{label}</span><ChevronRight size={14} className="turn-process-chevron" /></summary>
      {expanded && <div className="turn-process-body">{process.map(item => <Item key={item.id} item={item} active={active} />)}</div>}
    </details> : <div className="turn-duration" title={timingHint}>{active && <Loader2 size={14} className="spin" />}{label}</div>}
    {results.map(item => <Item key={item.id} item={item} />)}
    {turn.status === "completed" && !results.length && !!process.length && <div className="turn-note">此回合没有最终答复，可展开处理过程查看。</div>}
    {turn.error && <div className="inline-error"><AlertCircle size={15} />{turn.error.message || output(turn.error)}</div>}
    {turn.status === "failed" && !turn.error && <div className="inline-error"><AlertCircle size={15} />此回合执行失败，可展开处理过程查看详情。</div>}
    {turn.status === "interrupted" && <div className="turn-note">此回合已停止或连接已结束。</div>}
  </section>;
});
export function Transcript({ thread, running, older, hasOlder, loading, offline = false, onReference }: { thread: Json; running: boolean; older: () => void; hasOlder: boolean; loading: boolean; offline?: boolean; onReference?: (reference: MessageReference) => void }) {
  const bottom = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (follow.current) bottom.current?.scrollIntoView({ block: "end", behavior: "auto" });
  }, [thread]);
  useEffect(() => { follow.current = true; bottom.current?.scrollIntoView({ block: "end" }); }, [thread.id]);
  return <ReferenceContext.Provider value={onReference}><div className="transcript" ref={scroll} onScroll={() => { const el = scroll.current; if (el) follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 160; }}>
    <div className="transcript-inner">
      {hasOlder && <button className="load-older" disabled={offline || loading} title={offline ? "连接恢复后可加载更早的回合" : undefined} onClick={() => { follow.current = false; older(); }}>{loading ? "正在读取…" : "加载更早的回合"}</button>}
      {(thread.turns || []).map((turn: Json) => <Turn key={`${thread.id}:${turn.id}`} turn={turn} running={running && turn.status === "inProgress"} />)}
      {running && !(thread.turns || []).some((turn: Json) => turn.status === "inProgress") && <div className="working-indicator"><span className="pulse-dot" />Codex 正在处理</div>}
      {thread.interrupted && <div className="inline-error"><AlertCircle size={15} />进程连接已结束，请刷新会话确认最终状态。</div>}
      <div ref={bottom} />
    </div>
  </div></ReferenceContext.Provider>;
}

export function Inspector({ thread, close }: { thread: Json | undefined; close: () => void }) {
  const changes: Json[] = (thread?.turns || []).flatMap((turn: Json) => (turn.items || []).filter((item: Json) => item.type === "fileChange").flatMap((item: Json) => item.changes || []));
  const diffs: string[] = (thread?.turns || []).filter((turn: Json) => turn.diff).map((turn: Json) => turn.diff);
  return <aside className="inspector" id="file-inspector" aria-label="文件变更"><div className="inspector-heading"><h2>文件变更</h2><span className="count">{changes.length}</span><button className="icon-button" title="关闭文件变更" aria-label="关闭文件变更" onClick={close}><X size={17} /></button></div>{!changes.length && !diffs.length ? <div className="inspector-empty"><FileCode2 size={26} strokeWidth={1.3} /><p>变更会显示在这里</p><small>Codex 修改文件后，可查看路径与差异。</small></div> : <div className="inspector-content">{changes.map((change, i) => <details key={i}><summary><FileCode2 size={14} /><span title={change.path}>{change.path}</span></summary><pre className="diff">{change.diff || output(change.kind)}</pre></details>)}{diffs.map((diff, i) => <details key={`diff-${i}`}><summary>回合差异 {i + 1}</summary><pre className="diff">{diff}</pre></details>)}</div>}</aside>;
}
