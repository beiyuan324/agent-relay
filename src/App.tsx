import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertCircle, Archive, ArchiveRestore, ArrowUp, ChevronDown, ChevronRight, CircleHelp, FileCode2, Folder, Globe2, Laptop, Loader2, LockKeyhole, Monitor, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Search, Settings2, ShieldCheck, Square, Wifi, X } from "lucide-react";
import { call, command, desktop, message, stateLabels, subscribe, title, when, type Device, type Json, type Snapshot } from "./api";
import { useWorkbench } from "./workbench";
import { updateProgress, useUpdates } from "./updates";
import { groupProjectThreads, type CodexProject, type ProjectGroup } from "./projects";
import { WindowTitlebar } from "./WindowTitlebar";
import { MentionComposer } from "./MentionComposer";
import { MessageQueue } from "./MessageQueue";
import { ContextUsage } from "./ContextUsage";
import { EMPTY_DRAFT, editDraft, insertMention, type ComposerDraft } from "./mentions";
import { EFFORT_LABELS, SLASH_COMMANDS, expandPrompt, parseSlash, type SlashCommand } from "./slash-commands";
import { CommandDialog, goalLabel, type CommandDialogState } from "./CommandDialog";
import { referenceKind, type MessageReference } from "./message-text";
import { Approval, Inspector, Transcript } from "./Transcript";
import { copy, DeviceDialog, DiagnosticsDialog, Modal, NewThreadDialog, PairDialog, SettingsDialog } from "./Dialogs";
import { useElementWidth, useFocusScope, useMediaQuery } from "./ui";

type Dialog = "pair" | "settings" | "new" | "diagnostics" | "help" | null;
const collapsedProjectsKey = "relay.collapsedProjects";
const deviceSidebarKey = "relay.deviceSidebarCollapsed";
const referenceLabels: Record<string, string> = { plugin: "插件", app: "应用", file: "文件" };
const projectKey = (device: string, cwd: string) => JSON.stringify([device, cwd]);
function readCollapsedProjects(): Record<string, boolean> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(collapsedProjectsKey) || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter(([, value]) => value === true));
  } catch { return {}; }
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const updates = useUpdates();
  const [deviceId, setDeviceId] = useState("local");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [commandDialog, setCommandDialog] = useState<CommandDialogState | null>(null);
  const [promptCatalog, setPromptCatalog] = useState<{ device: string; commands: SlashCommand[]; error?: string }>({ device: "", commands: [] });
  const [modeCatalog, setModeCatalog] = useState<{ device: string; modes: Json[]; error?: string }>({ device: "", modes: [] });
  const [creatingProjectKey, setCreatingProjectKey] = useState<string | null>(null);
  const creatingThread = useRef(false);
  const [collapsedProjects, setCollapsedProjects] = useState(readCollapsedProjects);
  const beginNewThread = useCallback(() => setDialog("new"), []);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [reference, setReference] = useState<MessageReference | null>(null);
  const [referenceCopied, setReferenceCopied] = useState(false);
  const promptedPairs = useRef(new Set<string>());
  const [error, setError] = useState("");
  const [booting, setBooting] = useState(desktop);
  const [inspector, setInspector] = useState(false);
  const [windowMaximized, setWindowMaximized] = useState(false);
  const [sidebar, setSidebar] = useState(() => {
    try { return localStorage.getItem(deviceSidebarKey) !== "true"; } catch { return true; }
  });
  const narrow = useMediaQuery("(max-width: 1100px)");
  const [sidebarOverlay, setSidebarOverlay] = useState(false);
  const sidebarExpanded = sidebarOverlay || (!narrow && sidebar);
  const workspace = useRef<HTMLElement>(null);
  const devicePanel = useRef<HTMLElement>(null);
  const inspectorPanel = useRef<HTMLDivElement>(null);
  const workspaceWidth = useElementWidth(workspace);
  const inspectorDrawer = inspector && workspaceWidth < 960;
  const details = snapshot?.devices.find(device => device.id === detailId);
  const modalOpen = dialog !== null || commandDialog !== null || !!details || reference !== null;
  const modifier = /mac|iphone|ipad/i.test(snapshot?.settings.identity.platform || navigator.platform) ? "⌘" : "Ctrl";
  const toggleSidebar = () => {
    if (narrow) {
      if (!sidebarOverlay) setInspector(false);
      setSidebarOverlay(previous => !previous);
    } else setSidebar(previous => !previous);
  };
  useFocusScope(devicePanel, sidebarOverlay && !modalOpen, () => setSidebarOverlay(false));
  useFocusScope(inspectorPanel, inspectorDrawer && !modalOpen && !sidebarOverlay, () => setInspector(false));
  useEffect(() => { if (!narrow) setSidebarOverlay(false); }, [narrow]);
  useEffect(() => {
    if (modalOpen) {
      setSidebarOverlay(false);
      if (inspectorDrawer) setInspector(false);
    }
  }, [modalOpen, inspectorDrawer]);
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({});
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [sharingBusy, setSharingBusy] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const device = snapshot?.devices.find(device => device.id === deviceId);
  const local = deviceId === "local";
  const available = desktop && !!snapshot && (local || (device?.state === "connected" && device.peerSharing));
  const deviceName = local ? snapshot?.settings.identity.name || "这台电脑" : device?.peer?.name || "另一台电脑";
  const availableDevices = useMemo(() => new Set<string>(desktop && snapshot ? ["local", ...snapshot.devices.filter(device => device.state === "connected" && device.peerSharing).map(device => device.id)] : []), [snapshot]);
  const workbench = useWorkbench(deviceId, available, setError, availableDevices);
  const connectionLabel = local ? "本机执行" : !available ? device?.state === "connected" ? "共享已暂停" : "连接已断开" : workbench.opening ? "正在同步会话" : "加密连接";
  const openReference = useCallback((reference: MessageReference) => {
    if (referenceKind(reference.href) === "thread") {
      const url = new URL(reference.href), host = url.searchParams.get("hostId");
      if (!host || host === "local") {
        if (!available) { setError("连接执行设备后才能打开引用的会话。"); return; }
        if (url.hostname !== workbench.selected) { setError(""); void workbench.open(url.hostname); }
        return;
      }
    }
    setReferenceCopied(false);
    setReference(reference);
  }, [available, workbench.open, workbench.selected]);
  const relayEvent = useRef(workbench.event); relayEvent.current = workbench.event;
  const deviceEventVersion = useRef(0);
  const deviceEvents = useRef(new Map<string, { version: number; device: Device }>());
  const readSnapshot = useCallback(async (stopped: () => boolean = () => false) => {
    const version = deviceEventVersion.current;
    const snapshot = await command<Snapshot>("snapshot");
    if (stopped()) return;
    const devices = new Map(snapshot.devices.map(device => [device.id, device]));
    for (const update of deviceEvents.current.values()) {
      if (update.version > version) devices.set(update.device.id, update.device);
    }
    setSnapshot({ ...snapshot, devices: [...devices.values()] });
  }, []);
  const refresh = useCallback(async (select?: string) => {
    if (!desktop) return;
    await readSnapshot();
    if (select) setDeviceId(select);
  }, [readSnapshot]);

  useEffect(() => {
    if (!desktop) return;
    let stopped = false;
    let dispose: (() => void) | undefined;
    void (async () => {
      dispose = await subscribe(event => {
        if (stopped) return;
        if (event.type === "device" && typeof event.device === "object") {
          const device = event.device as Device;
          deviceEvents.current.set(device.id, { version: ++deviceEventVersion.current, device });
          setSnapshot(previous => previous ? { ...previous, devices: [...previous.devices.filter(d => d.id !== device.id), device] } : previous);
        } else if (event.type === "diagnostic" && typeof event.message === "string") {
          const text = event.message;
          setError(text);
          setSnapshot(previous => previous ? { ...previous, diagnostics: [...previous.diagnostics.slice(-99), text] } : previous);
        } else relayEvent.current(event);
      });
      if (stopped) { dispose(); return; }
      await readSnapshot(() => stopped);
      if (!stopped) setBooting(false);
    })().catch(error => { if (!stopped) { setError(message(error)); setBooting(false); } });
    return () => { stopped = true; dispose?.(); };
  }, [readSnapshot]);

  useEffect(() => {
    if (!snapshot) return;
    if (details?.state === "pending" && !details.approved) promptedPairs.current.add(details.id);
    if (details || (dialog !== null && dialog !== "pair")) return;
    const pending = snapshot.devices.find(device => device.state === "pending" && device.peer && !device.approved && !promptedPairs.current.has(device.id));
    if (!pending) return;
    promptedPairs.current.add(pending.id);
    setDialog(null);
    setDetailId(pending.id);
  }, [snapshot, details, dialog]);

  useEffect(() => {
    document.documentElement.dataset.theme = snapshot?.settings.theme || "system";
  }, [snapshot?.settings.theme]);
  useEffect(() => {
    if (!local && snapshot && !device) { setDeviceId("local"); setDetailId(null); }
  }, [snapshot, device, local]);
  useEffect(() => {
    setModel(""); setEffort("");
    setDialog(previous => previous === "new" ? null : previous);
  }, [deviceId]);
  useEffect(() => {
    try { localStorage.setItem(collapsedProjectsKey, JSON.stringify(collapsedProjects)); } catch { /* Keep the in-memory preference when storage is unavailable. */ }
  }, [collapsedProjects]);
  useEffect(() => {
    try { localStorage.setItem(deviceSidebarKey, String(!sidebar)); } catch { /* Keep the current layout when storage is unavailable. */ }
  }, [sidebar]);
  useEffect(() => {
    if (!model && workbench.models.length) {
      const existing = workbench.models.find((m: Json) => m.model === workbench.permissions?.model);
      const preferred = existing || workbench.models.find((m: Json) => m.isDefault) || workbench.models[0];
      setModel(preferred.model || preferred.id);
      setEffort(workbench.permissions?.reasoningEffort || preferred.defaultReasoningEffort || "");
    }
  }, [workbench.models, workbench.permissions, model]);

  useEffect(() => {
    const savedModel = workbench.permissions?.model;
    if (savedModel && workbench.models.some((item: Json) => (item.model || item.id) === savedModel)) {
      setModel(savedModel); setEffort(workbench.permissions?.reasoningEffort || "");
    }
  }, [workbench.permissions, workbench.models]);

  const groupProjects = useMemo(() => groupProjectThreads(workbench.threads, workbench.projectCatalog, workbench.search), [workbench.threads, workbench.projectCatalog, workbench.search]);
  const archivedGroups = useMemo(() => groupProjectThreads(workbench.archivedThreads, workbench.projectCatalog, workbench.search).filter(group => group.threads.length), [workbench.archivedThreads, workbench.projectCatalog, workbench.search]);
  const projects = workbench.projectCatalog.data;
  const key = JSON.stringify([deviceId, workbench.thread?.relayDraftId || workbench.selected || ""]);
  const draftState = drafts[key] || EMPTY_DRAFT;
  const draft = draftState.text;
  const selectedModel = workbench.models.find((item: Json) => (item.model || item.id) === model);
  const efforts: Json[] = selectedModel?.supportedReasoningEfforts || [];
  const signedOut = workbench.environment?.account?.requiresOpenaiAuth && !workbench.environment?.account?.account;
  const canCompose = available && workbench.ready && !workbench.commandBusy && !workbench.opening && !workbench.thread?.relayArchived && !workbench.isArchiveBusy(workbench.selected || "") && workbench.environment?.installed !== false && !signedOut;
  useEffect(() => {
    if (!available) return;
    let stopped = false;
    setModeCatalog({ device: deviceId, modes: [] });
    setPromptCatalog({ device: deviceId, commands: [] });
    void call(deviceId, "relay/prompts").then(result => {
      if (!Array.isArray(result.data)) throw new Error("自定义命令目录无效");
      const seen = new Set<string>();
      const commands = result.data.filter((prompt: Json) => typeof prompt.name === "string" && typeof prompt.content === "string").map((prompt: Json): SlashCommand => ({ id: "prompts:" + prompt.name.toLowerCase(), label: prompt.name, description: prompt.description || "自定义提示词", keywords: prompt.argumentHint, prompt: { content: prompt.content, argumentHint: prompt.argumentHint || "" } })).filter((command: SlashCommand) => { if (seen.has(command.id)) return false; seen.add(command.id); return true; });
      if (!stopped) setPromptCatalog({ device: deviceId, commands, error: result.errors?.join("；") });
    }).catch(error => { if (!stopped) setPromptCatalog({ device: deviceId, commands: [], error: message(error) }); });
    void call(deviceId, "collaborationMode/list").then(result => {
      if (!Array.isArray(result.data)) throw new Error("执行电脑未返回协作模式目录");
      if (!stopped) setModeCatalog({ device: deviceId, modes: result.data });
    }).catch(error => { if (!stopped) setModeCatalog({ device: deviceId, modes: [], error: message(error) }); });
    return () => { stopped = true; };
  }, [deviceId, available]);
  const planPreset = modeCatalog.device === deviceId ? modeCatalog.modes.find(mode => mode.mode === "plan") : undefined;
  const effectiveModel = model || workbench.permissions?.model || selectedModel?.model || (workbench.models.find(item => item.isDefault) || workbench.models[0])?.model || planPreset?.model || "";
  const fastTier = (selectedModel?.serviceTiers || []).find((tier: Json) => tier.name?.toLowerCase() === "fast" || tier.id === "fast" || tier.id === "priority");
  useEffect(() => {
    if (!selectedModel || !workbench.serviceTier || workbench.serviceTier === "default") return;
    if (!(selectedModel.serviceTiers || []).some((tier: Json) => tier.id === workbench.serviceTier)) workbench.setServiceTier("default");
  }, [selectedModel, workbench.serviceTier]);
  const persisted = !!workbench.selected && !workbench.thread?.relayHistoryPending && !workbench.thread?.relayDraft;
  const occupied = !!workbench.activeTurn || workbench.sending || !!workbench.queue.length || workbench.thread?.status?.type === "active";
  const commands = useMemo(() => [...SLASH_COMMANDS, ...(promptCatalog.device === deviceId ? promptCatalog.commands : [])].map(command => {
    let disabledReason: string | undefined;
    if (["compact", "fork", "review", "rename", "archive", "goal"].includes(command.id) && !persisted) disabledReason = "发送首条消息后可使用";
    if (["compact", "fork", "review", "archive"].includes(command.id) && occupied) disabledReason = "请等待当前回合结束并处理待发消息";
    if (["compact", "review", "fork", "archive"].includes(command.id) && workbench.requests.some(request => !request.params?.threadId || request.params.threadId === workbench.selected)) disabledReason = "请先处理当前会话的待办审批";
    if (command.id === "plan" && !planPreset && workbench.mode !== "plan") disabledReason = modeCatalog.error ? "执行电脑不支持计划模式，请升级 Codex" : "正在读取可用的协作模式";
    if (command.id === "fast" && !fastTier) disabledReason = "当前模型未提供 Fast 服务档位";
    if (command.id === "reasoning" && !efforts.length) disabledReason = "当前模型未提供可选择的推理强度";
    if (command.id === "model" && !workbench.models.length) disabledReason = "执行电脑未提供可用模型";
    if (workbench.commandBusy) disabledReason = workbench.commandBusy;
    return { ...command, disabledReason };
  }), [deviceId, promptCatalog, persisted, occupied, planPreset, modeCatalog.error, fastTier, efforts.length, workbench.models.length, workbench.mode, workbench.requests, workbench.selected, workbench.commandBusy]);
  const consumeDraft = (sent: ComposerDraft, draftKey: string, next = EMPTY_DRAFT) => setDrafts(previous => previous[draftKey] === sent ? { ...previous, [draftKey]: next } : previous);
  const togglePlan = () => {
    if (!planPreset && workbench.mode !== "plan") { setError("执行电脑未提供计划模式，请等待模式目录加载或升级 Codex。"); return; }
    workbench.setMode(workbench.mode === "plan" ? "default" : "plan");
    composer.current?.focus();
  };
  const executeSlash = async (command: SlashCommand, preserveDraft = false) => {
    const selected = commands.find(item => item.id === command.id);
    if (!selected) { setError("未知命令，输入 / 查看可用命令。"); return; }
    if (selected.disabledReason) { setError(selected.disabledReason); return; }
    const sent = draftState, draftKey = key, parsed = parseSlash(draft);
    const preserved = !preserveDraft && draft.startsWith("/ ") ? editDraft(sent, draft.slice(2)) : undefined;
    const argument = preserveDraft || preserved ? "" : parsed?.argument || "";
    const scope = { device: deviceId, id: workbench.selected };
    const consume = (next?: ComposerDraft) => { if (!preserveDraft) consumeDraft(sent, draftKey, next || preserved || EMPTY_DRAFT); };
    try {
      if (selected.prompt) {
        try { consume(editDraft(sent, expandPrompt(selected.prompt.content, argument) + (preserved?.text ? "\n\n" + preserved.text : ""))); window.requestAnimationFrame(() => composer.current?.focus()); }
        catch {
          setCommandDialog({ kind: "prompt", device: deviceId, threadId: workbench.selected || "", argument, prompt: selected.prompt, initial: selected.id, suffix: preserved });
          consume();
        }
        return;
      }
      if (command.id === "plan") {
        const next = argument === "off" || argument === "default" ? "default" : argument ? "plan" : workbench.mode === "plan" ? "default" : "plan";
        if (argument && !["on", "off", "default"].includes(argument)) {
          if (!await workbench.send(editDraft(sent, argument), effectiveModel, effort, next, workbench.serviceTier)) return;
        }
        workbench.setMode(next); consume(); return;
      }
      if (command.id === "model" && argument) {
        const chosen = workbench.models.find(item => (item.model || item.id) === argument);
        if (!chosen) throw new Error("未找到此模型，请使用 /model 从列表选择。");
        setModel(chosen.model || chosen.id); setEffort(chosen.defaultReasoningEffort || ""); consume(); return;
      }
      if (command.id === "reasoning" && argument) {
        if (argument !== "default" && !efforts.some(item => item.reasoningEffort === argument)) throw new Error("当前模型不支持此推理强度。");
        setEffort(argument === "default" ? "" : argument); consume(); return;
      }
      if (command.id === "fast") {
        if (argument && !["on", "off"].includes(argument)) throw new Error("用法：/fast [on|off]");
        workbench.setServiceTier(argument === "off" || (!argument && workbench.serviceTier === fastTier.id) ? "default" : fastTier.id); consume(); return;
      }
      if (command.id === "skills" || command.id === "apps") { consume(editDraft(sent, (command.id === "skills" ? "$" : "@") + argument + (preserved?.text ? " " + preserved.text : ""))); window.requestAnimationFrame(() => { composer.current?.focus(); composer.current?.setSelectionRange(1 + argument.length, 1 + argument.length); }); return; }
      if (command.id === "init") {
        if (await workbench.send(editDraft(sent, "请检查当前项目，并为项目创建或完善 AGENTS.md，记录项目结构、开发约定、常用命令和注意事项。" + (argument ? "\n补充要求：" + argument : "")), effectiveModel, effort, planPreset || workbench.thread?.relayMode ? workbench.mode : undefined, workbench.serviceTier)) consume();
        return;
      }
      if (command.id === "compact") { if (argument) throw new Error("/compact 不接受额外参数"); await workbench.runCommand("thread/compact/start", {}, scope); consume(); return; }
      if (command.id === "fork") { if (argument) throw new Error("/fork 不接受额外参数"); await workbench.runCommand("thread/fork", {}, scope); consume(); return; }
      if (command.id === "new") {
        if (argument) throw new Error("/new 不接受额外参数");
        if (!workbench.thread?.cwd) { beginNewThread(); consume(); return; }
        await workbench.create(workbench.thread.cwd, model, deviceId, workbench.thread.projectId); consume(); return;
      }
      if (command.id === "project") { beginNewThread(); consume(); return; }
      if (command.id === "archive") { if (argument) throw new Error("/archive 不接受额外参数"); if (workbench.thread && await workbench.changeArchive(workbench.thread, true)) consume(); return; }
      if (command.id === "settings") { setDialog("settings"); consume(); return; }
      if (command.id === "feedback") { setDialog("diagnostics"); consume(); return; }
      if (command.id === "rename" && argument) { await workbench.runCommand("thread/name/set", { name: argument }, scope); consume(); return; }
      const kind = (command.id === "usage" ? "status" : command.id) as CommandDialogState["kind"];
      const state: CommandDialogState = { kind, device: deviceId, threadId: workbench.selected || "", argument, initial: kind === "rename" ? title(workbench.thread || {}) : undefined };
      if (kind === "status") {
        state.info = { deviceName, "会话 ID": workbench.selected, "执行电脑": deviceName, "项目路径": workbench.thread?.cwd || "未指定", "模型": effectiveModel || "主机默认", "推理强度": EFFORT_LABELS[effort] || effort || "默认", "协作模式": workbench.mode === "plan" ? "计划模式" : "默认模式", "上下文用量": workbench.thread?.tokenUsage?.last?.totalTokens ?? workbench.thread?.tokenUsage?.total?.totalTokens ?? "未提供", "上下文窗口": workbench.thread?.tokenUsage?.modelContextWindow ?? "未提供" };
        state.load = () => call(scope.device, "account/rateLimits/read");
      }
      if (kind === "mcp") state.load = async () => {
        const data: Json[] = [], seen = new Set<string>(); let cursor: string | null = null;
        do {
          const page: Json = await call(scope.device, "mcpServerStatus/list", { limit: 100, cursor, ...(persisted ? { threadId: scope.id } : {}) });
          if (!Array.isArray(page.data)) throw new Error("执行电脑返回的 MCP 列表无效");
          data.push(...page.data); cursor = page.nextCursor || null;
          if (cursor && seen.has(cursor)) throw new Error("MCP 分页未能继续"); if (cursor) seen.add(cursor);
        } while (cursor && data.length < 1000);
        return { data };
      };
      if (kind === "goal") state.load = () => call(scope.device, "thread/goal/get", { threadId: scope.id });
      setCommandDialog(state); consume();
    } catch (error) { setError(message(error)); }
  };
  const send = async () => {
    if (!canCompose || !draft.trim()) return;
    if (draft.trim() === "/") { composer.current?.focus(); composer.current?.setSelectionRange(1, 1); return; }
    const slash = parseSlash(draft);
    if (slash) {
      const command = commands.find(command => command.id === slash.id);
      if (command) await executeSlash(command);
      else {
        try {
          const catalog = await call(deviceId, "skills/list", { cwds: workbench.thread?.cwd ? [workbench.thread.cwd] : undefined });
          const skill = (catalog.data || []).flatMap((entry: Json) => entry.skills || []).find((skill: Json) => skill.enabled !== false && typeof skill.name === "string" && skill.name.toLowerCase() === slash.id);
          if (!skill) throw new Error("未知命令 /" + slash.id + "，输入 / 查看可用命令。");
          const next = insertMention(draftState, 0, draft.indexOf("/") + slash.id.length + 1, { kind: "skill", name: skill.name, label: skill.interface?.displayName || skill.name, path: skill.path, detail: skill.description || "" });
          consumeDraft(draftState, key, next.draft);
          window.requestAnimationFrame(() => { composer.current?.focus(); composer.current?.setSelectionRange(next.caret, next.caret); });
        } catch (error) { setError(message(error)); }
      }
      return;
    }
    const sent = draftState, draftKey = key;
    if (await workbench.send(sent, effectiveModel, effort, workbench.thread?.relayMode, workbench.serviceTier)) consumeDraft(sent, draftKey);
  };
  const implementPlan = async (plan: string) => {
    if (!canCompose || !planPreset) return;
    const accepted = await workbench.send({ text: "请按以下计划开始实施：\n\n" + plan, mentions: [] }, effectiveModel, effort, "default", workbench.serviceTier);
    if (accepted) workbench.setMode("default");
  };
  const implementPlanRef = useRef(implementPlan); implementPlanRef.current = implementPlan;
  const onImplementPlan = useCallback((plan: string) => { void implementPlanRef.current(plan); }, []);
  const applyCommand = async (value: Json) => {
    if (!commandDialog) return;
    if (commandDialog.device !== deviceId || commandDialog.threadId !== workbench.selected) throw new Error("会话或设备已变化，请重新打开命令");
    const scope = { device: commandDialog.device, id: commandDialog.threadId };
    if (commandDialog.kind === "prompt") {
      if (draftState.text.trim() && draftState !== commandDialog.suffix) throw new Error("输入框中已有新草稿，请先关闭命令并处理草稿");
      const text = expandPrompt(commandDialog.prompt!.content, value.value);
      const next = commandDialog.suffix ? editDraft(commandDialog.suffix, text + "\n\n" + commandDialog.suffix.text) : { text, mentions: [] };
      setDrafts(previous => ({ ...previous, [key]: next }));
      window.requestAnimationFrame(() => composer.current?.focus());
    }
    else if (commandDialog.kind === "model") { const chosen = workbench.models.find(item => (item.model || item.id) === value.value); if (!chosen) throw new Error("此模型已不可用"); setModel(value.value); setEffort(chosen.defaultReasoningEffort || ""); }
    else if (commandDialog.kind === "reasoning") setEffort(value.value);
    else if (commandDialog.kind === "rename") await workbench.runCommand("thread/name/set", { name: value.value }, scope);
    else if (commandDialog.kind === "review") await workbench.runCommand("review/start", value, scope);
    else if (commandDialog.kind === "goal") await workbench.runCommand(value.action === "clear" ? "thread/goal/clear" : "thread/goal/set", value.action === "clear" ? {} : value.action === "status" ? { status: value.status } : value, scope);
  };
  const queueing = !!workbench.activeTurn || workbench.sending || workbench.queue.length > 0;
  const editQueued = (id: string) => {
    if (draft.length) return;
    const item = workbench.removeQueued(id);
    if (!item) return;
    setDrafts(previous => ({ ...previous, [key]: item.draft }));
    setModel(item.model); setEffort(item.effort);
    if (item.collaborationMode || planPreset) workbench.setMode(item.collaborationMode || "default");
    if (item.serviceTier || workbench.serviceTier) workbench.setServiceTier(item.serviceTier || "default");
    window.requestAnimationFrame(() => { composer.current?.focus(); composer.current?.setSelectionRange(item.draft.text.length, item.draft.text.length); });
  };
  useEffect(() => {
    if (composer.current) { composer.current.style.height = "auto"; composer.current.style.height = `${Math.min(composer.current.scrollHeight, 180)}px`; }
  }, [draft, workbench.selected]);
  const openCommands = () => {
    if (!canCompose) return;
    const body = draft.startsWith("/") ? draft.replace(/^\/[^\s]*\s*/, "") : draft;
    setDrafts(previous => ({ ...previous, [key]: editDraft(draftState, "/" + (body ? " " + body : "")) }));
    window.requestAnimationFrame(() => { composer.current?.focus(); composer.current?.setSelectionRange(1, 1); });
  };
  const shortcuts = useRef({ available, modalOpen, sidebarOverlay, inspectorDrawer, canCompose, openCommands });
  shortcuts.current = { available, modalOpen, sidebarOverlay, inspectorDrawer, canCompose, openCommands };
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || shortcuts.current.modalOpen || shortcuts.current.sidebarOverlay || shortcuts.current.inspectorDrawer) return;
      if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && shortcuts.current.canCompose && !(event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])"))) { event.preventDefault(); shortcuts.current.openCommands(); return; }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        if (event.key.toLowerCase() === "k") { event.preventDefault(); searchInput.current?.focus(); }
        if (event.key.toLowerCase() === "n") { event.preventDefault(); if (shortcuts.current.available) beginNewThread(); }
        if (event.key === ",") { event.preventDefault(); setDialog("settings"); }
      }
    };
    window.addEventListener("keydown", handle); return () => window.removeEventListener("keydown", handle);
  }, [beginNewThread]);

  const action = async (name: string, args: Json = {}) => {
    try { await command(name, args); await refresh(); }
    catch (error) { setError(message(error)); }
  };
  const toggleSharing = async () => {
    setSharingBusy(true);
    await action("set_sharing", { enabled: !snapshot?.settings.sharing });
    setSharingBusy(false);
  };
  const createThread = async (cwd: string, project?: CodexProject) => {
    if (creatingThread.current) throw new Error("正在创建会话，请稍候");
    if (project && !project.native) throw new Error("此版本 Codex 不支持保存原生项目归属，请升级 Codex 后在项目中新建会话。");
    const target = deviceId;
    creatingThread.current = true;
    setCreatingProjectKey(projectKey(target, project?.id || "unassigned"));
    try {
      await workbench.create(cwd, model, target, project?.id);
      setCollapsedProjects(previous => { const next = { ...previous, [projectKey(target, project?.id || "unassigned")]: false }; if (project) for (const root of project.rootPaths) delete next[projectKey(target, root)]; return next; });
    } finally {
      creatingThread.current = false;
      setCreatingProjectKey(null);
    }
  };
  const approvalForThread = workbench.requests.filter(request => !request.params?.threadId || request.params.threadId === workbench.selected);
  const renderProjectGroups = (groups: ProjectGroup[], archived: boolean) => groups.map(group => {
    const { threads } = group;
    const cwd = group.rootPaths[0];
    const key = projectKey(deviceId, archived ? `archived:${group.id}` : group.id);
    const savedCollapse = collapsedProjects[key] ?? (!archived && group.rootPaths.some(root => collapsedProjects[projectKey(deviceId, root)]));
    const collapsed = !!savedCollapse && !workbench.search.trim();
    const listId = `project-${encodeURIComponent(key)}`;
    return <div className="project-group" key={group.id}>
      <div className="project-heading">
        <button className="project-toggle" title={group.rootPaths.length ? `${group.name}\n${group.rootPaths.join("\n")}` : "未归属于 Codex 项目的会话"} aria-expanded={!collapsed} aria-controls={listId} onClick={() => setCollapsedProjects(previous => { const next = { ...previous, [key]: !collapsed }; if (!archived) for (const root of group.rootPaths) delete next[projectKey(deviceId, root)]; return next; })}>
          <ChevronRight size={12} className={collapsed ? "" : "expanded"} /><Folder size={13} /><span className="project-name">{group.name}</span><span className="project-count" title="当前已加载的会话数量">{threads.length}</span>
        </button>
        {!archived && group.project && cwd && <button className="icon-button project-new" title={!group.project.native ? "此版本 Codex 不支持保存原生项目归属，请升级后新建会话" : creatingProjectKey === key ? "正在创建会话…" : `在 ${group.name} 中新建会话`} aria-label={`在 ${group.name} 中新建会话`} aria-busy={creatingProjectKey === key} disabled={!available || creatingProjectKey !== null || !group.project.native || workbench.environment?.installed === false || signedOut} onClick={() => { setError(""); void createThread(cwd, group.project).catch(error => setError(message(error))); }}>{creatingProjectKey === key ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}</button>}
      </div>
      <div id={listId} hidden={collapsed}>{threads.map(thread => {
        const busy = workbench.isArchiveBusy(thread.id);
        const reason = archived ? "" : workbench.archiveReason(thread);
        const actionLabel = archived ? "恢复会话" : "归档会话";
        const tooltip = () => {
          const date = when(thread.updatedAt || thread.createdAt);
          return [title(thread), date && `更新于：${date}`].filter(Boolean).join("\n");
        };
        return <div key={thread.id} className={`thread-row ${workbench.selected === thread.id ? "selected" : ""} ${busy ? "is-busy" : ""}`} aria-busy={busy}>
          <button className={`thread-item ${workbench.selected === thread.id ? "selected" : ""}`} title={tooltip()} onMouseEnter={event => { event.currentTarget.title = tooltip(); }} onFocus={event => { event.currentTarget.title = tooltip(); }} disabled={!available || busy} onClick={() => { setError(""); void workbench.open(thread.id, archived); }}>
            <div className="thread-item-heading"><span className="thread-item-title">{title(thread)}</span>{!archived && thread.status?.type === "active" && <span className="thread-meta"><span className="status-dot connected" /></span>}</div>
          </button>
          <button className="icon-button thread-archive" title={reason || actionLabel} aria-label={`${actionLabel}：${title(thread)}`} disabled={!available || busy || !!reason} onClick={() => { setError(""); void workbench.changeArchive(thread, !archived); }}>{busy ? <Loader2 size={16} className="spin" /> : archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}</button>
        </div>;
      })}{!threads.length && <div className="project-empty">{workbench.search ? "没有匹配的会话" : (archived ? workbench.archivedNextCursor : workbench.nextCursor) ? "更多会话尚未加载" : "暂无会话"}</div>}</div>
    </div>;
  });

  return <div className={`app-frame ${windowMaximized ? "is-maximized" : ""}`}>
    <WindowTitlebar onError={setError} onMaximizedChange={setWindowMaximized} />
    <div className={`app-shell ${!sidebarExpanded ? "sidebar-collapsed" : ""}`}>
    <div className="device-slot" inert={modalOpen || inspectorDrawer}>
    <aside className={`device-sidebar ${sidebarOverlay ? "is-overlay" : ""}`} id="device-sidebar" ref={devicePanel} tabIndex={sidebarOverlay ? -1 : undefined} role={sidebarOverlay ? "dialog" : undefined} aria-modal={sidebarOverlay || undefined} aria-label="设备与设置">
      <div className="device-sidebar-header">
        <h2 className="device-sidebar-title">设备</h2>
        <button className="icon-button sidebar-toggle" title={sidebarExpanded ? "收起设备栏" : "展开设备栏"} aria-label={sidebarExpanded ? "收起设备栏" : "展开设备栏"} aria-expanded={sidebarExpanded} aria-controls="device-sidebar" onClick={toggleSidebar}>{sidebarExpanded ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}</button>
      </div>
      <button className={`device-item ${local ? "selected" : ""}`} title={`${snapshot?.settings.identity.name || "这台电脑"} · ${desktop ? "本机 Codex" : "桌面预览"}`} aria-label={`${snapshot?.settings.identity.name || "这台电脑"}（本机）`} aria-pressed={local} onClick={() => { setDeviceId("local"); setSidebarOverlay(false); setError(""); }}><span className="device-icon"><Laptop size={19} /><span className={`status-dot device-status ${desktop && snapshot ? "connected" : ""}`} aria-hidden="true" /></span><span className="device-copy"><strong>{snapshot?.settings.identity.name || "这台电脑"}</strong><small>{desktop ? "本机 Codex" : "桌面预览"}</small></span></button>
      <div className="sidebar-section-label devices-label"><span>远程设备</span><button className="icon-button" title="添加设备" aria-label="添加设备" onClick={() => setDialog("pair")}><Plus size={15} /></button></div>
      <div className="paired-devices">
        {snapshot?.devices.map(device => <div className="device-row" key={device.id}><button className={`device-item ${deviceId === device.id ? "selected" : ""}`} title={`${device.peer?.name || "等待设备加入"} · ${stateLabels[device.state] || device.state}`} aria-label={`${device.peer?.name || "等待设备加入"} · ${stateLabels[device.state] || device.state}`} aria-pressed={deviceId === device.id} onClick={() => { setDeviceId(device.id); setSidebarOverlay(false); setError(""); if (device.state === "pending" && !device.approved) setDetailId(device.id); }}><span className="device-icon"><Monitor size={19} /><span className={`status-dot device-status ${device.state}`} aria-hidden="true" /></span><span className="device-copy"><strong>{device.peer?.name || "等待设备加入"}</strong><small>{stateLabels[device.state] || device.state}</small></span>{device.mode === "relay" ? <Globe2 size={13} className="connection-icon" /> : <Wifi size={13} className="connection-icon" />}</button><button className="device-more icon-button" title="设备详情" aria-label={`${device.peer?.name || "设备"}详情`} onClick={() => setDetailId(device.id)}><MoreHorizontal size={16} /></button></div>)}
        {!snapshot?.devices.length && <div className="no-devices"><p>未添加远程设备</p><button className="add-device-inline" onClick={() => setDialog("pair")}><Plus size={13} />添加设备</button></div>}
      </div>
      <div className="sidebar-bottom"><div className="share-card"><div className="share-card-top"><span className="share-symbol"><ShieldCheck size={17} /></span><div><strong>共享这台电脑</strong><small>{snapshot?.settings.sharing ? "已配对设备可访问 Codex" : "远端暂时无法访问本机"}</small></div><button className={`switch ${snapshot?.settings.sharing ? "on" : ""}`} role="switch" aria-checked={!!snapshot?.settings.sharing} aria-label="共享这台电脑" disabled={!desktop || !snapshot || sharingBusy} onClick={() => void toggleSharing()}><span /></button></div></div><button className={`compact-share ${snapshot?.settings.sharing ? "is-sharing" : ""}`} role="switch" aria-checked={!!snapshot?.settings.sharing} aria-label="共享这台电脑" title={snapshot?.settings.sharing ? "本机共享已开启，点击暂停" : "本机共享已暂停，点击开启"} disabled={!desktop || !snapshot || sharingBusy} onClick={() => void toggleSharing()}><ShieldCheck size={20} /></button><button className="sidebar-footer-button" title={`设置 (${modifier}+,)`} aria-label="设置" onClick={() => setDialog("settings")}><Settings2 size={18} /><span className="sidebar-footer-label">设置</span><span className="footer-meta">{modifier} ,</span></button><button className={`sidebar-footer-button ${snapshot?.diagnostics.length ? "has-diagnostics" : ""}`} title={snapshot?.diagnostics.length ? `连接诊断：${snapshot.diagnostics.length} 条记录` : "连接诊断"} aria-label="连接诊断" onClick={() => setDialog("diagnostics")}><Activity size={18} /><span className="sidebar-footer-label">连接诊断</span><span className={`footer-meta ${snapshot?.diagnostics.length ? "diagnostic-count" : ""}`}>{snapshot?.diagnostics.length || ""}</span></button><div className="sidebar-footnote"><LockKeyhole size={11} />设备之间，端到端加密</div></div>
    </aside>
    </div>
    {sidebarOverlay && <div className="sidebar-backdrop" aria-hidden="true" onMouseDown={() => setSidebarOverlay(false)} />}

    <aside className="thread-sidebar" aria-label="会话列表" inert={modalOpen || sidebarOverlay || inspectorDrawer}>
      <div className="thread-sidebar-top"><div><h1>会话</h1><p title={deviceName}>{deviceName}</p></div><button className="icon-button new-thread-button" aria-label="新建会话" title={`新建会话 (${modifier}+N)`} disabled={!available} onClick={() => beginNewThread()}><Plus size={20} /></button></div>
      <div className="search-box"><Search size={15} /><input ref={searchInput} value={workbench.search} disabled={!available} placeholder="搜索会话" aria-label="搜索会话" onChange={event => workbench.setSearch(event.target.value)} /><kbd>{modifier} K</kbd></div>
      {!!workbench.requests.length && <button className="approval-nav" onClick={() => { const id = workbench.requests[0].params?.threadId; if (id) void workbench.open(id); }}><ShieldCheck size={14} />{workbench.requests.length} 项待处理<ChevronRight size={13} /></button>}
      {workbench.projectsError && <div className="project-sync-error" role="status"><AlertCircle size={14} /><span>{workbench.projectsError}</span></div>}
      <div className="thread-list" aria-busy={workbench.loading || workbench.projectsLoading}>
        {renderProjectGroups(groupProjects, false)}
        {!workbench.threads.length && !groupProjects.length && !workbench.loading && !workbench.projectsLoading && <div className="thread-list-empty">{!available ? "连接设备后，会话会显示在这里。" : workbench.search ? "没有找到匹配的会话。" : "暂无会话。"}</div>}
        {workbench.projectsLoading && !projects.length && <div className="list-loading"><Loader2 size={17} className="spin" />正在同步 Codex 项目…</div>}
        {workbench.loading && !workbench.threads.length && <div className="list-loading"><Loader2 size={17} className="spin" />正在读取会话…</div>}
        {workbench.nextCursor && <button className="load-older" disabled={!available || workbench.loading} onClick={() => void workbench.loadMore()}>加载更多会话</button>}
      </div>
      <section className="archive-section" aria-label="已归档会话">
        <button className="archive-toggle" aria-expanded={workbench.archiveExpanded} aria-controls="archived-thread-list" onClick={workbench.toggleArchive}>
          <ChevronRight size={14} className={workbench.archiveExpanded ? "expanded" : ""} /><Archive size={15} /><span>已归档</span>
          {workbench.archiveExpanded && !workbench.archivedLoading && !workbench.archivedError && <span className="project-count" title="当前已加载的归档会话数量">{workbench.archivedThreads.length}</span>}
        </button>
        <div className="archived-thread-list" id="archived-thread-list" hidden={!workbench.archiveExpanded} aria-busy={workbench.archivedLoading}>
          {workbench.archiveExpanded && <>
            {renderProjectGroups(archivedGroups, true)}
            {workbench.archivedLoading && !workbench.archivedThreads.length && <div className="list-loading"><Loader2 size={16} className="spin" />正在读取已归档会话…</div>}
            {workbench.archivedError && <div className="archive-list-error" role="status"><p>{workbench.archivedError}</p><button className="text-button" disabled={!available || workbench.archivedLoading} onClick={() => void workbench.retryArchived()}><RefreshCw size={13} />重试读取</button></div>}
            {!workbench.archivedThreads.length && !workbench.archivedLoading && !workbench.archivedError && <div className="archive-list-empty">{!available ? "连接设备后可查看归档会话。" : workbench.search ? "没有匹配的已归档会话。" : "暂无已归档会话。"}</div>}
            {workbench.archivedNextCursor && <button className="load-older" disabled={!available || workbench.archivedLoading} onClick={() => void workbench.loadMoreArchived()}>加载更多已归档会话</button>}
          </>}
        </div>
      </section>
      <div className="thread-sidebar-footer"><span>{workbench.threads.length ? `已加载 ${workbench.threads.length} 个会话` : "Codex 工作台"}</span><button className="icon-button" aria-label="刷新会话" disabled={!available || workbench.loading || workbench.archivedLoading || workbench.opening} onClick={() => void workbench.refresh()}><RefreshCw size={13} /></button></div>
    </aside>

    <main className="workspace" ref={workspace} inert={modalOpen || sidebarOverlay}>
      <header className="workspace-toolbar" data-tauri-drag-region inert={inspectorDrawer}>
        <div className="toolbar-leading">{workbench.thread && <div className="toolbar-title"><strong title={title(workbench.thread)}>{title(workbench.thread)}</strong>{workbench.thread.cwd && <button className="toolbar-path" title={`复制项目路径：${workbench.thread.cwd}`} onClick={() => { void copy(workbench.thread!.cwd).catch(error => setError(message(error))); }}>{workbench.thread.cwd}</button>}</div>}</div>
        <div className="toolbar-trailing">
          {local ? <div className="execution-device" title={`当前执行电脑：${deviceName}（本机）`}><span className={`status-dot ${available ? "connected" : ""}`} /><Laptop size={13} /><span>{deviceName}</span></div> : <button className={`execution-device ${!available ? "is-offline" : ""}`} title={`当前执行电脑：${deviceName} · ${connectionLabel}，查看设备详情`} onClick={() => setDetailId(deviceId)}><span className={`status-dot ${available ? "connected" : ""}`} /><Monitor size={13} /><span>{deviceName}</span>{!available && <span className="execution-connection">{device?.state === "connected" ? "共享已暂停" : "已断开"}</span>}<ChevronDown size={12} /></button>}
          <button className={`icon-button ${inspector ? "active" : ""}`} aria-label="文件变更检查器" title="文件变更" aria-pressed={inspector} aria-expanded={inspector} aria-controls="file-inspector" onClick={() => { setSidebarOverlay(false); setInspector(previous => !previous); }}><FileCode2 size={18} /></button>
          <button className="icon-button" title="使用帮助" aria-label="使用帮助" onClick={() => setDialog("help")}><CircleHelp size={18} /></button>
        </div>
      </header>
      {!desktop && <div className="preview-banner" inert={inspectorDrawer}><Monitor size={14} />这是界面预览。请通过 Relay 桌面应用连接真实设备和 Codex。</div>}
      {error && <div className="error-banner" role="alert" inert={inspectorDrawer}><AlertCircle size={15} /><span>{error}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setError("")}><X size={14} /></button></div>}
      {["available", "downloading", "ready", "installing"].includes(updates.status.phase) && <div className="update-banner" role="status" inert={modalOpen || inspectorDrawer}><RefreshCw size={15} className={updates.status.phase === "downloading" || updates.status.phase === "installing" ? "spin" : ""} /><span>{updates.status.phase === "downloading" ? `正在下载 Relay 更新 · ${updateProgress(updates.status)}` : updates.status.phase === "ready" ? `Relay ${updates.status.version} 已准备好安装` : updates.status.phase === "installing" ? "正在安装 Relay 更新…" : `Relay ${updates.status.version} 可更新`}</span><button className="secondary small" onClick={() => setDialog("settings")}>查看更新</button></div>}
      <div className="workspace-content">
        <div className="conversation-column" inert={inspectorDrawer}>
          {booting ? <div className="center-state"><Loader2 className="spin" size={27} /><h2>正在准备工作空间</h2></div> : !local && !available && !(workbench.selected && workbench.thread) ? <div className="center-state device-state"><span className="state-illustration"><Monitor size={49} strokeWidth={1.1} /><span className={`status-dot ${device?.state}`} /></span><h2>{device?.state === "pending" ? "确认这台电脑" : device?.state === "connected" ? "对方已暂停共享" : device?.state === "waiting" ? "等待另一台电脑加入" : device?.state === "handshaking" ? "正在验证设备身份" : "等待设备连接"}</h2><p>{device?.state === "pending" ? `请核对“${deviceName}”的身份，并在双方电脑上确认配对。` : device?.state === "connected" ? "请在执行电脑上开启共享，然后就能继续工作。" : device?.error || (device?.state === "waiting" ? "等待另一台电脑使用配对链接加入；收到设备身份后才会出现确认按钮。" : device?.state === "handshaking" ? "正在完成加密握手和设备身份交换，完成后请在双方电脑上确认。" : device?.state === "connecting" ? "正在连接设备或 Workers 中继。连接失败时会显示具体原因。" : "连接恢复后，可以重新读取会话。任务和审批不会自动重发。")}</p>{device && <div className="center-actions">{!device.approved && device.peer ? <button className="primary" onClick={() => setDetailId(device.id)}><ShieldCheck size={16} />确认设备身份</button> : <button className="secondary" onClick={() => setDetailId(device.id)}>设备详情</button>}{device.state !== "pending" && device.state !== "connected" && <button className="primary" onClick={() => void action("reconnect_device", { id: device.id })}><RefreshCw size={15} />重新连接</button>}</div>}</div> : workbench.selected && workbench.thread ? <><div className="conversation-notices"><div className="conversation-context">{!local && !available ? <AlertCircle size={12} className="connection-offline" /> : <LockKeyhole size={12} />}<span className={!local && !available ? "connection-offline" : undefined} role="status" title={!local && !available ? `${device?.error || connectionLabel}。当前显示已接收的内容，草稿可以继续编辑。` : undefined}>{connectionLabel}</span><span className="context-permissions"><ShieldCheck size={12} />{workbench.thread.relayArchived ? "已归档" : !available ? "离线浏览" : workbench.opening ? "正在接续" : !workbench.ready ? "尚未接续" : typeof workbench.permissions?.approvalPolicy === "string" ? `审批：${workbench.permissions.approvalPolicy}` : "沿用主机权限"}{workbench.permissions?.sandbox?.type ? ` · ${workbench.permissions.sandbox.type}` : ""}</span>{workbench.opening && <Loader2 size={13} className="spin" />}</div>{available && workbench.resumeError && <div className="session-banner" role="status"><AlertCircle size={16} /><div><strong>暂时无法接续 · 仅查看历史</strong><p>{workbench.resumeError}</p></div><button className="secondary small" disabled={!available || workbench.opening} onClick={() => { setError(""); if (workbench.selected) void workbench.open(workbench.selected); }}><RefreshCw size={13} />{workbench.opening ? "正在读取…" : "重试接续"}</button></div>}
            {workbench.thread.relayArchived && <div className="session-banner archived-banner" role="status"><Archive size={16} /><div><strong>此会话已归档</strong><p>恢复后可继续发送消息。</p></div><button className="secondary small" disabled={!available || workbench.opening || workbench.isArchiveBusy(workbench.thread.id)} onClick={() => { setError(""); void workbench.changeArchive(workbench.thread!, false); }}><ArchiveRestore size={14} />{workbench.isArchiveBusy(workbench.thread.id) ? "正在恢复…" : "恢复会话"}</button></div>}
            {workbench.historyError && <div className="session-banner history-warning" role="status"><AlertCircle size={15} /><div><p>{workbench.historyError}</p></div></div>}
            </div>
            <Transcript thread={workbench.thread} running={available && workbench.ready && !!workbench.activeTurn} older={() => void workbench.older()} hasOlder={!!workbench.olderCursor} loading={workbench.opening} offline={!available} onReference={openReference} onImplementPlan={canCompose && planPreset ? onImplementPlan : undefined} />
            {workbench.ready && !workbench.opening && !!approvalForThread.length && <div className="approvals-container">{approvalForThread.map(request => <Approval request={request} key={request.id} deviceName={deviceName} resolve={workbench.resolve} />)}</div>}
            {!workbench.thread.relayArchived && <div className="composer-container">{workbench.commandBusy && <div className="composer-command-status" role="status"><Loader2 size={14} className="spin" />{workbench.commandBusy}</div>}{workbench.thread.goal && <div className="composer-goal"><span><strong>目标 · {goalLabel(workbench.thread.goal.status)}</strong><small>{workbench.thread.goal.objective}</small></span><button className="secondary small" disabled={!canCompose} onClick={() => { void executeSlash(commands.find(command => command.id === "goal")!, true); }}>管理目标</button></div>}<MessageQueue items={workbench.queue} paused={workbench.queuePaused} available={canCompose} canEdit={!draft.length} onEdit={editQueued} onRemove={id => { workbench.removeQueued(id); }} onResume={workbench.resumeQueue} /><div className={`composer ${!canCompose ? "disabled" : ""}`}><MentionComposer key={key} device={deviceId} threadId={workbench.thread.relayDraft ? "" : workbench.selected || ""} cwd={workbench.thread.cwd || ""} deviceName={deviceName} enabled={canCompose && !modalOpen && !sidebarOverlay && !inspectorDrawer} draft={draftState} onChange={value => setDrafts(previous => ({ ...previous, [key]: value }))} inputRef={composer} commands={commands} commandError={promptCatalog.device === deviceId ? promptCatalog.error : undefined} onCommand={command => { void executeSlash(command); }} onTogglePlan={togglePlan} onSend={() => void send()} placeholder={canCompose ? queueing ? "继续输入，Enter 加入队列，当前回合结束后发送" : workbench.mode === "plan" ? "描述目标或问题，先与 Codex 制定计划" : "输入消息，/ 使用命令，@ 引用文件或应用，$ 使用技能" : workbench.commandBusy ? workbench.commandBusy : !available ? "连接已断开，可继续编辑草稿，恢复后再发送" : workbench.opening ? "正在同步会话，可继续编辑草稿" : workbench.resumeError ? "当前仅查看历史，接续成功后可发送消息" : "连接恢复后可继续输入和发送"} /><div className="composer-bottom"><div className="composer-selectors"><button type="button" className={`composer-mode ${workbench.mode === "plan" ? "is-plan" : ""}`} aria-pressed={workbench.mode === "plan"} disabled={!canCompose || (!planPreset && workbench.mode !== "plan")} title="Shift + Tab 切换计划模式" onClick={togglePlan}>{workbench.mode === "plan" ? "计划模式" : "默认模式"}</button>{workbench.serviceTier && workbench.serviceTier !== "default" && <span className="composer-tier">Fast</span>}<select aria-label="选择模型" title={selectedModel?.displayName || model || "主机默认模型"} value={model} disabled={!canCompose} onChange={event => { const chosen = workbench.models.find((m: Json) => (m.model || m.id) === event.target.value); setModel(event.target.value); setEffort(chosen?.defaultReasoningEffort || ""); }}><option value="">主机默认模型</option>{workbench.models.map((m: Json) => <option key={m.id || m.model} value={m.model || m.id}>{m.displayName || m.model || m.id}</option>)}</select>{!!efforts.length && <select aria-label="推理强度" value={effort} disabled={!canCompose} onChange={event => setEffort(event.target.value)}><option value="">默认强度</option>{efforts.map((e: Json) => <option key={e.reasoningEffort} value={e.reasoningEffort}>{EFFORT_LABELS[e.reasoningEffort] || e.reasoningEffort}</option>)}</select>}</div><div className="composer-actions"><ContextUsage usage={workbench.thread.tokenUsage} />{workbench.activeTurn && <button className="stop-button" aria-label="停止当前回合" onClick={() => void workbench.stop()} disabled={!available || !workbench.ready || workbench.opening}><Square size={12} fill="currentColor" />停止</button>}<button className="send-button" aria-label={queueing ? "加入消息队列" : "发送消息"} title={queueing ? "加入队列，当前回合结束后发送" : "发送消息"} disabled={!canCompose || !draft.trim()} onClick={() => void send()}><ArrowUp size={19} /></button></div></div></div><div className="composer-footnote" title={promptCatalog.device === deviceId ? promptCatalog.error : undefined}><span><Monitor size={11} />任务将在 {deviceName} 执行</span><span>{queueing ? "Enter 加入队列" : "Enter 发送"} · Shift + Enter 换行</span></div></div>}</> : workbench.selected && workbench.opening ? <div className="center-state"><Loader2 className="spin" size={26} /><p>正在读取会话…</p></div> : <div className="welcome">
              <h2>未选择会话</h2>
              <p className="welcome-description">从左侧打开已有会话，或新建会话。</p>
              <div className="welcome-actions">
                <button className="primary" disabled={!available || workbench.environment?.installed === false || signedOut} onClick={() => beginNewThread()}><Plus size={16} />新建会话</button>
                <button className="secondary" onClick={() => setDialog("pair")}>添加设备</button>
              </div>
              {(workbench.environment?.installed === false || signedOut) && <div className="environment-notice" role="status">
                <AlertCircle size={17} /><div><strong>{signedOut ? "Codex 未登录" : "未找到 Codex"}</strong><p>{signedOut ? <>在执行电脑运行 <code>codex login</code>，登录后刷新会话列表。</> : "在执行电脑安装 Codex，或在设置中指定可执行文件。"}</p></div>
                <button className="secondary small" onClick={() => { if (local) setDialog("settings"); else setDetailId(deviceId); }}>{local ? "设置" : "设备详情"}</button>
              </div>}
            </div>}
        </div>
        {inspectorDrawer && <div className="inspector-backdrop" aria-hidden="true" onMouseDown={() => setInspector(false)} />}
        {inspector && <div className={`inspector-panel ${inspectorDrawer ? "is-drawer" : ""}`} ref={inspectorPanel} role={inspectorDrawer ? "dialog" : undefined} aria-modal={inspectorDrawer || undefined} aria-label={inspectorDrawer ? "文件变更检查器" : undefined} tabIndex={inspectorDrawer ? -1 : undefined}><Inspector thread={workbench.thread} close={() => setInspector(false)} /></div>}
      </div>
    </main>
    {commandDialog && <CommandDialog key={JSON.stringify([commandDialog.device, commandDialog.threadId, commandDialog.kind])} state={commandDialog} commands={commands} models={workbench.models} model={model} effort={effort} close={() => setCommandDialog(null)} apply={applyCommand} />}
    {dialog === "pair" && <PairDialog snapshot={snapshot} close={() => setDialog(null)} changed={refresh} />}
    {dialog === "settings" && <SettingsDialog snapshot={snapshot} updates={updates} close={() => setDialog(null)} changed={async () => { await refresh(); workbench.refresh(); }} />}
    {dialog === "diagnostics" && <DiagnosticsDialog snapshot={snapshot} close={() => setDialog(null)} />}
    {dialog === "new" && <NewThreadDialog key={deviceId} projects={projects} deviceName={deviceName} close={() => setDialog(null)} create={createThread} />}
    {dialog === "help" && <Modal title="使用帮助" close={() => setDialog(null)}><div className="help-steps"><p><strong>1. 准备 Codex</strong><br />两台电脑安装 Relay 和 Codex，并分别完成本机登录。</p><p><strong>2. 创建并加入邀请</strong><br />选择“添加设备”。同一网络使用局域网地址，异地连接使用已部署的 Workers 中继。</p><p><strong>3. 双方确认并启用共享</strong><br />核对设备身份，分别确认配对，并打开需要被访问的电脑的共享开关。</p><p><strong>4. 选择执行电脑</strong><br />设备栏切换电脑，选择或新建会话。每次发送前可在工具栏确认执行位置。</p><p className="muted micro">网络恢复后重新读取会话。Relay 不会自动重发任务或审批，也不接管其他 Codex 进程中的活跃任务。{modifier}+K 搜索，{modifier}+N 新建，{modifier}+, 设置。</p></div></Modal>}
    {reference && <Modal title={reference.label} subtitle={referenceKind(reference.href) === "thread" ? "此引用来自另一台 Codex 主机，当前设备无法直接打开。" : "消息中引用的" + (referenceLabels[referenceKind(reference.href) || ""] || "资源")} close={() => setReference(null)} footer={<button className="secondary full" onClick={() => { void copy(reference.href).then(() => setReferenceCopied(true)).catch(error => setError(message(error))); }}>{referenceCopied ? "已复制引用地址" : "复制引用地址"}</button>}><div className="settings-group"><div className="info-row"><span>名称</span><strong className="info-value">{reference.label}</strong></div><div className="info-row"><span>地址</span><span className="info-value mono">{reference.href}</span></div></div></Modal>}
    {details && <DeviceDialog key={details.id} device={details} close={() => setDetailId(null)} changed={() => refresh()} />}
    </div>
  </div>;
}
