import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectTmpDir from "./ProjectTmpDir.ts";

const codex = ProviderInstanceId.make("codex");
const codexWithTmpDir = ProviderInstanceId.make("codex_tmpdir");

const layerTest = ProjectTmpDir.layer.pipe(
  Layer.provideMerge(
    ServerSettings.layerTest({
      providerInstances: {
        [codexWithTmpDir]: {
          driver: ProviderDriverKind.make("codex"),
          environment: [{ name: "TMPDIR", value: "/instance-tmp" }],
        },
      },
    }),
  ),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "project-tmpdir-" })),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({ operation: "ProjectTmpDir.test", cwd, args });
    return result.stdout;
  });

const makeRepo = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "project-tmpdir-repo-" });
  yield* git(root, "init", "--quiet");
  // The machine's global ignore may already cover .pstack/.
  yield* git(root, "config", "core.excludesFile", "/dev/null");
  return root;
});

it.layer(layerTest)("ProjectTmpDir", (it) => {
  it.effect("puts the directory in the project's .pstack folder", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.equal(ProjectTmpDir.projectTmpDirPath(path, "/work/app"), "/work/app/.pstack/tmp");
    }),
  );

  it.effect("adds .pstack/ to an exclude on its own line", () =>
    Effect.sync(() => {
      assert.equal(ProjectTmpDir.withPstackExcluded(""), ".pstack/\n");
      assert.equal(ProjectTmpDir.withPstackExcluded("# rules"), "# rules\n.pstack/\n");
      assert.equal(ProjectTmpDir.withPstackExcluded("# rules\n"), "# rules\n.pstack/\n");
    }),
  );

  it.effect("makes an owner-only .pstack/tmp in a repo and keeps git status clean", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectTmpDir = yield* ProjectTmpDir.ProjectTmpDir;
      const root = yield* makeRepo;

      const tmpDir = yield* projectTmpDir.resolve({ projectRoot: root, instanceId: codex });
      yield* projectTmpDir.resolve({ projectRoot: root, instanceId: codex });

      assert.equal(tmpDir, path.join(root, ".pstack", "tmp"));
      assert.equal((yield* fileSystem.stat(path.join(root, ".pstack", "tmp"))).mode & 0o777, 0o700);
      yield* fileSystem.writeFileString(path.join(root, ".pstack", "tmp", "scratch"), "x");
      assert.equal(yield* git(root, "status", "--porcelain", "--untracked-files=all"), "");
      const exclude = yield* fileSystem.readFileString(path.join(root, ".git", "info", "exclude"));
      assert.equal(exclude.split("\n").filter((line) => line === ".pstack/").length, 1);
    }),
  );

  it.effect("makes a precreated .pstack/tmp owner-only", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectTmpDir = yield* ProjectTmpDir.ProjectTmpDir;
      const root = yield* makeRepo;
      const existing = path.join(root, ".pstack", "tmp");
      yield* fileSystem.makeDirectory(existing, { recursive: true });
      yield* fileSystem.chmod(existing, 0o755);

      assert.equal(
        yield* projectTmpDir.resolve({ projectRoot: root, instanceId: codex }),
        existing,
      );
      assert.equal((yield* fileSystem.stat(existing)).mode & 0o777, 0o700);
    }),
  );

  it.effect("leaves a repo that already ignores .pstack/ alone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectTmpDir = yield* ProjectTmpDir.ProjectTmpDir;
      const root = yield* makeRepo;
      yield* fileSystem.writeFileString(path.join(root, ".gitignore"), ".pstack/\n");
      const excludePath = path.join(root, ".git", "info", "exclude");
      const before = (yield* fileSystem.exists(excludePath))
        ? yield* fileSystem.readFileString(excludePath)
        : undefined;

      yield* projectTmpDir.resolve({ projectRoot: root, instanceId: codex });

      const after = (yield* fileSystem.exists(excludePath))
        ? yield* fileSystem.readFileString(excludePath)
        : undefined;
      assert.equal(after, before);
      assert.equal(yield* fileSystem.readFileString(path.join(root, ".gitignore")), ".pstack/\n");
    }),
  );

  it.effect("makes the directory in a folder that is not a repo without making one", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectTmpDir = yield* ProjectTmpDir.ProjectTmpDir;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "project-tmpdir-plain-" });

      const tmpDir = yield* projectTmpDir.resolve({ projectRoot: root, instanceId: codex });

      assert.equal(tmpDir, path.join(root, ".pstack", "tmp"));
      assert.equal(yield* fileSystem.exists(path.join(root, ".git")), false);
    }),
  );

  it.effect("gives no directory for a missing root, and never creates the root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectTmpDir = yield* ProjectTmpDir.ProjectTmpDir;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "project-tmpdir-gone-" });
      const root = path.join(parent, "deleted-project");

      assert.equal(
        yield* projectTmpDir.resolve({ projectRoot: root, instanceId: codex }),
        undefined,
      );
      assert.equal(
        yield* projectTmpDir.resolve({ projectRoot: undefined, instanceId: codex }),
        undefined,
      );
      assert.equal(yield* fileSystem.exists(root), false);
    }),
  );

  it.effect("gives no directory when the root is not writable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const projectTmpDir = yield* ProjectTmpDir.ProjectTmpDir;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "project-tmpdir-ro-" });
      yield* fileSystem.chmod(root, 0o500);
      yield* Effect.addFinalizer(() => fileSystem.chmod(root, 0o700).pipe(Effect.ignore));

      assert.equal(
        yield* projectTmpDir.resolve({ projectRoot: root, instanceId: codex }),
        undefined,
      );
    }),
  );

  it.effect("keeps the instance's own TMPDIR", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectTmpDir = yield* ProjectTmpDir.ProjectTmpDir;
      const root = yield* makeRepo;

      assert.equal(
        yield* projectTmpDir.resolve({ projectRoot: root, instanceId: codexWithTmpDir }),
        undefined,
      );
      assert.equal(yield* fileSystem.exists(path.join(root, ".pstack")), false);
    }),
  );
});
