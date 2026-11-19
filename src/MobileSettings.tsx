import { useEffect, useState } from "react";
import { Bell, Battery, ShieldCheck } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { message, mobileAction, type Json } from "./api";

export function MobileSettings() {
  const [status, setStatus] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let stopped = false;
    let dispose: (() => void) | undefined;
    const refresh = () => { void mobileAction("status").then(status => { if (!stopped) setStatus(status); }).catch(error => { if (!stopped) setError(message(error)); }); };
    refresh();
    void listen<Json>("relay:permissions", event => { if (!stopped) setStatus(event.payload); }).then(unlisten => { if (stopped) unlisten(); else dispose = unlisten; });
    window.addEventListener("focus", refresh);
    return () => { stopped = true; dispose?.(); window.removeEventListener("focus", refresh); };
  }, []);
  const action = async (name: string, value: Json = {}) => {
    setBusy(true); setError("");
    try { await mobileAction(name, value); setStatus(await mobileAction("status")); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  };
  return <>
    <div className="form-section-label">后台与通知</div>
    <div className="settings-group">
      <label className="setting-field"><span>保持后台连接</span><input type="checkbox" checked={!!status?.background} disabled={!status || busy} onChange={event => void action("background", { enabled: event.target.checked })} /></label>
      <p className="group-note">开启后通过常驻通知保持连接，锁屏时继续处理待发队列。通知中的“停止后台连接”可随时关闭。</p>
      <div className="mobile-setting-action"><Bell size={19} /><div><strong>审批与任务结果</strong><small>{status?.notifications ? "通知已开启" : "允许通知后接收审批和完成提醒"}</small></div><button className="secondary small" disabled={busy} onClick={() => void action("notifications")}>通知设置</button></div>
      <div className="mobile-setting-action"><Battery size={19} /><div><strong>电池与后台限制</strong><small>{status?.batteryExempt ? "已允许不受电池优化限制" : "持续使用时，将 Relay 的电池策略设为不限制"}</small></div><button className="secondary small" disabled={busy} onClick={() => void action("battery")}>打开设置</button></div>
      <div className="mobile-setting-action"><ShieldCheck size={19} /><div><strong>后台自启动</strong><small>{/xiaomi/i.test(status?.manufacturer || "") ? "澎湃 OS：允许后台自启动，并在电池设置中选择不限制" : "在系统应用设置中允许后台运行"}</small></div><button className="secondary small" disabled={busy} onClick={() => void action("autostart")}>打开设置</button></div>
    </div>
    {error && <p className="error-text" role="alert">{error}</p>}
  </>;
}
