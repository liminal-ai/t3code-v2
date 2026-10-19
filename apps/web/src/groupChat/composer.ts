import type {
  GroupChatCommand,
  GroupChatGroupId,
  GroupChatMember,
  GroupChatMemberId,
} from "@t3tools/contracts";

const MENTION_AT_CARET = /(^|\s)@([a-z0-9_-]*)$/i;
const MENTION_TOKEN = /(^|[\s(])@([a-z0-9][a-z0-9_-]*)(?=$|[\s,.:;!?)])/gi;

export function mentionAtCaret(text: string, caret: number): string | null {
  const match = MENTION_AT_CARET.exec(text.slice(0, caret));
  return match === null ? null : match[2]!.toLowerCase();
}

function mentionedMembers(
  text: string,
  members: ReadonlyArray<GroupChatMember>,
): ReadonlyArray<GroupChatMemberId> {
  const found: GroupChatMemberId[] = [];
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const handle = match[2]!.toLowerCase();
    const hit = members.find((m) => m.handle === handle);
    if (hit !== undefined && !found.includes(hit.id)) found.push(hit.id);
  }
  return found;
}

export function suggestions(
  members: ReadonlyArray<GroupChatMember>,
  partial: string,
): ReadonlyArray<GroupChatMember> {
  return members.filter((m) => m.handle.startsWith(partial));
}

export function completeMention(
  text: string,
  caret: number,
  member: GroupChatMember,
): { readonly text: string; readonly caret: number } {
  const before = text
    .slice(0, caret)
    .replace(MENTION_AT_CARET, (_whole, lead: string) => `${lead}@${member.handle} `);
  return { text: before + text.slice(caret), caret: before.length };
}

export function tickedAfterTyping(
  ticked: ReadonlyArray<GroupChatMemberId>,
  text: string,
  members: ReadonlyArray<GroupChatMember>,
): ReadonlyArray<GroupChatMemberId> {
  const named = mentionedMembers(text, members).filter((id) => !ticked.includes(id));
  return named.length === 0 ? ticked : [...ticked, ...named];
}

export function sendCommand(
  groupId: GroupChatGroupId,
  text: string,
  ticked: ReadonlyArray<GroupChatMemberId>,
  members: ReadonlyArray<GroupChatMember>,
): Extract<GroupChatCommand, { readonly _tag: "message.send" }> {
  const active = new Set(members.filter((m) => m.removedAt === null).map((m) => m.id));
  return {
    _tag: "message.send",
    groupId,
    text,
    recipients: ticked.filter((id) => active.has(id)),
  };
}

/**
 * The box is cleared when a send leaves, so what the operator types while the request is out is
 * theirs to keep. A failed send puts its text back only when nothing new was typed.
 */
export function textAfterSend(draftNow: string, submitted: string, sent: boolean): string {
  if (sent || draftNow !== "") return draftNow;
  return submitted;
}

const recipientsKey = (groupId: GroupChatGroupId) => `t3code:group-chat:recipients:${groupId}`;

export function loadRecipients(
  groupId: GroupChatGroupId,
  storage: Pick<Storage, "getItem"> = localStorage,
): ReadonlyArray<GroupChatMemberId> {
  try {
    const raw = storage.getItem(recipientsKey(groupId));
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is GroupChatMemberId => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveRecipients(
  groupId: GroupChatGroupId,
  ticked: ReadonlyArray<GroupChatMemberId>,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(recipientsKey(groupId), JSON.stringify(ticked));
  } catch {}
}
