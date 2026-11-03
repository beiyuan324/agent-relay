import type { Json } from "./api";

export type MentionKind = "file" | "directory" | "skill" | "app";
export interface MentionTarget {
  kind: MentionKind;
  name: string;
  label: string;
  path: string;
  detail: string;
  relativePath?: string;
}
export interface DraftMention extends MentionTarget { start: number; end: number; token: string }
export interface ComposerDraft { text: string; mentions: DraftMention[] }
export const EMPTY_DRAFT: ComposerDraft = { text: "", mentions: [] };

export function validMentions(draft: ComposerDraft): DraftMention[] {
  return draft.mentions.filter(mention => mention.start >= 0 && mention.end > mention.start &&
    draft.text.slice(mention.start, mention.end) === mention.token).sort((a, b) => a.start - b.start);
}
export function editDraft(draft: ComposerDraft, text: string): ComposerDraft {
  const previous = draft.text;
  if (previous === text) return draft;
  let start = 0, suffix = 0;
  while (start < previous.length && start < text.length && previous[start] === text[start]) ++start;
  while (suffix < previous.length - start && suffix < text.length - start &&
    previous[previous.length - suffix - 1] === text[text.length - suffix - 1]) ++suffix;
  const end = previous.length - suffix, shift = text.length - previous.length;
  const mentions = validMentions(draft).flatMap(mention => {
    if (mention.end <= start) return [mention];
    if (mention.start >= end) return [{ ...mention, start: mention.start + shift, end: mention.end + shift }];
    return [];
  });
  return { text, mentions };
}
export function mentionTrigger(draft: ComposerDraft, caret: number, selectionEnd: number) {
  if (caret !== selectionEnd || caret <= 0 || caret > draft.text.length) return null;
  const start = Math.max(draft.text.lastIndexOf("@", caret - 1), draft.text.lastIndexOf("$", caret - 1));
  if (start < 0 || (start > 0 && /[a-zA-Z0-9_.$@+-]/.test(draft.text[start - 1]))) return null;
  const prefix = draft.text[start] as "@" | "$";
  const query = draft.text.slice(start + 1, caret);
  if (/[\s@$]/.test(query) || query.length > 256) return null;
  if (validMentions(draft).some(mention => mention.start <= start && mention.end >= caret)) return null;
  return { start, end: caret, prefix, query, key: prefix + start + ":" + caret + ":" + query };
}
export function insertMention(draft: ComposerDraft, start: number, end: number, target: MentionTarget) {
  const token = target.kind === "skill" ? "$" + target.name : "@" + (target.relativePath || target.label) + (target.kind === "directory" && !/[\\/]$/.test(target.relativePath || target.label) ? "/" : "");
  const trailing = /^\s/.test(draft.text.slice(end)) ? "" : " ";
  const text = draft.text.slice(0, start) + token + trailing + draft.text.slice(end);
  const next = editDraft(draft, text);
  next.mentions.push({ ...target, start, end: start + token.length, token });
  return { draft: next, caret: start + token.length + trailing.length };
}
export function removeMention(draft: ComposerDraft, mention: DraftMention): ComposerDraft {
  return editDraft(draft, draft.text.slice(0, mention.start) + draft.text.slice(mention.end));
}
export function referenceInput(draft: ComposerDraft): Json[] {
  const leading = draft.text.length - draft.text.trimStart().length;
  const end = draft.text.trimEnd().length;
  const source = draft.text.slice(leading, end);
  const mentions = validMentions(draft).filter(mention => mention.start >= leading && mention.end <= end);
  const encoder = new TextEncoder(), elements: Json[] = [], bindings: Json[] = [];
  const bound = new Set<string>();
  let text = "", cursor = 0;
  for (const mention of mentions) {
    const start = mention.start - leading, stop = mention.end - leading;
    if (start < cursor) continue;
    text += source.slice(cursor, start);
    const byteStart = encoder.encode(text).length;
    const token = mention.kind === "skill" ? "$" + mention.name : mention.token;
    if (mention.kind === "file" || mention.kind === "directory") {
      const label = mention.token.replace(/[\\[\]]/g, "\\$&");
      const path = encodeURI(mention.path.replace(/\\/g, "/")).replace(/[()#?<>]/g, value => encodeURIComponent(value));
      text += "[" + label + "](<" + path + ">)";
    } else text += token;
    elements.push({ byte_range: { start: byteStart, end: encoder.encode(text).length }, placeholder: token });
    const bindingKey = mention.kind + ":" + mention.path;
    if (!bound.has(bindingKey) && (mention.kind === "app" || mention.kind === "skill")) {
      bindings.push({ type: mention.kind === "app" ? "mention" : "skill", name: mention.name, path: mention.path });
      bound.add(bindingKey);
    }
    cursor = stop;
  }
  text += source.slice(cursor);
  return [{ type: "text", text, text_elements: elements }, ...bindings];
}
export function fileTarget(file: Json, cwd: string): MentionTarget | null {
  if (typeof file.path !== "string" || !file.path) return null;
  const root = typeof file.root === "string" ? file.root : cwd;
  const absolute = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(file.path);
  const separator = root.includes("\\") ? "\\" : "/";
  const path = absolute ? file.path : root.replace(/[\\/]+$/, "") + separator + file.path.replace(/^[\\/]+/, "");
  const normalized = path.replace(/\\/g, "/"), prefix = root.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  const comparable = /^[a-zA-Z]:|^\\\\/.test(root) ? normalized.toLowerCase() : normalized;
  const comparablePrefix = /^[a-zA-Z]:|^\\\\/.test(root) ? prefix.toLowerCase() : prefix;
  const relativePath = comparable.startsWith(comparablePrefix) ? normalized.slice(prefix.length) : file.path.replace(/\\/g, "/");
  const name = typeof file.file_name === "string" && file.file_name ? file.file_name : relativePath.split("/").pop() || path;
  return { kind: file.match_type === "directory" ? "directory" : "file", name, label: relativePath, path, relativePath, detail: path };
}
export function matchesMention(target: MentionTarget, query: string): boolean {
  const needle = query.toLocaleLowerCase(), haystack = (target.name + " " + target.label + " " + target.detail).toLocaleLowerCase();
  if (haystack.includes(needle)) return true;
  let index = 0;
  for (const character of haystack) if (character === needle[index]) ++index;
  return index === needle.length;
}
