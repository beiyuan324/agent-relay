import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AtSign, Blocks, File, Folder, Loader2, RefreshCw, Sparkles, X } from "lucide-react";
import { call, folder, message, type Json } from "./api";
import { editDraft, fileTarget, insertMention, matchesMention, mentionTrigger, removeMention, validMentions, type ComposerDraft, type MentionKind, type MentionTarget } from "./mentions";

const labels: Record<MentionKind, string> = { file: "文件", directory: "目录", skill: "技能", app: "应用" };
const tabs = [{ id: "all", label: "全部" }, { id: "files", label: "文件" }, { id: "skills", label: "技能" }, { id: "apps", label: "应用" }] as const;
type Tab = typeof tabs[number]["id"];
type Catalog = { apps: MentionTarget[]; skills: MentionTarget[]; errors: string[]; loading: boolean };
function TargetIcon({ kind }: { kind: MentionKind }) {
  return kind === "app" ? <Blocks size={16} /> : kind === "skill" ? <Sparkles size={16} /> : kind === "directory" ? <Folder size={16} /> : <File size={16} />;
}
async function availableApps(device: string, threadId: string, refresh: boolean, stopped: () => boolean): Promise<MentionTarget[]> {
  const apps: MentionTarget[] = [], seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const result: Json = await call(device, "app/list", { cursor, limit: 100, threadId, forceRefetch: refresh });
    if (stopped()) return [];
    if (!Array.isArray(result.data)) throw new Error("Codex 返回了无效的应用列表");
    for (const app of result.data) {
      if (!app.isAccessible || app.isEnabled === false || typeof app.id !== "string" || typeof app.name !== "string") continue;
      const path = app.id.startsWith("app://") ? app.id : "app://" + app.id;
      apps.push({ kind: "app", name: app.name, label: app.name, path, detail: app.description || "已连接的应用" });
    }
    cursor = result.nextCursor || null;
    if (cursor && seen.has(cursor)) throw new Error("应用列表分页未能继续，请刷新后重试");
    if (cursor) seen.add(cursor);
  } while (cursor && apps.length < 1000 && !stopped());
  return apps;
}
async function availableSkills(device: string, cwd: string, refresh: boolean): Promise<{ skills: MentionTarget[]; errors: string[] }> {
  if (!cwd) return { skills: [], errors: [] };
  const result = await call(device, "skills/list", { cwds: [cwd], forceReload: refresh });
  if (!Array.isArray(result.data)) throw new Error("Codex 返回了无效的技能列表");
  const skills: MentionTarget[] = [], errors: string[] = [];
  for (const entry of result.data) {
    for (const skill of entry.skills || []) {
      if (skill.enabled === false || typeof skill.name !== "string" || typeof skill.path !== "string") continue;
      skills.push({ kind: "skill", name: skill.name, label: skill.interface?.displayName || skill.name, path: skill.path,
        detail: skill.interface?.shortDescription || skill.shortDescription || skill.description || skill.path });
    }
    for (const error of entry.errors || []) if (error.message) errors.push("技能：" + error.message);
  }
  return { skills, errors };
}

export function MentionComposer({ device, threadId, cwd, deviceName, enabled, draft, onChange, inputRef, onSend, placeholder }: {
  device: string; threadId: string; cwd: string; deviceName: string; enabled: boolean;
  draft: ComposerDraft; onChange: (draft: ComposerDraft) => void; inputRef: RefObject<HTMLTextAreaElement | null>;
  onSend: () => void; placeholder: string;
}) {
  const [caret, setCaret] = useState({ start: draft.text.length, end: draft.text.length });
  const [dismissed, setDismissed] = useState("");
  const [composing, setComposing] = useState(false);
  const [tab, setTab] = useState<Tab>("all");
  const [activeIndex, setActiveIndex] = useState(0);
  const [revision, setRevision] = useState(0);
  const [catalog, setCatalog] = useState<Catalog>({ apps: [], skills: [], errors: [], loading: false });
  const [files, setFiles] = useState<MentionTarget[]>([]);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState("");
  const [cancellationToken] = useState(() => crypto.randomUUID());
  const catalogCache = useRef<{ key: string; value: Catalog } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const menuId = useId();
  const trigger = mentionTrigger(draft, caret.start, caret.end);
  const open = enabled && !composing && !!trigger && dismissed !== trigger.key;
  const query = trigger?.query || "";

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const element = anchor.current;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const topInset = document.querySelector(".window-titlebar")?.getBoundingClientRect().bottom || 0;
      setMenuStyle({
        left: rect.left, width: rect.width, bottom: window.innerHeight - rect.top + 12,
        maxHeight: Math.max(0, Math.min(420, rect.top - topInset - 24)),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (element.parentElement) observer.observe(element.parentElement);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const key = JSON.stringify([device, threadId, cwd, revision]);
    if (catalogCache.current?.key === key) { setCatalog(catalogCache.current.value); return; }
    let stopped = false;
    setCatalog({ apps: [], skills: [], errors: [], loading: true });
    void Promise.allSettled([
      availableApps(device, threadId, revision > 0, () => stopped),
      availableSkills(device, cwd, revision > 0),
    ]).then(results => {
      if (stopped) return;
      const [apps, skills] = results;
      const value: Catalog = {
        apps: apps.status === "fulfilled" ? apps.value : [],
        skills: skills.status === "fulfilled" ? skills.value.skills : [],
        errors: [
          ...(apps.status === "rejected" ? ["应用：" + message(apps.reason)] : []),
          ...(skills.status === "rejected" ? ["技能：" + message(skills.reason)] : skills.value.errors),
        ],
        loading: false,
      };
      catalogCache.current = { key, value };
      setCatalog(value);
    });
    return () => { stopped = true; };
  }, [open, device, threadId, cwd, revision]);

  useEffect(() => {
    setFiles([]); setFileError(""); setFileLoading(false);
    if (!open || !query || !cwd) return;
    let stopped = false;
    setFileLoading(true);
    const timer = window.setTimeout(() => {
      void call(device, "fuzzyFileSearch", { query, roots: [cwd], cancellationToken }).then(result => {
        if (stopped) return;
        if (!Array.isArray(result.files)) throw new Error("Codex 返回了无效的文件搜索结果");
        setFiles(result.files.map((file: Json) => fileTarget(file, cwd)).filter((target: MentionTarget | null): target is MentionTarget => target !== null));
      }).catch(error => { if (!stopped) setFileError(message(error)); })
        .finally(() => { if (!stopped) setFileLoading(false); });
    }, 200);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [open, query, cwd, device, cancellationToken, revision]);

  const options = useMemo(() => {
    const currentProject: MentionTarget[] = !query && cwd ? [{ kind: "directory", name: folder(cwd), label: folder(cwd), path: cwd, relativePath: ".", detail: "当前项目 · " + cwd }] : [];
    const candidates = [...currentProject, ...files, ...catalog.apps, ...catalog.skills];
    const seen = new Set<string>();
    return candidates.filter(target => {
      if (tab === "files" && target.kind !== "file" && target.kind !== "directory") return false;
      if (tab === "skills" && target.kind !== "skill") return false;
      if (tab === "apps" && target.kind !== "app") return false;
      if (target.kind !== "file" && target.kind !== "directory" && !matchesMention(target, query)) return false;
      const key = target.kind + ":" + target.path;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 80);
  }, [query, cwd, files, catalog.apps, catalog.skills, tab]);
  useEffect(() => { setActiveIndex(0); }, [options]);
  useEffect(() => {
    if (open) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const focusAt = (position: number) => {
    setCaret({ start: position, end: position });
    window.requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(position, position); });
  };
  const choose = (target: MentionTarget) => {
    if (!trigger) return;
    const next = insertMention(draft, trigger.start, trigger.end, target);
    onChange(next.draft); setDismissed(""); focusAt(next.caret);
  };
  const loading = ((tab === "all" || tab === "files") && fileLoading) || (tab !== "files" && catalog.loading);
  const errors = [...((tab === "all" || tab === "files") && fileError ? ["文件：" + fileError] : []), ...(tab !== "files" ? catalog.errors : [])];
  return <div className="mention-composer" ref={anchor}>
    {open && createPortal(<div className="mention-menu" style={menuStyle}>
      <div className="mention-menu-heading"><AtSign size={15} /><strong>引用</strong><span title={deviceName}>{deviceName}</span><button type="button" className="icon-button" title="刷新引用列表" aria-label="刷新引用列表" onMouseDown={event => event.preventDefault()} onClick={() => setRevision(previous => previous + 1)}><RefreshCw size={13} /></button></div>
      <div className="mention-tabs" role="group" aria-label="引用类型">{tabs.map(item => <button type="button" key={item.id} aria-pressed={tab === item.id} className={tab === item.id ? "selected" : ""} onMouseDown={event => event.preventDefault()} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
      <div className="mention-options" id={menuId} role="listbox" aria-label="选择引用" aria-busy={loading} ref={list}>
        {options.map((target, index) => <button type="button" role="option" aria-selected={index === activeIndex} data-active={index === activeIndex} id={menuId + "-" + index} className={"mention-option " + (index === activeIndex ? "active" : "")} key={target.kind + ":" + target.path} title={target.detail} onMouseDown={event => event.preventDefault()} onMouseMove={() => setActiveIndex(index)} onClick={() => choose(target)}>
          <span className="mention-option-icon"><TargetIcon kind={target.kind} /></span><span className="mention-option-copy"><strong>{target.label}</strong><small>{target.detail}</small></span><span className="mention-kind">{labels[target.kind]}</span>
        </button>)}
        {!options.length && !loading && <div className="mention-empty">{!query && (tab === "files" || tab === "all") ? "输入文件名，搜索当前项目。" : "没有匹配的引用。"}</div>}
        {loading && <div className="mention-loading"><Loader2 size={14} className="spin" />正在读取候选…</div>}
      </div>
      {!query && (tab === "all" || tab === "files") && <div className="mention-search-hint">{cwd ? "继续输入可搜索项目文件和目录。" : "当前会话未提供项目路径，无法搜索文件。"}</div>}
      {!!errors.length && <details className="mention-query-errors"><summary>部分候选暂不可用</summary>{errors.map((error, index) => <p key={index}>{error}</p>)}</details>}
      <div className="mention-menu-footer">↑↓ 选择 · Enter / Tab 插入 · Esc 关闭</div>
    </div>, document.body)}
    <textarea ref={inputRef} aria-label={"向 " + deviceName + " 发送消息"} role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? menuId : undefined} aria-activedescendant={open && options[activeIndex] ? menuId + "-" + activeIndex : undefined} placeholder={placeholder} value={draft.text} rows={2}
      onChange={event => { onChange(editDraft(draft, event.target.value)); setCaret({ start: event.target.selectionStart, end: event.target.selectionEnd }); }}
      onSelect={event => setCaret({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })}
      onBlur={() => { if (trigger) setDismissed(trigger.key); }}
      onCompositionStart={() => setComposing(true)}
      onCompositionEnd={event => { setComposing(false); setCaret({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || composing) return;
        if (open) {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDismissed(trigger!.key); return; }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (options.length) setActiveIndex(previous => (previous + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
            return;
          }
          if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
            event.preventDefault(); event.stopPropagation();
            if (options[activeIndex]) choose(options[activeIndex]);
            return;
          }
        }
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); }
      }} />
    {!!validMentions(draft).length && <div className="mention-chips" aria-label="已选引用">{validMentions(draft).map(mention => <span className="mention-chip" key={mention.start + ":" + mention.path} title={mention.path}><TargetIcon kind={mention.kind} /><span>{mention.label}</span><button type="button" aria-label={"移除引用 " + mention.label} onMouseDown={event => event.preventDefault()} onClick={() => { onChange(removeMention(draft, mention)); focusAt(mention.start); }}><X size={12} /></button></span>)}</div>}
    <button type="button" className="mention-shortcut" disabled={!enabled} title="输入 @ 引用文件、目录、技能或应用" onMouseDown={event => event.preventDefault()} onClick={() => {
      const input = inputRef.current, start = input?.selectionStart ?? draft.text.length, end = input?.selectionEnd ?? start;
      const prefix = start > 0 && /[a-zA-Z0-9_.+-]/.test(draft.text[start - 1]) ? " @" : "@";
      onChange(editDraft(draft, draft.text.slice(0, start) + prefix + draft.text.slice(end)));
      setDismissed(""); focusAt(start + prefix.length);
    }}><AtSign size={13} />引用文件、技能或应用</button>
  </div>;
}
