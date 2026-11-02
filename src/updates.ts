import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { version } from "../package.json";
import { command, desktop, message } from "./api";

export interface UpdateStatus {
  revision: number;
  phase: "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "upToDate" | "error" | "development" | "preview";
  currentVersion: string;
  version: string | null;
  notes: string | null;
  downloaded: number;
  total: number | null;
  lastChecked: number | null;
  error: string | null;
}
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

export function useUpdates() {
  const [status, setStatus] = useState<UpdateStatus>({
    revision: 0, phase: desktop ? "idle" : "preview", currentVersion: version,
    version: null, notes: null, downloaded: 0, total: null, lastChecked: null, error: null,
  });
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const inFlight = useRef(false);
  const current = useRef(status); current.current = status;
  const mounted = useRef(true);
  const apply = useCallback((next: UpdateStatus) => {
    if (mounted.current) setStatus(previous => next.revision >= previous.revision ? next : previous);
  }, []);
  const run = useCallback(async (name: string) => {
    if (!desktop || inFlight.current) return;
    inFlight.current = true;
    setPending(true); setActionError("");
    try { apply(await command<UpdateStatus>(name)); }
    catch (error) { if (mounted.current) setActionError(message(error)); }
    finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }, [apply]);

  useEffect(() => {
    mounted.current = true;
    if (!desktop) return;
    let stopped = false;
    let dispose: (() => void) | undefined;
    let startup: ReturnType<typeof setTimeout> | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    const autoCheck = () => {
      const update = current.current;
      if (["idle", "upToDate", "error"].includes(update.phase)
        && (!update.lastChecked || Date.now() - update.lastChecked >= CHECK_INTERVAL)) {
        void run("check_for_updates");
      }
    };
    void (async () => {
      dispose = await listen<UpdateStatus>("relay:update", event => { if (!stopped) apply(event.payload); });
      if (stopped) { dispose(); return; }
      const snapshot = await command<UpdateStatus>("update_status");
      if (stopped) return;
      apply(snapshot);
      startup = setTimeout(autoCheck, 10_000);
      interval = setInterval(autoCheck, CHECK_INTERVAL);
    })().catch(error => { if (!stopped) setActionError(message(error)); });
    return () => {
      stopped = true; mounted.current = false;
      dispose?.(); clearTimeout(startup); clearInterval(interval);
    };
  }, [apply, run]);

  return {
    status, pending, error: actionError || status.error,
    check: () => run("check_for_updates"),
    download: () => run("download_update"),
    install: () => run("install_update"),
  };
}
export type Updates = ReturnType<typeof useUpdates>;

export function updateProgress(status: UpdateStatus) {
  const received = (status.downloaded / 1024 / 1024).toFixed(1);
  if (!status.total) return `已下载 ${received} MB`;
  const total = (status.total / 1024 / 1024).toFixed(1);
  const percent = Math.min(100, Math.floor(status.downloaded / status.total * 100));
  return `${percent}% · ${received} / ${total} MB`;
}
