import { describe, expect, it } from "vitest";
import { applyEvent, mergeApprovals, mergeLive, pruneCache, retainedBytes } from "../src/workbench-state";

describe("bounded session cache", () => {
  it("evicts least recently used sessions while protecting the selected session", () => {
    const cache = { old: { id: "old" }, selected: { id: "selected" }, recent: { id: "recent" } };
    expect(Object.keys(pruneCache(cache, "selected", new Map([["old", 1], ["selected", 0], ["recent", 2]]), 2))).toEqual(["selected", "recent"]);
  });
  it("enforces the byte budget while keeping an oversized selected session usable", () => {
    const selected = { id: "selected", text: "x".repeat(2048) };
    const cache = { selected, other: { text: "y".repeat(2048) } };
    expect(pruneCache(cache, "selected", new Map(), 24, retainedBytes(selected) - 1)).toEqual({ selected });
    expect(pruneCache(cache, null, new Map(), 24, 1)).toEqual({});
  });
  it("preserves identity if no eviction is needed", () => {
    const cache = { a: { turns: [] } };
    expect(pruneCache(cache, null, new Map())).toBe(cache);
  });
});
describe("live history merge", () => {
  it("preserves stable historical turns when applying a live delta", () => {
    const history = { id: "history", items: [], status: "completed" };
    const thread = { turns: [history, { id: "live", status: "inProgress", items: [] }] };
    const next = applyEvent(thread, { method: "item/agentMessage/delta", params: { turnId: "live", itemId: "reply", delta: "你好" } });
    expect(next.turns[0]).toBe(history);
    expect(next.turns[1].items[0].text).toBe("你好");
    expect(thread.turns[1].items).toEqual([]);
  });
  it("does not duplicate streamed text or reopen completed turns", () => {
    const history = { turns: [{ id: "turn", status: "completed", items: [{ id: "reply", text: "hello world", status: "completed" }] }] };
    const live = { turns: [{ id: "turn", status: "inProgress", items: [{ id: "reply", text: "hello" }] }] };
    const merged = mergeLive(history, live, new Set(["turn"]));
    expect(merged.turns[0].status).toBe("completed");
    expect(merged.turns[0].items[0].text).toBe("hello world");
  });
  it("merges approvals arriving or resolving during a snapshot", () => {
    const added = { id: "new", method: "approval" };
    expect(mergeApprovals([{ id: "old" }], new Map([
      ["old", { sequence: 2 }], ["new", { sequence: 3, request: added }],
    ]), 1)).toEqual([added]);
  });
});
