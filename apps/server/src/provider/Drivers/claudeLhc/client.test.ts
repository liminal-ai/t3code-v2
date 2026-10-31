import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { getSessionMessages, inspectSessions } from "./client.ts";

describe("claude-lhc client", () => {
  it.effect("runs an operation in the vendored package's sidecar", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      expect(yield* inspectSessions(["first", "second"], { lhc: { home } })).toEqual([
        { kind: "unknown" },
        { kind: "unknown" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails an operation with the sidecar's reason", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const error = yield* getSessionMessages("missing", { lhc: { home } }).pipe(Effect.flip);
      expect(error._tag).toBe("ClaudeLhcOperationError");
      expect(error.message).toBe(
        "claude-lhc getSessionMessages failed: no LHC thread holds the Claude session missing",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
