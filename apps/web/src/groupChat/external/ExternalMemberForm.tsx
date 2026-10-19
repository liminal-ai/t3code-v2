import type {
  GroupChatExternalKind,
  GroupChatGroupId,
  GroupChatMemberId,
} from "@t3tools/contracts";
import { useId, useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";
import { Textarea } from "../../components/ui/textarea";
import { dispatchGroupChat } from "../api";
import { Refusal, useRefusal } from "../refusal";

const DEFAULT_BODY_TEMPLATE = '{"text": "{{envelope}}"}';
const DEFAULT_REPLY_PATH = "reply";
const COPIED_FOR_MS = 1200;

/** `Name: value` per line. A line without a colon is ignored. */
export function parseHeaderLines(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    if (name !== "") headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

/** The URL with its token hidden, for a screen someone else may see. */
export const maskToken = (url: string) => url.replace(/([?&]token=)[^&]*/, "$1••••••••");

export const fetchInboundUrl = async (memberId: GroupChatMemberId): Promise<string> => {
  const result = await dispatchGroupChat({ _tag: "member.inboundUrl", memberId });
  if (result._tag !== "url") throw new Error("the server did not return an inbound URL");
  return result.url;
};

/** Shows an inbound URL masked, with Reveal and Copy, so the token is never on screen by accident. */
export function InboundUrl({ url }: { url: string }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
    setTimeout(() => setCopied("idle"), COPIED_FOR_MS);
  };
  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg border bg-muted/40 p-2 text-xs"
      data-testid="inbound-url"
      data-revealed={revealed || undefined}
    >
      <span className="text-muted-foreground">
        Inbound URL. A POST here with {`{"text": "..."}`} posts into the group as this member. The
        URL carries a secret token, so share it only with the agent.
      </span>
      <code className="break-all font-mono text-2xs" data-testid="inbound-url-text">
        {revealed ? url : maskToken(url)}
      </code>
      <div className="flex items-center gap-1.5">
        <Button size="xs" variant="outline" type="button" onClick={() => void copy()}>
          {copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}
        </Button>
        <Button
          size="xs"
          variant="ghost-muted"
          type="button"
          onClick={() => setRevealed((value) => !value)}
        >
          {revealed ? "Hide" : "Reveal"}
        </Button>
      </div>
    </div>
  );
}

export function ExternalMemberForm({
  groupId,
  onClose,
}: {
  groupId: GroupChatGroupId;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<GroupChatExternalKind>("rest");
  const [handle, setHandle] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [headers, setHeaders] = useState("");
  const [bodyTemplate, setBodyTemplate] = useState(DEFAULT_BODY_TEMPLATE);
  const [replyPath, setReplyPath] = useState(DEFAULT_REPLY_PATH);
  const [callbackOrigin, setCallbackOrigin] = useState("");
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<{ handle: string; inboundUrl: string } | null>(null);
  const { refusal, run } = useRefusal();
  const ids = {
    handle: useId(),
    url: useId(),
    secret: useId(),
    headers: useId(),
    body: useId(),
    replyPath: useId(),
    origin: useId(),
  };

  const submit = async () => {
    if (busy || url.trim() === "") return;
    setBusy(true);
    const result = await run(async () => {
      const created = await dispatchGroupChat({
        _tag: "member.addExternal",
        groupId,
        handle: handle.trim(),
        kind,
        config: {
          url: url.trim(),
          headers: parseHeaderLines(headers),
          bodyTemplate,
          replyPath,
          secret,
          callbackOrigin: callbackOrigin.trim(),
        },
      });
      if (created._tag !== "member") throw new Error("the server did not return the member");
      return {
        handle: created.member.handle,
        inboundUrl: await fetchInboundUrl(created.member.id),
      };
    });
    setBusy(false);
    if (result !== undefined) setAdded(result);
  };

  if (added !== null) {
    return (
      <div className="flex flex-col gap-2" data-testid="external-member-added">
        <p className="text-sm">
          Added <span className="font-medium">@{added.handle}</span>. Give the agent its inbound URL
          if it should post on its own.
        </p>
        <InboundUrl url={added.inboundUrl} />
        <div className="flex justify-end">
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-3"
      data-testid="external-member-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <RadioGroup
        value={kind}
        onValueChange={(value) => setKind(value === "webhook" ? "webhook" : "rest")}
        aria-label="Member kind"
      >
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <RadioGroupItem value="rest" aria-label="REST" />
          <span className="flex flex-col">
            <span>REST</span>
            <span className="text-2xs text-muted-foreground">
              Answers the envelope in the same HTTP response.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <RadioGroupItem value="webhook" aria-label="Webhook" />
          <span className="flex flex-col">
            <span>Webhook</span>
            <span className="text-2xs text-muted-foreground">
              Acknowledges the envelope and posts its reply to a callback URL later.
            </span>
          </span>
        </label>
      </RadioGroup>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.url}>Endpoint URL</Label>
          <Input
            id={ids.url}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="http://127.0.0.1:14199/rest/reply"
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.handle}>Handle (optional)</Label>
          <Input
            id={ids.handle}
            value={handle}
            onChange={(event) => setHandle(event.target.value.toLowerCase())}
            placeholder="mock"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.secret}>Shared secret</Label>
          <Input
            id={ids.secret}
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            autoComplete="off"
          />
          <span className="text-2xs text-muted-foreground">
            Signs what the server sends and verifies what the agent posts. Required once this server
            is reachable beyond this machine.
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.replyPath}>Reply path</Label>
          <Input
            id={ids.replyPath}
            value={replyPath}
            onChange={(event) => setReplyPath(event.target.value)}
            placeholder={DEFAULT_REPLY_PATH}
          />
          <span className="text-2xs text-muted-foreground">
            Where the reply text sits in the agent's JSON, such as choices.0.message.content.
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={ids.body}>Body template</Label>
        <Textarea
          id={ids.body}
          rows={2}
          value={bodyTemplate}
          onChange={(event) => setBodyTemplate(event.target.value)}
        />
        <span className="text-2xs text-muted-foreground">
          Placeholders: envelope, groupId, groupTitle, handle, memberId, deliveryId, idempotencyKey,
          callbackUrl, inboundUrl.
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.headers}>Extra headers (optional)</Label>
          <Textarea
            id={ids.headers}
            rows={2}
            value={headers}
            onChange={(event) => setHeaders(event.target.value)}
            placeholder={"Authorization: Bearer …"}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.origin}>Callback origin (optional)</Label>
          <Input
            id={ids.origin}
            value={callbackOrigin}
            onChange={(event) => setCallbackOrigin(event.target.value)}
            placeholder="https://t3.example.ts.net"
          />
          <span className="text-2xs text-muted-foreground">
            Where the agent should reach this server. Empty means the server's own address.
          </span>
        </div>
      </div>
      <Refusal text={refusal} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy || url.trim() === ""}>
          Add external member
        </Button>
      </div>
    </form>
  );
}
