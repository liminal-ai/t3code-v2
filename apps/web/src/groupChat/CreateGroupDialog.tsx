import { useNavigate } from "@tanstack/react-router";
import type { ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { attempt, dispatchGroupChat } from "./api";
import { ThreadPicker } from "./ThreadPicker";

const NO_EXCLUSIONS: ReadonlySet<ThreadId> = new Set();

export function CreateGroupDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<ThreadId>>(new Set());
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (busy || selected.size === 0) return;
    setBusy(true);
    const result = await attempt(() =>
      dispatchGroupChat({
        _tag: "group.create",
        title: title.trim() === "" ? "Group chat" : title.trim(),
        threadIds: [...selected],
      }),
    );
    setBusy(false);
    if (result === undefined || result._tag !== "group") return;
    onClose();
    void navigate({ to: "/group-chat/$groupId", params: { groupId: result.group.id } });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-3xl">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <DialogHeader>
            <DialogTitle>New group chat</DialogTitle>
            <DialogDescription>
              Pick the T3 threads that join. Each gets a short handle you can rename later.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="group-chat-title">Title</Label>
              <Input
                id="group-chat-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Group chat"
              />
            </div>
            <ThreadPicker
              selected={selected}
              exclude={NO_EXCLUSIONS}
              onToggle={(thread) =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (next.has(thread.id)) next.delete(thread.id);
                  else next.add(thread.id);
                  return next;
                })
              }
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || selected.size === 0}>
              Create with {selected.size || "no"} {selected.size === 1 ? "thread" : "threads"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
