import type { Json } from "./api";

export const CACHE_MAX_THREADS = 24;
export const CACHE_MAX_BYTES = 48 * 1024 * 1024;

// Count retained UTF-16 strings and object overhead. Shared immutable objects
// are measured once, so each streamed delta only measures the changed branch.
const sizes = new WeakMap<object, number>();
export function retainedBytes(value: unknown): number {
  if (typeof value === "string") return value.length * 2;
  if (!value || typeof value !== "object") return 8;
  const known = sizes.get(value);
  if (known !== undefined) return known;
  const size = 64 + Object.entries(value).reduce((sum, [key, entry]) => sum + key.length * 2 + retainedBytes(entry), 0);
  sizes.set(value, size);
  return size;
}

export function pruneCache(cache: Record<string, Json>, protectedKey: string | null, access: Map<string, number>,
  maxThreads = CACHE_MAX_THREADS, maxBytes = CACHE_MAX_BYTES): Record<string, Json> {
  const entries = Object.entries(cache);
  let bytes = entries.reduce((sum, [, thread]) => sum + retainedBytes(thread), 0);
  let count = entries.length;
  const evicted = new Set<string>();
  for (const [key, thread] of entries.sort(([a], [b]) => (access.get(a) || 0) - (access.get(b) || 0))) {
    if (count <= maxThreads && bytes <= maxBytes) break;
    if (key === protectedKey) continue;
    evicted.add(key); count--; bytes -= retainedBytes(thread);
  }
  return evicted.size ? Object.fromEntries(entries.filter(([key]) => !evicted.has(key))) : cache;
}

export interface ApprovalUpdate { sequence: number; request?: Json }
export function mergeApprovals(snapshot: Json[], updates: Map<string, ApprovalUpdate>, since: number): Json[] {
  const requests = new Map(snapshot.map(request => [String(request.id), request]));
  for (const [id, update] of updates) {
    if (update.sequence <= since) continue;
    if (update.request) requests.set(id, update.request);
    else requests.delete(id);
  }
  return [...requests.values()];
}

export function applyEvent(previous: Json, event: Json, receivedAt = Date.now()): Json {
  const method = event.method as string;
  const p = event.params || {};
  const next: Json = { ...previous, turns: [...(previous.turns || [])] };
  if (method === "thread/started" && p.thread) return { ...next, ...p.thread };
  if (method === "thread/status/changed") { next.status = p.status; return next; }
  if (method === "thread/tokenUsage/updated") {
    next.tokenUsage = p.tokenUsage;
    return next;
  }
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

export function mergeLive(history: Json, live: Json | undefined, touched: Set<string>): Json {
  if (!live) return history;
  history = { ...history, tokenUsage: live.tokenUsage ?? history.tokenUsage };
  const liveTurns = new Map<string, Json>((live.turns || []).map((turn: Json) => [turn.id, turn]));
  const turns = (history.turns || []).map((turn: Json) => {
    const timing = liveTurns.get(turn.id)?.relayTiming;
    return timing ? { ...turn, relayTiming: { ...timing, ...turn.relayTiming } } : turn;
  });
  if (!touched.size) return { ...history, turns };
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
