import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

// claude-lhc 0.2.0 (vendor/claude-lhc) pins this Agent SDK; stock Claude keeps its own.
export const CLAUDE_LHC_AGENT_SDK = "0.3.312";

interface BundledPackage {
  readonly name: string;
  readonly version: string | undefined;
}

/** Packages that run only in claude-lhc's sidecar, so the server executable must never bundle them. */
const SIDECAR_ONLY: ReadonlyArray<{
  readonly label: string;
  readonly matches: (pkg: BundledPackage) => boolean;
}> = [
  { label: "lhc", matches: (pkg) => pkg.name === "lhc" },
  { label: "Effect 3", matches: (pkg) => pkg.name === "effect" && !!pkg.version?.startsWith("3.") },
  { label: "js-tiktoken", matches: (pkg) => pkg.name === "js-tiktoken" },
  {
    label: `Agent SDK ${CLAUDE_LHC_AGENT_SDK}`,
    matches: (pkg) =>
      pkg.name === "@anthropic-ai/claude-agent-sdk" && pkg.version === CLAUDE_LHC_AGENT_SDK,
  },
];

function bundledPackage(moduleId: string): BundledPackage | undefined {
  const parts = moduleId.replaceAll("\\", "/").split("/node_modules/");
  const [scope = "", base = ""] = parts.at(-1)?.split("/") ?? [];
  if (parts.length < 2 || scope === "") return undefined;
  const name = scope.startsWith("@") ? `${scope}/${base}` : scope;
  // pnpm keeps each package at .pnpm/<name>@<version>[_<peers>]/node_modules/<name>.
  const entry = parts.at(-2)?.split("/").slice(-2);
  const prefix = `${name.replace("/", "+")}@`;
  const version =
    entry?.[0] === ".pnpm" && entry[1]?.startsWith(prefix)
      ? entry[1].slice(prefix.length).split("_")[0]
      : undefined;
  return { name, version };
}

export interface BundledModuleReport {
  readonly moduleCount: number;
  readonly claudeLhcClient: boolean;
  readonly sidecarOnly: ReadonlyArray<string>;
}

export function inspectBundledModules(moduleIds: ReadonlyArray<string>): BundledModuleReport {
  const packages = moduleIds.map((moduleId) => ({ moduleId, pkg: bundledPackage(moduleId) }));
  return {
    moduleCount: moduleIds.length,
    claudeLhcClient: packages.some(({ pkg }) => pkg?.name === "claude-lhc"),
    sidecarOnly: packages.flatMap(({ moduleId, pkg }) => {
      const rule = pkg === undefined ? undefined : SIDECAR_ONLY.find((r) => r.matches(pkg));
      return rule === undefined ? [] : [`${rule.label}: ${moduleId}`];
    }),
  };
}

export class BundledModulesError extends Schema.TaggedError<BundledModulesError>()(
  "BundledModulesError",
  { message: Schema.String },
) {}

const decodeModuleList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

/** Reads the module list the executable build wrote and fails on any sidecar-only module. */
export const checkBundledModules = Effect.fn("checkBundledModules")(function* (listPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const moduleIds = yield* fs.readFileString(listPath).pipe(
    Effect.mapError(() => new BundledModulesError({ message: `No module list at ${listPath}.` })),
    Effect.flatMap(decodeModuleList),
    Effect.mapError((error) =>
      error._tag === "BundledModulesError"
        ? error
        : new BundledModulesError({ message: `${listPath} is not a JSON array of module ids.` }),
    ),
  );
  if (moduleIds.length === 0) {
    return yield* new BundledModulesError({ message: `The module list at ${listPath} is empty.` });
  }
  const report = inspectBundledModules(moduleIds);
  if (report.sidecarOnly.length > 0) {
    return yield* new BundledModulesError({
      message: `The executable bundles modules that only claude-lhc's sidecar may load:\n${report.sidecarOnly.join("\n")}`,
    });
  }
  return report;
});
