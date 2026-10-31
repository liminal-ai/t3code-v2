import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const RULE = "t3code/claude-engine-binding-accessor";
const adapter = createOxlintRuleHarness(RULE, {
  filename: "apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts",
});
const otherFile = createOxlintRuleHarness(RULE, {
  filename: "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts",
});

const IMPORTS = `
  import {
    checkClaudeEngineBinding,
    rowEngineBinding,
    stampEngineBinding,
  } from "../../provider/Drivers/claudeLhc/binding.ts";
  import * as Traits from "../../provider/Drivers/claudeLhc/traits.ts";
`;

describe(RULE, () => {
  adapter.valid(
    "allows the seed and the template passed straight to an accessor, declarations and keys",
    `${IMPORTS}
      interface ClaudeAdapterV2Options {
        readonly engineBinding?: unknown;
      }
      type Hooks = Pick<ClaudeAdapterV2Options, "engineBinding">;
      export const run = (adapterOptions: ClaudeAdapterV2Options, threadInput: any, row: any) => [
        stampEngineBinding(threadInput.engineBinding, adapterOptions.instanceId),
        checkClaudeEngineBinding(row, adapterOptions?.engineBinding, adapterOptions.instanceId),
        checkClaudeEngineBinding(row, (adapterOptions.engineBinding as any), "instance"),
        Traits.claudeThreadTraits(threadInput["engineBinding"], { nativeThreadId: "n" }),
        { appThreadId: row.appThreadId, engineBinding: rowEngineBinding(row) },
      ];
    `,
  );

  adapter.invalid(
    "reports a row's binding read directly",
    `${IMPORTS}
      export const binding = (row: any) => row.nativeMetadata?.engineBinding ?? null;
    `,
    (output) => {
      assert.match(
        output,
        /through rowEngineBinding, copyEngineBinding or checkClaudeEngineBinding/,
      );
    },
  );

  adapter.invalid(
    "reports a string-key read",
    `${IMPORTS}
      export const binding = (row: any) => row.nativeMetadata["engineBinding"];
    `,
  );

  adapter.invalid(
    "reports a template-literal key read",
    `${IMPORTS}
      export const binding = (row: any) => row.nativeMetadata[\`engineBinding\`];
    `,
  );

  adapter.invalid(
    "reports the template stored in a local",
    `${IMPORTS}
      export const run = (adapterOptions: any, row: any) => {
        const template = adapterOptions.engineBinding;
        return checkClaudeEngineBinding(row, template, adapterOptions.instanceId);
      };
    `,
  );

  adapter.invalid(
    "reports a read passed to a function that is not an accessor",
    `${IMPORTS}
      const keyOf = (binding: any) => binding?.continuationKey;
      export const key = (row: any) => keyOf(row.nativeMetadata?.engineBinding);
    `,
  );

  adapter.invalid(
    "reports a destructured binding",
    `${IMPORTS}
      export const binding = (row: any) => {
        const { engineBinding } = row.nativeMetadata ?? {};
        return engineBinding;
      };
    `,
  );

  otherFile.valid(
    "leaves the same reads alone in another file",
    `
      export const binding = (row: any, adapterOptions: any) => [
        row.nativeMetadata?.engineBinding,
        row.nativeMetadata["engineBinding"],
        adapterOptions.engineBinding,
      ];
    `,
  );
});
