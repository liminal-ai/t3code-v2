// MCP responses carry opaque JSON-RPC envelopes.
// @effect-diagnostics preferSchemaOverJson:off
/**
 * Cursor Cloud pieces of the Cursor adapter: which GitHub checkout a cloud VM
 * starts from, what the cloud agent must be told about the machine it cannot
 * reach, and linking the pull requests a cloud run opens to its T3 thread.
 *
 * @module provider-cursor/server/cloud
 */
import type { RunResult } from "@cursor/sdk";
import type { ChatAttachment, ChatFileAttachment } from "@t3tools/contracts";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";
import { discardResponseBody, responsePayloads } from "@t3tools/shared/mcpResponsePayloads";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

import type * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";

/** The launcher's checkout as a cloud VM will and will not see it. */
export interface CursorCloudCheckout {
  readonly repository: { readonly url: string; readonly startingRef?: string } | null;
  readonly branch: string | null;
  readonly unpushedCommits: number;
  readonly uncommittedChanges: boolean;
}

const git = (cwd: string, args: ReadonlyArray<string>) =>
  ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.flatMap((spawner) => spawner.string(ChildProcess.make("git", [...args], { cwd }))),
    Effect.map((output) => output.trim()),
    Effect.orElseSucceed(() => ""),
  );

/**
 * A cloud VM clones the project's GitHub repository. It starts from the
 * thread's branch when origin has that branch, otherwise from the repository's
 * default branch. Commits not on origin and uncommitted edits never reach it.
 */
export const resolveCursorCloudCheckout = Effect.fn("resolveCursorCloudCheckout")(function* (
  cwd: string | null,
) {
  if (cwd === null) {
    return { repository: null, branch: null, unpushedCommits: 0, uncommittedChanges: false };
  }
  // Credentials in the URL must not reach Cursor, the prompt, or the protocol log.
  const remote = (yield* git(cwd, ["remote", "get-url", "origin"])).replace(
    /^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i,
    "$1",
  );
  if (remote.length === 0) {
    return { repository: null, branch: null, unpushedCommits: 0, uncommittedChanges: false };
  }
  const nameWithOwner = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remote);
  const url = nameWithOwner === null ? remote : `https://github.com/${nameWithOwner}`;
  const branch = (yield* git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])) || null;
  const onOrigin =
    branch !== null &&
    (yield* git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]))
      .length > 0;
  const unpushed = yield* git(
    cwd,
    onOrigin
      ? ["rev-list", "--count", `refs/remotes/origin/${branch}..HEAD`]
      : ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
  );
  const status = yield* git(cwd, ["status", "--porcelain"]);
  return {
    repository: { url, ...(onOrigin ? { startingRef: branch } : {}) },
    branch,
    unpushedCommits: Number.parseInt(unpushed, 10) || 0,
    uncommittedChanges: status.length > 0,
  } satisfies CursorCloudCheckout;
});

/** Prepended to a cloud thread's first prompt. */
export function cursorCloudEnvironmentNote(checkout: CursorCloudCheckout): string {
  const lines: Array<string> = [];
  if (checkout.repository === null) {
    lines.push("You are running on a Cursor Cloud VM with no repository checked out.");
  } else {
    const ref =
      checkout.repository.startingRef ??
      (checkout.branch === null
        ? "its default branch"
        : `its default branch, because ${checkout.branch} is not on origin`);
    lines.push(
      `You are running on a Cursor Cloud VM with a fresh clone of ${checkout.repository.url} at ${ref}.`,
    );
  }
  lines.push(
    "You cannot reach the machine that started you: its files, its T3 Code tools, and anything not pushed to GitHub are unavailable. Local paths in this message refer to that machine, not to your VM.",
  );
  const missing = [
    ...(checkout.unpushedCommits > 0
      ? [
          `${checkout.unpushedCommits} commit${checkout.unpushedCommits === 1 ? "" : "s"} not on origin`,
        ]
      : []),
    ...(checkout.uncommittedChanges ? ["uncommitted changes"] : []),
  ];
  if (missing.length > 0) {
    lines.push(
      `When this thread started, the launcher's checkout${checkout.branch === null ? "" : ` of ${checkout.branch}`} had ${missing.join(" and ")}. They are not in your clone. If your task depends on them, say so in your reply.`,
    );
  }
  return `<cursor_cloud_environment>\n${lines.join("\n")}\n</cursor_cloud_environment>`;
}

const CLOUD_INLINE_ATTACHMENT_MAX_BYTES = 100_000;

/**
 * A cloud VM cannot read attachment files on this machine. Text files,
 * including folded pastes, travel inline in the prompt instead.
 */
export function isInlineCursorCloudAttachment(attachment: ChatAttachment): boolean {
  if (attachment.type !== "file" || attachment.sizeBytes > CLOUD_INLINE_ATTACHMENT_MAX_BYTES) {
    return false;
  }
  const file = attachment as ChatFileAttachment;
  return (
    file.source?._tag === "pasted-text" ||
    file.mimeType.startsWith("text/") ||
    file.mimeType === "application/json"
  );
}

/** The prompt text for a non-image attachment, given its content when it was readable. */
export function cursorCloudAttachmentText(
  attachment: ChatAttachment,
  text: string | undefined,
): string {
  return text === undefined
    ? `[Attached ${attachment.type} "${attachment.name}" was not sent: a Cursor Cloud VM cannot read files on the machine that started it. Only text files up to 100 KB travel inline.]`
    : `[Attached file "${attachment.name}" follows inline.]\n${text}`;
}

/** Pull requests a finished cloud run opened or worked on. */
export function cursorCloudPullRequestUrls(result: RunResult): ReadonlyArray<string> {
  return [
    ...new Set(
      (result.git?.branches ?? []).flatMap((branch) =>
        branch.prUrl === undefined || branch.prUrl.length === 0 ? [] : [branch.prUrl],
      ),
    ),
  ];
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

export class CursorCloudPullRequestLinkError extends Schema.TaggedError<CursorCloudPullRequestLinkError>()(
  "CursorCloudPullRequestLinkError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not link a Cursor Cloud pull request: ${this.detail}`;
  }
}

function jsonRpcError(payloads: ReadonlyArray<unknown>, id: string): unknown {
  const response = payloads.find(
    (payload) =>
      typeof payload === "object" && payload !== null && Reflect.get(payload, "id") === id,
  );
  if (response === undefined) return "no response";
  const error = Reflect.get(response as object, "error");
  if (error !== undefined) return error;
  const result = Reflect.get(response as object, "result");
  return typeof result === "object" && result !== null && Reflect.get(result, "isError") === true
    ? result
    : undefined;
}

/**
 * Links a cloud run's pull requests to its thread through the thread's own T3
 * MCP credential, the same `link_pull_request` call a local agent makes. The
 * cloud VM cannot reach T3's MCP server, so the adapter makes the call for it.
 */
export const linkCursorCloudPullRequests = Effect.fn("linkCursorCloudPullRequests")(function* (
  input: {
    readonly mcpSession: McpProviderSession.McpProviderSessionConfig;
    readonly urls: ReadonlyArray<string>;
  },
  fetchImplementation: typeof fetch = fetch,
) {
  if (input.urls.length === 0) return;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  const send = (message: object) =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () =>
          fetchImplementation(input.mcpSession.endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              authorization: input.mcpSession.authorizationHeader,
              ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
              ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
            },
            body: JSON.stringify(message),
          }),
        catch: (cause) =>
          new CursorCloudPullRequestLinkError({ detail: "T3 MCP request failed.", cause }),
      });
      sessionId = response.headers.get("mcp-session-id") ?? sessionId;
      if (!response.ok) {
        yield* discardResponseBody(response);
        return yield* new CursorCloudPullRequestLinkError({
          detail: `T3 MCP endpoint answered HTTP ${response.status}.`,
        });
      }
      return yield* Stream.runCollect(
        responsePayloads(
          response,
          (cause) =>
            new CursorCloudPullRequestLinkError({ detail: "Unreadable T3 MCP response.", cause }),
        ),
      );
    });

  const initialized = yield* send({
    jsonrpc: "2.0",
    id: "initialize",
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "t3-code-cursor-cloud", version: "0.0.0" },
    },
  });
  const initializeError = jsonRpcError(initialized, "initialize");
  if (initializeError !== undefined) {
    return yield* new CursorCloudPullRequestLinkError({
      detail: `T3 MCP initialize failed: ${JSON.stringify(initializeError)}`,
    });
  }
  const negotiated = initialized
    .map((payload) =>
      typeof payload === "object" && payload !== null
        ? Reflect.get(Reflect.get(payload, "result") ?? {}, "protocolVersion")
        : undefined,
    )
    .find((version) => typeof version === "string");
  protocolVersion = typeof negotiated === "string" ? negotiated : MCP_PROTOCOL_VERSION;
  yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });

  for (const [index, url] of input.urls.entries()) {
    const id = `link-${index}`;
    const responses = yield* send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "link_pull_request", arguments: { url } },
    });
    const error = jsonRpcError(responses, id);
    if (error !== undefined) {
      return yield* new CursorCloudPullRequestLinkError({
        detail: `link_pull_request failed for ${url}: ${JSON.stringify(error)}`,
      });
    }
  }
});
