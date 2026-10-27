export const RESERVED_HANDLES = new Set([
  "operator",
  "system",
  "human",
  "user",
  "you",
  "me",
  "all",
  "everyone",
  "here",
  "group",
  "nobody",
  "none",
  "removed",
  "removed-member",
  "envelope",
  "end",
  "message",
  "app",
]);

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{0,15}$/;

export function handleProblem(handle: string): string | null {
  if (!HANDLE_RE.test(handle))
    return "handles are 1-16 characters: a-z, 0-9, - and _, starting with a letter or digit";
  if (RESERVED_HANDLES.has(handle))
    return `@${handle} is reserved: the app uses "${handle}" for non-members`;
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function stripLeadingHandle(text: string, handles: ReadonlyArray<string>): string {
  const names = handles.filter(Boolean).map(escapeRe);
  if (names.length === 0) return text;
  const bold = "(?:\\*\\*|__)?";
  const re = new RegExp(
    `^\\s*${bold}@?(?:${names.join("|")})${bold}(?:\\s*[:：](?!//)|\\s+[\\u2014\\u2013-]\\s)\\s*${bold}\\s*`,
    "i",
  );
  const out = text.replace(re, "");
  return out.trim() ? out : text;
}

const isControl = (ch: string) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127;

export function oneLine(s: string, max = 80): string {
  const flat = Array.from(s, (ch) => (isControl(ch) ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const SIGN_OFF = "[[SIGN-OFF]]";
export function isSignOff(text: string): boolean {
  const lines = text.split(/\r?\n/);
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  if (lines.at(-1)?.trim() !== SIGN_OFF) return false;
  let fence: { char: string; len: number } | null = null;
  let comment = false;
  for (const line of lines.slice(0, -1)) {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (f && !comment) {
      if (!fence) fence = { char: f[1]![0]!, len: f[1]!.length };
      else if (f[1]![0] === fence.char && f[1]!.length >= fence.len && !f[2]!.trim()) fence = null;
      continue;
    }
    if (!fence) for (const t of line.matchAll(/<!--|-->/g)) comment = t[0] === "<!--";
  }
  return !fence && !comment;
}
export function withoutSignOffLine(text: string): string {
  const lines = text.replace(/\s+$/, "").split(/\r?\n/);
  if (lines.at(-1)?.trim() === SIGN_OFF) lines.pop();
  return lines.join("\n").trimEnd();
}
