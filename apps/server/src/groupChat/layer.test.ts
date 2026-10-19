import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { GroupChatUnavailable } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { GroupChat, layer as groupChatLayer } from "./layer.ts";

it.layer(NodeServices.layer)("group chat module", (it) => {
  it.effect("T3CODE_GROUP_CHAT=off opens no store and answers disabled", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-group-chat-off-" });
      const failure = yield* Effect.flatMap(Effect.service(GroupChat), (groupChat) =>
        Effect.flip(groupChat.store),
      ).pipe(
        Effect.provide(
          groupChatLayer.pipe(
            Layer.provide(Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir))),
            Layer.provide(
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_GROUP_CHAT: "off" } })),
            ),
          ),
        ),
      );
      assert.deepStrictEqual(failure, new GroupChatUnavailable({ reason: "disabled" }));
      assert.isFalse(yield* fileSystem.exists(path.join(baseDir, "userdata", "group-chat")));
    }).pipe(Effect.scoped),
  );
});
