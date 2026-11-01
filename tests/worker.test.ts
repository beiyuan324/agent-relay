// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { RelayRoom } from "../workers/relay/src/index";
class Socket {
  sent: string[] = [];
  close = vi.fn();
  constructor(public attachment: any) {}
  serializeAttachment(value: any) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  send(value: string) { this.sent.push(value); }
}
function room(sockets: Socket[]) {
  const state = {
    getWebSockets: (role: string) => sockets.filter(ws => ws.attachment.role === role),
    storage: { delete: vi.fn(async () => true), get: vi.fn(async () => undefined), getAlarm: vi.fn(async () => null), setAlarm: vi.fn(async () => {}) },
  };
  return new RelayRoom(state as any, {} as any);
}
describe("agent replacement", () => {
  it("closes established tunnels, keeps pending phones, and ignores old agent frames", async () => {
    const old = new Socket({ role: "agent", reg: true });
    const replacement = new Socket({ role: "agent", reg: false });
    const phone = new Socket({ role: "phone", id: "old-tunnel", pid: "p1", deadline: null });
    const pending = new Socket({ role: "phone", id: null, pid: "p2", deadline: Date.now() + 60_000 });
    const relay = room([old, replacement, phone, pending]);
    await relay.webSocketMessage(replacement as any, JSON.stringify({ t: "register" }));
    expect(old.close).toHaveBeenCalledWith(4000, expect.any(String));
    expect(phone.close).toHaveBeenCalledWith(1012, "agent replaced");
    expect(phone.attachment.id).toBeNull();
    expect(pending.close).not.toHaveBeenCalled();
    expect(pending.attachment.id).toBeTruthy();
    expect(replacement.sent.map(value => JSON.parse(value).t)).toEqual(["registered", "wopen"]);
    await relay.webSocketMessage(old as any, JSON.stringify({ t: "wmsg", id: pending.attachment.id, s: "stale" }));
    expect(pending.sent).toEqual([]);
    const opened = replacement.sent.length;
    await relay.webSocketMessage(phone as any, "late frame from closed tunnel");
    expect(replacement.sent).toHaveLength(opened);
    await relay.webSocketClose(old as any, 4000, "", true);
    expect(pending.close).not.toHaveBeenCalled();
  });
  it("acknowledges repeated registration without interrupting active tunnels", async () => {
    const agent = new Socket({ role: "agent", reg: true });
    const phone = new Socket({ role: "phone", id: "tunnel", pid: "p1", deadline: null });
    await room([agent, phone]).webSocketMessage(agent as any, JSON.stringify({ t: "register" }));
    expect(phone.close).not.toHaveBeenCalled();
    expect(agent.sent.map(value => JSON.parse(value).t)).toEqual(["registered"]);
  });
});
