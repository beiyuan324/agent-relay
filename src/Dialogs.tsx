import { useEffect, useRef, useState, type ReactNode } from "react";
import { version as appVersion } from "../package.json";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Check, CheckCircle2, Copy, Globe2, Link2, Loader2, Monitor, ShieldCheck, Wifi, X } from "lucide-react";
import { command, desktop, message, stateLabels, type Device, type Json, type Snapshot } from "./api";

export async function copy(text: string) {
  if (desktop) await writeText(text);
  else await navigator.clipboard.writeText(text);
}
export function Modal({ title, subtitle, close, children, wide = false }: { title: string; subtitle?: string; close: () => void; children: ReactNode; wide?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') || [])].filter(el => el.offsetParent !== null);
    focusable()[0]?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key === "Tab") {
        const elements = focusable(), first = elements[0], last = elements[elements.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", handle);
    return () => { document.removeEventListener("keydown", handle); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={panel}><button className="icon-button modal-close" aria-label="关闭" onClick={close}><X size={17} /></button><h2 id="dialog-title">{title}</h2>{subtitle && <p className="modal-subtitle">{subtitle}</p>}{children}</div></div>;
}

export function PairDialog({ snapshot, close, changed }: { snapshot: Snapshot | null; close: () => void; changed: (id?: string) => Promise<void> }) {
  const [tab, setTab] = useState<"invite" | "join">("invite");
  const [mode, setMode] = useState<"lan" | "relay">("lan");
  const [address, setAddress] = useState(snapshot?.addresses[0]?.url || "");
  const [relay, setRelay] = useState(snapshot?.settings.relayUrl || "");
  const [uri, setUri] = useState("");
  const [created, setCreated] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const invite = async () => {
    setBusy(true); setError("");
    try { const result = await command<Json>("create_invitation", { endpoint: mode === "lan" ? address : relay, mode }); setCreated(result); await changed(); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  };
  const join = async () => {
    setBusy(true); setError("");
    try { const id = await command<string>("join_invitation", { uri: uri.trim() }); setUri(""); await changed(id); close(); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  };
  return <Modal title="连接另一台电脑" subtitle="创建邀请，或使用另一台电脑的配对链接加入。" close={close}>
    <div className="segmented"><button className={tab === "invite" ? "active" : ""} disabled={busy} onClick={() => { setTab("invite"); setError(""); }}>创建邀请</button><button className={tab === "join" ? "active" : ""} disabled={busy} onClick={() => { setTab("join"); setError(""); }}>加入设备</button></div>
    {tab === "invite" ? created ? <div className="invite-result"><div className="success-symbol"><Link2 size={25} /></div><h3>邀请已准备好</h3><p>把配对链接发送到另一台电脑，在 Relay 中选择“加入设备”。连接后，双方还需确认设备身份。</p><textarea className="invite-uri" readOnly aria-label="配对链接" value={created.uri} /><button className="primary full" onClick={() => { void copy(created.uri).then(() => setCopied(true)).catch(error => setError(message(error))); }}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "已复制链接" : "复制配对链接"}</button><div className="hint"><ShieldCheck size={15} />链接包含配对密钥，请仅交给你要连接的电脑。</div></div> : <><div className="connection-choices"><button className={mode === "lan" ? "chosen" : ""} onClick={() => setMode("lan")}><Wifi size={21} /><strong>同一网络</strong><small>局域网加密直连</small></button><button className={mode === "relay" ? "chosen" : ""} onClick={() => setMode("relay")}><Globe2 size={21} /><strong>异地连接</strong><small>通过 Workers 中继</small></button></div>{mode === "lan" ? <div className="form-group"><label htmlFor="lan-address">这台电脑的地址</label>{!!snapshot?.addresses.length && <select value={snapshot.addresses.some(a => a.url === address) ? address : ""} onChange={event => setAddress(event.target.value)} aria-label="选择网卡"><option value="">手动输入地址</option>{snapshot.addresses.map(a => <option key={a.url} value={a.url}>{a.name}</option>)}</select>}<input id="lan-address" value={address} placeholder="ws://192.168.1.10:47321" onChange={event => setAddress(event.target.value)} /><small>选择另一台电脑能够访问的网卡地址；VPN 地址也可使用。</small>{snapshot?.listenerError && <p className="error-text">{snapshot.listenerError}</p>}</div> : <div className="form-group"><label htmlFor="relay-address">Workers 中继地址</label><input id="relay-address" value={relay} placeholder="https://your-relay.workers.dev" onChange={event => setRelay(event.target.value)} /><small>两台电脑通过同一个中继连接，聊天内容在两端加密。</small></div>}<div className="dialog-footer"><span className="micro muted">邀请不会自动启用本机共享</span><button className="primary" disabled={busy || !(mode === "lan" ? address.trim() : relay.trim())} onClick={() => void invite()}>{busy && <Loader2 className="spin" size={15} />}创建配对链接</button></div></> : <><div className="join-art"><Monitor size={34} strokeWidth={1.3} /><Link2 size={20} /><Monitor size={34} strokeWidth={1.3} /></div><div className="form-group"><label htmlFor="join-uri">另一台电脑的配对链接</label><textarea id="join-uri" value={uri} placeholder="relay://connect?…" rows={4} autoComplete="off" spellCheck={false} onChange={event => setUri(event.target.value)} /><small>添加后核对设备名称，并在两端分别确认连接。</small></div><button className="primary full" disabled={busy || !uri.trim()} onClick={() => void join()}>{busy && <Loader2 size={15} className="spin" />}连接设备</button></>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </Modal>;
}

export function DeviceDialog({ device, close, changed }: { device: Device; close: () => void; changed: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [remove, setRemove] = useState(false);
  const action = async (name: string) => {
    setBusy(true); setError("");
    try { await command(name, { id: device.id }); await changed(); if (name === "remove_device") close(); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  };
  return <Modal title={device.peer?.name || "等待设备加入"} subtitle="设备连接与信任" close={close}>
    <div className="device-detail-symbol"><Monitor size={48} strokeWidth={1.1} /><span className={`status-dot ${device.state}`} /></div>
    <div className="settings-group">
      <div className="info-row"><span>连接状态</span><strong>{stateLabels[device.state] || device.state}</strong></div>
      <div className="info-row"><span>连接方式</span><strong>{device.mode === "lan" ? "局域网直连" : "Workers 中继"}</strong></div>
      <div className="info-row"><span>连接地址</span><span className="mono truncate" title={device.endpoint}>{device.endpoint}</span></div>
      {device.peer && <div className="info-row"><span>设备标识</span><span className="mono micro">{device.peer.id.slice(0, 8)}</span></div>}
      <div className="info-row"><span>本机确认</span><strong>{device.approved ? "已确认" : "待确认"}</strong></div>
      <div className="info-row"><span>对方确认</span><strong>{device.peerApproved ? "已确认" : "等待对方"}</strong></div>
      <div className="info-row"><span>对方共享</span><strong>{device.peerSharing ? "已启用" : "已暂停"}</strong></div>
    </div>
    {device.error && <p className="error-text">{device.error}</p>}
    {!device.approved && device.peer && <div className="trust-prompt"><ShieldCheck size={20} /><p>确认后，在双方启用共享期间，这台设备可以查看、继续和操作你当前用户的全部 Codex 项目与会话。</p><button className="primary full" disabled={busy} onClick={() => void action("approve_device")}>信任并确认配对</button></div>}
    {device.approved && !device.peerApproved && <p className="hint"><CheckCircle2 size={15} />本机已确认，请在另一台电脑上确认此配对。</p>}
    <div className="dialog-footer"><button className="secondary" disabled={busy || device.state === "credentialMissing"} onClick={() => void action("reconnect_device")}>重新连接</button><button className="danger-text" disabled={busy} onClick={() => setRemove(true)}>取消配对</button></div>
    {remove && <div className="remove-prompt"><p>取消后立即断开连接，并删除系统中保存的配对密钥。</p><button className="secondary small" disabled={busy} onClick={() => setRemove(false)}>保留配对</button><button className="danger small" disabled={busy} onClick={() => void action("remove_device")}>确认取消配对</button></div>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </Modal>;
}

export function SettingsDialog({ snapshot, close, changed }: { snapshot: Snapshot | null; close: () => void; changed: () => Promise<void> }) {
  const [name, setName] = useState(snapshot?.settings.identity.name || "");
  const [path, setPath] = useState(snapshot?.settings.codexPath || "");
  const [relay, setRelay] = useState(snapshot?.settings.relayUrl || "");
  const [theme, setTheme] = useState(snapshot?.settings.theme || "system");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [installation, setInstallation] = useState<{ path: string; source: string } | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectionError, setDetectionError] = useState("");
  const detectionGeneration = useRef(0);
  useEffect(() => () => { detectionGeneration.current++; }, []);
  useEffect(() => {
    if (!desktop || snapshot?.settings.codexPath) return;
    let stopped = false;
    setDetecting(true);
    void command<{ path: string; source: string }>("detect_codex")
      .then(result => { if (!stopped) setInstallation(result); })
      .catch(error => { if (!stopped) setDetectionError(message(error)); })
      .finally(() => { if (!stopped) setDetecting(false); });
    return () => { stopped = true; };
  }, []);
  const detect = async () => {
    const generation = ++detectionGeneration.current;
    setDetecting(true); setDetectionError("");
    try {
      const result = await command<{ path: string; source: string }>("detect_codex");
      if (generation !== detectionGeneration.current) return;
      setInstallation(result); setPath("");
    } catch (error) {
      if (generation === detectionGeneration.current) setDetectionError(message(error));
    } finally {
      if (generation === detectionGeneration.current) setDetecting(false);
    }
  };
  const save = async () => {
    setBusy(true); setError("");
    try { await command("save_settings", { name, codexPath: path.trim(), relayUrl: relay.trim(), theme }); await changed(); close(); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  };
  return <Modal title="设置" subtitle="让两台电脑，自然地协作。" close={close}>
    <div className="form-section-label">这台电脑</div><div className="settings-group"><label className="setting-field">设备名称<input value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label><label className="setting-field">外观<select value={theme} onChange={event => setTheme(event.target.value as typeof theme)}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label></div>
    <div className="form-section-label">Codex</div><div className="settings-group"><label className="setting-field vertical">可执行文件<div className="input-with-button"><input value={path} disabled={detecting || busy} placeholder={installation && !path ? "自动检测（已找到 Codex）" : "留空以自动检测"} onChange={event => { setPath(event.target.value); setInstallation(null); setDetectionError(""); }} /><button className="secondary small" disabled={detecting || busy || !desktop} onClick={() => { void pickFile({ multiple: false, directory: false, title: "选择 Codex 可执行文件" }).then(value => { if (typeof value === "string") { setPath(value); setInstallation(null); setDetectionError(""); } }).catch(error => setError(message(error))); }}>选择…</button></div></label><div className="codex-detection"><div className="codex-detection-result" aria-live="polite">{detecting ? <span className="muted"><Loader2 className="spin" size={13} />正在查找 Codex…</span> : installation && !path ? <><span className="codex-found"><CheckCircle2 size={13} />已找到 · {installation.source}</span><code title={installation.path}>{installation.path}</code></> : <span className="muted">{path ? "当前使用手动指定的路径" : desktop ? "自动查找本机 Codex 安装" : "请在桌面应用中检测"}</span>}</div><button className="secondary small" disabled={detecting || busy || !desktop} onClick={() => void detect()}>自动检测</button></div>{detectionError && <p className="group-note error-text" role="status">{detectionError}</p>}<p className="group-note">留空会在启动时自动查找，安装更新后无需重选路径。复用本机登录与配置；更改此设置前请先停止运行中的回合。</p></div>
    <div className="form-section-label">连接</div><div className="settings-group"><label className="setting-field vertical">默认 Workers 中继地址<input value={relay} placeholder="https://your-relay.workers.dev" onChange={event => setRelay(event.target.value)} /></label><p className="group-note">局域网监听端口：{snapshot?.settings.listenPort || 47321}。已有设备使用各自配对时的中继地址。</p></div>
    {error && <p className="error-text" role="alert">{error}</p>}<div className="dialog-footer"><span className="micro muted">Relay {appVersion}</span><button className="primary" disabled={busy || detecting || !name.trim()} onClick={() => void save()}>{busy ? "正在保存…" : "完成"}</button></div>
  </Modal>;
}
export function NewThreadDialog({ projects, initialCwd, deviceName, close, create }: { projects: string[]; initialCwd?: string; deviceName: string; close: () => void; create: (cwd: string) => Promise<void> }) {
  const [cwd, setCwd] = useState(initialCwd ?? projects[0] ?? ""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <Modal title="新建会话" subtitle={`在 ${deviceName} 上运行 Codex。`} close={close}><div className="form-group"><label htmlFor="new-project">执行电脑上的项目路径</label><input id="new-project" list="known-projects" placeholder="D:\\Projects\\my-app" value={cwd} onChange={event => setCwd(event.target.value)} /><datalist id="known-projects">{projects.map(path => <option value={path} key={path} />)}</datalist><small>输入执行电脑上的绝对路径，或选择已有项目。目录有效性由执行电脑确认。</small></div>{error && <p className="error-text">{error}</p>}<div className="dialog-footer"><span className="micro muted">沿用主机的权限与沙箱配置</span><button className="primary" disabled={busy || !cwd.trim()} onClick={() => { setBusy(true); setError(""); void create(cwd.trim()).then(close).catch(error => setError(message(error))).finally(() => setBusy(false)); }}>{busy ? "正在创建…" : "新建会话"}</button></div></Modal>;
}
export function DiagnosticsDialog({ snapshot, close }: { snapshot: Snapshot | null; close: () => void }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState("");
  const text = [`Relay ${appVersion} · ${snapshot?.settings.identity.platform || "桌面预览"}`, snapshot?.listenerError, ...(snapshot?.diagnostics || [])].filter(Boolean).join("\n");
  return <Modal title="连接诊断" subtitle="仅包含连接与状态信息，不包含配对密钥、聊天正文和登录凭据。" close={close}><pre className="diagnostics">{text}{!snapshot?.diagnostics.length && !snapshot?.listenerError ? "\n暂无连接错误。" : ""}</pre><button className="secondary full" onClick={() => { void copy(text).then(() => setCopied(true)).catch(error => setError(message(error))); }}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "已复制" : "复制诊断信息"}</button>{error && <p className="error-text">{error}</p>}</Modal>;
}
