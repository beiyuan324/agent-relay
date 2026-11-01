import { useCallback, useEffect, useRef, useState } from "react";
import { call, message, type Json, type RelayEvent } from "./api";
import { referenceInput, type ComposerDraft } from "./mentions";
import { EMPTY_PROJECT_CATALOG, projectCatalog, type ProjectCatalog } from "./projects";
import { applyEvent, mergeLive, mergeApprovals, pruneCache, retainedBytes, type ApprovalUpdate } from "./workbench-state";
export { applyEvent } from "./workbench-state";

const keyOf = (device: string, thread: string) => JSON.stringify([device, thread]);
export function useWorkbench(device: string, available: boolean, onError: (error: string) => void) {
  const [threads, setThreads] = useState<Json[]>([]);
  const [archiveExpanded, setArchiveExpanded] = useState(false);
  const [archivedThreads, setArchivedThreads] = useState<Json[]>([]);
  const archivedListed = useRef(archivedThreads); archivedListed.current = archivedThreads;
  const [archivedNextCursor, setArchivedNextCursor] = useState<string | null>(null);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archivedError, setArchivedError] = useState("");
  const [archiveBusy, setArchiveBusy] = useState<Record<string, boolean>>({});
  const archiveMutations = useRef(new Set<string>());
  const archiveFlags = useRef<Record<string, boolean>>({});
  const [listRevision, setListRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [cache, updateCache] = useState<Record<string, Json>>({});
  const cached = useRef(cache); cached.current = cache;
  const cacheAccess = useRef(new Map<string, number>());
  const accessClock = useRef(0);
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
  const [projectRevision, setProjectRevision] = useState(0);
  const [projectState, setProjectState] = useState<{ device: string; value: ProjectCatalog }>({ device, value: EMPTY_PROJECT_CATALOG });
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState("");
  const refreshTargets = useRef(new Set<string>());
  const active = useRef({ device, selected, available, archiveExpanded });
  active.current = { device, selected, available, archiveExpanded };
  const events = useRef<Record<string, { turns: Record<string, number> }>>({});
  const approvalUpdates = useRef<Record<string, Map<string, ApprovalUpdate>>>({});
  const pendingEvents = useRef<{ key: string; id: string; value: Json; receivedAt: number }[]>([]);
  const pendingBytes = useRef(0);
  const scheduled = useRef<{ frame: number; timer: number } | null>(null);
  const sequence = useRef(0);
  const selection = useRef<Record<string, { id: string; archived: boolean }>>({});
  const listDevice = useRef(device);
  const listEpoch = useRef(0);
  const archivedListEpoch = useRef(0);
  const openEpoch = useRef(0);
  const processEpoch = useRef<Record<string, number>>({});
  const sendingRef = useRef(false);
  const onErrorRef = useRef(onError); onErrorRef.current = onError;

  const setCache = useCallback((update: (previous: Record<string, Json>) => Record<string, Json>) => {
    updateCache(previous => {
      const next = update(previous);
      const { device, selected } = active.current;
      const protectedKey = selected ? keyOf(device, selected) : null;
      for (const [key, thread] of Object.entries(next)) {
        if (thread !== previous[key] || key === protectedKey) cacheAccess.current.set(key, ++accessClock.current);
      }
      return pruneCache(next, protectedKey, cacheAccess.current);
    });
  }, []);

  const flushEvents = useCallback(() => {
    if (scheduled.current) {
      window.cancelAnimationFrame(scheduled.current.frame);
      window.clearTimeout(scheduled.current.timer);
      scheduled.current = null;
    }
    const batch = pendingEvents.current;
    pendingEvents.current = [];
    pendingBytes.current = 0;
    if (!batch.length) return;
    setCache(previous => {
      const next = { ...previous };
      for (const { key, id, value, receivedAt } of batch) {
        if (!next[key] && key !== keyOf(active.current.device, active.current.selected || "")) continue;
        next[key] = applyEvent(next[key] || { id, turns: [] }, value, receivedAt);
      }
      return next;
    });
  }, [setCache]);

  useEffect(() => () => {
    if (scheduled.current) {
      window.cancelAnimationFrame(scheduled.current.frame);
      window.clearTimeout(scheduled.current.timer);
      scheduled.current = null;
    }
    pendingEvents.current = [];
    pendingBytes.current = 0;
  }, []);

  useEffect(() => {
    for (const key of cacheAccess.current.keys()) {
      if (cache[key]) continue;
      cacheAccess.current.delete(key);
      delete events.current[key];
      resumed.current.delete(key);
    }
    setSessions(previous => {
      const entries = Object.entries(previous).filter(([key]) => cache[key]);
      return entries.length === Object.keys(previous).length ? previous : Object.fromEntries(entries);
    });
  }, [cache]);

  const recordApproval = useCallback((target: string, id: string, request?: Json) => {
    approvalUpdates.current[target]?.set(String(id), { sequence: ++sequence.current, request });
  }, []);

  useEffect(() => {
    if (!available) { setProjectsLoading(false); setProjectsError(""); return; }
    let stopped = false, fetching = false;
    const target = device;
    const load = async () => {
      if (fetching || stopped) return;
      fetching = true;
      setProjectsLoading(true);
      try {
        const value = projectCatalog(await call(target, "relay/projects", {}));
        if (!stopped) {
          setProjectState(previous => previous.device === target && JSON.stringify(previous.value) === JSON.stringify(value) ? previous : { device: target, value });
          setProjectsError("");
        }
      } catch (error) {
        if (!stopped) setProjectsError("无法同步 Codex 项目：" + message(error));
      } finally {
        fetching = false;
        if (!stopped) setProjectsLoading(false);
      }
    };
    void load();
    const focus = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(focus, 30000);
    window.addEventListener("focus", focus);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [device, available, environmentRevision, projectRevision]);

  const fetchList = useCallback(async (cursor: string | null = null, term = "", archived = false) => {
    if (!active.current.available || (archived && !active.current.archiveExpanded)) return;
    const target = active.current.device;
    const epochs = archived ? archivedListEpoch : listEpoch;
    const epoch = ++epochs.current;
    const loading = archived ? setArchivedLoading : setLoading;
    const rows = archived ? setArchivedThreads : setThreads;
    const nextCursor = archived ? setArchivedNextCursor : setNextCursor;
    loading(true);
    if (archived) setArchivedError("");
    const current = () => epoch === epochs.current && target === active.current.device && active.current.available && (!archived || active.current.archiveExpanded);
    try {
      const result = await call(target, "thread/list", { cursor, limit: 40, sortKey: "updated_at", archived, ...(term ? { searchTerm: term } : {}) });
      if (!current()) return;
      const data: Json[] = (result.data || []).map((thread: Json) => ({ ...thread, relayArchived: archived }));
      for (const thread of data) {
        archiveFlags.current[keyOf(target, thread.id)] = archived;
        if (!archived) delete newThreads.current[keyOf(target, thread.id)];
      }
      const query = term.toLocaleLowerCase();
      const pending = archived ? [] : Object.entries(newThreads.current)
        .filter(([key, thread]) => JSON.parse(key)[0] === target && (!query || [thread.name, thread.preview, thread.cwd].some(value => typeof value === "string" && value.toLocaleLowerCase().includes(query))))
        .map(([, thread]) => thread);
      rows(previous => {
        const listed = cursor ? [...previous, ...data.filter(thread => !previous.some(row => row.id === thread.id))] : data;
        return [...pending, ...listed.filter(thread => !pending.some(row => row.id === thread.id))];
      });
      nextCursor(result.nextCursor || null);
    } catch (error) {
      if (current()) {
        if (archived) setArchivedError(message(error));
        else onErrorRef.current(message(error));
      }
    } finally { if (current()) loading(false); }
  }, []);

  useEffect(() => {
    ++listEpoch.current; ++archivedListEpoch.current; ++openEpoch.current;
    if (listDevice.current !== device) { listDevice.current = device; active.current.archiveExpanded = false; setArchiveExpanded(false); }
    for (const key of resumed.current) if (JSON.parse(key)[0] === device) resumed.current.delete(key);
    setSessions(previous => Object.fromEntries(Object.entries(previous).map(([key, session]) =>
      [key, JSON.parse(key)[0] === device ? { ...session, ready: false } : session])));
    const restore = selection.current[device];
    setThreads(Object.entries(newThreads.current).filter(([key]) => JSON.parse(key)[0] === device).map(([, thread]) => thread)); setSelected(restore?.id || null); setEnvironment(null); setModels([]); setPermissions(null); setSearch(""); setNextCursor(null); setOlderCursor(null); setOpening(false); setSending(false); setLoading(false);
    setArchivedThreads([]); setArchivedNextCursor(null); setArchivedLoading(false); setArchivedError("");
    if (!available) return;
    if (restore) void open(restore.id, restore.archived);
    let stopped = false;
    const target = device;
    const refresh = refreshTargets.current.delete(target);
    const pendingStartedAt = sequence.current;
    const generation = processEpoch.current[target] || 0;
    const current = () => !stopped && generation === (processEpoch.current[target] || 0);
    const pendingUpdates = new Map<string, ApprovalUpdate>();
    approvalUpdates.current[target] = pendingUpdates;
    void Promise.allSettled([
      call(target, "relay/environment", { refresh }).then(result => { if (current()) setEnvironment(result); }),
      (async () => {
        let cursor: string | null = null;
        const all: Json[] = [];
        do {
          const result: Json = await call(target, "model/list", { limit: 100, cursor });
          all.push(...(result.data || []));
          cursor = result.nextCursor || null;
        } while (cursor && all.length < 1000 && current());
        if (current()) setModels(all);
      })(),
      call(target, "relay/pending").then(result => {
        if (current()) setRequests(previous => ({ ...previous, [target]: mergeApprovals(result.requests || [], pendingUpdates, pendingStartedAt) }));
      }).finally(() => { if (approvalUpdates.current[target] === pendingUpdates) delete approvalUpdates.current[target]; }),
    ]).then(results => {
      if (current()) {
        const failure = results.find(result => result.status === "rejected");
        if (failure?.status === "rejected") onErrorRef.current(message(failure.reason));
      }
    });
    return () => { stopped = true; if (approvalUpdates.current[target] === pendingUpdates) delete approvalUpdates.current[target]; };
  }, [device, available, environmentRevision]);

  useEffect(() => {
    if (!available) return;
    const timer = window.setTimeout(() => { void fetchList(null, search.trim()); }, 250);
    return () => window.clearTimeout(timer);
  }, [device, available, search, listRevision, fetchList, environmentRevision]);

  useEffect(() => {
    ++archivedListEpoch.current;
    setArchivedLoading(available && archiveExpanded); setArchivedError("");
    setArchivedThreads([]); setArchivedNextCursor(null);
    if (!available || !archiveExpanded) return;
    const timer = window.setTimeout(() => { void fetchList(null, search.trim(), true); }, 250);
    return () => window.clearTimeout(timer);
  }, [device, available, search, archiveExpanded, listRevision, fetchList, environmentRevision]);

  const open = useCallback(async (id: string, archivedHint?: boolean) => {
    const target = active.current.device;
    if (!active.current.available) return;
    flushEvents();
    const key = keyOf(target, id);
    if (archiveMutations.current.has(key)) return;
    const archived = archivedHint ?? archiveFlags.current[key] ?? false;
    if (archiveFlags.current[key] !== undefined && archiveFlags.current[key] !== archived) return;
    const epoch = ++openEpoch.current;
    const startedAt = sequence.current;
    selection.current[target] = { id, archived };
    resumed.current.delete(key);
    setSessions(previous => ({ ...previous, [key]: { ready: false } }));
    active.current = { ...active.current, selected: id };
    setSelected(id); setOpening(true); setPermissions(null); setOlderCursor(null);
    const summary = (archived ? archivedListed.current : listed.current).find(thread => thread.id === id);
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
      flushEvents();
      const touched = new Set(Object.entries(events.current[key]?.turns || {}).filter(([, updated]) => updated > startedAt).map(([id]) => id));
      // Merge live snapshots; replaying deltas onto a fetched snapshot can duplicate text.
      setCache(previous => {
        const history = { ...previous[key], ...thread, turns: historyError ? previous[key]?.turns || thread.turns || [] : thread.turns || [] };
        return { ...previous, [key]: { ...mergeLive(history, previous[key], touched), interrupted: false, relayArchived: archived } };
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
  }, [flushEvents, setCache]);

  const toggleArchive = useCallback(() => {
    const expanded = !active.current.archiveExpanded;
    active.current = { ...active.current, archiveExpanded: expanded };
    if (!expanded) { ++archivedListEpoch.current; setArchivedLoading(false); }
    setArchiveExpanded(expanded);
  }, []);

  const applyArchiveState = useCallback((target: string, id: string, archived: boolean) => {
    const key = keyOf(target, id);
    if (archiveFlags.current[key] === archived) return;
    archiveFlags.current[key] = archived;
    delete newThreads.current[key];
    resumed.current.delete(key);
    setSessions(previous => ({ ...previous, [key]: { ready: false } }));
    setCache(previous => previous[key] ? { ...previous, [key]: { ...previous[key], relayArchived: archived } } : previous);
    if (selection.current[target]?.id === id) delete selection.current[target];
    if (target !== active.current.device) return;
    ++listEpoch.current; ++archivedListEpoch.current;
    setLoading(false); setNextCursor(null); setArchivedLoading(false); setArchivedNextCursor(null);
    setThreads(previous => previous.filter(thread => thread.id !== id));
    setArchivedThreads(previous => previous.filter(thread => thread.id !== id));
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
      flushEvents();
      delete approvalUpdates.current[target];
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
      recordApproval(target, String(value.id), value);
      setRequests(previous => ({ ...previous, [target]: [...(previous[target] || []).filter(r => r.id !== value.id), value] }));
      return;
    }
    if (value.method === "relay/approvalResolved" || value.method === "serverRequest/resolved") {
      recordApproval(target, String(p.id ?? p.requestId));
      setRequests(previous => ({ ...previous, [target]: (previous[target] || []).filter(r => r.id !== (p.id || p.requestId)) }));
    }
    if (value.method === "project/changed" || value.method === "thread/project/updated") {
      if (target === active.current.device) {
        setProjectRevision(previous => previous + 1);
        setListRevision(previous => previous + 1);
      }
      return;
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
    if (target === active.current.device && archiveFlags.current[key] !== true && value.method === "thread/started" && p.thread) {
      setThreads(previous => [p.thread, ...previous.filter(t => t.id !== p.thread.id)]);
    }
    if (!cached.current[key] && key !== keyOf(active.current.device, active.current.selected || "")) return;
    const entry = events.current[key] ||= { turns: {} };
    const turnId = p.turnId || p.turn?.id;
    if (turnId) entry.turns[turnId] = ++sequence.current;
    const turns = Object.entries(entry.turns);
    if (turns.length > 512) entry.turns = Object.fromEntries(turns.sort((a, b) => b[1] - a[1]).slice(0, 512));
    pendingEvents.current.push({ key, id, value, receivedAt: Date.now() });
    pendingBytes.current += retainedBytes(value);
    if (pendingEvents.current.length >= 512 || pendingBytes.current >= 2 * 1024 * 1024) flushEvents();
    else if (!scheduled.current) {
      scheduled.current = {
        frame: window.requestAnimationFrame(flushEvents),
        timer: window.setTimeout(flushEvents, 100),
      };
    }
  }, [applyArchiveState, flushEvents, recordApproval, setCache]);

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

  const create = async (cwd: string, model: string, expectedDevice: string, projectId?: string) => {
    const target = active.current.device;
    if (target !== expectedDevice || !active.current.available) throw new Error("执行电脑已切换或离线，请重新选择设备后新建会话");
    const epoch = openEpoch.current;
    const generation = processEpoch.current[target] || 0;
    const result = await call(target, "thread/start", { cwd, ...(model ? { model } : {}), ...(projectId ? { projectId } : {}) });
    if (generation !== (processEpoch.current[target] || 0)) throw new Error("Codex 进程已退出，新建会话尚未保存，请重新新建会话");
    const thread = result.thread;
    if (!thread?.id) throw new Error("Codex 返回了无效的会话数据");
    const key = keyOf(target, thread.id);
    newThreads.current[key] = { ...thread, relayHistoryPending: true };
    setCache(previous => ({ ...previous, [key]: { ...previous[key], ...thread, turns: previous[key]?.turns || thread.turns || [] } }));
    if (target !== active.current.device) return;
    if (epoch !== openEpoch.current || !active.current.available) {
      setThreads(previous => [thread, ...previous.filter(t => t.id !== thread.id)]);
      return;
    }
    ++openEpoch.current; ++listEpoch.current;
    setListRevision(previous => previous + 1);
    active.current = { ...active.current, selected: thread.id };
    setLoading(false); setNextCursor(null);
    setThreads(previous => [thread, ...previous.filter(t => t.id !== thread.id)]);
    selection.current[target] = { id: thread.id, archived: false };
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
    const generation = processEpoch.current[target] || 0;
    try {
      const result = await call(target, "turn/start", {
        threadId: id, input: referenceInput(draft),
        ...(model ? { model } : {}), ...(effort ? { effort } : {}),
      });
      if (generation !== (processEpoch.current[target] || 0)) throw new Error("Codex 进程已退出，请重新读取会话确认提交状态");
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
    recordApproval(target, id);
    setRequests(previous => ({ ...previous, [target]: (previous[target] || []).filter(request => request.id !== id) }));
  };
  const older = async () => {
    if (!selected || !olderCursor || opening || !available) return;
    const target = device, id = selected, key = keyOf(device, selected), cursor = olderCursor;
    const epoch = ++openEpoch.current;
    const generation = processEpoch.current[target] || 0;
    const current = () => epoch === openEpoch.current && generation === (processEpoch.current[target] || 0) && active.current.available && active.current.device === target && active.current.selected === id;
    setOpening(true);
    try {
      const page = await call(target, "thread/turns/list", { threadId: id, cursor, limit: 20, sortDirection: "desc", itemsView: "full" });
      if (!current()) return;
      if (!Array.isArray(page.data)) throw new Error("Codex 返回了无效的回合列表");
      setOlderCursor(page.nextCursor || null);
      setCache(previous => {
        const thread = previous[key]; if (!thread) return previous;
        const old = [...(page.data || [])].reverse().filter((turn: Json) => !thread.turns.some((t: Json) => t.id === turn.id));
        return { ...previous, [key]: { ...thread, turns: [...old, ...thread.turns] } };
      });
    } catch (error) { if (current()) onErrorRef.current(message(error)); }
    finally { if (current()) setOpening(false); }
  };
  return {
    threads, selected, thread, models, environment, permissions, requests: requests[device] || [],
    projectCatalog: projectState.device === device && available ? projectState.value : EMPTY_PROJECT_CATALOG,
    projectsLoading, projectsError,
    archivedThreads, archivedNextCursor, archivedLoading, archivedError, archiveExpanded, toggleArchive,
    changeArchive, archiveReason,
    isArchiveBusy: (id: string) => !!archiveBusy[keyOf(device, id)],
    search, setSearch, nextCursor, loading, opening, sending, activeTurn, olderCursor,
    ready, resumeError: session?.resumeError, historyError: session?.historyError,
    open, event, create, send, stop, resolve, older,
    refresh: () => { refreshTargets.current.add(active.current.device); setEnvironmentRevision(previous => previous + 1); },
    loadMore: () => fetchList(nextCursor, search.trim()),
    loadMoreArchived: () => fetchList(archivedNextCursor, search.trim(), true),
    retryArchived: () => fetchList(null, search.trim(), true),
  };
}
