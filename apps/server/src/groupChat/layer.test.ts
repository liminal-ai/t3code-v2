import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  GroupChatUnavailable,
  MessageId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { GroupChat, layer as groupChatLayer } from "./layer.ts";
import * as Store from "./store.ts";
import { layerNeverPort } from "./testkit.ts";

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
            Layer.provide(layerNeverPort),
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

  it.effect("the layer builds while the thread port never settles", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-group-chat-never-" });
      const snapshot = yield* Effect.flatMap(Effect.service(GroupChat), (groupChat) =>
        Effect.flatMap(groupChat.engine, (engine) =>
          engine.start.pipe(Effect.andThen(engine.snapshot)),
        ),
      ).pipe(
        Effect.provide(
          groupChatLayer.pipe(
            Layer.provide(layerNeverPort),
            Layer.provide(Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir))),
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
          ),
        ),
      );
      assert.deepStrictEqual(snapshot, { groups: [], members: [] });
    }).pipe(Effect.scoped),
  );

  it.effect("a persisted running delivery is picked up at start without blocking it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-group-chat-persisted-",
      });
      const config = Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir));
      const { stateDir } = yield* Effect.service(ServerConfig.ServerConfig).pipe(
        Effect.provide(config),
      );
      // A server that was following a reply when it went down: the row says accepted and running.
      const seeded = yield* Effect.scoped(
        Effect.flatMap(Store.open(Store.storeFile(path, stateDir)), (store) =>
          store.transaction((tx) =>
            Effect.gen(function* () {
              const group = yield* tx.createGroup("persisted");
              const member = yield* tx.addMember({
                groupId: group.id,
                handle: "alpha",
                color: 0,
                source: {
                  _tag: "t3",
                  thread: {
                    environmentId: EnvironmentId.make("env"),
                    threadId: ThreadId.make("alpha"),
                    title: "Alpha",
                  },
                },
              });
              const message = yield* tx.appendMessage({
                groupId: group.id,
                author: { _tag: "operator" },
                kind: "chat",
                text: "hello",
                displayText: "hello",
                recipients: [member.id],
              });
              const delivery = yield* tx.insertDelivery({
                groupId: group.id,
                memberId: member.id,
                triggerMessageId: message.id,
                turnKey: message.turnKey,
                discussionId: null,
                round: null,
                toSeq: message.seq,
                wait: null,
              });
              yield* tx.updateDelivery(delivery.id, {
                dispatch: "accepted",
                state: "running",
                runId: RunId.make("run-1"),
                messageId: MessageId.make("message:group-chat:m:alpha:1"),
              });
              return { groupId: group.id, deliveryId: delivery.id };
            }),
          ),
        ),
      );
      const { snapshot, delivery } = yield* Effect.flatMap(Effect.service(GroupChat), (groupChat) =>
        Effect.gen(function* () {
          const engine = yield* groupChat.engine;
          yield* engine.start;
          const snapshot = yield* engine.snapshot;
          const store = yield* groupChat.store;
          return { snapshot, delivery: yield* store.delivery(seeded.deliveryId) };
        }),
      ).pipe(
        Effect.provide(
          groupChatLayer.pipe(
            Layer.provide(layerNeverPort),
            Layer.provide(config),
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
          ),
        ),
      );
      assert.strictEqual(snapshot.groups[0]?.id, seeded.groupId);
      assert.strictEqual(delivery?.state, "running", "the follow waits on the port, untouched");
    }).pipe(Effect.scoped),
  );
});
