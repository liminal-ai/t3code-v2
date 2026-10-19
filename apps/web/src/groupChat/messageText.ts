/** Messages past a few screens collapse to a preview behind Show all. */
export const LONG_MESSAGE_CHARS = 4_000;
export const PREVIEW_CHARS = 1_500;

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The first part of a long message, cut at a line end near the limit. A code fence left open by
 * the cut is closed with the same fence, so the preview renders as the message would.
 */
export function previewOf(text: string): string {
  let cut = text.slice(0, PREVIEW_CHARS);
  const lineEnd = cut.lastIndexOf("\n");
  if (lineEnd > PREVIEW_CHARS * 0.6) cut = cut.slice(0, lineEnd);
  else if (cut.length < text.length) {
    // The cut landed mid-line. Back up to the line start when that line opens a fence, so the
    // preview never ends inside a fence opener such as "```ts" or a partial "~~".
    const lineStart = cut.lastIndexOf("\n") + 1;
    const rest = text.slice(lineStart);
    if (FENCE_LINE.test(rest)) cut = cut.slice(0, Math.max(0, lineStart - 1));
  }
  const open = openFence(cut);
  if (open !== null) cut += `\n${open}`;
  return `${cut}\n\n…`;
}

/** The fence that is still open at the end of `text`, or null. Mirrors how markdown closes them. */
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

/** A one-line plain-text snippet of a markdown message, for context lines and titles. */
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
