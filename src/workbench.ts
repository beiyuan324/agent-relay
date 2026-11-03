import { useCallback, useEffect, useRef, useState } from "react";
import { call, message, type Json, type RelayEvent } from "./api";
import { referenceInput, type ComposerDraft } from "./mentions";
import type { CollaborationMode } from "./slash-commands";
import { EMPTY_PROJECT_CATALOG, projectCatalog, type ProjectCatalog } from "./projects";
import { applyEvent, mergeLive, mergeApprovals, pruneCache, retainedBytes, type ApprovalUpdate } from "./workbench-state";
export { applyEvent } from "./workbench-state";

export interface QueuedMessage {
  id: string;
  draft: ComposerDraft;
  model: string;
  effort: string;
  collaborationMode?: CollaborationMode;
  serviceTier?: string;
  status: "queued" | "sending" | "failed";
  error?: string;
}
interface MessageQueue { items: QueuedMessage[]; paused?: string }
const keyOf = (device: string, thread: string) => JSON.stringify([device, thread]);
export function useWorkbench(device: string, available: boolean, onError: (error: string) => void, availableDevices?: ReadonlySet<string>) {
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
  const [commandState, setCommandState] = useState<Record<string, string>>({});
  const commandLocks = useRef<Record<string, string>>({});
  const commandTokens = useRef<Record<string, string>>({});
  const goalVersions = useRef<Record<string, number>>({});
  const updateCommand = useCallback((key: string, label?: string) => {
    if (!label && !commandLocks.current[key]) return;
    if (label) commandLocks.current[key] = label;
    else { delete commandLocks.current[key]; delete commandTokens.current[key]; }
    setCommandState({ ...commandLocks.current });
  }, []);
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
  const [queues, setQueues] = useState<Record<string, MessageQueue>>({});
  const queued = useRef(queues);
  const inFlight = useRef<{ key: string } | null>(null);
  const liveTurns = useRef<Record<string, { id: string; status: string; sequence: number }>>({});
  const connected = useRef<ReadonlySet<string>>(new Set());
  connected.current = availableDevices || new Set(available ? [device] : []);
  const onErrorRef = useRef(onError); onErrorRef.current = onError;

  const updateQueues = useCallback((update: (previous: Record<string, MessageQueue>) => Record<string, MessageQueue>) => {
    const next = update(queued.current);
    if (next === queued.current) return;
    queued.current = Object.fromEntries(Object.entries(next).filter(([, queue]) => queue.items.length));
    setQueues(queued.current);
  }, []);
  const pauseQueue = useCallback((key: string, reason: string) => {
    updateQueues(previous => !previous[key]?.items.length || previous[key].paused === reason ? previous : {
      ...previous, [key]: { ...previous[key], paused: reason },
    });
  }, [updateQueues]);

  useEffect(() => {
    for (const key of resumed.current) {
      if (!connected.current.has(JSON.parse(key)[0])) resumed.current.delete(key);
    }
  }, [availableDevices, device, available]);

  const setCache = useCallback((update: (previous: Record<string, Json>) => Record<string, Json>) => {
    updateCache(previous => {
      const next = update(previous);
      const { device, selected } = active.current;
      const protectedKey = selected ? keyOf(device, selected) : null;
      for (const [key, thread] of Object.entries(next)) {
        if (thread !== previous[key] || key === protectedKey) cacheAccess.current.set(key, ++accessClock.current);
      }
      const protectedKeys = new Set(Object.keys(queued.current));
      if (protectedKey) protectedKeys.add(protectedKey);
      return pruneCache(next, protectedKeys, cacheAccess.current);
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
      delete liveTurns.current[key];
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
      const data: Json[] = (result.data || [])
        .filter((thread: Json) => archived || newThreads.current[keyOf(target, thread.id)]?.relayHistoryPending !== true)
        .map((thread: Json) => ({ ...thread, relayArchived: archived }));
      for (const thread of data) {
        archiveFlags.current[keyOf(target, thread.id)] = archived;
        if (!archived) delete newThreads.current[keyOf(target, thread.id)];
      }
      const query = term.toLocaleLowerCase();
      const pending = archived ? [] : Object.entries(newThreads.current)
        .filter(([key, thread]) => JSON.parse(key)[0] === target && thread.relayHistoryPending === false && (!query || [thread.name, thread.preview, thread.cwd].some(value => typeof value === "string" && value.toLocaleLowerCase().includes(query))))
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
    const changedDevice = listDevice.current !== device;
    if (changedDevice) {
      listDevice.current = device;
      const restore = selection.current[device];
      active.current = { ...active.current, selected: restore?.id || null, archiveExpanded: false };
      setArchiveExpanded(false);
      setThreads(Object.entries(newThreads.current).filter(([key, thread]) => JSON.parse(key)[0] === device && thread.relayHistoryPending === false).map(([, thread]) => thread)); setSelected(restore?.id || null); setEnvironment(null); setModels([]); setPermissions(null); setSearch(""); setNextCursor(null); setOlderCursor(null); setSending(false);
      setArchivedThreads([]); setArchivedNextCursor(null); setArchivedError("");
    }
    ++listEpoch.current; ++archivedListEpoch.current; ++openEpoch.current;
    flushEvents();
    for (const key of resumed.current) if (JSON.parse(key)[0] === device) resumed.current.delete(key);
    setSessions(previous => Object.fromEntries(Object.entries(previous).map(([key, session]) =>
      [key, JSON.parse(key)[0] === device ? { ...session, ready: false } : session])));
    setOpening(false); setLoading(false); setArchivedLoading(false);
    if (!available) return;
    const restore = selection.current[device];
    if (restore) void open(restore.id, restore.archived, { preserveHistory: !changedDevice });
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
  }, [device, available, environmentRevision, flushEvents]);

  useEffect(() => {
    if (!available) return;
    const timer = window.setTimeout(() => { void fetchList(null, search.trim()); }, 250);
    return () => window.clearTimeout(timer);
  }, [device, available, search, listRevision, fetchList, environmentRevision]);

  useEffect(() => {
    ++archivedListEpoch.current;
    setArchivedLoading(available && archiveExpanded); setArchivedError("");
    if (!available || !archiveExpanded) return;
    const timer = window.setTimeout(() => { void fetchList(null, search.trim(), true); }, 250);
    return () => window.clearTimeout(timer);
  }, [device, available, search, archiveExpanded, listRevision, fetchList, environmentRevision]);

  const open = useCallback(async (id: string, archivedHint?: boolean, options: { preserveHistory?: boolean } = {}) => {
    const target = active.current.device;
    if (!active.current.available) return;
    flushEvents();
    const key = keyOf(target, id);
    if (archiveMutations.current.has(key)) return;
    const archived = archivedHint ?? archiveFlags.current[key] ?? false;
    if (archiveFlags.current[key] !== undefined && archiveFlags.current[key] !== archived) return;
    const preserveHistory = !!options.preserveHistory && !!cached.current[key];
    const retainedTurns: Json[] = preserveHistory ? cached.current[key].turns || [] : [];
    const retainedIds = new Set(retainedTurns.map(turn => turn.id));
    const epoch = ++openEpoch.current;
    const current = () => epoch === openEpoch.current && target === active.current.device && active.current.available;
    const startedAt = sequence.current;
    selection.current[target] = { id, archived };
    resumed.current.delete(key);
    delete liveTurns.current[key];
    setSessions(previous => ({ ...previous, [key]: { ready: false } }));
    active.current = { ...active.current, selected: id };
    setSelected(id); setOpening(true);
    if (!preserveHistory) { setPermissions(null); setOlderCursor(null); }
    const summary = (archived ? archivedListed.current : listed.current).find(thread => thread.id === id);
    if (!preserveHistory) setCache(previous => ({ ...previous, [key]: { ...summary, ...previous[key], id, relayArchived: archived, turns: previous[key]?.turns || [] } }));
    try {
      let result: Json | undefined;
      let resumeError = "", historyError = "";
      try {
        const draft = newThreads.current[key];
        result = !archived && draft?.relayDraft
          ? { thread: draft, relayHistoryPending: true, model: draft.relayModel }
          : await call(target, archived ? "thread/read" : "thread/resume", { threadId: id, ...(archived ? { includeTurns: false } : {}) });
        if (!result?.thread) throw new Error("Codex 返回了无效的会话数据，请检查版本兼容性");
      } catch (error) { result = undefined; if (!archived) resumeError = message(error); }
      if (!current()) return;
      let thread: Json = result?.thread || { ...summary, id };
      let cursor: string | null = null;
      if (result?.relayHistoryPending === true) {
        // Local drafts and newly started sessions have no persisted history yet.
        thread = { ...newThreads.current[key], ...thread };
        newThreads.current[key] = { ...thread, relayHistoryPending: true };
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
      if (!current()) return;
      try {
        const turns: Json[] = [];
        const seenCursors = new Set<string>();
        do {
          if (cursor) {
            if (seenCursors.has(cursor)) throw new Error("Codex 返回了重复的历史分页游标");
            seenCursors.add(cursor);
          }
          const page: Json = await call(target, "thread/turns/list", { threadId: id, limit: 20, sortDirection: "desc", itemsView: "full", ...(cursor ? { cursor } : {}) });
          if (!current()) return;
          if (!Array.isArray(page.data)) throw new Error("Codex 返回了无效的回合列表");
          turns.push(...page.data);
          cursor = page.nextCursor || null;
          if (!retainedIds.size || page.data.some((turn: Json) => retainedIds.has(turn.id))) break;
        } while (cursor);
        thread = { ...thread, turns: turns.reverse() };
      } catch (pageError) {
        if (!current()) return;
        try {
          const history = await call(target, "thread/read", { threadId: id, includeTurns: true });
          if (!Array.isArray(history.thread?.turns)) throw new Error("Codex 未返回会话历史");
          thread = history.thread;
        } catch (error) {
          historyError = `无法更新历史：${message(pageError)}；完整历史读取：${message(error)}。当前内容可能不完整。`;
        }
      }
      if (!current()) return;
      const latest = (thread.turns || []).at(-1);
      if (thread.status?.type !== "active" && !(thread.turns || []).some((turn: Json) => turn.status === "inProgress")) updateCommand(key);
      if (historyError) pauseQueue(key, "会话历史未同步完整，请重新读取后继续队列");
      else if (latest && ["failed", "interrupted"].includes(latest.status)) pauseQueue(key, "上个回合未正常完成，队列已暂停");
      flushEvents();
      const touched = new Set(Object.entries(events.current[key]?.turns || {}).filter(([, updated]) => updated > startedAt).map(([id]) => id));
      // Merge live snapshots; replaying deltas onto a fetched snapshot can duplicate text.
      const refreshedIds = new Set((thread.turns || []).map((turn: Json) => turn.id));
      const overlap = retainedTurns.findIndex(turn => refreshedIds.has(turn.id));
      const retainedPrefix = preserveHistory && !historyError ? retainedTurns.slice(0, overlap < 0 ? retainedTurns.length : overlap) : [];
      setCache(previous => {
        const history = { ...previous[key], ...thread, turns: historyError ? previous[key]?.turns || thread.turns || [] : [...retainedPrefix, ...(thread.turns || [])] };
        return { ...previous, [key]: { ...mergeLive(history, previous[key], touched), relayMode: previous[key]?.relayMode ?? result?.collaborationMode?.mode, relayServiceTier: previous[key]?.relayServiceTier ?? result?.serviceTier ?? undefined, interrupted: false, relayArchived: archived } };
      });
      if (result && !archived) {
        resumed.current.add(key);
        setPermissions({ approvalPolicy: result.approvalPolicy, sandbox: result.sandbox, model: result.model, reasoningEffort: result.reasoningEffort });
      }
      if (!preserveHistory || (!historyError && overlap < 0)) setOlderCursor(cursor);
      setSessions(previous => ({ ...previous, [key]: { ready: !!result && !archived, resumeError, historyError } }));
    } catch (error) {
      if (current()) {
        setCache(previous => ({ ...previous, [key]: previous[key] || { ...summary, id, turns: [] } }));
        setSessions(previous => ({ ...previous, [key]: { ready: false, ...(archived ? { historyError: message(error) } : { resumeError: message(error) }) } }));
      }
    } finally { if (epoch === openEpoch.current) setOpening(false); }
  }, [flushEvents, pauseQueue, setCache, updateCommand]);

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
    if (archived) pauseQueue(key, "会话已归档，恢复会话后可继续队列");
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
  }, [pauseQueue]);

  const materializeThread = useCallback((target: string, id: string) => {
    const key = keyOf(target, id);
    const pending = newThreads.current[key];
    if (!pending || pending.relayDraft || archiveFlags.current[key] === true) return;
    const thread = { ...pending, relayHistoryPending: false };
    newThreads.current[key] = thread;
    if (target === active.current.device) setThreads(previous => [thread, ...previous.filter(row => row.id !== id)]);
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
      for (const key of Object.keys(commandLocks.current)) if (JSON.parse(key)[0] === target) updateCommand(key);
      for (const key of Object.keys(queued.current)) {
        if (JSON.parse(key)[0] === target) pauseQueue(key, "Codex 已退出，重新接续会话后可继续队列");
      }
      for (const key of Object.keys(liveTurns.current)) if (JSON.parse(key)[0] === target) delete liveTurns.current[key];
      const endedAt = Date.now();
      const discarded = new Set<string>();
      for (const [key, thread] of Object.entries(newThreads.current)) {
        if (JSON.parse(key)[0] === target && thread.relayHistoryPending === true && !thread.relayDraft) {
          discarded.add(thread.id);
          delete newThreads.current[key];
        }
      }
      if (active.current.device === target) setThreads(previous => previous.filter(thread => !discarded.has(thread.id)));
      for (const key of resumed.current) if (JSON.parse(key)[0] === target) resumed.current.delete(key);
      setSessions(previous => Object.fromEntries(Object.entries(previous).map(([key, session]) =>
        [key, JSON.parse(key)[0] === target && !newThreads.current[key]?.relayDraft ? { ...session, ready: false, resumeError: archiveFlags.current[key] ? undefined : p.reason || "Codex 进程已退出，请重试接续" } : session])));
      if (active.current.device === target) { ++openEpoch.current; setOpening(false); setPermissions(null); }
      setRequests(previous => ({ ...previous, [target]: [] }));
      setCache(previous => Object.fromEntries(Object.entries(previous).map(([key, thread]) => {
        if (JSON.parse(key)[0] !== target || thread.relayDraft) return [key, thread];
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
    if (value.method === "turn/completed" || value.method === "thread/closed") updateCommand(key);
    if (value.method === "thread/goal/updated" || value.method === "thread/goal/cleared") goalVersions.current[key] = (goalVersions.current[key] || 0) + 1;
    if (value.method === "thread/name/updated" && target === active.current.device) {
      setThreads(previous => previous.map(thread => thread.id === id ? { ...thread, name: p.threadName ?? p.name } : thread));
      setArchivedThreads(previous => previous.map(thread => thread.id === id ? { ...thread, name: p.threadName ?? p.name } : thread));
    }
    if (value.method === "thread/archived" || value.method === "thread/unarchived") {
      applyArchiveState(target, id, value.method === "thread/archived");
      return;
    }
    if (value.method === "thread/status/changed" && p.status?.type === "active" && liveTurns.current[key]?.status !== "inProgress") delete liveTurns.current[key];
    if ((value.method === "turn/started" || value.method === "turn/completed") && (cached.current[key] || queued.current[key])) {
      liveTurns.current[key] = { id: p.turn?.id || p.turnId, status: p.turn?.status || (value.method === "turn/started" ? "inProgress" : "completed"), sequence: ++sequence.current };
      if (value.method === "turn/completed" && liveTurns.current[key].status !== "completed") {
        pauseQueue(key, liveTurns.current[key].status === "interrupted" ? "当前回合已停止，队列已暂停" : "当前回合未正常完成，队列已暂停");
      }
    }
    if (value.method === "thread/closed") {
      resumed.current.delete(key);
      pauseQueue(key, "会话已关闭，重新接续后可继续队列");
    }
    if (value.method === "turn/started") {
      materializeThread(target, id);
      if (target === active.current.device && !newThreads.current[key] && !listed.current.some(thread => thread.id === id)) setListRevision(previous => previous + 1);
    }
    if (value.method === "thread/started" && p.thread && newThreads.current[key]) {
      const pending = newThreads.current[key];
      newThreads.current[key] = { ...pending, ...p.thread, preview: p.thread.preview || pending.preview };
    }
    const hasConversation = newThreads.current[key]?.relayHistoryPending !== true && (p.thread?.preview?.trim() || p.thread?.turns?.length || cached.current[key]?.turns?.length);
    if (target === active.current.device && archiveFlags.current[key] !== true && value.method === "thread/started" && p.thread && hasConversation) {
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
  }, [applyArchiveState, flushEvents, materializeThread, pauseQueue, recordApproval, setCache, updateCommand]);

  const archiveReason = (thread: Json): string => {
    const key = keyOf(device, thread.id);
    const current = cache[key] || thread;
    if (!available) return "连接设备后可归档";
    if (archiveBusy[key]) return "正在更新归档状态";
    if (newThreads.current[key]?.relayHistoryPending === true) return "发送首条消息后可归档";
    if (selected === thread.id && opening) return "正在读取会话";
    if (commandLocks.current[key]) return commandLocks.current[key];
    if (inFlight.current?.key === key) return "正在发送消息";
    if (queued.current[key]?.items.length) return "请先处理此会话的待发消息";
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
    if (sendingRef.current) throw new Error("正在发送消息，请稍候");
    const existing = Object.entries(newThreads.current).find(([key, thread]) =>
      JSON.parse(key)[0] === target && thread.relayHistoryPending === true && thread.cwd === cwd && (thread.projectId || "") === (projectId || ""));
    if (existing) { await open(existing[1].id); return; }
    const id = "draft:" + crypto.randomUUID();
    const thread: Json = { id, cwd, ...(projectId ? { projectId } : {}), turns: [], relayDraft: true, relayDraftId: id, relayModel: model, relayHistoryPending: true };
    const key = keyOf(target, id);
    newThreads.current[key] = thread;
    ++openEpoch.current;
    active.current = { ...active.current, selected: id };
    setCache(previous => ({ ...previous, [key]: thread }));
    selection.current[target] = { id: thread.id, archived: false };
    resumed.current.add(key);
    setSelected(thread.id); setOpening(false); setSearch(""); setOlderCursor(null);
    setPermissions({ model });
    setSessions(previous => ({ ...previous, [key]: { ready: true } }));
  };
  const submit = useCallback(async (target: string, selectedId: string, item: QueuedMessage) => {
    if (sendingRef.current || queued.current[keyOf(target, selectedId)]?.items[0]?.id !== item.id || queued.current[keyOf(target, selectedId)]?.items[0]?.status !== "queued") return;
    let id = selectedId;
    const { draft, model, effort, collaborationMode, serviceTier } = item;
    const flight = { key: keyOf(target, id) };
    inFlight.current = flight;
    sendingRef.current = true; setSending(true);
    updateQueues(previous => ({ ...previous, [flight.key]: { ...previous[flight.key], items: previous[flight.key].items.map(row => row.id === item.id ? { ...row, status: "sending" } : row) } }));
    const submittedAt = Date.now();
    const submittedSequence = sequence.current;
    const generation = processEpoch.current[target] || 0;
    try {
      const draftKey = keyOf(target, id);
      const pendingDraft = newThreads.current[draftKey];
      if (pendingDraft?.relayDraft) {
        const created = await call(target, "thread/start", { cwd: pendingDraft.cwd, ...(model ? { model } : {}), ...(pendingDraft.projectId ? { projectId: pendingDraft.projectId } : {}) });
        if (generation !== (processEpoch.current[target] || 0)) throw new Error("Codex 进程已退出，请重新发送消息");
        if (!created.thread?.id) throw new Error("Codex 返回了无效的会话数据");
        id = created.thread.id as string;
        const key = keyOf(target, id);
        const thread = { ...pendingDraft, ...created.thread, preview: created.thread.preview || draft.text.trim(), relayDraft: false, relayDraftId: pendingDraft.relayDraftId, relayHistoryPending: true };
        newThreads.current[key] = thread;
        delete newThreads.current[draftKey];
        resumed.current.delete(draftKey);
        resumed.current.add(key);
        flight.key = key;
        updateQueues(previous => {
          const next = { ...previous, [key]: previous[draftKey] };
          delete next[draftKey];
          return next;
        });
        if (selection.current[target]?.id === selectedId) selection.current[target] = { id, archived: false };
        if (target === active.current.device && active.current.selected === selectedId) {
          ++openEpoch.current;
          active.current = { ...active.current, selected: id };
          setSelected(id); setOpening(false);
          setPermissions({ approvalPolicy: created.approvalPolicy, sandbox: created.sandbox, model: created.model, reasoningEffort: created.reasoningEffort });
        }
        setCache(previous => {
          const next = { ...previous, [key]: thread };
          delete next[draftKey];
          return next;
        });
        setSessions(previous => {
          const next = { ...previous, [key]: { ready: true } };
          delete next[draftKey];
          return next;
        });
      }
      if (!connected.current.has(target) || generation !== (processEpoch.current[target] || 0) || !resumed.current.has(keyOf(target, id))) throw new Error("连接或会话状态已变化，请重新接续后发送");
      const result = await call(target, "turn/start", {
        threadId: id, input: referenceInput(draft),
        ...(model ? { model } : {}), ...(effort ? { effort } : {}),
        ...(collaborationMode ? { collaborationMode: { mode: collaborationMode, settings: { model, reasoning_effort: effort || null, developer_instructions: null } } } : {}),
        ...(serviceTier ? { serviceTier } : {}),
      });
      if (generation !== (processEpoch.current[target] || 0)) throw new Error("Codex 进程已退出，请重新读取会话确认提交状态");
      const key = keyOf(target, id);
      if (!result.turn?.id) throw new Error("未收到回合确认，请查看会话后重试或移除此消息");
      const observed = liveTurns.current[key];
      // A completion notification (or a newer turn) can arrive before this reply.
      if (!observed || observed.sequence <= submittedSequence || (observed.id === result.turn.id && observed.status === "inProgress")) {
        liveTurns.current[key] = { id: result.turn.id, status: result.turn.status || "inProgress", sequence: observed?.id === result.turn.id ? observed.sequence : submittedSequence };
      }
      if (result.turn?.id) {
        if (newThreads.current[key] && !newThreads.current[key].preview) newThreads.current[key].preview = draft.text.trim();
        materializeThread(target, id);
      }
      if (result.turn) setCache(previous => {
        const thread = previous[key]; if (!thread) return previous;
        const existing = (thread.turns || []).find((turn: Json) => turn.id === result.turn.id);
        const timing = { startedAtMs: submittedAt, ...existing?.relayTiming };
        const turns = existing
          ? thread.turns.map((turn: Json) => turn.id === result.turn.id ? { ...result.turn, ...turn, status: turn.status !== "inProgress" ? turn.status : result.turn.status || turn.status, relayTiming: timing } : turn)
          : [...(thread.turns || []), { ...result.turn, relayTiming: timing }];
        return { ...previous, [key]: { ...thread, turns } };
      });
      if (["failed", "interrupted"].includes(liveTurns.current[key]?.status || "")) pauseQueue(key, "当前回合未正常完成，队列已暂停");
      updateQueues(previous => !previous[flight.key] ? previous : ({
        ...previous, [flight.key]: { ...previous[flight.key], items: previous[flight.key].items.filter(row => row.id !== item.id) },
      }));
    } catch (error) {
      const detail = message(error);
      updateQueues(previous => !previous[flight.key] ? previous : ({
        ...previous, [flight.key]: { ...previous[flight.key], paused: "发送未完成，请查看会话后重试或移除此消息", items: previous[flight.key].items.map(row => row.id === item.id ? { ...row, status: "failed", error: detail } : row) },
      }));
      onErrorRef.current(detail);
    } finally {
      inFlight.current = null;
      sendingRef.current = false;
      setSending(false);
    }
  }, [materializeThread, pauseQueue, setCache, updateQueues]);

  const send = async (draft: ComposerDraft, model: string, effort: string, collaborationMode?: CollaborationMode, serviceTier?: string): Promise<boolean> => {
    const { device: target, selected: id, available } = active.current;
    if (!id || !available || !resumed.current.has(keyOf(target, id)) || archiveFlags.current[keyOf(target, id)] === true || archiveMutations.current.has(keyOf(target, id)) || !draft.text.trim()) return false;
    const key = keyOf(target, id);
    if (commandLocks.current[key]) { onErrorRef.current(commandLocks.current[key]); return false; }
    if (collaborationMode && !model) { onErrorRef.current("请选择模型后再使用协作模式"); return false; }
    const item: QueuedMessage = { id: crypto.randomUUID(), draft: { text: draft.text, mentions: draft.mentions.map(mention => ({ ...mention })) }, model, effort, collaborationMode, serviceTier, status: "queued" };
    updateQueues(previous => ({ ...previous, [key]: { ...previous[key], items: [...(previous[key]?.items || []), item] } }));
    return true;
  };

  useEffect(() => {
    if (sendingRef.current) return;
    for (const [key, queue] of Object.entries(queues)) {
      const [target, id] = JSON.parse(key) as [string, string];
      const item = queue.items[0], thread = cache[key];
      if (commandLocks.current[key]) continue;
      if (!item || item.status !== "queued" || queue.paused || !connected.current.has(target) || !resumed.current.has(key) || !thread || thread.relayArchived || archiveFlags.current[key] || archiveMutations.current.has(key)) continue;
      const live = liveTurns.current[key];
      if (live?.status === "inProgress" || (!live && thread.status?.type === "active") || (thread.turns || []).some((turn: Json) => turn.status === "inProgress" && !(live && live.id === turn.id && live.status !== "inProgress"))) continue;
      if (pendingEvents.current.some(event => event.key === key)) continue;
      if ((requests[target] || []).some(request => !request.params?.threadId || request.params.threadId === id)) continue;
      void submit(target, id, item);
      break;
    }
  }, [queues, cache, sessions, requests, device, available, availableDevices, sending, submit, commandState]);

  const runCommand = async (method: string, params: Json = {}, expected = { device, id: selected }): Promise<Json> => {
    const current = active.current, target = expected.device, id = expected.id;
    if (!id || current.device !== target || current.selected !== id || !current.available || !resumed.current.has(keyOf(target, id))) throw new Error("会话或设备已变化，请重新打开命令");
    const key = keyOf(target, id), thread = cached.current[key];
    if (!thread || thread.relayDraft || thread.relayArchived) throw new Error("发送首条消息并接续会话后可执行此命令");
    if (commandLocks.current[key]) throw new Error(commandLocks.current[key]);
    const startsWork = method === "thread/compact/start" || method === "review/start";
    if ((startsWork || method === "thread/fork") && (queued.current[key]?.items.length || inFlight.current?.key === key || liveTurns.current[key]?.status === "inProgress" || thread.status?.type === "active" || (thread.turns || []).some((turn: Json) => turn.status === "inProgress"))) throw new Error("请等待当前回合结束并处理待发消息后执行此命令");
    if (startsWork && (requests[target] || []).some(request => !request.params?.threadId || request.params.threadId === id)) throw new Error("请先处理当前会话的待办审批");
    const label = method === "thread/compact/start" ? "正在压缩上下文…" : method === "review/start" ? "正在审查代码…" : "正在执行命令…";
    const operation = crypto.randomUUID();
    commandTokens.current[key] = operation;
    updateCommand(key, label);
    const goalVersion = goalVersions.current[key] || 0;
    const generation = processEpoch.current[target] || 0;
    const startedSequence = sequence.current;
    try {
      const result = await call(target, method, { ...params, threadId: id });
      if (generation !== (processEpoch.current[target] || 0)) throw new Error("Codex 进程已退出，请重新读取会话确认命令结果");
      if (method === "thread/fork" && result.thread?.id) {
        setCache(previous => ({ ...previous, [keyOf(target, result.thread.id)]: { ...result.thread, relayMode: thread.relayMode, relayServiceTier: thread.relayServiceTier } }));
        if (active.current.device === target) {
          setThreads(previous => [result.thread, ...previous.filter(thread => thread.id !== result.thread.id)]);
          if (active.current.selected === id) await open(result.thread.id);
        }
      }
      if (method === "thread/name/set") {
        setCache(previous => ({ ...previous, [key]: { ...previous[key], name: params.name } }));
        if (active.current.device === target) setThreads(previous => previous.map(thread => thread.id === id ? { ...thread, name: params.name } : thread));
      }
      if ((method === "thread/goal/set" || method === "thread/goal/clear") && goalVersion === (goalVersions.current[key] || 0)) setCache(previous => ({ ...previous, [key]: { ...previous[key], goal: result.goal || null } }));
      if (startsWork && result.turn?.id && (!liveTurns.current[key] || liveTurns.current[key].sequence <= startedSequence)) {
        liveTurns.current[key] = { id: result.turn.id, status: result.turn.status || "inProgress", sequence: startedSequence };
        setCache(previous => {
          const thread = previous[key]; if (!thread || (thread.turns || []).some((turn: Json) => turn.id === result.turn.id)) return previous;
          return { ...previous, [key]: { ...thread, turns: [...(thread.turns || []), result.turn] } };
        });
      }
      return result;
    } catch (error) {
      if (commandTokens.current[key] === operation) updateCommand(key);
      if (startsWork) pauseQueue(key, "命令结果尚未确认，请重新读取会话后继续队列");
      throw new Error(message(error) + "；若执行电脑的 Codex 版本不支持此命令，请先升级。");
    } finally {
      if (!startsWork && commandTokens.current[key] === operation) updateCommand(key);
    }
  };
  const setMode = (mode: CollaborationMode) => {
    const current = active.current;
    if (!current.selected) return;
    const key = keyOf(current.device, current.selected);
    setCache(previous => ({ ...previous, [key]: { ...previous[key], relayMode: mode } }));
  };
  const setServiceTier = (tier: string) => {
    const current = active.current;
    if (!current.selected) return;
    const key = keyOf(current.device, current.selected);
    setCache(previous => ({ ...previous, [key]: { ...previous[key], relayServiceTier: tier } }));
  };

  const removeQueued = (id: string): QueuedMessage | undefined => {
    const current = active.current;
    if (!current.selected) return;
    const key = keyOf(current.device, current.selected);
    const item = queued.current[key]?.items.find(item => item.id === id);
    if (!item || item.status === "sending") return;
    updateQueues(previous => ({ ...previous, [key]: { ...previous[key], items: previous[key].items.filter(row => row.id !== id) } }));
    return item;
  };
  const resumeQueue = (retryId?: string) => {
    const current = active.current;
    if (!current.selected || !current.available) return;
    const key = keyOf(current.device, current.selected), queue = queued.current[key];
    if (!queue || !resumed.current.has(key)) return;
    updateQueues(previous => ({ ...previous, [key]: { items: queue.items.map(item => item.id === retryId && item.status === "failed" ? { ...item, status: "queued", error: undefined } : item) } }));
  };
  const thread = selected ? cache[keyOf(device, selected)] : undefined;
  const session = selected ? sessions[keyOf(device, selected)] : undefined;
  const ready = available && !!session?.ready;
  useEffect(() => {
    if (!ready || !selected || thread?.relayDraft || thread?.relayHistoryPending) return;
    let stopped = false;
    const key = keyOf(device, selected), version = goalVersions.current[key] || 0;
    void call(device, "thread/goal/get", { threadId: selected }).then(result => {
      if (!stopped && version === (goalVersions.current[key] || 0)) setCache(previous => !previous[key] ? previous : ({ ...previous, [key]: { ...previous[key], goal: result.goal || null } }));
    }).catch(() => { /* Older Codex hosts do not expose goal mode. */ });
    return () => { stopped = true; };
  }, [device, selected, ready, thread?.relayDraft, thread?.relayHistoryPending, setCache]);
  const activeTurn = [...(thread?.turns || [])].reverse().find((turn: Json) => turn.status === "inProgress");
  const stop = async () => {
    if (!selected || !available || !resumed.current.has(keyOf(device, selected)) || !activeTurn?.id) return;
    pauseQueue(keyOf(device, selected), "已停止当前回合，队列已暂停");
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
    projectCatalog: projectState.device === device ? projectState.value : EMPTY_PROJECT_CATALOG,
    projectsLoading, projectsError,
    archivedThreads, archivedNextCursor, archivedLoading, archivedError, archiveExpanded, toggleArchive,
    changeArchive, archiveReason,
    isArchiveBusy: (id: string) => !!archiveBusy[keyOf(device, id)],
    search, setSearch, nextCursor, loading, opening, sending: selected ? !!queues[keyOf(device, selected)]?.items.some(item => item.status === "sending") : false, activeTurn, olderCursor,
    queue: selected ? queues[keyOf(device, selected)]?.items || [] : [],
    queuePaused: selected ? queues[keyOf(device, selected)]?.paused : undefined,
    removeQueued, resumeQueue, runCommand, setMode, setServiceTier,
    mode: (thread?.relayMode || "default") as CollaborationMode,
    serviceTier: thread?.relayServiceTier as string | undefined,
    commandBusy: selected ? commandState[keyOf(device, selected)] : undefined,
    ready, resumeError: session?.resumeError, historyError: session?.historyError,
    open, event, create, send, stop, resolve, older,
    refresh: () => { refreshTargets.current.add(active.current.device); setEnvironmentRevision(previous => previous + 1); },
    loadMore: () => fetchList(nextCursor, search.trim()),
    loadMoreArchived: () => fetchList(archivedNextCursor, search.trim(), true),
    retryArchived: () => fetchList(null, search.trim(), true),
  };
}
