import { useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { updateProgress, type Updates } from "./updates";

export function UpdateSettings({ updates }: { updates: Updates }) {
  const { status, pending, error } = updates;
  const [confirmInstall, setConfirmInstall] = useState(false);
  const working = pending || ["checking", "downloading", "installing"].includes(status.phase);
  const disabled = status.phase === "preview" || status.phase === "development";
  const descriptions = {
    idle: "启动后自动检查更新，也可以随时手动检查。",
    checking: "正在检查新版本…",
    available: `发现新版本 ${status.version || ""}，下载后可选择安装时间。`,
    downloading: `正在下载更新 · ${updateProgress(status)}`,
    ready: `版本 ${status.version || ""} 已下载并通过签名验证。`,
    installing: "正在启动安装程序，Relay 将退出并在更新后重新打开。",
    upToDate: "当前已是最新版本。",
    error: "暂时无法检查更新，可稍后重试。",
    development: "开发模式不检查或安装更新，请使用正式安装版。",
    preview: "请在 Relay 桌面安装版中检查更新。",
  };
  return <>
    <div className="form-section-label">应用更新</div>
    <div className="settings-group update-settings" aria-busy={working}>
      <div className="update-settings-row">
        <div><strong>Relay {status.currentVersion}</strong><p role="status">{descriptions[status.phase]}</p></div>
        {status.phase === "ready" ? <button className="primary small" disabled={working} onClick={() => setConfirmInstall(true)}>安装并重启</button>
          : status.phase === "available" ? <button className="primary small" disabled={working} onClick={() => void updates.download()}><Download size={14} />{pending ? "正在处理…" : "下载更新"}</button>
          : <button className="secondary small" disabled={working || disabled} onClick={() => void updates.check()}>{working ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}{status.phase === "checking" ? "正在检查…" : "检查更新"}</button>}
      </div>
      {status.phase === "downloading" && <progress aria-label="更新下载进度" max={status.total || undefined} value={status.total ? Math.min(status.downloaded, status.total) : undefined} />}
      {status.lastChecked && <p className="group-note">上次检查：{new Date(status.lastChecked).toLocaleString("zh-CN")}</p>}
      {status.notes && <details className="update-notes"><summary>版本说明 · {status.version}</summary><p>{status.notes}</p></details>}
      {confirmInstall && status.phase === "ready" && <div className="update-confirm">
        <p>安装会退出 Relay 并断开设备连接。请先保存未发送的草稿，完成任务和审批。</p>
        <div><button className="secondary small" disabled={working} onClick={() => setConfirmInstall(false)}>稍后安装</button><button className="primary small" disabled={working} onClick={() => { setConfirmInstall(false); void updates.install(); }}>确认安装并重启</button></div>
      </div>}
      {error && <p className="group-note error-text" role="alert">{error}</p>}
    </div>
  </>;
}
