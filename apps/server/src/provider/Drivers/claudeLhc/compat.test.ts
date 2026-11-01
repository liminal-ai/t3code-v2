import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import {
  makeClaudeAgentSdkQueryRunner,
  type ClaudeQuerySeam,
} from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as PortScanner from "../../../preview/PortScanner.ts";
import { query, type ClaudeRunnerQuery } from "./client.ts";
import { stockMessage } from "./compat.ts";

// The sidecar sends each SDK message as one JSON line, as these are.
const wire = (message: object) => stockMessage(JSON.parse(JSON.stringify(message)));

const USER = {
  type: "user",
  message: { role: "user", content: "inbox delivery" },
  parent_tool_use_id: null,
  session_id: "session",
  uuid: "0b9a8c1e-0000-4000-8000-000000000001",
};

const RESULT_ERROR = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  num_turns: 0,
  errors: ["startup refused"],
  session_id: "session",
  uuid: "0b9a8c1e-0000-4000-8000-000000000002",
};

describe("stockMessage", () => {
  it("keeps a session-inbox delivery a task notification and drops the subkind stock cannot name", () => {
    expect(
      wire({
        ...USER,
        origin: { kind: "task-notification", subkind: "session-inbox", runId: "r1" },
      }),
    ).toEqual({ ...USER, origin: { kind: "task-notification", runId: "r1" } });
    expect(
      wire({
        ...RESULT_ERROR,
        origin: { kind: "task-notification", subkind: "session-inbox" },
      }),
    ).toEqual({ ...RESULT_ERROR, origin: { kind: "task-notification" } });
  });

  it("keeps a subkind stock can name", () => {
    const origin = { kind: "task-notification", subkind: "scheduled-trigger" };
    expect(wire({ ...USER, origin })).toEqual({ ...USER, origin });
  });

  it("drops a startup failure reason only SDK 0.3.312 names and keeps a stock one", () => {
    expect(wire({ ...RESULT_ERROR, startup_failure_reason: "provider_not_allowed" })).toEqual(
      RESULT_ERROR,
    );
    expect(wire({ ...RESULT_ERROR, startup_failure_reason: "cwd_unavailable" })).toEqual({
      ...RESULT_ERROR,
      startup_failure_reason: "cwd_unavailable",
    });
  });

  it("passes every other message through unchanged", () => {
    const status = { type: "system", subtype: "status", status: "compacting", session_id: "s" };
    expect(wire(status)).toEqual(status);
    expect(wire(USER)).toEqual(USER);
  });
});

// A sidecar that never answers on its first start and answers every control on its second.
const STUB_SIDECAR = `
import { createInterface } from "node:readline";
const answers = process.argv[2] === "answer";
createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (answers && frame.type === "req") {
    const value = { added: [], removed: [], errors: {} };
    process.stdout.write(JSON.stringify({ type: "res", id: frame.id, ok: true, value }) + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`;

describe("claudeRunnerQuery", () => {
  it.effect("closes a failed open's claude-lhc query on dispose, so the runner retries it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const sidecar = path.join(home, "sidecar.mjs");
      yield* fs.writeFileString(sidecar, STUB_SIDECAR);
      const queries: Array<ClaudeRunnerQuery> = [];
      const registering = Promise.withResolvers<void>();
      const seam: ClaudeQuerySeam = {
        program: () => undefined,
        createQuery: (prompt, { spawnClaudeCodeProcess: _spawn, ...options }) => {
          const mode = queries.length === 0 ? "stall" : "answer";
          const opened = query(prompt, {
            ...options,
            lhc: { home, spawn: { command: process.execPath, args: [sidecar, mode] } },
          });
          queries.push(opened);
          return {
            ...opened,
            setMcpServers: (servers) => {
              registering.resolve();
              return opened.setMcpServers(servers);
            },
          };
        },
        forkSession: () => Effect.die("unused"),
        subagentLaunchToolUseId: () => Effect.die("unused"),
      };
      const runner = yield* makeClaudeAgentSdkQueryRunner(seam).pipe(
        Effect.provideService(ProviderEventLoggers, { native: undefined, canonical: undefined }),
        Effect.provide(PortScanner.layerTest),
      );

      const opening = yield* runner
        .open({
          providerSessionId: ProviderSessionId.make("session-lhc-registration"),
          thread: { appThreadId: ThreadId.make("thread-lhc-registration"), engineBinding: null },
          options: {
            resume: "native-session",
            model: "claude-sonnet-4-6",
            tools: [],
            permissionMode: "default",
            mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1:9/mcp" } },
          },
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => registering.promise);
      yield* TestClock.adjust("90 seconds");
      const session = yield* Fiber.join(opening);
      yield* Effect.addFinalizer(() => session.close.pipe(Effect.orDie));

      expect(queries).toHaveLength(2);
      const stalled = yield* Effect.promise(() =>
        queries[0]!.setModel("claude-sonnet-5").then(
          () => "open",
          (cause: Error) => cause.message,
        ),
      );
      expect(stalled).toBe("claude-lhc sidecar is closed");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
