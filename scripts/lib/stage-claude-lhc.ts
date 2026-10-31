import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

export type NodePlatformKey = `${NodeJS.Platform}-${NodeJS.Architecture}`;

export const CLAUDE_LHC_STAGE_TARGETS = [
  "linux-x64",
  "linux-arm64",
  "darwin-arm64",
] as const satisfies ReadonlyArray<NodePlatformKey>;

const decodePinJson = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String, sha512: Schema.String })),
);
const RuntimePackage = Schema.Struct({
  name: Schema.String,
  dependencies: Schema.Record(Schema.String, Schema.String),
});
const decodeSidecarLock = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ packages: Schema.Struct({ "": RuntimePackage }) })),
);
const encodeRuntimePackageJson = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ ...RuntimePackage.fields, private: Schema.Boolean })),
);

export class ClaudeLhcStageError extends Schema.TaggedError<ClaudeLhcStageError>()(
  "ClaudeLhcStageError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

function claudeLhcStageSkipReason(
  target: NodePlatformKey,
  host: NodePlatformKey,
): string | undefined {
  if (!(CLAUDE_LHC_STAGE_TARGETS as ReadonlyArray<NodePlatformKey>).includes(target)) {
    return `claude-lhc ships for ${CLAUDE_LHC_STAGE_TARGETS.join(", ")} only`;
  }
  if (target !== host) {
    return `built on ${host}, and the staged Node must run on ${target}`;
  }
  return undefined;
}

const STRIPPED_FILE = /\.(map|ts|mts|cts|tsx)$/;

const stripTree = Effect.fn("stage-claude-lhc.stripTree")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
): Effect.fn.Return<void, PlatformError.PlatformError> {
  for (const entry of yield* fs.readDirectory(root)) {
    const child = path.join(root, entry);
    const info = yield* fs.stat(child);
    if (info.type === "Directory") {
      if (entry === ".bin") {
        yield* fs.remove(child, { recursive: true });
      } else {
        yield* stripTree(fs, path, child);
      }
    } else if (STRIPPED_FILE.test(entry)) {
      yield* fs.remove(child);
    }
  }
});

const resolvePinnedNode = Effect.fn("stage-claude-lhc.resolvePinnedNode")(function* (
  version: string,
) {
  if (process.versions.node === version) return process.execPath;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const vp = yield* resolveSpawnCommand("vp", [
    "env",
    "exec",
    "--node",
    version,
    "node",
    "-p",
    "process.execPath",
  ]);
  const node = (yield* spawner.string(
    ChildProcess.make(vp.command, vp.args, { shell: vp.shell }),
  )).trim();
  const actual = node
    ? (yield* spawner.string(ChildProcess.make(node, ["-p", "process.versions.node"]))).trim()
    : "";
  if (actual !== version) {
    return yield* new ClaudeLhcStageError({
      detail: `lhc-runtime needs Node ${version}, the root engines.node, and \`vp env exec --node ${version}\` gave ${node || "no path"} (${actual || "no version"}).`,
    });
  }
  return node;
});

export const stageClaudeLhcRuntime = Effect.fn("stageClaudeLhcRuntime")(function* (input: {
  readonly vendorDir: string;
  readonly releaseDir: string;
  readonly target: NodePlatformKey;
  readonly nodeVersion: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host: NodePlatformKey = `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`;
  const skip = claudeLhcStageSkipReason(input.target, host);
  if (skip !== undefined) {
    yield* Effect.log(`lhc-runtime: skipped for ${input.target} (${skip})`);
    return Option.none<string>();
  }

  const started = yield* Clock.currentTimeMillis;
  const pin = yield* decodePinJson(
    yield* fs.readFileString(path.join(input.vendorDir, "pin.json")),
  );
  const tarballName = `claude-lhc-${pin.version}.tgz`;
  const tarball = yield* fs.readFile(path.join(input.vendorDir, tarballName));
  const sha512 = Hex.encode(yield* (yield* Crypto.Crypto).digest("SHA-512", tarball));
  if (sha512 !== pin.sha512) {
    return yield* new ClaudeLhcStageError({
      detail: `${tarballName} has sha512 ${sha512}, and pin.json pins ${pin.sha512}.`,
    });
  }
  const lockText = yield* fs.readFileString(path.join(input.vendorDir, "sidecar-lock.json"));
  const root = (yield* decodeSidecarLock(lockText)).packages[""];
  const node = yield* resolvePinnedNode(input.nodeVersion);
  yield* Effect.log(`lhc-runtime: staging claude-lhc ${pin.version} for ${input.target}...`);

  const runtimeDir = path.join(input.releaseDir, "lhc-runtime");
  yield* fs.makeDirectory(runtimeDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(runtimeDir, "package.json"),
    `${yield* encodeRuntimePackageJson({ ...root, private: true })}\n`,
  );
  yield* fs.writeFileString(path.join(runtimeDir, "package-lock.json"), lockText);
  yield* fs.writeFile(path.join(runtimeDir, tarballName), tarball);

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const npm = yield* resolveSpawnCommand("npm", [
    "ci",
    "--omit=dev",
    "--omit=optional",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(npm.command, npm.args, {
      cwd: runtimeDir,
      shell: npm.shell,
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  if (exitCode !== 0) {
    return yield* new ClaudeLhcStageError({
      detail: `npm ci for lhc-runtime exited with code ${String(exitCode)}.`,
    });
  }
  for (const entry of [
    "package.json",
    "package-lock.json",
    tarballName,
    "node_modules/.package-lock.json",
  ]) {
    yield* fs.remove(path.join(runtimeDir, entry), { force: true });
  }
  yield* stripTree(fs, path, path.join(runtimeDir, "node_modules"));

  const stagedNode = path.join(runtimeDir, "node");
  yield* fs.copyFile(node, stagedNode);
  yield* fs.chmod(stagedNode, 0o755);
  yield* Effect.log(
    `lhc-runtime: staged claude-lhc ${pin.version} and Node ${input.nodeVersion} for ${input.target} in ${(((yield* Clock.currentTimeMillis) - started) / 1000).toFixed(1)}s.`,
  );
  return Option.some(stagedNode);
});
