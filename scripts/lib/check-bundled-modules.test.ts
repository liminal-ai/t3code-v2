import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { CLAUDE_LHC_AGENT_SDK, checkBundledModules } from "./check-bundled-modules.ts";

const store = "/repo/node_modules/.pnpm";
const claudeLhc = `${store}/claude-lhc@file+vendor+claude-lhc+claude-lhc-0.2.0.tgz_supports-color@8.1.1/node_modules/claude-lhc`;
const STOCK = [
  "/repo/apps/server/src/bin.ts",
  "/repo/apps/server/src/provider/Drivers/claudeLhc/client.ts",
  `${store}/effect@4.0.5/node_modules/effect/dist/Effect.js`,
  `${store}/@anthropic-ai+claude-agent-sdk@0.3.276_@anthropic-ai+sdk@0.93.0_zod@4.6.5__@modelcontex_cd977b8afd2dcf6d293e7605bbafda97/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`,
];

const check = Effect.fn(function* (moduleIds: ReadonlyArray<string> | undefined) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const list = path.join(yield* fs.makeTempDirectoryScoped(), "modules.json");
  if (moduleIds !== undefined) yield* fs.writeFileString(list, JSON.stringify(moduleIds));
  return yield* checkBundledModules(list).pipe(
    Effect.map((report) => ({ ok: true as const, report })),
    Effect.catchTags({
      BundledModulesError: (error) =>
        Effect.succeed({ ok: false as const, message: error.message }),
    }),
  );
}, Effect.scoped);

describe("checkBundledModules", () => {
  it.effect("fails on a module from lhc", () =>
    Effect.gen(function* () {
      const result = yield* check([...STOCK, `${claudeLhc}/node_modules/lhc/dist/index.js`]);
      expect(result).toEqual({
        ok: false,
        message: `The executable bundles modules that only claude-lhc's sidecar may load:\nlhc: ${claudeLhc}/node_modules/lhc/dist/index.js`,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails on Effect 3, js-tiktoken, and claude-lhc's Agent SDK", () =>
    Effect.gen(function* () {
      const result = yield* check([
        ...STOCK,
        `${store}/effect@3.22.4/node_modules/effect/dist/esm/Schema.js`,
        `${store}/js-tiktoken@1.0.21/node_modules/js-tiktoken/dist/lite.js`,
        `${store}/@anthropic-ai+claude-agent-sdk@${CLAUDE_LHC_AGENT_SDK}_zod@4.4.3/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`,
      ]);
      expect(result.ok).toBe(false);
      expect(
        result.ok
          ? []
          : result.message
              .split("\n")
              .slice(1)
              .map((l) => l.split(":")[0]),
      ).toEqual(["Effect 3", "js-tiktoken", `Agent SDK ${CLAUDE_LHC_AGENT_SDK}`]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("passes a bundle that only names lhc in its own paths, and reports the client", () =>
    Effect.gen(function* () {
      expect(yield* check(STOCK)).toEqual({
        ok: true,
        report: { moduleCount: 4, claudeLhcClient: false, sidecarOnly: [] },
      });
      expect(yield* check([...STOCK, `${claudeLhc}/dist/client/index.js`])).toEqual({
        ok: true,
        report: { moduleCount: 5, claudeLhcClient: true, sidecarOnly: [] },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails on a missing or empty list", () =>
    Effect.gen(function* () {
      const missing = yield* check(undefined);
      const empty = yield* check([]);
      expect(missing.ok ? "" : missing.message).toMatch(/^No module list at .*modules\.json\.$/);
      expect(empty.ok ? "" : empty.message).toMatch(
        /^The module list at .*modules\.json is empty\.$/,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("names the Agent SDK the vendored claude-lhc depends on", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const manifest = path.join(
        yield* path.fromFileUrl(new URL("../..", import.meta.url)),
        "apps/server/node_modules/claude-lhc/package.json",
      );
      const { dependencies } = JSON.parse(yield* fs.readFileString(manifest));
      expect(dependencies["@anthropic-ai/claude-agent-sdk"]).toBe(CLAUDE_LHC_AGENT_SDK);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
