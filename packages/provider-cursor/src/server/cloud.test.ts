// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- tests build a real git checkout and fake MCP JSON-RPC.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  cursorCloudEnvironmentNote,
  cursorCloudPullRequestUrls,
  linkCursorCloudPullRequests,
  resolveCursorCloudCheckout,
} from "./cloud.ts";

function git(cwd: string, ...args: ReadonlyArray<string>) {
  NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T3",
      GIT_AUTHOR_EMAIL: "t3@example.com",
      GIT_COMMITTER_NAME: "T3",
      GIT_COMMITTER_EMAIL: "t3@example.com",
    },
  });
}

const makeCheckout = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-cloud-checkout-" });
  git(cwd, "init", "--quiet", "--initial-branch=feature");
  git(cwd, "remote", "add", "origin", "git@github.com:liminal-ai/t3code-v2.git");
  yield* fileSystem.writeFileString(path.join(cwd, "a.txt"), "a");
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "first");
  return { cwd, fileSystem, path };
});

describe("resolveCursorCloudCheckout", () => {
  it.effect("starts from the thread's branch when origin has it", () =>
    Effect.gen(function* () {
      const { cwd, fileSystem, path } = yield* makeCheckout;
      git(cwd, "update-ref", "refs/remotes/origin/feature", "HEAD");
      yield* fileSystem.writeFileString(path.join(cwd, "b.txt"), "b");
      git(cwd, "add", ".");
      git(cwd, "commit", "--quiet", "-m", "second");
      yield* fileSystem.writeFileString(path.join(cwd, "a.txt"), "edited");

      const checkout = yield* resolveCursorCloudCheckout(cwd);

      assert.deepStrictEqual(checkout, {
        repository: { url: "https://github.com/liminal-ai/t3code-v2", startingRef: "feature" },
        branch: "feature",
        unpushedCommits: 1,
        uncommittedChanges: true,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to the default branch when origin lacks the thread's branch", () =>
    Effect.gen(function* () {
      const { cwd } = yield* makeCheckout;

      const checkout = yield* resolveCursorCloudCheckout(cwd);

      assert.deepStrictEqual(checkout, {
        repository: { url: "https://github.com/liminal-ai/t3code-v2" },
        branch: "feature",
        unpushedCommits: 1,
        uncommittedChanges: false,
      });
      assert.include(
        cursorCloudEnvironmentNote(checkout),
        "at its default branch, because feature is not on origin.",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("gives an empty VM to a thread outside a repository", () =>
    Effect.gen(function* () {
      const checkout = yield* resolveCursorCloudCheckout(null);
      assert.isNull(checkout.repository);
      assert.include(cursorCloudEnvironmentNote(checkout), "no repository checked out");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("cursorCloudEnvironmentNote", () => {
  it("tells the cloud agent what the launcher had that its clone lacks", () => {
    const note = cursorCloudEnvironmentNote({
      repository: { url: "https://github.com/liminal-ai/t3code-v2", startingRef: "feature" },
      branch: "feature",
      unpushedCommits: 2,
      uncommittedChanges: true,
    });
    assert.include(note, "fresh clone of https://github.com/liminal-ai/t3code-v2 at feature.");
    assert.include(note, "its T3 Code tools");
    assert.include(
      note,
      "the launcher's checkout of feature had 2 commits not on origin and uncommitted changes.",
    );
  });

  it("omits the warning when the clone matches the launcher", () => {
    const note = cursorCloudEnvironmentNote({
      repository: { url: "https://github.com/liminal-ai/t3code-v2", startingRef: "main" },
      branch: "main",
      unpushedCommits: 0,
      uncommittedChanges: false,
    });
    assert.notInclude(note, "launcher's checkout");
  });
});

describe("cursorCloudPullRequestUrls", () => {
  it("returns each pull request once", () => {
    assert.deepStrictEqual(
      cursorCloudPullRequestUrls({
        id: "run-1",
        status: "finished",
        git: {
          branches: [
            {
              repoUrl: "https://github.com/a/b",
              branch: "cursor/x",
              prUrl: "https://github.com/a/b/pull/1",
            },
            {
              repoUrl: "https://github.com/a/b",
              branch: "cursor/x",
              prUrl: "https://github.com/a/b/pull/1",
            },
            { repoUrl: "https://github.com/a/c", branch: "cursor/y" },
          ],
        },
      }),
      ["https://github.com/a/b/pull/1"],
    );
  });
});

describe("linkCursorCloudPullRequests", () => {
  const mcpSession = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("cursor-cloud"),
    endpoint: "http://127.0.0.1:1/mcp",
    authorizationHeader: "Bearer thread-credential",
    browserToolsAvailable: true,
  };

  const fakeMcp = (toolResult: unknown) => {
    const requests: Array<{ readonly headers: Record<string, string>; readonly body: unknown }> =
      [];
    const fetchImplementation = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push({ headers: init?.headers as Record<string, string>, body });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = body.method === "initialize" ? { protocolVersion: "2025-06-18" } : toolResult;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json", "mcp-session-id": "mcp-session" },
      });
    }) as typeof fetch;
    return { requests, fetchImplementation };
  };

  it.effect("calls link_pull_request for each URL with the thread's credential", () =>
    Effect.gen(function* () {
      const { requests, fetchImplementation } = fakeMcp({ content: [] });

      yield* linkCursorCloudPullRequests(
        { mcpSession, urls: ["https://github.com/a/b/pull/1", "https://github.com/a/b/pull/2"] },
        fetchImplementation,
      );

      assert.deepStrictEqual(
        requests.map((request) => request.body),
        [
          {
            jsonrpc: "2.0",
            id: "initialize",
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "t3-code-cursor-cloud", version: "0.0.0" },
            },
          },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          {
            jsonrpc: "2.0",
            id: "link-0",
            method: "tools/call",
            params: {
              name: "link_pull_request",
              arguments: { url: "https://github.com/a/b/pull/1" },
            },
          },
          {
            jsonrpc: "2.0",
            id: "link-1",
            method: "tools/call",
            params: {
              name: "link_pull_request",
              arguments: { url: "https://github.com/a/b/pull/2" },
            },
          },
        ],
      );
      assert.isTrue(
        requests.every((request) => request.headers.authorization === "Bearer thread-credential"),
      );
      assert.equal(requests.at(-1)?.headers["mcp-session-id"], "mcp-session");
    }),
  );

  it.effect("fails when the tool reports an error", () =>
    Effect.gen(function* () {
      const { fetchImplementation } = fakeMcp({ isError: true, content: [] });

      const error = yield* Effect.flip(
        linkCursorCloudPullRequests(
          { mcpSession, urls: ["https://github.com/a/b/pull/1"] },
          fetchImplementation,
        ),
      );

      assert.equal(error._tag, "CursorCloudPullRequestLinkError");
      assert.include(error.message, "link_pull_request failed for https://github.com/a/b/pull/1");
    }),
  );
});
