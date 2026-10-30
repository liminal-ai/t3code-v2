import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomePath } from "./pathExpansion.ts";
import type { ProviderAdapterV2RuntimePolicy } from "./ProviderAdapter.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  return next;
});

/** Points the agent's `TMPDIR` at its project's `.pstack/tmp/` when the runtime policy names one. */
export function withProjectTmpDir<Env extends Readonly<Record<string, string | undefined>>>(
  environment: Env,
  runtimePolicy: Pick<ProviderAdapterV2RuntimePolicy, "projectTmpDir"> | undefined,
): Env {
  const projectTmpDir = runtimePolicy?.projectTmpDir;
  return projectTmpDir === undefined ? environment : { ...environment, TMPDIR: projectTmpDir };
}
