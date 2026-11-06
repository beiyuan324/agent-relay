import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AtSign, Blocks, File, Folder, Loader2, RefreshCw, Sparkles, X } from "lucide-react";
import { call, folder, message, type Json } from "./api";
import { editDraft, fileTarget, insertMention, matchesMention, mentionTrigger, removeMention, validMentions, type ComposerDraft, type MentionKind, type MentionTarget } from "./mentions";

import { matchesCommand, slashTrigger, type SlashCommand } from "./slash-commands";

const labels: Record<MentionKind, string> = { file: "文件", directory: "目录", skill: "技能", app: "应用" };
const tabs = [{ id: "all", label: "全部" }, { id: "files", label: "文件" }, { id: "apps", label: "应用" }] as const;
type Tab = typeof tabs[number]["id"];
type Catalog = { apps: MentionTarget[]; skills: MentionTarget[]; errors: string[]; loading: boolean };
function TargetIcon({ kind }: { kind: MentionKind }) {
  return kind === "app" ? <Blocks size={16} /> : kind === "skill" ? <Sparkles size={16} /> : kind === "directory" ? <Folder size={16} /> : <File size={16} />;
}
async function availableApps(device: string, threadId: string, refresh: boolean, stopped: () => boolean): Promise<MentionTarget[]> {
  const apps: MentionTarget[] = [], seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const result: Json = await call(device, "app/list", { cursor, limit: 100, ...(threadId ? { threadId } : {}), forceRefetch: refresh });
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

export function MentionComposer({ device, threadId, cwd, deviceName, enabled, draft, onChange, inputRef, onSend, placeholder, commands = [], commandError, onCommand, onTogglePlan }: {
  device: string; threadId: string; cwd: string; deviceName: string; enabled: boolean;
  draft: ComposerDraft; onChange: (draft: ComposerDraft) => void; inputRef: RefObject<HTMLTextAreaElement | null>;
  onSend: () => void; placeholder: string;
  commands?: SlashCommand[]; commandError?: string; onCommand?: (command: SlashCommand) => void; onTogglePlan?: () => void;
}) {
  const [caret, setCaret] = useState({ start: draft.text.length, end: draft.text.length });
  const [dismissed, setDismissed] = useState("");
  const [composing, setComposing] = useState(false);
  const [tab, setTab] = useState<Tab>("all");
  const [activeIndex, setActiveIndex] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
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
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input) setCaret(previous => previous.start === input.selectionStart && previous.end === input.selectionEnd ? previous : { start: input.selectionStart, end: input.selectionEnd });
  }, [draft.text, inputRef]);
  const trigger = mentionTrigger(draft, caret.start, caret.end);
  const slash = slashTrigger(draft, caret.start, caret.end);
  const slashOpen = enabled && !composing && !!slash && dismissed !== slash.key && !!onCommand;
  const open = enabled && !composing && !slashOpen && !!trigger && dismissed !== trigger.key;
  const popupOpen = open || slashOpen;
  const query = trigger?.query || "";
  const skillsOnly = trigger?.prefix === "$" || slashOpen;

  useLayoutEffect(() => {
    if (!popupOpen || !anchor.current) return;
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
  }, [popupOpen]);

  useEffect(() => {
    if (!popupOpen) return;
    const key = JSON.stringify([device, threadId, cwd, revision, skillsOnly]);
    if (catalogCache.current?.key === key) { setCatalog(catalogCache.current.value); return; }
    let stopped = false;
    setCatalog({ apps: [], skills: [], errors: [], loading: true });
    void Promise.allSettled([
      skillsOnly ? Promise.resolve([] as MentionTarget[]) : availableApps(device, threadId, revision > 0, () => stopped),
      skillsOnly ? availableSkills(device, cwd, revision > 0) : Promise.resolve({ skills: [] as MentionTarget[], errors: [] as string[] }),
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
  }, [popupOpen, device, threadId, cwd, revision, skillsOnly]);

  useEffect(() => {
    setFiles([]); setFileError(""); setFileLoading(false);
    if (!open || skillsOnly || !query || !cwd) return;
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
  }, [open, skillsOnly, query, cwd, device, cancellationToken, revision]);

  const options = useMemo(() => {
    const currentProject: MentionTarget[] = !query && cwd ? [{ kind: "directory", name: folder(cwd), label: folder(cwd), path: cwd, relativePath: ".", detail: "当前项目 · " + cwd }] : [];
    const candidates = skillsOnly ? catalog.skills : [...currentProject, ...files, ...catalog.apps];
    const seen = new Set<string>();
    return candidates.filter(target => {
      if (!skillsOnly && tab === "files" && target.kind !== "file" && target.kind !== "directory") return false;
      if (!skillsOnly && tab === "apps" && target.kind !== "app") return false;
      if (target.kind !== "file" && target.kind !== "directory" && !matchesMention(target, query)) return false;
      const key = target.kind + ":" + target.path;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 80);
  }, [query, cwd, files, catalog.apps, catalog.skills, tab, skillsOnly]);
  useEffect(() => { setActiveIndex(0); }, [options]);
  useEffect(() => {
    if (open) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const slashOptions = useMemo(() => [
    ...commands.filter(command => matchesCommand(command, slash?.query || "")).map(command => ({ key: command.id, command, target: null as MentionTarget | null })),
    ...catalog.skills.filter(target => matchesMention(target, slash?.query || "")).map(target => ({ key: "skill:" + target.path, command: null as SlashCommand | null, target })),
  ].slice(0, 100), [commands, catalog.skills, slash?.query]);
  useEffect(() => { setSlashIndex(0); }, [slash?.query, device, threadId]);
  const selectedSlashIndex = Math.min(slashIndex, Math.max(0, slashOptions.length - 1));
  useEffect(() => {
    if (slashOpen) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedSlashIndex, slashOpen]);

  const focusAt = (position: number) => {
    setCaret({ start: position, end: position });
    window.requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(position, position); });
  };
  const choose = (target: MentionTarget) => {
    if (!trigger) return;
    const next = insertMention(draft, trigger.start, trigger.end, target);
    onChange(next.draft); setDismissed(""); focusAt(next.caret);
  };
  const chooseSlash = (index: number) => {
    const option = slashOptions[index];
    if (!slash || !option || option.command?.disabledReason) return;
    if (option.target) {
      const next = insertMention(draft, slash.start, slash.end, option.target);
      onChange(next.draft); setDismissed(""); focusAt(next.caret);
    } else if (option.command) {
      setDismissed(slash.key);
      onCommand?.(option.command);
    }
  };
  const loading = skillsOnly ? catalog.loading : ((tab === "all" || tab === "files") && fileLoading) || (tab !== "files" && catalog.loading);
  const errors = [...(!skillsOnly && (tab === "all" || tab === "files") && fileError ? ["文件：" + fileError] : []), ...(skillsOnly || tab !== "files" ? catalog.errors : [])];
  const startReference = (symbol: "@" | "$") => {
    const input = inputRef.current, start = input?.selectionStart ?? draft.text.length, end = input?.selectionEnd ?? start;
    const prefix = start > 0 && /[a-zA-Z0-9_.$@+-]/.test(draft.text[start - 1]) ? " " + symbol : symbol;
    onChange(editDraft(draft, draft.text.slice(0, start) + prefix + draft.text.slice(end)));
    setDismissed(""); focusAt(start + prefix.length);
  };
  return <div className="mention-composer" ref={anchor}>
    {slashOpen && createPortal(<div className="mention-menu slash-menu" style={menuStyle}>
      <div className="mention-menu-heading"><strong>命令与技能</strong></div>
      <div className="mention-options" id={menuId} role="listbox" aria-label="选择命令或技能" ref={list}>
        {slashOptions.map((option, index) => <button type="button" role="option" aria-selected={index === selectedSlashIndex} aria-disabled={!!option.command?.disabledReason} data-active={index === selectedSlashIndex} id={menuId + "-" + index} className={"mention-option " + (index === selectedSlashIndex ? "active" : "")} key={option.key} title={option.command?.disabledReason || option.command?.description || option.target?.detail} onMouseDown={event => event.preventDefault()} onMouseMove={() => setSlashIndex(index)} onClick={() => chooseSlash(index)}>
          <span className="mention-option-copy"><strong>{option.command ? "/" + option.command.id : "/" + option.target!.name}<span className="slash-command-label">{option.command?.label}</span></strong>{(option.command?.disabledReason || option.target?.detail) && <small>{option.command?.disabledReason || option.target?.detail}</small>}</span>
        </button>)}
        {!slashOptions.length && <div className="mention-empty">没有匹配的命令或技能</div>}
        {catalog.loading && <div className="mention-loading"><Loader2 size={14} className="spin" />正在读取项目技能…</div>}
      </div>
      {!!catalog.errors.length && <div className="mention-search-hint" role="status">{catalog.errors.join("；")}</div>}
      {commandError && <div className="mention-search-hint" role="status">自定义命令：{commandError}</div>}
    </div>, document.body)}
    {open && createPortal(<div className="mention-menu" style={menuStyle}>
      <div className="mention-menu-heading">{skillsOnly ? <Sparkles size={15} /> : <AtSign size={15} />}<strong>{skillsOnly ? "使用技能" : "引用"}</strong><button type="button" className="icon-button" title={skillsOnly ? "刷新技能列表" : "刷新引用列表"} aria-label={skillsOnly ? "刷新技能列表" : "刷新引用列表"} onMouseDown={event => event.preventDefault()} onClick={() => setRevision(previous => previous + 1)}><RefreshCw size={13} /></button></div>
      {!skillsOnly && <div className="mention-tabs" role="group" aria-label="引用类型">{tabs.map(item => <button type="button" key={item.id} aria-pressed={tab === item.id} className={tab === item.id ? "selected" : ""} onMouseDown={event => event.preventDefault()} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>}
      <div className="mention-options" id={menuId} role="listbox" aria-label={skillsOnly ? "选择技能" : "选择引用"} aria-busy={loading} ref={list}>
        {options.map((target, index) => <button type="button" role="option" aria-selected={index === activeIndex} data-active={index === activeIndex} id={menuId + "-" + index} className={"mention-option " + (index === activeIndex ? "active" : "")} key={target.kind + ":" + target.path} aria-label={`${labels[target.kind]}：${target.label}，${target.detail}`} title={target.detail} onMouseDown={event => event.preventDefault()} onMouseMove={() => setActiveIndex(index)} onClick={() => choose(target)}>
          <span className="mention-option-icon"><TargetIcon kind={target.kind} /></span><span className="mention-option-copy"><strong>{target.kind === "skill" ? "$" + target.name : target.label}</strong><small>{target.detail}</small></span>
        </button>)}
        {!options.length && !loading && <div className="mention-empty">{skillsOnly ? cwd ? "没有匹配的技能。" : "当前会话未提供项目路径，无法读取技能。" : !query && (tab === "files" || tab === "all") ? "输入文件名，搜索当前项目。" : "没有匹配的引用。"}</div>}
        {loading && <div className="mention-loading"><Loader2 size={14} className="spin" />正在读取候选…</div>}
      </div>
      {!skillsOnly && !cwd && (tab === "all" || tab === "files") && <div className="mention-search-hint" role="status">当前会话未提供项目路径，无法搜索文件。</div>}
      {!!errors.length && <details className="mention-query-errors"><summary>部分候选暂不可用</summary>{errors.map((error, index) => <p key={index}>{error}</p>)}</details>}
    </div>, document.body)}
    <textarea ref={inputRef} aria-label={"向 " + deviceName + " 发送消息"} role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={popupOpen} aria-controls={popupOpen ? menuId : undefined} aria-activedescendant={slashOpen && slashOptions[selectedSlashIndex] ? menuId + "-" + selectedSlashIndex : open && options[activeIndex] ? menuId + "-" + activeIndex : undefined} placeholder={placeholder} value={draft.text} rows={2}
      onChange={event => { onChange(editDraft(draft, event.target.value)); setCaret({ start: event.target.selectionStart, end: event.target.selectionEnd }); }}
      onSelect={event => setCaret({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })}
      onFocus={() => setDismissed("")}
      onBlur={() => { if (slash) setDismissed(slash.key); else if (trigger) setDismissed(trigger.key); }}
      onCompositionStart={() => setComposing(true)}
      onCompositionEnd={event => { setComposing(false); setCaret({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing) return;
        if (event.key === "Tab" && event.shiftKey && enabled && onTogglePlan) {
          event.preventDefault(); event.stopPropagation(); onTogglePlan(); return;
        }
        if (slashOpen) {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDismissed(slash!.key); return; }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (slashOptions.length) setSlashIndex((selectedSlashIndex + (event.key === "ArrowDown" ? 1 : -1) + slashOptions.length) % slashOptions.length);
            return;
          }
          if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
            event.preventDefault(); event.stopPropagation();
            if (slashOptions.length) chooseSlash(selectedSlashIndex); else if (event.key === "Enter") onSend();
            return;
          }
        }
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
    {!!validMentions(draft).length && <div className="mention-chips" aria-label="已选引用">{validMentions(draft).map(mention => <span className="mention-chip" key={mention.start + ":" + mention.path} title={mention.path}><TargetIcon kind={mention.kind} /><span>{mention.kind === "skill" ? "$" + mention.name : mention.label}</span><button type="button" aria-label={"移除引用 " + mention.label} onMouseDown={event => event.preventDefault()} onClick={() => { onChange(removeMention(draft, mention)); focusAt(mention.start); }}><X size={12} /></button></span>)}</div>}
    <div className="mention-shortcuts">
      {onCommand && <button type="button" className="mention-shortcut" disabled={!enabled} aria-label="命令" title="命令 (/)" onMouseDown={event => event.preventDefault()} onClick={() => { const body = draft.text.startsWith("/") ? draft.text.replace(/^\/[^\s]*\s*/, "") : draft.text; onChange(editDraft(draft, "/" + (body ? " " + body : ""))); setDismissed(""); focusAt(1); }}><span className="slash-symbol" aria-hidden="true">/</span></button>}
      <button type="button" className="mention-shortcut" disabled={!enabled} aria-label="引用文件或应用" title="引用文件或应用 (@)" onMouseDown={event => event.preventDefault()} onClick={() => startReference("@")}><AtSign size={16} /></button>
      <button type="button" className="mention-shortcut" disabled={!enabled} aria-label="使用技能" title="使用技能 ($)" onMouseDown={event => event.preventDefault()} onClick={() => startReference("$")}><Sparkles size={16} /></button>
    </div>
  </div>;
}
