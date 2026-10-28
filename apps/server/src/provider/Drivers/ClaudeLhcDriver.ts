import { CLAUDE_LHC_DRIVER_KIND, ClaudeLhcSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { makeClaudeDriver } from "./ClaudeDriver.ts";
import { makeClaudeLhcCreateQuery, resolveClaudeLhcSidecar } from "./ClaudeLhcSidecar.ts";

export const CLAUDE_LHC_FORK_REFUSAL =
  "Claude LHC threads can't be forked: a fork would copy the native transcript, not the LHC view. Start a new thread instead.";

const decodeClaudeLhcSettings = Schema.decodeSync(ClaudeLhcSettings);

export const ClaudeLhcDriver = makeClaudeDriver({
  driverKind: CLAUDE_LHC_DRIVER_KIND,
  displayName: "Claude LHC",
  configSchema: ClaudeLhcSettings,
  defaultConfig: () => decodeClaudeLhcSettings({}),
  continuationKeyPrefix: CLAUDE_LHC_DRIVER_KIND,
  querySeam: ({ environment, baseDir, config }) => {
    const sidecar = resolveClaudeLhcSidecar(environment, baseDir);
    if (sidecar._tag === "unavailable") {
      return {
        createQuery: () => {
          throw new Error(sidecar.reason);
        },
        forkRefusal: CLAUDE_LHC_FORK_REFUSAL,
        canRollback: false,
        unavailableReason: sidecar.reason,
      };
    }
    return {
      createQuery: makeClaudeLhcCreateQuery({
        launch: sidecar.launch,
        windows: {
          autoCompactWindow: config.autoCompactWindow,
          lhcLowerBound: config.lhcLowerBound,
        },
        environment,
      }),
      program: { command: sidecar.launch.node, args: [sidecar.launch.entry] },
      forkRefusal: CLAUDE_LHC_FORK_REFUSAL,
    };
  },
});
