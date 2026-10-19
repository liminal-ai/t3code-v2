export const LONG_MESSAGE_CHARS = 4_000;
export const PREVIEW_CHARS = 1_500;

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

export function previewOf(text: string): string {
  let cut = text.slice(0, PREVIEW_CHARS);
  const lineEnd = cut.lastIndexOf("\n");
  if (lineEnd > PREVIEW_CHARS * 0.6) cut = cut.slice(0, lineEnd);
  else if (cut.length < text.length) {
    const lineStart = cut.lastIndexOf("\n") + 1;
    const rest = text.slice(lineStart);
    if (FENCE_LINE.test(rest)) cut = cut.slice(0, Math.max(0, lineStart - 1));
  }
  const open = openFence(cut);
  if (open !== null) cut += `\n${open}`;
  return `${cut}\n\n…`;
}

function openFence(text: string): string | null {
  let fence: { readonly char: string; readonly len: number } | null = null;
  for (const line of text.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (match === null) continue;
    const marker = match[1]!;
    if (fence === null) {
      fence = { char: marker[0]!, len: marker.length };
    } else if (marker[0] === fence.char && marker.length >= fence.len && match[2]!.trim() === "") {
      fence = null;
    }
  }
  return fence === null ? null : fence.char.repeat(fence.len);
}

export function plainSnippet(markdown: string, max = 72): string {
  let text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > max) text = `${text.slice(0, max).trimEnd()}…`;
  return text;
}
