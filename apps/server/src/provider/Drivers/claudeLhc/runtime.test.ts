import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveClaudeLhcRuntime } from "./runtime.ts";

const unix = HostProcess.Platform.defaultValue() !== "win32";

const fakeNode = Effect.fn(function* (file: string, version: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, `#!/bin/sh\necho ${version}\n`);
  yield* fs.chmod(file, 0o755);
  return file;
});

const touch = Effect.fn(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, "");
  return file;
});

const release = Effect.fn(function* (options: { readonly staged: boolean }) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  const executable = yield* fakeNode(path.join(directory, "t3"), "v26.12.1");
  if (!options.staged) return { directory, executable };
  const node = yield* fakeNode(path.join(directory, "lhc-runtime", "node"), "v26.12.1");
  const sidecar = yield* touch(
    path.join(directory, "lhc-runtime", "node_modules", "claude-lhc", "dist", "sidecar.js"),
  );
  return { directory, executable, node, sidecar };
});

const failure = (environment: NodeJS.ProcessEnv) =>
  resolveClaudeLhcRuntime(environment).pipe(
    Effect.flip,
    Effect.map((problem) => problem.message),
  );

describe.runIf(unix)("resolveClaudeLhcRuntime", () => {
  it.effect("takes the override pair over a staged release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staged = yield* release({ staged: true });
      const scratch = yield* fs.makeTempDirectoryScoped();
      const node = yield* fakeNode(path.join(scratch, "bin", "node"), "v24.3.0");
      const sidecar = yield* touch(path.join(scratch, "sidecar.js"));
      const runtime = yield* resolveClaudeLhcRuntime({
        CLAUDE_LHC_NODE: node,
        CLAUDE_LHC_SIDECAR: sidecar,
      }).pipe(
        Effect.provideService(HostProcess.ExecutablePath, staged.executable),
        Effect.provideService(HostProcess.IsExecutable, true),
      );
      expect(runtime).toEqual({ node, sidecar });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses half an override", () =>
    Effect.gen(function* () {
      expect(yield* failure({ CLAUDE_LHC_NODE: process.execPath })).toBe(
        "Set both CLAUDE_LHC_NODE and CLAUDE_LHC_SIDECAR, or neither.",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("runs a release's staged Node and sidecar beside the executable", () =>
    Effect.gen(function* () {
      const staged = yield* release({ staged: true });
      const runtime = yield* resolveClaudeLhcRuntime({}).pipe(
        Effect.provideService(HostProcess.ExecutablePath, staged.executable),
        Effect.provideService(HostProcess.IsExecutable, true),
      );
      expect(runtime).toEqual({ node: staged.node, sidecar: staged.sidecar });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("names the target when a release has no lhc-runtime", () =>
    Effect.gen(function* () {
      const bare = yield* release({ staged: false });
      const message = yield* failure({}).pipe(
        Effect.provideService(HostProcess.ExecutablePath, bare.executable),
        Effect.provideService(HostProcess.IsExecutable, true),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Architecture, "x64"),
      );
      expect(message).toBe("LHC runtime not staged for linux-x64");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("never runs the executable as Node", () =>
    Effect.gen(function* () {
      const staged = yield* release({ staged: true });
      const message = yield* failure({
        CLAUDE_LHC_NODE: staged.executable,
        CLAUDE_LHC_SIDECAR: staged.sidecar,
      }).pipe(
        Effect.provideService(HostProcess.ExecutablePath, staged.executable),
        Effect.provideService(HostProcess.IsExecutable, true),
      );
      expect(message).toBe(`${staged.executable} is the T3 executable, not Node.`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("never runs a hard link of the executable as Node", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bare = yield* release({ staged: false });
      const node = path.join(bare.directory, "lhc-runtime", "node");
      const sidecar = yield* touch(
        path.join(
          bare.directory,
          "lhc-runtime",
          "node_modules",
          "claude-lhc",
          "dist",
          "sidecar.js",
        ),
      );
      yield* fs.link(bare.executable, node);
      const message = yield* failure({ CLAUDE_LHC_NODE: node, CLAUDE_LHC_SIDECAR: sidecar }).pipe(
        Effect.provideService(HostProcess.ExecutablePath, bare.executable),
        Effect.provideService(HostProcess.IsExecutable, true),
      );
      expect(message).toBe(`${node} is the T3 executable, not Node.`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("runs the installed package under the current Node in development", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtime = yield* resolveClaudeLhcRuntime({}).pipe(
        Effect.provideService(HostProcess.ExecutablePath, process.execPath),
        Effect.provideService(HostProcess.IsExecutable, false),
      );
      expect(runtime.node).toBe(process.execPath);
      expect(runtime.sidecar).toMatch(/[/\\]claude-lhc[/\\]dist[/\\]sidecar\.js$/);
      expect(yield* fs.exists(runtime.sidecar)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a Node older than 24.3 and names its version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const scratch = yield* fs.makeTempDirectoryScoped();
      const node = yield* fakeNode(path.join(scratch, "node"), "v24.2.9");
      const sidecar = yield* touch(path.join(scratch, "sidecar.js"));
      expect(yield* failure({ CLAUDE_LHC_NODE: node, CLAUDE_LHC_SIDECAR: sidecar })).toBe(
        `claude-lhc needs Node 24.3.0 or later, and ${node} is 24.2.9.`,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a missing sidecar", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const scratch = yield* fs.makeTempDirectoryScoped();
      const sidecar = path.join(scratch, "missing", "sidecar.js");
      expect(
        yield* failure({ CLAUDE_LHC_NODE: process.execPath, CLAUDE_LHC_SIDECAR: sidecar }),
      ).toBe(`claude-lhc sidecar not found at ${sidecar}.`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
