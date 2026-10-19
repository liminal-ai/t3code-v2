import type { GroupChatGroupId, GroupChatMember, GroupChatMemberId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  completeMention,
  loadRecipients,
  mentionAtCaret,
  saveRecipients,
  sendCommand,
  suggestions,
  draftAfterSend,
  tickedAfterTyping,
} from "./composer";

const groupId = "grp_1" as GroupChatGroupId;

const member = (handle: string, removedAt: string | null = null): GroupChatMember =>
  ({
    id: `mem_${handle}` as GroupChatMemberId,
    groupId,
    handle,
    handleHistory: [],
    color: 0,
    kind: {
      _tag: "t3",
      thread: { environmentId: "env", threadId: `thread_${handle}`, title: handle },
    },
    seenSeq: 0,
    introduced: false,
    toldRoster: null,
    addedAt: "2026-10-19T00:00:00.000Z",
    removedAt,
  }) as unknown as GroupChatMember;

const members = [member("alpha"), member("alps"), member("bravo")];

describe("composer", () => {
  it("typing @handle ticks that member", () => {
    expect(tickedAfterTyping([], "hi @alpha, look", members)).toEqual(["mem_alpha"]);
    expect(tickedAfterTyping(["mem_bravo" as GroupChatMemberId], "hi @alpha", members)).toEqual([
      "mem_bravo",
      "mem_alpha",
    ]);
    expect(tickedAfterTyping([], "mail me@alpha.example", members)).toEqual([]);
    expect(tickedAfterTyping([], "alpha://service/path", members)).toEqual([]);
  });

  it("autocomplete matches handle prefixes", () => {
    expect(mentionAtCaret("hello @al", 9)).toBe("al");
    expect(mentionAtCaret("hello @al there", 9)).toBe("al");
    expect(mentionAtCaret("hello al", 8)).toBeNull();
    expect(suggestions(members, "al").map((m) => m.handle)).toEqual(["alpha", "alps"]);
    expect(suggestions(members, "alph").map((m) => m.handle)).toEqual(["alpha"]);
    expect(completeMention("hello @al there", 9, members[0]!)).toEqual({
      text: "hello @alpha  there",
      caret: 13,
    });
  });

  it("nobody ticked sends a log-only message", () => {
    expect(sendCommand(groupId, "note to self", [], members)).toEqual({
      _tag: "message.send",
      groupId,
      text: "note to self",
      recipients: [],
    });
    const gone = member("gone", "2026-10-19T00:00:00.000Z");
    expect(
      sendCommand(groupId, "hi", ["mem_gone", "mem_bravo"] as GroupChatMemberId[], [
        ...members,
        gone,
      ]).recipients,
    ).toEqual(["mem_bravo"]);
  });

  it("a draft typed during a send survives it, and a failed send comes back only to an empty box", () => {
    const sent = { groupId, text: "first message" };
    const typed = new Map([[groupId, "next thought"]]);
    const empty = new Map<GroupChatGroupId, string>();
    expect(draftAfterSend(typed, sent, true)).toBe(typed);
    expect(draftAfterSend(empty, sent, true)).toBe(empty);
    expect(draftAfterSend(typed, sent, false)).toBe(typed);
    expect(draftAfterSend(empty, sent, false).get(groupId)).toBe("first message");
  });

  it("a failed send comes back to its own group's box while another group's box keeps its text", () => {
    const other = "grp_other" as GroupChatGroupId;
    const drafts = new Map([[other, "typing in the other group"]]);
    const after = draftAfterSend(drafts, { groupId, text: "for the first group" }, false);
    expect(after.get(groupId)).toBe("for the first group");
    expect(after.get(other)).toBe("typing in the other group");
  });

  it("recipients are kept per group", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    saveRecipients(groupId, ["mem_alpha"] as GroupChatMemberId[], storage);
    expect(loadRecipients(groupId, storage)).toEqual(["mem_alpha"]);
    expect(loadRecipients("grp_other" as GroupChatGroupId, storage)).toEqual([]);
  });
});
