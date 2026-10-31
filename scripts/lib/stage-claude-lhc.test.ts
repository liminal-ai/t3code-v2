import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  CLAUDE_LHC_STAGE_TARGETS,
  type NodePlatformKey,
  stageClaudeLhcRuntime,
} from "./stage-claude-lhc.ts";

const PACKAGE_FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "claude-lhc",
    version: "0.2.0",
    type: "module",
    bin: { "claude-lhc": "./bin/claude-lhc.js" },
  }),
  "bin/claude-lhc.js": "#!/usr/bin/env node\n",
  "dist/sidecar.js": "process.stdin.resume();\n",
  "dist/sidecar.js.map": "{}",
  "dist/sidecar.d.ts": "export {};\n",
  "src/runtime.js": "export {};\n",
  "src/runtime.ts": "export {};\n",
};

const fixture = Effect.fn("test.fixture")(function* (options: { readonly pinnedSha?: string }) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "stage-claude-lhc-" });
  const packageDir = path.join(root, "src", "package");
  for (const [file, text] of Object.entries(PACKAGE_FILES)) {
    yield* fs.makeDirectory(path.dirname(path.join(packageDir, file)), { recursive: true });
    yield* fs.writeFileString(path.join(packageDir, file), text);
  }
  const vendorDir = path.join(root, "vendor");
  yield* fs.makeDirectory(vendorDir);
  const tarball = path.join(vendorDir, "claude-lhc-0.2.0.tgz");
  yield* spawner.exitCode(
    ChildProcess.make("tar", ["-czf", tarball, "-C", path.join(root, "src"), "package"]),
  );
  const bytes = yield* fs.readFile(tarball);
  const sha512 = yield* (yield* Crypto.Crypto).digest("SHA-512", bytes);
  yield* fs.writeFileString(
    path.join(vendorDir, "pin.json"),
    JSON.stringify({
      version: "0.2.0",
      sha512: options.pinnedSha ?? Hex.encode(sha512),
      sourceSha: "0".repeat(40),
    }),
  );
  const spec = "file:claude-lhc-0.2.0.tgz";
  yield* fs.writeFileString(
    path.join(vendorDir, "sidecar-lock.json"),
    JSON.stringify({
      name: "lhc-runtime",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "lhc-runtime", dependencies: { "claude-lhc": spec } },
        "node_modules/claude-lhc": {
          version: "0.2.0",
          resolved: spec,
          integrity: `sha512-${Base64.encode(sha512)}`,
          bin: { "claude-lhc": "bin/claude-lhc.js" },
        },
      },
    }),
  );
  return { vendorDir, releaseDir: path.join(root, "release") };
});

const listTree = Effect.fn("test.listTree")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(root, { recursive: true });
  const files: Array<string> = [];
  for (const entry of entries) {
    if ((yield* fs.stat(path.join(root, entry))).type !== "Directory") files.push(entry);
  }
  return files.toSorted();
});

const onHost = (target: NodePlatformKey) => {
  const [platform, arch] = target.split("-") as [NodeJS.Platform, NodeJS.Architecture];
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(HostProcess.Architecture, arch),
    );
};

describe("stageClaudeLhcRuntime", () => {
  it.effect("fails on a sha512 mismatch before it installs anything", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { vendorDir, releaseDir } = yield* fixture({ pinnedSha: "0".repeat(128) });
      const error = yield* stageClaudeLhcRuntime({
        vendorDir,
        releaseDir,
        target: "linux-x64",
        nodeVersion: process.versions.node,
      }).pipe(onHost("linux-x64"), Effect.flip);
      expect(error.message).toMatch(
        /^claude-lhc-0\.2\.0\.tgz has sha512 [0-9a-f]{128}, and pin\.json pins 0{128}\.$/,
      );
      expect(yield* fs.exists(path.join(releaseDir, "lhc-runtime"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each(CLAUDE_LHC_STAGE_TARGETS)(
    "stages the sidecar and the pinned Node on a %s host",
    (target) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const { vendorDir, releaseDir } = yield* fixture({});
        const stagedNode = yield* stageClaudeLhcRuntime({
          vendorDir,
          releaseDir,
          target,
          nodeVersion: process.versions.node,
        }).pipe(onHost(target));
        const runtimeDir = path.join(releaseDir, "lhc-runtime");
        expect(stagedNode).toEqual(Option.some(path.join(runtimeDir, "node")));
        expect(yield* listTree(runtimeDir)).toEqual([
          "node",
          "node_modules/claude-lhc/bin/claude-lhc.js",
          "node_modules/claude-lhc/dist/sidecar.js",
          "node_modules/claude-lhc/package.json",
          "node_modules/claude-lhc/src/runtime.js",
        ]);
        const version = yield* spawner.string(
          ChildProcess.make(path.join(runtimeDir, "node"), ["-p", "process.versions.node"]),
        );
        expect(version.trim()).toBe(process.versions.node);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("skips a Windows target and a cross-host target with the log line", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stage-claude-lhc-" });
      const logs: Array<string> = [];
      const stage = (target: NodePlatformKey) =>
        stageClaudeLhcRuntime({
          vendorDir: path.join(root, "missing-vendor"),
          releaseDir: root,
          target,
          nodeVersion: process.versions.node,
        }).pipe(
          onHost("linux-x64"),
          Effect.provide(
            Logger.layer([Logger.make((options) => logs.push(String(options.message)))]),
          ),
        );
      expect(yield* stage("win32-x64")).toEqual(Option.none());
      expect(yield* stage("linux-arm64")).toEqual(Option.none());
      expect(logs).toEqual([
        "lhc-runtime: skipped for win32-x64 (claude-lhc ships for linux-x64, linux-arm64, darwin-arm64 only)",
        "lhc-runtime: skipped for linux-arm64 (built on linux-x64, and the staged Node must run on linux-arm64)",
      ]);
      expect(yield* fs.readDirectory(root)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
