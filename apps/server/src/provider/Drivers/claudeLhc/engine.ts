import type {
  ClaudeSettings,
  OrchestrationV2EngineCompactPolicy,
  OrchestrationV2ProviderCapabilities,
  ServerProviderState,
} from "@t3tools/contracts";
import type { ProviderEngineBindingTemplate } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  makeClaudeAgentSdkQueryRunner,
  type ClaudeAgentSdkQueryRunnerShape,
} from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { resolveClaudeSdkExecutablePath } from "../ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "../ClaudeHome.ts";
import { makeClaudeLhcInstance } from "./instance.ts";
import { ClaudeLhcRuntimeProblem, resolveClaudeLhcRuntime } from "./runtime.ts";
import { makeClaudeLhcSeam } from "./seam.ts";

export type ClaudeEngine =
  | { readonly engine: "claude" }
  | { readonly engine: "claude-lhc"; readonly compact: OrchestrationV2EngineCompactPolicy }
  | { readonly engine: "claude-lhc"; readonly compact: null; readonly problem: string };

export type ClaudeLhcEngine = Extract<ClaudeEngine, { readonly engine: "claude-lhc" }>;

type ClaudeEngineSettings = Pick<
  ClaudeSettings,
  "contextEngine" | "lhcCompactTrigger" | "lhcCompactTarget"
>;

const TOKEN_COUNT = /^[1-9]\d*$/;

const FIELD_TITLES = {
  trigger: "LHC compact trigger",
  target: "LHC compact target",
} as const;

type TokenField =
  | { readonly tokens: number }
  | { readonly missing: true }
  | { readonly invalid: string };

function readTokenField(raw: string | undefined): TokenField {
  const value = raw?.trim() ?? "";
  if (value.length === 0) return { missing: true };
  const tokens = Number(value);
  return TOKEN_COUNT.test(value) && Number.isSafeInteger(tokens) ? { tokens } : { invalid: value };
}

export function parseClaudeEngine(config: ClaudeEngineSettings): ClaudeEngine {
  if (config.contextEngine === "claude") return { engine: "claude" };
  const fields = {
    trigger: readTokenField(config.lhcCompactTrigger),
    target: readTokenField(config.lhcCompactTarget),
  };
  const missing = (["trigger", "target"] as const).filter((key) => "missing" in fields[key]);
  const problems: Array<string> = [];
  if (missing.length > 0) {
    problems.push(
      `Set ${missing.map((key) => FIELD_TITLES[key]).join(" and ")} to run LHC threads.`,
    );
  }
  for (const key of ["trigger", "target"] as const) {
    const field = fields[key];
    if ("invalid" in field) {
      problems.push(
        `${FIELD_TITLES[key]} must be a whole number of tokens, not "${field.invalid}".`,
      );
    }
  }
  if ("tokens" in fields.trigger && "tokens" in fields.target) {
    const compact = { trigger: fields.trigger.tokens, target: fields.target.tokens };
    if (compact.target < compact.trigger) return { engine: "claude-lhc", compact };
    problems.push(
      `${FIELD_TITLES.target} (${compact.target}) must be below ${FIELD_TITLES.trigger} (${compact.trigger}).`,
    );
  }
  return { engine: "claude-lhc", compact: null, problem: problems.join(" ") };
}

export interface ClaudeLhcEngineInput {
  readonly engine: ClaudeLhcEngine;
  readonly config: Pick<ClaudeSettings, "binaryPath" | "homePath">;
  /** The instance's environment, which also carries the runtime overrides. */
  readonly processEnv: NodeJS.ProcessEnv;
  readonly continuationKey: string;
  readonly claudeHome: string;
  readonly stateDir: string;
}

export interface ClaudeLhcEngineParts {
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly engineBinding: ProviderEngineBindingTemplate;
  readonly queryRunner: ClaudeAgentSdkQueryRunnerShape;
  /** Why the instance cannot run LHC threads. Its status shows it and its opens fail with it. */
  readonly problem: string | undefined;
}

export const makeClaudeLhcEngine = Effect.fn("makeClaudeLhcEngine")(function* (
  input: ClaudeLhcEngineInput,
) {
  const environment = yield* makeClaudeEnvironment(input.config, input.processEnv);
  const runtime = yield* Effect.result(resolveClaudeLhcRuntime(environment));
  const problem =
    "problem" in input.engine
      ? input.engine.problem
      : Result.isFailure(runtime)
        ? runtime.failure.message
        : undefined;
  const instance = makeClaudeLhcInstance({
    continuationKey: input.continuationKey,
    claudeHome: input.claudeHome,
    compact: input.engine.compact,
  });
  const seam = yield* makeClaudeLhcSeam({
    runtime:
      problem === undefined
        ? runtime
        : Result.fail(new ClaudeLhcRuntimeProblem({ detail: problem })),
    stateDir: input.stateDir,
    environment,
    binaryPath: yield* resolveClaudeSdkExecutablePath(input.config.binaryPath, environment),
  });
  return {
    capabilities: instance.capabilities,
    engineBinding: instance.engineBinding,
    queryRunner: yield* makeClaudeAgentSdkQueryRunner(seam),
    problem,
  } satisfies ClaudeLhcEngineParts;
});

/** A disabled instance keeps its disabled status. */
export function reportClaudeLhcProblem<
  Provider extends { readonly enabled: boolean; readonly status: ServerProviderState },
>(provider: Provider, problem: string | undefined): Provider {
  return problem === undefined || !provider.enabled
    ? provider
    : { ...provider, status: "error", message: problem };
}
