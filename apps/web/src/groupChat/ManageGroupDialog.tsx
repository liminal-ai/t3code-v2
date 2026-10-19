import { useNavigate } from "@tanstack/react-router";
import type { GroupChatMember, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { useThreadShell } from "../state/entities";
import { dispatchGroupChat } from "./api";
import { MemberDot, memberColor, memberThreadRef, runtimeLabel } from "./MemberChip";
import { Refusal, useRefusal } from "./refusal";
import { forgetGroup, type GroupView } from "./store";
import { ThreadPicker } from "./ThreadPicker";

interface Confirmation {
  readonly title: string;
  readonly body: string;
  readonly action: string;
  readonly run: () => Promise<boolean>;
}

function ConfirmDialog({ request, onClose }: { request: Confirmation; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const { refusal, run } = useRefusal();
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{request.title}</AlertDialogTitle>
          <AlertDialogDescription data-testid="confirm-body">{request.body}</AlertDialogDescription>
          <Refusal text={refusal} />
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const done = await run(request.run);
              setBusy(false);
              if (done === true) onClose();
            }}
          >
            {request.action}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function HandleEditor({ member }: { member: GroupChatMember }) {
  const [value, setValue] = useState(member.handle);
  const { refusal, run } = useRefusal();
  const dirty = value !== member.handle;
  const save = async () => {
    await run(() =>
      dispatchGroupChat({ _tag: "member.rename", memberId: member.id, handle: value }),
    );
  };
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty) void save();
      }}
    >
      <span className="text-sm" style={{ color: memberColor(member.color) }}>
        @
      </span>
      <Input
        size="compact"
        value={value}
        onChange={(event) => setValue(event.target.value.toLowerCase())}
        aria-label={`Handle for ${member.handle}`}
        className="w-32"
      />
      {dirty ? (
        <Button size="xs" variant="outline" type="submit">
          Save
        </Button>
      ) : null}
      <Refusal text={refusal} />
    </form>
  );
}

function MemberRow({
  member,
  confirm,
}: {
  member: GroupChatMember;
  confirm: (request: Confirmation) => void;
}) {
  const shell = useThreadShell(memberThreadRef(member));
  const settled = shell?.settledAt !== null && shell?.settledAt !== undefined;
  const [busy, setBusy] = useState(false);
  const { refusal, run } = useRefusal();
  const settleThread = async () => {
    setBusy(true);
    await run(() =>
      dispatchGroupChat({
        _tag: settled ? "member.thread.unsettle" : "member.thread.settle",
        memberId: member.id,
      }),
    );
    setBusy(false);
  };
  return (
    <li
      className="flex flex-wrap items-center gap-3 border-b px-3 py-2 last:border-b-0"
      data-testid="manage-member"
      data-handle={member.handle}
    >
      <MemberDot member={member} />
      <div className="min-w-0 flex-1">
        <HandleEditor member={member} />
        <p className="mt-0.5 truncate text-2xs text-muted-foreground">
          {shell?.title ?? member.thread.title}
        </p>
        <Refusal text={refusal} />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Badge variant="outline" size="sm">
          {runtimeLabel(shell?.runtime?.status)}
        </Badge>
        {settled ? (
          <Badge variant="outline" size="sm">
            settled
          </Badge>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          disabled={busy || shell === null}
          onClick={() => void settleThread()}
        >
          {settled ? "Unsettle thread" : "Settle thread"}
        </Button>
        <Button
          size="xs"
          variant="ghost-destructive"
          onClick={() =>
            confirm({
              title: `Remove @${member.handle}?`,
              body: "The member leaves this group. Its past messages stay in the log, and its T3 thread is not changed.",
              action: "Remove member",
              run: async () => {
                await dispatchGroupChat({ _tag: "member.remove", memberId: member.id });
                return true;
              },
            })
          }
        >
          Remove
        </Button>
      </div>
    </li>
  );
}

export function ManageGroupDialog({ view, onClose }: { view: GroupView; onClose: () => void }) {
  const navigate = useNavigate();
  const group = view.group;
  const members = [...view.members.values()]
    .filter((m) => m.removedAt === null)
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  const [title, setTitle] = useState(group.title);
  const [adding, setAdding] = useState<ReadonlySet<ThreadId>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const { refusal, run } = useRefusal();
  const settled = group.settledAt !== null;
  const memberThreadIds: ReadonlySet<ThreadId> = new Set(members.map((m) => m.thread.threadId));

  const addSelected = async () => {
    for (const threadId of adding) {
      const added = await run(() =>
        dispatchGroupChat({ _tag: "member.add", groupId: group.id, threadId }),
      );
      if (added === undefined) return;
    }
    setAdding(new Set());
    setPickerOpen(false);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Manage "{group.title}"</DialogTitle>
          <DialogDescription>Handles are what you type after @.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(() =>
                dispatchGroupChat({ _tag: "group.rename", groupId: group.id, title: title.trim() }),
              );
            }}
          >
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-label="Group title"
              className="flex-1"
            />
            <Button
              variant="outline"
              type="submit"
              disabled={title.trim() === group.title || title.trim() === ""}
            >
              Rename
            </Button>
            <Button
              variant="outline"
              type="button"
              onClick={() =>
                void run(() =>
                  dispatchGroupChat({
                    _tag: settled ? "group.unsettle" : "group.settle",
                    groupId: group.id,
                  }),
                )
              }
            >
              {settled ? "Unsettle group" : "Settle group"}
            </Button>
          </form>
          <Refusal text={refusal} />

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Members</span>
              <Button size="xs" variant="outline" onClick={() => setPickerOpen((open) => !open)}>
                {pickerOpen ? "Cancel" : "Add members"}
              </Button>
            </div>
            <ul className="rounded-lg border">
              {members.map((member) => (
                <MemberRow key={member.id} member={member} confirm={setConfirmation} />
              ))}
            </ul>
            {pickerOpen ? (
              <div className="flex flex-col gap-2">
                <ThreadPicker
                  selected={adding}
                  exclude={memberThreadIds}
                  onToggle={(thread) =>
                    setAdding((current) => {
                      const next = new Set(current);
                      if (next.has(thread.id)) next.delete(thread.id);
                      else next.add(thread.id);
                      return next;
                    })
                  }
                />
                <div className="flex justify-end">
                  <Button disabled={adding.size === 0} onClick={() => void addSelected()}>
                    Add {adding.size || ""} to group
                  </Button>
                </div>
              </div>
            ) : null}
          </section>

          <section className="flex items-center justify-between gap-3 rounded-lg border border-destructive/24 p-3">
            <div>
              <p className="text-sm font-medium">Delete group chat</p>
              <p className="text-2xs text-muted-foreground">
                Removes the group and its log. T3 threads are never deleted or archived.
              </p>
            </div>
            <Button
              variant="destructive-outline"
              onClick={() =>
                setConfirmation({
                  title: `Delete "${group.title}"?`,
                  body: "This deletes the group chat, its message log and its members. The T3 threads themselves are not deleted, archived or changed.",
                  action: "Delete group",
                  run: async () => {
                    await dispatchGroupChat({ _tag: "group.delete", groupId: group.id });
                    forgetGroup(group.id);
                    onClose();
                    void navigate({ to: "/group-chat" });
                    return true;
                  },
                })
              }
            >
              Delete
            </Button>
          </section>
        </DialogPanel>
      </DialogPopup>
      {confirmation === null ? null : (
        <ConfirmDialog request={confirmation} onClose={() => setConfirmation(null)} />
      )}
    </Dialog>
  );
}
