import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { message, type Json } from "./api";
import { approvalChoices, mcpFormContent, mcpFormFields, requestedPermissions, type FormAnswers } from "./approvals";

function details(value: unknown): string { return JSON.stringify(value, null, 2) || ""; }

export function Approval({ request, deviceName, resolve }: { request: Json; deviceName: string; resolve: (id: string, result: Json) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [formAnswers, setFormAnswers] = useState<FormAnswers>({});
  const method = request.method;
  const input = method === "item/tool/requestUserInput" || method === "tool/requestUserInput";
  const execution = method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval";
  const permissions = method === "item/permissions/requestApproval";
  const elicitation = method === "mcpServer/elicitation/request";
  const known = input || execution || permissions || elicitation;
  const p = request.params || {};
  const profile = permissions ? requestedPermissions(p) : null;
  const form = elicitation && ["form", "openai/form", "openaiForm"].includes(p.mode);
  const fields = form ? mcpFormFields(p.requestedSchema) : null;
  const choices = execution ? approvalChoices(request) : [];
  const submit = async (result: Json) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await resolve(request.id, result); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  };
  const submitForm = () => {
    try { if (fields) void submit({ action: "accept", content: mcpFormContent(fields, formAnswers), _meta: null }); }
    catch (error) { setError(message(error)); }
  };
  return <section className="approval-card" aria-label="待处理审批" aria-busy={busy}>
    <div className="approval-heading"><ShieldCheck size={18} /><div><strong>{input ? "Codex 需要你的补充" : permissions ? "申请额外权限" : elicitation ? "工具需要你的确认" : known ? "需要你的确认" : "收到未支持的审批请求"}</strong><p>将在 {deviceName} 上继续{elicitation && p.serverName ? ` · ${p.serverName}` : ""}</p></div></div>
    {p.reason && <p>{p.reason}</p>}
    {p.command && <pre>{Array.isArray(p.command) ? p.command.join(" ") : p.command}</pre>}
    {p.cwd && <div className="micro muted">{p.cwd}</div>}
    {p.grantRoot && <p className="file-path">修改范围：{p.grantRoot}</p>}
    {permissions && <><p>仅授权这次申请列出的网络和文件访问范围。</p><pre aria-label="申请的权限">{details(p.permissions)}</pre>{profile ? <p className="muted micro">“允许本次回合”在此回合结束后失效；“在此会话中允许”会用于同一会话的后续回合。</p> : <p className="muted micro">此申请包含尚未支持的权限，仍可拒绝授权。</p>}</>}
    {elicitation && <>
      {(p.message || p.description) && <p>{p.message || p.description}</p>}
      {p.mode === "url" && <><p>请完成下方地址中的授权，再点击“已完成，继续”。</p><pre>{p.url}</pre></>}
      {p.mode === "openai/userVerification" && <p>此请求需要在执行电脑完成身份验证；也可以拒绝或取消请求。</p>}
      {form && !fields && <p>此表单含有暂不支持的字段，请在执行电脑处理，或拒绝／取消请求。</p>}
      {fields?.map(({ key, schema, options, required }) => <fieldset key={key} className="question" disabled={busy}>
        <legend>{schema.title || key}{required ? "（必填）" : "（可选）"}</legend>
        {schema.description && <p>{schema.description}</p>}
        {schema.type === "boolean" ? <select aria-label={schema.title || key} value={formAnswers[key] as string || ""} onChange={event => setFormAnswers(previous => ({ ...previous, [key]: event.target.value }))}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>
          : schema.type === "array" ? <div className="question-options">{options?.map(option => {
            const selected = Array.isArray(formAnswers[key]) ? formAnswers[key] as string[] : [];
            return <label key={option.value} className={selected.includes(option.value) ? "selected" : ""}><input type="checkbox" checked={selected.includes(option.value)} onChange={event => setFormAnswers(previous => ({ ...previous, [key]: event.target.checked ? [...selected, option.value] : selected.filter(value => value !== option.value) }))} /><span>{option.label}</span></label>;
          })}</div>
          : options ? <select aria-label={schema.title || key} value={formAnswers[key] as string || ""} onChange={event => setFormAnswers(previous => ({ ...previous, [key]: event.target.value }))}><option value="">请选择</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          : <input aria-label={schema.title || key} type={schema.type === "number" || schema.type === "integer" ? "number" : "text"} step={schema.type === "integer" ? 1 : "any"} min={schema.minimum} max={schema.maximum} value={formAnswers[key] as string || ""} autoComplete="off" onChange={event => setFormAnswers(previous => ({ ...previous, [key]: event.target.value }))} />}
      </fieldset>)}
    </>}
    {!input && <details><summary>请求详情 · {method}</summary><pre>{details(p)}</pre></details>}
    {input && (p.questions || []).map((question: Json) => <fieldset key={question.id} className="question" disabled={busy}><legend>{question.header || "补充信息"}</legend><p>{question.question}</p>{question.options?.length > 0 && <div className="question-options">{question.options.map((option: Json) => <label className={answers[question.id] === option.label ? "selected" : ""} key={option.label}><input type="radio" name={`${request.id}-${question.id}`} value={option.label} checked={answers[question.id] === option.label} onChange={() => setAnswers(previous => ({ ...previous, [question.id]: option.label }))} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>)}</div>}{(!question.options?.length || question.isOther) && <input type={question.isSecret ? "password" : "text"} placeholder="输入你的回答" value={answers[question.id] || ""} onChange={event => setAnswers(previous => ({ ...previous, [question.id]: event.target.value }))} />}</fieldset>)}
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="approval-actions">
      {input && <button className="primary small" disabled={busy || !(p.questions || []).length || !(p.questions || []).every((q: Json) => answers[q.id]?.trim())} onClick={() => void submit({ answers: Object.fromEntries((p.questions || []).map((q: Json) => [q.id, { answers: [answers[q.id]] }])) })}>{busy ? "正在提交…" : "提交回答"}</button>}
      {execution && choices.map((choice, index) => <button key={index} className={`${choice.primary ? "primary" : "secondary"} small`} disabled={busy} title={typeof choice.decision === "object" ? details(choice.decision) : undefined} onClick={() => void submit({ decision: choice.decision })}>{choice.label}</button>)}
      {execution && !choices.length && <p className="muted micro">执行电脑未提供可用的审批选项，请查看请求详情。</p>}
      {permissions && <><button className="secondary small" disabled={busy} onClick={() => void submit({ permissions: {}, scope: "turn" })}>拒绝</button><button className="secondary small" disabled={busy || !profile} onClick={() => void submit({ permissions: profile, scope: "session" })}>在此会话中允许</button><button className="primary small" disabled={busy || !profile} onClick={() => void submit({ permissions: profile, scope: "turn" })}>允许本次回合</button></>}
      {elicitation && <><button className="secondary small" disabled={busy} onClick={() => void submit({ action: "cancel", content: null, _meta: null })}>取消</button><button className="secondary small" disabled={busy} onClick={() => void submit({ action: "decline", content: null, _meta: null })}>拒绝</button>{fields && <button className="primary small" disabled={busy} onClick={submitForm}>确认并继续</button>}{p.mode === "url" && <button className="primary small" disabled={busy} onClick={() => void submit({ action: "accept", content: null, _meta: null })}>已完成，继续</button>}</>}
      {!known && <p className="muted micro">此请求保持待处理。可停止当前回合，并更新 Relay 以支持该审批类型。</p>}
    </div>
  </section>;
}
