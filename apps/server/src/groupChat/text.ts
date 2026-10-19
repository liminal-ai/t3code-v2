// Labels the envelopes use for non-members. No member may take one as a handle.
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

export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{0,15}$/;

export function handleProblem(handle: string): string | null {
  if (!HANDLE_RE.test(handle))
    return "handles are 1-16 characters: a-z, 0-9, - and _, starting with a letter or digit";
  if (RESERVED_HANDLES.has(handle))
    return `@${handle} is reserved: the app uses "${handle}" for non-members`;
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Agents sometimes open with their own name ("@alpha: ...", "**Alpha:** ...", "Alpha — ..."). The UI already
// labels every message, so a leading self-label is noise; this removes it for any handle the member has had.
// Only a real label counts: the name followed by a colon (spaces before it or not), or by a dash with whitespace
// on both sides. "alpha-beta rocks", "Alpha-1 is done" and "inbound-pipeline is ..." are words, and stay, and a
// colon that starts "://" opens a URI ("alpha://service/path"), not a label.
export function stripLeadingHandle(text: string, handles: ReadonlyArray<string>): string {
  const names = handles.filter(Boolean).map(escapeRe);
  if (names.length === 0) return text;
  const bold = "(?:\\*\\*|__)?";
  const re = new RegExp(
    `^\\s*${bold}@?(?:${names.join("|")})${bold}(?:\\s*[:：](?!//)|\\s+[—–-]\\s)\\s*${bold}\\s*`,
    "i",
  );
  const out = text.replace(re, "");
  return out.trim() ? out : text;
}

// One line, no control characters, bounded length: for operator- or agent-supplied names in headers.
export function oneLine(s: string, max = 80): string {
  const flat = s
    // eslint-disable-next-line no-control-regex -- removing control characters is the point.
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// The one sign-off rule the discussion instructions state: the marker alone on the last non-empty line,
// as prose. A marker line that sits inside an unclosed code fence or HTML comment is quoted text.
export const SIGN_OFF = "[[SIGN-OFF]]";
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
// Removes the sign-off line (only when it counted) for display.
export function withoutSignOffLine(text: string): string {
  const lines = text.replace(/\s+$/, "").split(/\r?\n/);
  if (lines.at(-1)?.trim() === SIGN_OFF) lines.pop();
  return lines.join("\n").trimEnd();
}
