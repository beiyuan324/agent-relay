import { ListOrdered, Loader2, Pencil, Play, RotateCcw, X } from "lucide-react";
import type { QueuedMessage } from "./workbench";

export function MessageQueue({ items, paused, available, canEdit, onEdit, onRemove, onResume }: {
  items: QueuedMessage[];
  paused?: string;
  available: boolean;
  canEdit: boolean;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onResume: (retryId?: string) => void;
}) {
  if (!items.length) return null;
  const failed = items.some(item => item.status === "failed");
  return <section className="message-queue" aria-label="待发消息">
    <div className="message-queue-heading">
      <ListOrdered size={14} /><strong>待发消息 <span>{items.length}</span></strong>
      <span className="message-queue-hint" role="status">{paused || (available ? "当前回合结束后依次发送" : "连接并接续会话后继续")}</span>
      {paused && !failed && <button className="text-button" disabled={!available} onClick={() => onResume()}><Play size={12} />继续队列</button>}
    </div>
    <ol className="message-queue-list">{items.map((item, index) => <li className={`queued-message ${item.status}`} key={item.id} aria-busy={item.status === "sending"}>
      <span className="queued-message-order">{item.status === "sending" ? <Loader2 size={13} className="spin" /> : index + 1}</span>
      <div className="queued-message-copy"><p title={item.draft.text}>{item.draft.text}</p><small>{item.status === "sending" ? "正在发送…" : item.status === "failed" ? "发送未确认" : "等待发送"}{item.model ? ` · ${item.model}` : ""}{item.effort ? ` · ${item.effort}` : ""}{item.collaborationMode ? ` · ${item.collaborationMode === "plan" ? "计划模式" : "默认模式"}` : ""}{item.serviceTier && item.serviceTier !== "default" ? " · Fast" : ""}</small>{item.error && <p className="queued-message-error" role="status">{item.error}</p>}</div>
      <div className="queued-message-actions">
        {item.status === "failed" && <button className="icon-button" disabled={!available} title="查看会话确认未发送后，重试此消息" aria-label={`重试第 ${index + 1} 条待发消息`} onClick={() => onResume(item.id)}><RotateCcw size={14} /></button>}
        <button className="icon-button" disabled={item.status === "sending" || !canEdit} title={canEdit ? "移回输入框编辑" : "请先发送或清空当前草稿再编辑"} aria-label={`编辑第 ${index + 1} 条待发消息`} onClick={() => onEdit(item.id)}><Pencil size={14} /></button>
        <button className="icon-button" disabled={item.status === "sending"} title="移除待发消息" aria-label={`移除第 ${index + 1} 条待发消息`} onClick={() => onRemove(item.id)}><X size={14} /></button>
      </div>
    </li>)}</ol>
  </section>;
}
