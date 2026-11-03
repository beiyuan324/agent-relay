export interface MessageReference { label: string; href: string }
export type ReferenceKind = "thread" | "plugin" | "app" | "file" | "web";

export function referenceKind(href: string): ReferenceKind | null {
  if (/[\u0000-\u001f\u007f]/.test(href)) return null;
  if (/^(?:[a-z]:[\\/]|\\\\|\/(?!\/))/i.test(href)) return "file";
  try {
    const url = new URL(href);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return "web";
    if (url.protocol === "thread:" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(url.hostname) && (!url.pathname || url.pathname === "/") && !url.username && !url.password && !url.port) return "thread";
    if (url.protocol === "plugin:" && url.hostname) return "plugin";
    if (url.protocol === "app:" && url.hostname) return "app";
    if (url.protocol === "file:") return "file";
  } catch { /* Leave malformed references as ordinary text. */ }
  return null;
}

// Keep the injected context recoverable without mixing it into the user's request.
export function messageBody(text: string) {
  const envelope = /^\s*## Referenced chats with Codex:\r?\n[\s\S]*?\r?\n## My request:[ \t]*\r?\n/.exec(text);
  const offset = envelope?.[0].length || 0;
  return { text: text.slice(offset), context: text.slice(0, offset).trim(), offset };
}

const unescapeMarkdown = (text: string) => text.replace(/\\([\\[\]()<>])/g, "$1");

// Only interpret explicit links; preserve all other user text, including code examples.
export function messageLinks(text: string): (string | MessageReference)[] {
  const parts: (string | MessageReference)[] = [];
  let cursor = 0, index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\") { index += 2; continue; }
    if (character === "\u0060" || (character === "~" && (index === 0 || text[index - 1] === "\n"))) {
      let end = index;
      while (text[end] === character) ++end;
      if (character === "\u0060" || end - index >= 3) {
        const close = text.indexOf(text.slice(index, end), end);
        index = close < 0 ? text.length : close + end - index;
        continue;
      }
    }
    if (character !== "[" || text[index - 1] === "!") { ++index; continue; }
    let labelEnd = index + 1, depth = 1;
    for (; labelEnd < text.length; ++labelEnd) {
      if (text[labelEnd] === "\\") { ++labelEnd; continue; }
      if (text[labelEnd] === "[") ++depth;
      if (text[labelEnd] === "]" && --depth === 0) break;
    }
    if (depth || text[labelEnd + 1] !== "(") { ++index; continue; }
    let start = labelEnd + 2;
    while (/[ \t]/.test(text[start] || "\n")) ++start;
    const angle = text[start] === "<";
    let end = start + (angle ? 1 : 0), nesting = 0;
    for (; end < text.length; ++end) {
      const next = text[end];
      if (next === "\\") { ++end; continue; }
      if (angle ? next === ">" : next === ")" && nesting === 0) break;
      if (next === "(") ++nesting;
      if (next === ")") --nesting;
      if (next === "\n" || (!angle && /\s/.test(next))) break;
    }
    const href = unescapeMarkdown(text.slice(start + (angle ? 1 : 0), end));
    let close = end + (angle ? 1 : 0);
    while (/[ \t]/.test(text[close] || "\n")) ++close;
    if (!href || !referenceKind(href) || text[close] !== ")" || (angle && text[end] !== ">")) { ++index; continue; }
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push({ label: unescapeMarkdown(text.slice(index + 1, labelEnd)), href });
    cursor = index = close + 1;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export function messagePreview(text: string): string {
  return messageLinks(messageBody(text).text).map(part => typeof part === "string" ? part : part.label).join("").replace(/\s+/g, " ").trim();
}
