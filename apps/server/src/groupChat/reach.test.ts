import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { GroupChatReach, isRemoteOrigin, layer } from "./reach.ts";

const exposedWith = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-group-chat-reach-" });
    const base = Context.get(
      yield* Layer.build(ServerConfig.layerTest(process.cwd(), baseDir)),
      ServerConfig.ServerConfig,
    );
    const reach = Context.get(
      yield* Layer.build(
        layer.pipe(Layer.provide(ServerConfig.layer({ ...base, host: "127.0.0.1", ...overrides }))),
      ),
      GroupChatReach,
    );
    return yield* reach.exposed;
  }).pipe(Effect.scoped);

it.layer(NodeServices.layer)("group chat reach", (it) => {
  it.effect("a loopback server with no link and no Tailscale Serve is not exposed", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* exposedWith({}));
    }),
  );

  it.effect("Tailscale Serve in front of a loopback server counts as exposed", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* exposedWith({ tailscaleServeEnabled: true }));
    }),
  );

  it.effect("a non-loopback host counts as exposed", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* exposedWith({ host: "100.64.0.1" }));
    }),
  );

  it.effect("a callback origin on another machine is remote; loopback and junk are not", () =>
    Effect.sync(() => {
      assert.isTrue(isRemoteOrigin("https://agent.example"));
      assert.isTrue(isRemoteOrigin("http://100.64.0.2:8080"));
      assert.isFalse(isRemoteOrigin("http://127.0.0.1:14320"));
      assert.isFalse(isRemoteOrigin("http://localhost:1"));
      assert.isFalse(isRemoteOrigin("not a url"));
    }),
  );
});
