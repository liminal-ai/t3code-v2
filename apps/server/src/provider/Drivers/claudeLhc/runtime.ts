import {
  parseGenericCliVersion,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
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

/** Electron sets `process.resourcesPath` in run-as-node mode too, and plain Node has none. */
export const ElectronResourcesPath = Context.Reference<string | undefined>(
  "t3/claudeLhc/ElectronResourcesPath",
  {
    defaultValue: () =>
      process.versions.electron === undefined
        ? undefined
        : (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath,
  },
);

const problem = (detail: string) => Effect.fail(new ClaudeLhcRuntimeProblem({ detail }));

/** Electron's asar support answers `access` on `app.asar` with ENOENT, and `stat` finds it. */
const exists = Effect.fn("claudeLhc.exists")(
  function* (file: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.stat(file);
    return true;
  },
  Effect.orElseSucceed(() => false),
);

const sameFile = Effect.fn("claudeLhc.sameFile")(
  function* (left: string, right: string) {
    const fs = yield* FileSystem.FileSystem;
    const [a, b] = yield* Effect.all([fs.stat(left), fs.stat(right)]);
    return (
      a.dev === b.dev &&
      Option.isSome(a.ino) &&
      Option.isSome(b.ino) &&
      a.ino.value > 0n &&
      a.ino.value === b.ino.value
    );
  },
  Effect.orElseSucceed(() => false),
);

const releaseTarget = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  return `${platform === "win32" ? "win" : platform}-${arch}`;
});

const stagedRuntime = Effect.fn("claudeLhc.stagedRuntime")(function* (
  staged: string,
  fallbackNode: string | undefined,
) {
  const path = yield* Path.Path;
  if (!(yield* exists(staged))) {
    return yield* problem(`LHC runtime not staged for ${yield* releaseTarget}`);
  }
  const stagedNode = path.join(staged, "node");
  return {
    node: fallbackNode === undefined || (yield* exists(stagedNode)) ? stagedNode : fallbackNode,
    sidecar: path.join(staged, "node_modules", "claude-lhc", "dist", "sidecar.js"),
  } satisfies ClaudeLhcRuntime;
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
    const executable = yield* HostProcess.ExecutablePath;
    return yield* stagedRuntime(path.join(path.dirname(executable), "lhc-runtime"), undefined);
  }

  const resources = yield* ElectronResourcesPath;
  if (resources !== undefined && (yield* exists(path.join(resources, "app.asar")))) {
    const electron = yield* HostProcess.ExecutablePath;
    return yield* stagedRuntime(path.join(resources, "lhc-runtime"), electron);
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

const nodeVersion = (node: string, environment: NodeJS.ProcessEnv) =>
  spawnAndCollect(node, ChildProcess.make(node, ["--version"], { env: environment })).pipe(
    Effect.map((result) => (result.code === 0 ? parseGenericCliVersion(result.stdout) : null)),
    Effect.orElseSucceed(() => null),
  );

export const resolveClaudeLhcRuntime = Effect.fn("claudeLhc.resolveRuntime")(function* (
  environment?: NodeJS.ProcessEnv,
) {
  const env = environment ?? (yield* HostProcess.Environment);
  const runtime = yield* locateRuntime(env);
  if (!(yield* exists(runtime.node))) {
    return yield* problem(`Node for claude-lhc not found at ${runtime.node}.`);
  }
  if (!(yield* exists(runtime.sidecar))) {
    return yield* problem(`claude-lhc sidecar not found at ${runtime.sidecar}.`);
  }
  if (yield* sameFile(runtime.node, yield* HostProcess.ExecutablePath)) {
    if (yield* HostProcess.IsExecutable) {
      return yield* problem(`${runtime.node} is the T3 executable, not Node.`);
    }
    if ((yield* ElectronResourcesPath) !== undefined && env.ELECTRON_RUN_AS_NODE !== "1") {
      return yield* problem(
        `${runtime.node} is the desktop app's Electron, which runs claude-lhc only with ELECTRON_RUN_AS_NODE=1.`,
      );
    }
  }
  const version = yield* nodeVersion(runtime.node, env);
  if (version === null) {
    return yield* problem(`Could not read the Node version of ${runtime.node}.`);
  }
  if (compareSemverVersions(version, CLAUDE_LHC_MINIMUM_NODE) < 0) {
    return yield* problem(
      `claude-lhc needs Node ${CLAUDE_LHC_MINIMUM_NODE} or later, and ${runtime.node} is ${version}.`,
    );
  }
  yield* Effect.logInfo("claude-lhc runtime resolved").pipe(
    Effect.annotateLogs({ node: runtime.node, nodeVersion: version, sidecar: runtime.sidecar }),
  );
  return runtime;
});
