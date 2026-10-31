import { useCallback, useEffect, useRef, useState } from "react";
import { call, message, type Json, type RelayEvent } from "./api";
import { referenceInput, type ComposerDraft } from "./mentions";

const keyOf = (device: string, thread: string) => JSON.stringify([device, thread]);
const selectionKeyOf = (device: string, archived: boolean) => JSON.stringify([device, archived]);
export function applyEvent(previous: Json, event: Json, receivedAt = Date.now()): Json {
  const method = event.method as string;
  const p = event.params || {};
  const next: Json = { ...previous, turns: [...(previous.turns || [])] };
  if (method === "thread/started" && p.thread) return { ...next, ...p.thread };
  if (method === "thread/status/changed") { next.status = p.status; return next; }
  const turnId = p.turnId || p.turn?.id;
  if (!turnId) return next;
  let index = next.turns.findIndex((turn: Json) => turn.id === turnId);
  if (index < 0) { index = next.turns.length; next.turns.push({ id: turnId, status: "inProgress", items: [] }); }
  let turn: Json = { ...next.turns[index], items: [...(next.turns[index].items || [])] };
  next.turns[index] = turn;
  if (method === "turn/started" || method === "turn/completed") {
    const timing = { ...turn.relayTiming };
    if (method === "turn/started" && timing.startedAtMs == null) timing.startedAtMs = receivedAt;
    if (method === "turn/completed" && timing.completedAtMs == null) timing.completedAtMs = receivedAt;
    turn = { ...turn, ...p.turn, items: p.turn?.items?.length ? p.turn.items : turn.items, relayTiming: timing };
    next.turns[index] = turn;
    return next;
  }
  if (p.item && (method === "item/started" || method === "item/completed")) {
    const itemIndex = turn.items.findIndex((item: Json) => item.id === p.item.id);
    if (itemIndex >= 0) turn.items[itemIndex] = { ...turn.items[itemIndex], ...p.item };
    else turn.items.push(p.item);
  } else if ((method.endsWith("/delta") || method.endsWith("Delta")) && p.itemId) {
    let itemIndex = turn.items.findIndex((item: Json) => item.id === p.itemId);
    if (itemIndex < 0) {
      itemIndex = turn.items.length;
      const type = method.includes("commandExecution") ? "commandExecution" : method.includes("reasoning") ? "reasoning" : method.includes("/plan/") ? "plan" : "agentMessage";
      turn.items.push({ id: p.itemId, type, text: "", summary: [], aggregatedOutput: "" });
    }
    const item = { ...turn.items[itemIndex] };
    if (item.type === "agentMessage" && typeof p.phase === "string") item.phase = p.phase;
    if (method.includes("commandExecution")) item.aggregatedOutput = (item.aggregatedOutput || "") + (p.delta || "");
    else if (method.includes("reasoning")) item.text = (item.text || "") + (p.delta || "");
    else item.text = (item.text || "") + (p.delta || "");
    turn.items[itemIndex] = item;
  } else if (method === "turn/diff/updated") turn.diff = p.diff;
  return next;
}

function mergeLive(history: Json, live: Json | undefined, updates: Json[]): Json {
  if (!live) return history;
  const liveTurns = new Map<string, Json>((live.turns || []).map((turn: Json) => [turn.id, turn]));
  const turns = (history.turns || []).map((turn: Json) => {
    const timing = liveTurns.get(turn.id)?.relayTiming;
    return timing ? { ...turn, relayTiming: { ...timing, ...turn.relayTiming } } : turn;
  });
  if (!updates.length) return { ...history, turns };
  const touched = new Set(updates.map(event => event.params?.turnId || event.params?.turn?.id).filter(Boolean));
  const longest = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" ? (a.length >= b.length ? a : b) : b ?? a;
  for (const current of live.turns || []) {
    if (!touched.has(current.id)) continue;
    const index = turns.findIndex((turn: Json) => turn.id === current.id);
    if (index < 0) { turns.push(current); continue; }
    const saved = turns[index];
    const items = [...(saved.items || [])];
    for (const item of current.items || []) {
      const i = items.findIndex((saved: Json) => saved.id === item.id);
      if (i < 0) { items.push(item); continue; }
      const previous = items[i];
      items[i] = {
        ...previous, ...item, phase: item.phase ?? previous.phase, text: longest(previous.text, item.text),
        aggregatedOutput: longest(previous.aggregatedOutput, item.aggregatedOutput),
        status: previous.status === "completed" ? previous.status : item.status || previous.status,
      };
    }
    const terminal = current.status !== "inProgress" ? current.status : saved.status;
    turns[index] = {
      ...saved, ...current, status: terminal, items,
      startedAt: current.startedAt ?? saved.startedAt,
      completedAt: current.completedAt ?? saved.completedAt,
      durationMs: current.durationMs ?? saved.durationMs,
      relayTiming: { ...saved.relayTiming, ...current.relayTiming },
    };
  }
  return { ...history, turns };
}

export function useWorkbench(device: string, available: boolean, onError: (error: string) => void) {
  const [threads, setThreads] = useState<Json[]>([]);
  const [archivedView, setArchivedView] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState<Record<string, boolean>>({});
  const archiveMutations = useRef(new Set<string>());
  const archiveFlags = useRef<Record<string, boolean>>({});
  const [listRevision, setListRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [cache, setCache] = useState<Record<string, Json>>({});
  const [sessions, setSessions] = useState<Record<string, { ready: boolean; resumeError?: string; historyError?: string }>>({});
  const resumed = useRef(new Set<string>());
  const newThreads = useRef<Record<string, Json>>({});
  const listed = useRef(threads); listed.current = threads;
  const [models, setModels] = useState<Json[]>([]);
  const [environment, setEnvironment] = useState<Json | null>(null);
  const [permissions, setPermissions] = useState<Json | null>(null);
  const [requests, setRequests] = useState<Record<string, Json[]>>({});
  const [search, setSearch] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [sending, setSending] = useState(false);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [environmentRevision, setEnvironmentRevision] = useState(0);
  const active = useRef({ device, selected, available, archivedView });
  active.current = { device, selected, available, archivedView };
  const events = useRef<Record<string, { sequence: number; log: { sequence: number; event: Json }[] }>>({});
  const sequence = useRef(0);
  const selection = useRef<Record<string, string>>({});
  const listEpoch = useRef(0);
  const openEpoch = useRef(0);
  const processEpoch = useRef<Record<string, number>>({});
  const sendingRef = useRef(false);
  const onErrorRef = useRef(onError); onErrorRef.current = onError;

  const fetchList = useCallback(async (cursor: string | null = null, term = "") => {
    if (!active.current.available) return;
    const target = active.current.device;
    const archived = active.current.archivedView;
    const epoch = ++listEpoch.current;
    setLoading(true);
    try {
      const result = await call(target, "thread/list", { cursor, limit: 40, sortKey: "updated_at", archived, ...(term ? { searchTerm: term } : {}) });
      if (epoch !== listEpoch.current || target !== active.current.device || archived !== active.current.archivedView) return;
      const data: Json[] = (result.data || []).map((thread: Json) => ({ ...thread, relayArchived: archived }));
      for (const thread of data) {
        archiveFlags.current[keyOf(target, thread.id)] = archived;
        if (!archived) delete newThreads.current[keyOf(target, thread.id)];
      }
      const query = term.toLocaleLowerCase();
      const pending = archived ? [] : Object.entries(newThreads.current)
        .filter(([key, thread]) => JSON.parse(key)[0] === target && (!query || [thread.name, thread.preview, thread.cwd].some(value => typeof value === "string" && value.toLocaleLowerCase().includes(query))))
        .map(([, thread]) => thread);
      setThreads(previous => {
        const rows = cursor ? [...previous, ...data.filter(thread => !previous.some(row => row.id === thread.id))] : data;
        return [...pending, ...rows.filter(thread => !pending.some(row => row.id === thread.id))];
      });
      setNextCursor(result.nextCursor || null);
    } catch (error) { if (epoch === listEpoch.current) onErrorRef.current(message(error)); }
    finally { if (epoch === listEpoch.current) setLoading(false); }
  }, []);

  useEffect(() => {
    ++listEpoch.current; ++openEpoch.current;
    for (const key of resumed.current) if (JSON.parse(key)[0] === device) resumed.current.delete(key);
    setSessions(previous => Object.fromEntries(Object.entries(previous).map(([key, session]) =>
      [key, JSON.parse(key)[0] === device ? { ...session, ready: false } : session])));
    const restore = selection.current[selectionKeyOf(device, active.current.archivedView)] || null;
    setThreads(active.current.archivedView ? [] : Object.entries(newThreads.current).filter(([key]) => JSON.parse(key)[0] === device).map(([, thread]) => thread)); setSelected(restore); setEnvironment(null); setModels([]); setPermissions(null); setSearch(""); setNextCursor(null); setOlderCursor(null); setOpening(false); setSending(false); setLoading(false);
    if (!available) return;
    if (restore) void open(restore);
    let stopped = false;
    const target = device;
    void Promise.allSettled([
      call(target, "relay/environment").then(result => { if (!stopped) setEnvironment(result); }),
      (async () => {
        let cursor: string | null = null;
        const all: Json[] = [];
        do {
          const result: Json = await call(target, "model/list", { limit: 100, cursor });
          all.push(...(result.data || []));
          cursor = result.nextCursor || null;
        } while (cursor && all.length < 1000 && !stopped);
        if (!stopped) setModels(all);
      })(),
      call(target, "relay/pending").then(result => { if (!stopped) setRequests(previous => ({ ...previous, [target]: result.requests || [] })); }),
    ]).then(results => {
      if (!stopped) {
        const failure = results.find(result => result.status === "rejected");
        if (failure?.status === "rejected") onErrorRef.current(message(failure.reason));
      }
    });
    return () => { stopped = true; };
  }, [device, available, environmentRevision]);

  useEffect(() => {
    if (!available) return;
    const timer = window.setTimeout(() => { void fetchList(null, search.trim()); }, 250);
    return () => window.clearTimeout(timer);
  }, [device, available, search, archivedView, listRevision, fetchList, environmentRevision]);

  const open = useCallback(async (id: string) => {
    const target = active.current.device;
    if (!active.current.available) return;
    const key = keyOf(target, id);
    if (archiveMutations.current.has(key)) return;
    const archived = archiveFlags.current[key] ?? active.current.archivedView;
    if (archived !== active.current.archivedView) return;
    const epoch = ++openEpoch.current;
    const startedAt = sequence.current;
    selection.current[selectionKeyOf(target, archived)] = id;
    resumed.current.delete(key);
    setSessions(previous => ({ ...previous, [key]: { ready: false } }));
    active.current = { ...active.current, selected: id };
    setSelected(id); setOpening(true); setPermissions(null); setOlderCursor(null);
    const summary = listed.current.find(thread => thread.id === id);
    setCache(previous => ({ ...previous, [key]: { ...summary, ...previous[key], id, relayArchived: archived, turns: previous[key]?.turns || [] } }));
    try {
      let result: Json | undefined;
      let resumeError = "", historyError = "";
      try {
        result = await call(target, archived ? "thread/read" : "thread/resume", { threadId: id, ...(archived ? { includeTurns: false } : {}) });
        if (!result?.thread) throw new Error("Codex 返回了无效的会话数据，请检查版本兼容性");
      } catch (error) { result = undefined; if (!archived) resumeError = message(error); }
      if (epoch !== openEpoch.current || target !== active.current.device) return;
      let thread: Json = result?.thread || { ...summary, id };
      let cursor: string | null = null;
      if (result?.relayHistoryPending === true) {
        // thread/start already loaded this session; there is no rollout to read yet.
        newThreads.current[key] = { ...thread, relayHistoryPending: true };
        setThreads(previous => [thread, ...previous.filter(row => row.id !== id)]);
        setCache(previous => ({ ...previous, [key]: { ...previous[key], ...thread, turns: previous[key]?.turns || [], interrupted: false } }));
        resumed.current.add(key);
        setPermissions({ approvalPolicy: result.approvalPolicy, sandbox: result.sandbox, model: result.model, reasoningEffort: result.reasoningEffort });
        setSessions(previous => ({ ...previous, [key]: { ready: true } }));
        return;
      }
      // Show the resume failure while the independent history read is still pending.
      if (!result && !archived) {
        setSessions(previous => ({ ...previous, [key]: { ready: false, resumeError } }));
        setCache(previous => ({ ...previous, [key]: previous[key] || { ...summary, id, turns: [] } }));
        try {
          const history = await call(target, "thread/read", { threadId: id, includeTurns: false });
          if (history.thread) thread = history.thread;
        } catch { /* The history page or full read below can still succeed. */ }
      }
      try {
        const page = await call(target, "thread/turns/list", { threadId: id, limit: 20, sortDirection: "desc", itemsView: "full" });
        if (!Array.isArray(page.data)) throw new Error("Codex 返回了无效的回合列表");
        thread = { ...thread, turns: [...page.data].reverse() };
        cursor = page.nextCursor || null;
      } catch (pageError) {
        try {
          const history = await call(target, "thread/read", { threadId: id, includeTurns: true });
          if (!Array.isArray(history.thread?.turns)) throw new Error("Codex 未返回会话历史");
          thread = history.thread;
        } catch (error) {
          historyError = `无法更新历史：${message(pageError)}；完整历史读取：${message(error)}。当前内容可能不完整。`;
        }
      }
      if (epoch !== openEpoch.current || target !== active.current.device) return;
      const updates = (events.current[key]?.log || []).filter(entry => entry.sequence > startedAt).map(entry => entry.event);
      // Merge live snapshots; replaying deltas onto a fetched snapshot can duplicate text.
      setCache(previous => {
        const history = { ...previous[key], ...thread, turns: historyError ? previous[key]?.turns || thread.turns || [] : thread.turns || [] };
        return { ...previous, [key]: { ...mergeLive(history, previous[key], updates), interrupted: false, relayArchived: archived } };
      });
      if (result && !archived) {
        resumed.current.add(key);
        setPermissions({ approvalPolicy: result.approvalPolicy, sandbox: result.sandbox, model: result.model, reasoningEffort: result.reasoningEffort });
      }
      setOlderCursor(cursor);
      setSessions(previous => ({ ...previous, [key]: { ready: !!result && !archived, resumeError, historyError } }));
    } catch (error) {
      if (epoch === openEpoch.current && target === active.current.device) {
        setCache(previous => ({ ...previous, [key]: previous[key] || { ...summary, id, turns: [] } }));
        setSessions(previous => ({ ...previous, [key]: { ready: false, ...(archived ? { historyError: message(error) } : { resumeError: message(error) }) } }));
      }
    } finally { if (epoch === openEpoch.current) setOpening(false); }
  }, []);

  const showArchived = useCallback((archived: boolean) => {
    if (archived === active.current.archivedView) return;
    const target = active.current.device;
    ++listEpoch.current; ++openEpoch.current;
    active.current = { ...active.current, archivedView: archived, selected: null };
    setArchivedView(archived); setThreads([]); setSelected(null); setNextCursor(null); setOlderCursor(null);
    setPermissions(null); setOpening(false); setLoading(active.current.available);
    const restore = selection.current[selectionKeyOf(target, archived)];
    if (restore && active.current.available) void open(restore);
  }, [open]);

  const applyArchiveState = useCallback((target: string, id: string, archived: boolean) => {
    const key = keyOf(target, id);
    if (archiveFlags.current[key] === archived) return;
    archiveFlags.current[key] = archived;
    delete newThreads.current[key];
    resumed.current.delete(key);
    setSessions(previous => ({ ...previous, [key]: { ready: false } }));
    setCache(previous => previous[key] ? { ...previous, [key]: { ...previous[key], relayArchived: archived } } : previous);
    for (const mode of [false, true]) {
      const selectionKey = selectionKeyOf(target, mode);
      if (selection.current[selectionKey] === id) delete selection.current[selectionKey];
    }
    if (target !== active.current.device) return;
    ++listEpoch.current;
    setLoading(false); setNextCursor(null);
    setThreads(previous => previous.filter(thread => thread.id !== id));
    if (active.current.selected === id) {
      ++openEpoch.current;
      active.current = { ...active.current, selected: null };
      setSelected(null); setOpening(false); setOlderCursor(null); setPermissions(null);
    }
    setListRevision(previous => previous + 1);
  }, []);

  const event = useCallback((event: RelayEvent) => {
    if (event.type !== "codex" || typeof event.device !== "string" || typeof event.message !== "object") return;
    const target = event.device;
    const value = event.message;
    const p = value.params || {};
    if (value.method === "relay/codexExited") {
      processEpoch.current[target] = (processEpoch.current[target] || 0) + 1;
      const endedAt = Date.now();
      const discarded = new Set<string>();
      for (const [key, thread] of Object.entries(newThreads.current)) {
        if (JSON.parse(key)[0] === target && thread.relayHistoryPending === true) {
          discarded.add(thread.id);
          delete newThreads.current[key];
        }
      }
      if (active.current.device === target) setThreads(previous => previous.filter(thread => !discarded.has(thread.id)));
      for (const key of resumed.current) if (JSON.parse(key)[0] === target) resumed.current.delete(key);
      setSessions(previous => Object.fromEntries(Object.entries(previous).map(([key, session]) =>
        [key, JSON.parse(key)[0] === target ? { ...session, ready: false, resumeError: archiveFlags.current[key] ? undefined : p.reason || "Codex 进程已退出，请重试接续" } : session])));
      if (active.current.device === target) { ++openEpoch.current; setOpening(false); setPermissions(null); }
      setRequests(previous => ({ ...previous, [target]: [] }));
      setCache(previous => Object.fromEntries(Object.entries(previous).map(([key, thread]) => {
        if (JSON.parse(key)[0] !== target) return [key, thread];
        return [key, { ...thread, interrupted: true, turns: (thread.turns || []).map((turn: Json) => turn.status === "inProgress" ? { ...turn, status: "interrupted", relayTiming: { ...turn.relayTiming, completedAtMs: endedAt } } : turn) }];
      })));
      if (active.current.device === target) onErrorRef.current(p.reason || "Codex 进程已退出，请刷新会话");
      return;
    }
    if (value.id !== undefined && value.method) {
      setRequests(previous => ({ ...previous, [target]: [...(previous[target] || []).filter(r => r.id !== value.id), value] }));
      return;
    }
    if (value.method === "relay/approvalResolved" || value.method === "serverRequest/resolved") {
      setRequests(previous => ({ ...previous, [target]: (previous[target] || []).filter(r => r.id !== (p.id || p.requestId)) }));
    }
    const id = p.threadId || p.thread?.id;
    if (!id) return;
    const key = keyOf(target, id);
    if (value.method === "thread/archived" || value.method === "thread/unarchived") {
      applyArchiveState(target, id, value.method === "thread/archived");
      return;
    }
    if (value.method === "turn/started" && newThreads.current[key]) newThreads.current[key].relayHistoryPending = false;
    if (value.method === "thread/started" && p.thread && newThreads.current[key]) newThreads.current[key] = { ...newThreads.current[key], ...p.thread };
    const entry = events.current[key] || { sequence: 0, log: [] };
    const currentSequence = ++sequence.current;
    const receivedAt = Date.now();
    entry.log.push({ sequence: currentSequence, event: value }); entry.sequence = currentSequence;
    if (entry.log.length > 4096) entry.log.splice(0, 1024);
    events.current[key] = entry;
    setCache(previous => ({ ...previous, [key]: applyEvent(previous[key] || { id, turns: [] }, value, receivedAt) }));
    if (target === active.current.device && !active.current.archivedView && archiveFlags.current[key] !== true && value.method === "thread/started" && p.thread) {
      setThreads(previous => [p.thread, ...previous.filter(t => t.id !== p.thread.id)]);
    }
  }, [applyArchiveState]);

  const archiveReason = (thread: Json): string => {
    const key = keyOf(device, thread.id);
    const current = cache[key] || thread;
    if (!available) return "连接设备后可归档";
    if (archiveBusy[key]) return "正在更新归档状态";
    if (newThreads.current[key]?.relayHistoryPending === true) return "发送首条消息后可归档";
    if (selected === thread.id && opening) return "正在读取会话";
    if (selected === thread.id && sending) return "正在发送消息";
    if (current.status?.type === "active" || (current.turns || []).some((turn: Json) => turn.status === "inProgress")) return "请等待当前任务结束后归档";
    if ((requests[device] || []).some(request => request.params?.threadId === thread.id)) return "请先处理此会话的待办审批";
    return "";
  };
  const changeArchive = async (thread: Json, archived: boolean): Promise<boolean> => {
    const target = active.current.device;
    const key = keyOf(target, thread.id);
    if (target !== device || !active.current.available || archiveMutations.current.has(key)) return false;
    const reason = archived ? archiveReason(thread) : "";
    if (reason) { onErrorRef.current(reason); return false; }
    archiveMutations.current.add(key);
    setArchiveBusy(previous => ({ ...previous, [key]: true }));
    try {
      const result = await call(target, archived ? "thread/archive" : "thread/unarchive", { threadId: thread.id });
      if (!archived && result.thread) setCache(previous => ({ ...previous, [key]: { ...previous[key], ...result.thread, relayArchived: false, turns: previous[key]?.turns || result.thread.turns || [] } }));
      applyArchiveState(target, thread.id, archived);
      return true;
    } catch (error) {
      onErrorRef.current(`${archived ? "归档" : "恢复"}会话失败：${message(error)}`);
      return false;
    } finally {
      archiveMutations.current.delete(key);
      setArchiveBusy(previous => { const next = { ...previous }; delete next[key]; return next; });
    }
  };

  const create = async (cwd: string, model: string, expectedDevice: string) => {
    const target = active.current.device;
    if (target !== expectedDevice || !active.current.available) throw new Error("执行电脑已切换或离线，请重新选择设备后新建会话");
    const epoch = openEpoch.current;
    const generation = processEpoch.current[target] || 0;
    const result = await call(target, "thread/start", { cwd, ...(model ? { model } : {}) });
    if (generation !== (processEpoch.current[target] || 0)) throw new Error("Codex 进程已退出，新建会话尚未保存，请重新新建会话");
    const thread = result.thread;
    if (!thread?.id) throw new Error("Codex 返回了无效的会话数据");
    const key = keyOf(target, thread.id);
    newThreads.current[key] = { ...thread, relayHistoryPending: true };
    setCache(previous => ({ ...previous, [key]: { ...previous[key], ...thread, turns: previous[key]?.turns || thread.turns || [] } }));
    if (target !== active.current.device) return;
    if (epoch !== openEpoch.current || !active.current.available) {
      if (!active.current.archivedView) setThreads(previous => [thread, ...previous.filter(t => t.id !== thread.id)]);
      return;
    }
    ++openEpoch.current; ++listEpoch.current;
    setListRevision(previous => previous + 1);
    const wasArchived = active.current.archivedView;
    active.current = { ...active.current, archivedView: false, selected: thread.id };
    setArchivedView(false); setLoading(false); setNextCursor(null);
    setThreads(previous => [thread, ...(wasArchived ? [] : previous.filter(t => t.id !== thread.id))]);
    selection.current[selectionKeyOf(target, false)] = thread.id;
    resumed.current.add(key);
    setSelected(thread.id); setOpening(false); setSearch(""); setOlderCursor(null);
    setPermissions({ approvalPolicy: result.approvalPolicy, sandbox: result.sandbox, model: result.model, reasoningEffort: result.reasoningEffort });
    setSessions(previous => ({ ...previous, [key]: { ready: true } }));
  };
  const send = async (draft: ComposerDraft, model: string, effort: string): Promise<boolean> => {
    const { device: target, selected: id, available } = active.current;
    if (!id || !available || !resumed.current.has(keyOf(target, id)) || archiveFlags.current[keyOf(target, id)] === true || archiveMutations.current.has(keyOf(target, id)) || !draft.text.trim() || sendingRef.current) return false;
    sendingRef.current = true; setSending(true);
    const submittedAt = Date.now();
    try {
      const result = await call(target, "turn/start", {
        threadId: id, input: referenceInput(draft),
        ...(model ? { model } : {}), ...(effort ? { effort } : {}),
      });
      const key = keyOf(target, id);
      if (result.turn && newThreads.current[key]) newThreads.current[key].relayHistoryPending = false;
      if (result.turn) setCache(previous => {
        const thread = previous[key]; if (!thread) return previous;
        const existing = (thread.turns || []).find((turn: Json) => turn.id === result.turn.id);
        const timing = { startedAtMs: submittedAt, ...existing?.relayTiming };
        const turns = existing
          ? thread.turns.map((turn: Json) => turn.id === result.turn.id ? { ...turn, relayTiming: timing } : turn)
          : [...(thread.turns || []), { ...result.turn, relayTiming: timing }];
        return { ...previous, [key]: { ...thread, turns } };
      });
      return true;
    } catch (error) { onErrorRef.current(message(error)); return false; }
    finally { sendingRef.current = false; if (target === active.current.device) setSending(false); }
  };
  const thread = selected ? cache[keyOf(device, selected)] : undefined;
  const session = selected ? sessions[keyOf(device, selected)] : undefined;
  const ready = !!session?.ready;
  const activeTurn = [...(thread?.turns || [])].reverse().find((turn: Json) => turn.status === "inProgress");
  const stop = async () => {
    if (!selected || !available || !resumed.current.has(keyOf(device, selected)) || !activeTurn?.id) return;
    try { await call(device, "turn/interrupt", { threadId: selected, turnId: activeTurn.id }); }
    catch (error) { onErrorRef.current(message(error)); }
  };
  const resolve = async (id: string, result: Json) => {
    const target = device;
    const current = active.current;
    if (target !== current.device || !current.available || !current.selected || !resumed.current.has(keyOf(target, current.selected))) {
      throw new Error("请先成功接续当前会话，再处理审批");
    }
    await call(target, "relay/approval", { id, result });
    setRequests(previous => ({ ...previous, [target]: (previous[target] || []).filter(request => request.id !== id) }));
  };
  const older = async () => {
    if (!selected || !olderCursor || opening) return;
    const target = device, id = selected, key = keyOf(device, selected), cursor = olderCursor;
    setOpening(true);
    try {
      const page = await call(target, "thread/turns/list", { threadId: id, cursor, limit: 20, sortDirection: "desc", itemsView: "full" });
      if (active.current.device !== target || active.current.selected !== id) return;
      setOlderCursor(page.nextCursor || null);
      setCache(previous => {
        const thread = previous[key]; if (!thread) return previous;
        const old = [...(page.data || [])].reverse().filter((turn: Json) => !thread.turns.some((t: Json) => t.id === turn.id));
        return { ...previous, [key]: { ...thread, turns: [...old, ...thread.turns] } };
      });
    } catch (error) { onErrorRef.current(message(error)); }
    finally { if (active.current.device === target && active.current.selected === id) setOpening(false); }
  };
  return {
    threads, selected, thread, models, environment, permissions, requests: requests[device] || [],
    archivedView, showArchived, changeArchive, archiveReason,
    isArchiveBusy: (id: string) => !!archiveBusy[keyOf(device, id)],
    search, setSearch, nextCursor, loading, opening, sending, activeTurn, olderCursor,
    ready, resumeError: session?.resumeError, historyError: session?.historyError,
    open, event, create, send, stop, resolve, older, refresh: () => setEnvironmentRevision(previous => previous + 1),
    loadMore: () => fetchList(nextCursor, search.trim()),
  };
}
