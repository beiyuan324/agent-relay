import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWorkbench } from "../src/workbench";
import type { Json } from "../src/api";
const { rpc, ipc, queueListeners } = vi.hoisted(() => ({ rpc: vi.fn(), ipc: vi.fn(), queueListeners: new Set<(snapshot: Json) => void>() }));
vi.mock("../src/api", () => ({ call: rpc, command: ipc, native: true, subscribeQueue: async (handler: (snapshot: Json) => void) => { queueListeners.add(handler); return () => queueListeners.delete(handler); }, message: (error: unknown) => String(error) }));
function deferred<T = Json>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function settle() { await act(async () => { await Promise.resolve(); }); }
function event(method: string, params: Json = {}, id?: string) {
  return { type: "codex" as const, device: "local", message: { method, params, ...(id ? { id } : {}) } };
}
beforeEach(() => {
  vi.useFakeTimers();
  rpc.mockReset();
  queueListeners.clear(); ipc.mockReset();
  ipc.mockResolvedValue({ revision: 0, queues: {}, created: {}, drafts: {} });
  rpc.mockImplementation(async (_device: string, method: string, params: Json) => {
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "thread/turns/list") return { data: [{ id: "turn", status: "inProgress", items: [] }], nextCursor: "older" };
    return { data: [], requests: [] };
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("invalidates installation detection only for the explicitly refreshed device", async () => {
  const { result, rerender } = renderHook(({ device }) => useWorkbench(device, true, vi.fn()), { initialProps: { device: "local" } });
  await settle();
  expect(rpc.mock.calls.filter(([, method]) => method === "relay/environment").at(-1)?.[2]).toEqual({ refresh: false });
  act(() => { result.current.refresh(); });
  await settle();
  expect(rpc.mock.calls.filter(([, method]) => method === "relay/environment").at(-1)?.[2]).toEqual({ refresh: true });
  rerender({ device: "remote" });
  await settle();
  expect(rpc.mock.calls.filter(([, method]) => method === "relay/environment").at(-1)?.[2]).toEqual({ refresh: false });
});
it("does not resurrect approvals resolved during the initial snapshot", async () => {
  const pending = deferred();
  rpc.mockImplementation(async (_device: string, method: string) => method === "relay/pending" ? pending.promise : { data: [] });
  const { result } = renderHook(() => useWorkbench("local", true, vi.fn()));
  await act(async () => {
    result.current.event(event("relay/approvalResolved", { id: "resolved" }));
    result.current.event(event("item/commandExecution/requestApproval", {}, "new"));
    pending.resolve({ requests: [{ id: "resolved" }] });
  });
  expect(result.current.requests.map(request => request.id)).toEqual(["new"]);
});
it("ignores pending snapshots from an exited process", async () => {
  const pending = deferred();
  rpc.mockImplementation(async (_device: string, method: string) => method === "relay/pending" ? pending.promise : { data: [] });
  const { result } = renderHook(() => useWorkbench("local", true, vi.fn()));
  await act(async () => {
    result.current.event(event("relay/codexExited"));
    pending.resolve({ requests: [{ id: "stale" }] });
  });
  expect(result.current.requests).toEqual([]);
});
it("batches streamed deltas in receive order", async () => {
  const { result } = renderHook(() => useWorkbench("local", true, vi.fn()));
  await settle();
  await act(async () => { await result.current.open("thread"); });
  act(() => {
    result.current.event(event("item/agentMessage/delta", { threadId: "thread", turnId: "turn", itemId: "reply", delta: "hello" }));
    result.current.event(event("item/agentMessage/delta", { threadId: "thread", turnId: "turn", itemId: "reply", delta: " world" }));
  });
  expect(result.current.thread?.turns[0].items).toEqual([]);
  act(() => { vi.advanceTimersByTime(100); });
  expect(result.current.thread?.turns[0].items[0].text).toBe("hello world");
});
it("flushes a large event immediately instead of retaining an oversized frame batch", async () => {
  const { result } = renderHook(() => useWorkbench("local", true, vi.fn()));
  await settle();
  await act(async () => { await result.current.open("thread"); });
  const text = "x".repeat(1_100_000);
  act(() => { result.current.event(event("item/agentMessage/delta", { threadId: "thread", turnId: "turn", itemId: "reply", delta: text })); });
  expect(result.current.thread?.turns[0].items[0].text).toBe(text);
  act(() => { vi.advanceTimersByTime(100); });
  expect(result.current.thread?.turns[0].items[0].text.length).toBe(text.length);
});
it("rejects older-page responses after reopening the same session", async () => {
  const old = deferred(), onError = vi.fn();
  const { result } = renderHook(() => useWorkbench("local", true, onError));
  await settle();
  await act(async () => { await result.current.open("thread"); });
  rpc.mockImplementation(async (_device: string, method: string, params: Json) => {
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "thread/turns/list" && params.cursor) return old.promise;
    if (method === "thread/turns/list") return { data: [{ id: "fresh", status: "completed", items: [] }], nextCursor: "fresh-cursor" };
    return {};
  });
  let older!: Promise<void>;
  act(() => { older = result.current.older(); });
  await act(async () => { await result.current.open("thread"); });
  await act(async () => { old.resolve({ data: [{ id: "stale", items: [] }], nextCursor: "stale-cursor" }); await older; });
  expect(result.current.thread?.turns.map((turn: Json) => turn.id)).toEqual(["fresh"]);
  expect(result.current.olderCursor).toBe("fresh-cursor");
  expect(onError).not.toHaveBeenCalled();
});
it("delegates sending to native code and ignores an older queue revision", async () => {
  rpc.mockImplementation(async (_device: string, method: string, params: Json) => {
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "thread/turns/list") return { data: [{ id: "previous", status: "completed", items: [] }] };
    return { data: [], requests: [] };
  });
  const { result } = renderHook(() => useWorkbench("local", true, vi.fn()));
  await settle();
  await act(async () => { await result.current.open("thread"); });
  await act(async () => { expect(await result.current.send({ text: "hello", mentions: [] }, "", "")).toBe(true); });
  expect(ipc.mock.calls.some(([method]) => method === "queue_enqueue")).toBe(true);
  expect(rpc.mock.calls.some(([, method]) => method === "turn/start")).toBe(false);
  const key = JSON.stringify(["local", "thread"]);
  const entry = { id: "queued", draft: { text: "hello", mentions: [] }, model: "", effort: "", status: "failed" };
  act(() => {
    for (const handler of queueListeners) handler({ revision: 3, queues: { [key]: { items: [entry], paused: "提交结果未知" } }, created: {} });
    for (const handler of queueListeners) handler({ revision: 2, queues: {}, created: {} });
  });
  expect(result.current.queue[0]?.status).toBe("failed");
  expect(result.current.queuePaused).toBe("提交结果未知");
});
it("retains the input when native enqueueing fails", async () => {
  const onError = vi.fn();
  const { result } = renderHook(() => useWorkbench("local", true, onError));
  await settle();
  await act(async () => { await result.current.open("thread"); });
  ipc.mockImplementation(async (method: string) => {
    if (method === "queue_enqueue") throw new Error("无法保存待发消息");
    return { revision: 0, queues: {}, created: {}, drafts: {} };
  });
  await act(async () => { expect(await result.current.send({ text: "保留草稿", mentions: [] }, "", "")).toBe(false); });
  expect(result.current.queue).toEqual([]);
  expect(onError).toHaveBeenCalledWith("Error: 无法保存待发消息");
});
it("merges queued deltas before completing a history read", async () => {
  const history = deferred();
  rpc.mockImplementation(async (_device: string, method: string, params: Json) => {
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "thread/turns/list") return history.promise;
    return { data: [], requests: [] };
  });
  const { result } = renderHook(() => useWorkbench("local", true, vi.fn()));
  await settle();
  let opening!: Promise<void>;
  act(() => { opening = result.current.open("thread"); });
  await settle();
  await act(async () => {
    result.current.event(event("item/agentMessage/delta", { threadId: "thread", turnId: "turn", itemId: "reply", delta: "hello world" }));
    history.resolve({ data: [{ id: "turn", status: "inProgress", items: [{ id: "reply", text: "hello" }] }] });
    await opening;
  });
  expect(result.current.thread?.turns[0].items[0].text).toBe("hello world");
});
