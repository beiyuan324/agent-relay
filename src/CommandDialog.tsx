import { useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { message, type Json } from "./api";
import { Modal } from "./Dialogs";
import type { ComposerDraft } from "./mentions";
import { EFFORT_LABELS, type SlashCommand } from "./slash-commands";

export type CommandDialogKind = "model" | "reasoning" | "review" | "rename" | "status" | "mcp" | "help" | "goal" | "prompt";
const titles: Record<CommandDialogKind, string> = {
  model: "选择模型", reasoning: "推理强度", review: "代码审查", rename: "重命名会话",
  status: "会话状态", mcp: "MCP 服务状态", help: "斜杠命令", goal: "目标", prompt: "自定义提示词",
};
export interface CommandDialogState {
  kind: CommandDialogKind;
  device: string;
  threadId: string;
  argument?: string;
  initial?: string;
  info?: Json;
  load?: () => Promise<Json>;
  prompt?: { content: string; argumentHint: string };
  suffix?: ComposerDraft;
}
export function CommandDialog({ state, commands, models, model, effort, close, apply }: {
  state: CommandDialogState; commands: SlashCommand[]; models: Json[]; model: string; effort: string;
  close: () => void; apply: (value: Json) => Promise<void>;
}) {
  const { kind } = state;
  const [value, setValue] = useState(state.argument || (kind === "prompt" ? "" : state.initial) || (kind === "model" ? model : kind === "reasoning" ? effort : ""));
  const [target, setTarget] = useState(state.argument ? "custom" : "uncommittedChanges");
  const [budget, setBudget] = useState("");
  const [data, setData] = useState<Json>({});
  const [loading, setLoading] = useState(!!state.load);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!state.load) return;
    let stopped = false;
    void state.load().then(result => {
      if (stopped) return;
      setData(result);
      if (kind === "goal" && result.goal) {
        setValue(state.argument || result.goal.objective || "");
        setBudget(result.goal.tokenBudget ? String(result.goal.tokenBudget) : "");
      }
    }).catch(error => { if (!stopped) setError(message(error)); }).finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [state]);
  const submit = async (payload?: Json) => {
    if (busy || loading) return;
    setBusy(true); setError("");
    try {
      if (kind === "goal" && !payload && budget && (!/^\d+$/.test(budget) || !Number.isSafeInteger(Number(budget)) || Number(budget) <= 0)) throw new Error("Token 预算必须为正整数");
      await apply(payload || (kind === "review" ? { target: target === "uncommittedChanges" ? { type: target } : target === "baseBranch" ? { type: target, branch: value.trim() } : target === "commit" ? { type: target, sha: value.trim(), title: null } : { type: "custom", instructions: value.trim() } }
        : kind === "goal" ? { objective: value.trim(), status: "active", tokenBudget: budget ? Number(budget) : null }
        : { value: value.trim() }));
      close();
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  };
  const readonly = ["status", "mcp", "help"].includes(kind);
  const empty = kind === "rename" || kind === "goal" || (kind === "review" && target !== "uncommittedChanges");
  const selectedModel = models.find(item => (item.model || item.id) === model);
  const rates: Json[] = data.rateLimitsByLimitId ? Object.values(data.rateLimitsByLimitId) as Json[] : data.rateLimits ? [data.rateLimits] : [];
  return <Modal title={titles[kind]} subtitle={state.info?.deviceName} close={close} footer={readonly ? <button className="secondary full" onClick={close}>关闭</button> : <div className="dialog-footer"><button className="secondary" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={busy || loading || (!!empty && !value.trim()) || (kind === "model" && !value)} onClick={() => void submit()}>{busy && <Loader2 size={14} className="spin" />}{kind === "review" ? "开始审查" : kind === "goal" ? data.goal ? "更新目标" : "开始目标" : "确定"}</button></div>}>
    {loading && <div className="command-loading" role="status"><Loader2 size={16} className="spin" />正在读取执行电脑的状态…</div>}
    {kind === "prompt" && <div className="form-group"><label htmlFor="prompt-arguments">{state.initial}</label><input id="prompt-arguments" autoFocus value={value} disabled={busy} placeholder={state.prompt?.argumentHint || '填写参数，例如 NAME="内容" 或位置参数'} onChange={event => setValue(event.target.value)} /></div>}
    {kind === "model" && <div className="form-group"><label htmlFor="command-model">后续消息使用的模型</label><select id="command-model" value={value} disabled={busy} onChange={event => setValue(event.target.value)}><option value="" disabled>选择可用模型</option>{models.map(item => <option key={item.id || item.model} value={item.model || item.id}>{item.displayName || item.model || item.id}</option>)}</select></div>}
    {kind === "reasoning" && <div className="form-group"><label htmlFor="command-effort">推理强度</label><select id="command-effort" value={value} disabled={busy} onChange={event => setValue(event.target.value)}><option value="">模型默认</option>{(selectedModel?.supportedReasoningEfforts || []).map((item: Json) => <option key={item.reasoningEffort} value={item.reasoningEffort}>{EFFORT_LABELS[item.reasoningEffort] || item.reasoningEffort}</option>)}</select></div>}
    {kind === "rename" && <form onSubmit={event => { event.preventDefault(); void submit(); }}><div className="form-group"><label htmlFor="command-name">会话名称</label><input id="command-name" autoFocus value={value} maxLength={120} disabled={busy} onChange={event => setValue(event.target.value)} /></div></form>}
    {kind === "review" && <div className="form-group"><label htmlFor="review-target">审查范围</label><select id="review-target" value={target} disabled={busy} onChange={event => { setTarget(event.target.value); setValue(""); }}><option value="uncommittedChanges">未提交的修改</option><option value="baseBranch">与基础分支比较</option><option value="commit">指定提交</option><option value="custom">自定义审查说明</option></select>{target !== "uncommittedChanges" && <><label htmlFor="review-value">{target === "baseBranch" ? "基础分支" : target === "commit" ? "提交 SHA" : "审查说明"}</label><textarea id="review-value" autoFocus rows={3} value={value} disabled={busy} onChange={event => setValue(event.target.value)} /></>}</div>}
    {kind === "goal" && !loading && <><div className="form-group"><label htmlFor="goal-objective">持续目标</label><textarea id="goal-objective" autoFocus rows={5} value={value} disabled={busy} onChange={event => setValue(event.target.value)} /><label htmlFor="goal-budget">Token 预算（可选）</label><input id="goal-budget" inputMode="numeric" value={budget} disabled={busy} onChange={event => setBudget(event.target.value)} /></div>{data.goal && <div className="goal-controls"><span>状态：{goalLabel(data.goal.status)}</span><span>已用 {Number(data.goal.tokensUsed || 0).toLocaleString()} tokens</span><button className="secondary small" disabled={busy} onClick={() => void submit({ action: "status", status: data.goal.status === "active" ? "paused" : "active" })}>{data.goal.status === "active" ? "暂停目标" : "继续目标"}</button><button className="secondary small" disabled={busy} onClick={() => void submit({ action: "clear" })}>清除目标</button></div>}</>}
    {kind === "status" && <><div className="settings-group">{Object.entries(state.info || {}).filter(([key]) => key !== "deviceName").map(([key, value]) => <div className="info-row" key={key}><span>{key}</span><span className="info-value">{String(value ?? "未提供")}</span></div>)}</div>{rates.map((rate, index) => <div className="settings-group" key={index}><strong>{rate.limitName || rate.limitId || "账户额度"}</strong>{["primary", "secondary"].map(window => rate[window] && <div className="info-row" key={window}><span>{window === "primary" ? "主要额度窗口" : "次要额度窗口"}</span><span className="info-value">已用 {rate[window].usedPercent ?? "未知"}%{rate[window].resetsAt ? " · " + new Date(rate[window].resetsAt * 1000).toLocaleString() + " 重置" : ""}</span></div>)}{rate.credits && <div className="info-row"><span>额度余额</span><span className="info-value">{rate.credits.unlimited ? "不限额" : rate.credits.balance ?? "未提供"}</span></div>}</div>)}</>}
    {kind === "mcp" && !loading && <div className="command-catalog">{(data.data || []).map((server: Json) => <div className="command-catalog-row" key={server.name}><strong>{server.name}</strong><small>{typeof server.runtimeStatus === "string" ? server.runtimeStatus : server.runtimeStatus?.status || server.runtimeStatus?.type || "未提供连接状态"} · {server.authStatus || "未提供认证状态"}</small><small>{Object.keys(server.tools || {}).length} 个工具 · {(server.resources || []).length} 个资源</small>{server.toolsError && <p className="error-text">{server.toolsError}</p>}</div>)}{!data.data?.length && !error && <p className="muted">执行电脑没有返回已配置的 MCP 服务。</p>}</div>}
    {kind === "help" && <div className="command-catalog">{commands.map(command => <div className="command-catalog-row" key={command.id}><strong>/{command.id} <span className="muted">{command.label}</span></strong><small>{command.description}</small>{command.disabledReason && <small className="muted">{command.disabledReason}</small>}</div>)}<p className="muted micro">↑↓ 选择，Enter / Tab 执行，Esc 关闭；Shift + Tab 切换计划模式。技能也会出现在 / 列表中。命令仅在当前执行环境支持时可用。</p></div>}
    {error && <p className="error-text" role="alert"><AlertCircle size={14} /> {error}</p>}
  </Modal>;
}
export function goalLabel(status: string) {
  return ({ active: "进行中", paused: "已暂停", blocked: "需要补充信息", usageLimited: "额度受限", budgetLimited: "预算耗尽", complete: "已完成" } as Record<string, string>)[status] || status;
}
