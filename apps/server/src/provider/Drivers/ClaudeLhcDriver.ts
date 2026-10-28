import { CLAUDE_LHC_DRIVER_KIND, ClaudeLhcSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { makeClaudeDriver } from "./ClaudeDriver.ts";
import {
  makeClaudeLhcCreateQuery,
  resolveClaudeLhcSidecar,
  sidecarHonorsRollback,
} from "./ClaudeLhcSidecar.ts";

const STOCK_CONTINUATION_PREFIX = "claude:";

/** An LHC thread never continues natively on a stock instance that shares its Claude home. */
export const claudeLhcContinuationGroupKey = (stockKey: string): string =>
  `claude-lhc:${stockKey.startsWith(STOCK_CONTINUATION_PREFIX) ? stockKey.slice(STOCK_CONTINUATION_PREFIX.length) : stockKey}`;

export const CLAUDE_LHC_FORK_REFUSAL =
  "Claude LHC threads can't be forked: a fork would copy the native transcript, not the LHC view. Start a new thread instead.";

const decodeClaudeLhcSettings = Schema.decodeSync(ClaudeLhcSettings);

export const ClaudeLhcDriver = makeClaudeDriver({
  driverKind: CLAUDE_LHC_DRIVER_KIND,
  displayName: "Claude LHC",
  configSchema: ClaudeLhcSettings,
  defaultConfig: () => decodeClaudeLhcSettings({}),
  continuationGroupKey: claudeLhcContinuationGroupKey,
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
      forkRefusal: CLAUDE_LHC_FORK_REFUSAL,
      canRollback: sidecarHonorsRollback(sidecar.launch.version),
    };
  },
});
