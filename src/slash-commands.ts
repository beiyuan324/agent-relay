import type { ComposerDraft } from "./mentions";

export type CollaborationMode = "default" | "plan";
export interface SlashCommand {
  id: string;
  label: string;
  description: string;
  keywords?: string;
  disabledReason?: string;
  prompt?: { content: string; argumentHint: string };
}
export const SLASH_COMMANDS: SlashCommand[] = [
  { id: "plan", label: "计划模式", description: "切换计划模式，先讨论并制定实施方案", keywords: "planning 规划" },
  { id: "compact", label: "压缩上下文", description: "压缩当前会话的上下文，保留关键信息", keywords: "context 压缩" },
  { id: "model", label: "选择模型", description: "选择后续消息使用的模型" },
  { id: "reasoning", label: "推理强度", description: "选择模型的推理强度", keywords: "effort 思考" },
  { id: "fast", label: "快速模式", description: "切换模型目录提供的 Fast 服务档位", keywords: "speed 速度" },
  { id: "review", label: "代码审查", description: "审查未提交修改、分支、提交或指定内容", keywords: "diff 审核" },
  { id: "new", label: "新建会话", description: "在当前项目中新建空白会话", keywords: "clear 新对话" },
  { id: "fork", label: "分叉会话", description: "复制当前会话历史，继续新的对话", keywords: "branch 分支" },
  { id: "rename", label: "重命名会话", description: "修改当前会话的名称" },
  { id: "archive", label: "归档会话", description: "归档当前会话，可从归档列表恢复" },
  { id: "goal", label: "目标模式", description: "设置持续目标，或管理现有目标", keywords: "objective 持续任务" },
  { id: "status", label: "会话状态", description: "查看会话、模型、上下文和账户额度" },
  { id: "usage", label: "账户额度", description: "查看执行电脑当前账户的使用额度及重置时间" },
  { id: "mcp", label: "MCP 状态", description: "查看执行电脑上的 MCP 服务及连接状态", keywords: "tools 工具" },
  { id: "init", label: "初始化项目说明", description: "让 Codex 为当前项目编写 AGENTS.md" },
  { id: "skills", label: "使用技能", description: "浏览执行电脑上当前项目可用的技能", keywords: "插件 skill" },
  { id: "apps", label: "引用应用", description: "浏览执行电脑上已连接的应用", keywords: "app 应用" },
  { id: "project", label: "选择项目", description: "选择一个项目并新建会话", keywords: "local 目录" },
  { id: "settings", label: "设置", description: "打开 Relay 设置" },
  { id: "feedback", label: "连接诊断", description: "查看 Relay 的连接与执行诊断" },
  { id: "help", label: "命令帮助", description: "查看所有可用命令及使用方法" },
];

export function slashTrigger(draft: ComposerDraft, start: number, end: number) {
  if (start !== end || start < 1 || start > draft.text.length || draft.mentions.some(mention => mention.start < start && mention.end >= start)) return null;
  const match = /^\/([^\s/]*)$/.exec(draft.text.slice(0, start));
  return match ? { query: match[1].toLowerCase(), start: 0, end: start, key: draft.text.slice(0, start) } : null;
}
export function parseSlash(text: string) {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trimStart());
  return match ? { id: match[1].toLowerCase(), argument: (match[2] || "").trim() } : null;
}
export function matchesCommand(command: SlashCommand, query: string) {
  return [command.id, command.label, command.description, command.keywords || ""].some(value => value.toLowerCase().includes(query));
}
export function expandPrompt(content: string, argument: string) {
  const tokens: string[] = [];
  let token = "", quote = "", started = false;
  for (let index = 0; index < argument.length; index++) {
    const character = argument[index];
    if (character === "\\" && (argument[index + 1] === quote || argument[index + 1] === '"')) {
      token += argument[++index]; started = true;
    } else if (quote) {
      if (character === quote) quote = ""; else token += character;
    } else if (character === '"' || character === "'") { quote = character; started = true; }
    else if (/\s/.test(character)) { if (started) { tokens.push(token); token = ""; started = false; } }
    else { token += character; started = true; }
  }
  if (quote) throw new Error("命令参数的引号未闭合");
  if (started) tokens.push(token);
  const named = new Map<string, string>(), positional: string[] = [];
  for (const token of tokens) {
    const match = /^([A-Z][A-Z0-9_]*)=([\s\S]*)$/.exec(token);
    if (match) named.set(match[1], match[2]); else positional.push(token);
  }
  return content.replace(/\$(ARGUMENTS|[1-9](?!\d)|[A-Z][A-Z0-9_]*)\b/g, (_, key: string) => {
    if (key === "ARGUMENTS") return argument;
    const value = /^[1-9]$/.test(key) ? positional[Number(key) - 1] : named.get(key);
    if (value === undefined) throw new Error("缺少命令参数 $" + key + "，请在命令后填写参数。");
    return value;
  });
}
export const EFFORT_LABELS: Record<string, string> = { minimal: "最小", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大", ultra: "最高" };
