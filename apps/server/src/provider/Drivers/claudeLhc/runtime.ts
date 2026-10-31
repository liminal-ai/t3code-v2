import {
  parseGenericCliVersion,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/process";

const CLAUDE_LHC_MINIMUM_NODE = "24.3.0";

export interface ClaudeLhcRuntime {
  readonly node: string;
  readonly sidecar: string;
}

export class ClaudeLhcRuntimeProblem extends Schema.TaggedError<ClaudeLhcRuntimeProblem>()(
  "ClaudeLhcRuntimeProblem",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const problem = (detail: string) => Effect.fail(new ClaudeLhcRuntimeProblem({ detail }));

const exists = Effect.fn("claudeLhc.exists")(
  function* (file: string) {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(file);
  },
  Effect.orElseSucceed(() => false),
);

const sameFile = Effect.fn("claudeLhc.sameFile")(
  function* (left: string, right: string) {
    const fs = yield* FileSystem.FileSystem;
    const [a, b] = yield* Effect.all([fs.realPath(left), fs.realPath(right)]);
    return a === b;
  },
  Effect.orElseSucceed(() => false),
);

const releaseTarget = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  return `${platform === "win32" ? "win" : platform}-${arch}`;
});

const locateRuntime = Effect.fn("claudeLhc.locateRuntime")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const node = environment.CLAUDE_LHC_NODE?.trim() || undefined;
  const sidecar = environment.CLAUDE_LHC_SIDECAR?.trim() || undefined;
  if (node !== undefined || sidecar !== undefined) {
    if (node === undefined || sidecar === undefined) {
      return yield* problem("Set both CLAUDE_LHC_NODE and CLAUDE_LHC_SIDECAR, or neither.");
    }
    return { node: path.resolve(node), sidecar: path.resolve(sidecar) } satisfies ClaudeLhcRuntime;
  }

  if (yield* HostProcess.IsExecutable) {
    const staged = path.join(path.dirname(yield* HostProcess.ExecutablePath), "lhc-runtime");
    if (!(yield* exists(staged))) {
      return yield* problem(`LHC runtime not staged for ${yield* releaseTarget}`);
    }
    return {
      node: path.join(staged, "node"),
      sidecar: path.join(staged, "node_modules", "claude-lhc", "dist", "sidecar.js"),
    } satisfies ClaudeLhcRuntime;
  }

  const packageJson = yield* Effect.try(() => import.meta.resolve("claude-lhc/package.json")).pipe(
    Effect.flatMap((url) => path.fromFileUrl(new URL(url))),
    Effect.mapError(
      () => new ClaudeLhcRuntimeProblem({ detail: "The claude-lhc package is not installed." }),
    ),
  );
  return {
    node: yield* resolveNodeExecutable("claude-lhc", environment).pipe(
      Effect.mapError((error) => new ClaudeLhcRuntimeProblem({ detail: error.message })),
    ),
    sidecar: path.join(path.dirname(packageJson), "dist", "sidecar.js"),
  } satisfies ClaudeLhcRuntime;
});

const nodeVersion = (node: string) =>
  spawnAndCollect(node, ChildProcess.make(node, ["--version"])).pipe(
    Effect.map((result) => (result.code === 0 ? parseGenericCliVersion(result.stdout) : null)),
    Effect.orElseSucceed(() => null),
  );

export const resolveClaudeLhcRuntime = Effect.fn("claudeLhc.resolveRuntime")(function* (
  environment?: NodeJS.ProcessEnv,
) {
  const runtime = yield* locateRuntime(environment ?? (yield* HostProcess.Environment));
  if (!(yield* exists(runtime.node))) {
    return yield* problem(`Node for claude-lhc not found at ${runtime.node}.`);
  }
  if (!(yield* exists(runtime.sidecar))) {
    return yield* problem(`claude-lhc sidecar not found at ${runtime.sidecar}.`);
  }
  if (
    (yield* HostProcess.IsExecutable) &&
    (yield* sameFile(runtime.node, yield* HostProcess.ExecutablePath))
  ) {
    return yield* problem(`${runtime.node} is the T3 executable, not Node.`);
  }
  const version = yield* nodeVersion(runtime.node);
  if (version === null) {
    return yield* problem(`Could not read the Node version of ${runtime.node}.`);
  }
  if (compareSemverVersions(version, CLAUDE_LHC_MINIMUM_NODE) < 0) {
    return yield* problem(
      `claude-lhc needs Node ${CLAUDE_LHC_MINIMUM_NODE} or later, and ${runtime.node} is ${version}.`,
    );
  }
  return runtime;
});
