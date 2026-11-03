import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Json = Record<string, any>;
export interface Identity { id: string; name: string; platform: string }
export interface Device {
  id: string; peer: Identity | null; mode: "lan" | "relay"; endpoint: string;
  state: string; approved: boolean; peerApproved: boolean; peerSharing: boolean; error: string | null;
}
export interface Settings {
  identity: Identity; codexPath: string; relayUrl: string; listenPort: number;
  sharing: boolean; theme: "system" | "light" | "dark"; devices: Json[];
}
export interface Snapshot {
  settings: Settings; devices: Device[]; addresses: { name: string; url: string }[];
  diagnostics: string[]; listenerError: string | null;
}
export interface RelayEvent { type: "device" | "codex" | "diagnostic"; device?: Device | string; message?: Json | string }
export const desktop = isTauri();
export async function command<T>(name: string, args: Json = {}): Promise<T> {
  if (!desktop) throw new Error("请在 Relay 桌面应用中使用此功能。浏览器预览不连接本机或远端 Codex。");
  return invoke<T>(name, args);
}
export const call = <T = Json>(device: string, method: string, params: Json = {}) =>
  command<T>("codex_call", { device, method, params });
export const subscribe = (handler: (event: RelayEvent) => void) =>
  listen<RelayEvent>("relay:event", event => handler(event.payload));
export function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
export const stateLabels: Record<string, string> = {
  connected: "已连接", pending: "等待配对确认", connecting: "正在连接", handshaking: "正在验证设备身份", waiting: "等待设备加入",
  offline: "未连接", replaced: "连接已被替换", credentialMissing: "需要重新配对",
};
export function title(thread: Json) { return thread.name || thread.title || thread.preview?.slice(0, 64) || "新会话"; }
export function folder(path = "") { return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "未指定项目"; }
export function when(value: number | string | undefined) {
  if (!value) return "";
  const date = new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时前`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}天前`;
  if (seconds < 31536000) return `${Math.floor(seconds / 2592000)}个月前`;
  return `${Math.floor(seconds / 31536000)}年前`;
}
