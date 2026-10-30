/**
 * Gives each project one `<workspace root>/.pstack/tmp/` for its local agents' `TMPDIR`, shared by
 * every thread in it, worktree threads included. An instance's own `TMPDIR` wins. A missing or
 * unwritable root gives no directory and logs why once, and nothing here fails a launch.
 */
import type { ProviderInstanceEnvironment, ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const PSTACK_IGNORE_LINE = ".pstack/";
const GIT_TIMEOUT_MS = 5_000;

export class ProjectTmpDir extends Context.Service<
  ProjectTmpDir,
  {
    /** The directory for an agent of `instanceId` in the project at `projectRoot`, or none. */
    readonly resolve: (input: {
      readonly projectRoot: string | undefined;
      readonly instanceId: ProviderInstanceId;
    }) => Effect.Effect<string | undefined>;
  }
>()("t3/fork/ProjectTmpDir") {}

export function projectTmpDirPath(path: Path.Path, projectRoot: string): string {
  return path.join(projectRoot, ".pstack", "tmp");
}

export function instanceSetsTmpDir(environment: ProviderInstanceEnvironment | undefined): boolean {
  return environment?.some((variable) => variable.name === "TMPDIR") ?? false;
}

/** `.git/info/exclude` with `.pstack/` added on its own line. */
export function withPstackExcluded(exclude: string): string {
  const separator = exclude === "" || exclude.endsWith("\n") ? "" : "\n";
  return `${exclude}${separator}${PSTACK_IGNORE_LINE}\n`;
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  const settings = yield* ServerSettings.ServerSettingsService;
  const logged = yield* Ref.make<ReadonlySet<string>>(new Set());
  const excludeChecked = yield* Ref.make<ReadonlySet<string>>(new Set());
  const excludeLock = yield* Semaphore.make(1);

  const logOnce = (projectRoot: string, reason: string) =>
    Ref.modify(logged, (current) => {
      const key = `${projectRoot}\0${reason}`;
      return current.has(key) ? [false, current] : [true, new Set([...current, key])];
    }).pipe(
      Effect.flatMap((first) =>
        first
          ? Effect.logWarning("Agents in this project keep the server's TMPDIR", {
              projectRoot,
              reason,
            })
          : Effect.void,
      ),
    );

  const git = (projectRoot: string, args: ReadonlyArray<string>) =>
    gitDriver.execute({
      operation: "ProjectTmpDir.excludePstack",
      cwd: projectRoot,
      args: ["-c", "core.fsmonitor=false", ...args],
      allowNonZeroExit: true,
      timeoutMs: GIT_TIMEOUT_MS,
    });

  // The poteto-mode Run folder rule: `.pstack/` stays out of git through the repo's own exclude,
  // never a tracked `.gitignore`. A folder that is not a repository needs nothing.
  const excludePstack = Effect.fn("ProjectTmpDir.excludePstack")(function* (projectRoot: string) {
    const excludePath = yield* git(projectRoot, ["rev-parse", "--git-path", "info/exclude"]);
    if (excludePath.exitCode !== 0) return;
    const ignored = yield* git(projectRoot, ["check-ignore", "-q", PSTACK_IGNORE_LINE]);
    if (ignored.exitCode === 0) return;
    const exclude = path.resolve(projectRoot, excludePath.stdout.trim());
    const current = (yield* fileSystem.exists(exclude))
      ? yield* fileSystem.readFileString(exclude)
      : "";
    yield* fileSystem.makeDirectory(path.dirname(exclude), { recursive: true });
    yield* fileSystem.writeFileString(exclude, withPstackExcluded(current));
  });

  const ensureExcluded = (projectRoot: string) =>
    excludeLock.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* Ref.get(excludeChecked)).has(projectRoot)) return;
        yield* excludePstack(projectRoot).pipe(
          Effect.catch((error) =>
            logOnce(projectRoot, `could not add .pstack/ to git's exclude: ${error.message}`),
          ),
        );
        yield* Ref.update(excludeChecked, (current) => new Set([...current, projectRoot]));
      }),
    );

  const resolve = Effect.fn("ProjectTmpDir.resolve")(function* (input: {
    readonly projectRoot: string | undefined;
    readonly instanceId: ProviderInstanceId;
  }) {
    const current = yield* settings.getSettings.pipe(Effect.option);
    const instance =
      current._tag === "Some" && Object.hasOwn(current.value.providerInstances, input.instanceId)
        ? current.value.providerInstances[input.instanceId]
        : undefined;
    if (instanceSetsTmpDir(instance?.environment)) return undefined;

    const { projectRoot } = input;
    if (projectRoot === undefined) {
      yield* logOnce("", "the thread has no project");
      return undefined;
    }
    const rootIsDirectory = yield* fileSystem.stat(projectRoot).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
    if (!rootIsDirectory) {
      yield* logOnce(projectRoot, "the project root is missing");
      return undefined;
    }
    const tmpDir = projectTmpDirPath(path, projectRoot);
    // Made on every launch, so a deleted `.pstack/` never leaves agents a TMPDIR that is gone.
    const writable = yield* fileSystem.makeDirectory(tmpDir, { recursive: true, mode: 0o700 }).pipe(
      Effect.andThen(fileSystem.access(tmpDir, { writable: true })),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!writable) {
      yield* logOnce(projectRoot, `${tmpDir} could not be made or is not writable`);
      return undefined;
    }
    yield* ensureExcluded(projectRoot);
    return tmpDir;
  });

  return ProjectTmpDir.of({ resolve });
});

export const layer = Layer.effect(ProjectTmpDir, make);
