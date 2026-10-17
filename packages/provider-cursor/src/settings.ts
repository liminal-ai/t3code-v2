import {
  CustomModelSetting,
  makeProviderSettingsSchema,
  TrimmedString,
  type ProviderSettingsFormOption,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const CURSOR_RUNTIMES = [
  { value: "local", label: "Local" },
  { value: "cloud", label: "Cursor Cloud" },
] as const satisfies ReadonlyArray<ProviderSettingsFormOption>;
export const CursorRuntime = Schema.Literals(CURSOR_RUNTIMES.map((runtime) => runtime.value));
export type CursorRuntime = typeof CursorRuntime.Type;

export const CursorSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    // Keep V1's CLI configuration when V2 rewrites the shared settings file.
    // V2's Cursor SDK does not use these fields.
    binaryPath: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    apiEndpoint: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    runtime: CursorRuntime.pipe(
      Schema.withDecodingDefault(Effect.succeed("local" as const)),
      Schema.annotateKey({
        title: "Runs on",
        description:
          "Cursor Cloud runs each thread on a Cursor VM that clones the project's GitHub repository. It cannot see this machine's files or T3 tools. Turn on \"Continue threads after restarts\" so T3 follows a cloud run across a restart; otherwise the run finishes on Cursor unseen.",
        providerSettingsForm: {
          control: "select",
          options: CURSOR_RUNTIMES,
          clearWhenEmpty: "omit",
        },
      }),
    ),
    cloudAutoCreatePR: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({
        title: "Open a pull request when a cloud run finishes",
        description: "Cursor Cloud only.",
        providerSettingsForm: { control: "switch", clearWhenEmpty: "omit" },
      }),
    ),
    cloudOpenAsCursorGithubApp: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "Open pull requests as the Cursor GitHub app",
        description: "Cursor Cloud only. Off opens them as the signed-in Cursor user.",
        providerSettingsForm: { control: "switch", clearWhenEmpty: "omit" },
      }),
    ),
  },
  {
    order: ["runtime", "cloudAutoCreatePR", "cloudOpenAsCursorGithubApp"],
  },
);
export type CursorSettings = typeof CursorSettings.Type;
