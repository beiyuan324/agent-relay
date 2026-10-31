import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { desktop, message } from "./api";

type WindowAction = "minimize" | "maximize" | "close";

export function WindowTitlebar({ onError, onMaximizedChange }: {
  onError: (error: string) => void;
  onMaximizedChange: (maximized: boolean) => void;
}) {
  const [appWindow] = useState(() => desktop ? getCurrentWindow() : null);
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const revision = useRef(0);
  const report = useCallback((error: unknown) => {
    if (mounted.current) onError(`窗口操作失败：${message(error)}`);
  }, [onError]);
  const syncMaximized = useCallback(async () => {
    if (!appWindow) return;
    const current = ++revision.current;
    const value = await appWindow.isMaximized();
    if (mounted.current && current === revision.current) {
      setMaximized(value);
      onMaximizedChange(value);
    }
  }, [appWindow, onMaximizedChange]);

  useEffect(() => {
    mounted.current = true;
    if (!appWindow) return () => { mounted.current = false; };
    let stopped = false;
    let focusRevision = 0;
    const listeners: (() => void)[] = [];
    const retain = (dispose: () => void) => { if (stopped) dispose(); else listeners.push(dispose); };
    void Promise.allSettled([
      appWindow.onResized(() => { if (!stopped) void syncMaximized().catch(report); }).then(retain),
      appWindow.onFocusChanged(({ payload }) => {
        if (!stopped) { ++focusRevision; setFocused(payload); }
      }).then(retain),
      syncMaximized(),
      appWindow.isFocused().then(value => { if (!stopped && focusRevision === 0) setFocused(value); }),
    ]).then(results => {
      if (stopped) return;
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") report(failure.reason);
    });
    return () => {
      stopped = true;
      mounted.current = false;
      ++revision.current;
      listeners.forEach(dispose => dispose());
    };
  }, [appWindow, syncMaximized, report]);

  const act = async (action: WindowAction) => {
    if (!appWindow || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      if (action === "minimize") await appWindow.minimize();
      else if (action === "close") await appWindow.close();
      else { await appWindow.toggleMaximize(); await syncMaximized(); }
    } catch (error) { report(error); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const drag = (event: MouseEvent<HTMLDivElement>) => {
    if (!appWindow || event.button !== 0) return;
    event.preventDefault();
    if (event.detail === 2) void act("maximize");
    else void appWindow.startDragging().catch(report);
  };

  return <header className={`window-titlebar ${!focused ? "inactive" : ""}`} aria-label="窗口标题栏">
    <div className="window-drag-area" onMouseDown={drag}>
      <img src="/relay-icon.png" alt="" draggable={false} /><span>Relay</span>
    </div>
    <div className="window-controls" role="group" aria-label="窗口控制">
      <button type="button" className="window-control" title="最小化" aria-label="最小化窗口" disabled={!appWindow || busy} onClick={() => void act("minimize")}><Minus size={15} /></button>
      <button type="button" className="window-control" title={maximized ? "还原" : "最大化"} aria-label={maximized ? "还原窗口" : "最大化窗口"} aria-pressed={maximized} disabled={!appWindow || busy} onClick={() => void act("maximize")}>{maximized ? <Copy size={13} /> : <Square size={12} />}</button>
      <button type="button" className="window-control window-close" title="关闭" aria-label="关闭窗口" disabled={!appWindow || busy} onClick={() => void act("close")}><X size={16} /></button>
    </div>
  </header>;
}
