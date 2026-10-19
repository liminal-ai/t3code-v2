import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the cap test needs a request whose body never ends.
import * as NodeHttp from "node:http";
import {
  EnvironmentHttpApi,
  type GroupChatGroupId,
  type GroupChatMemberId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { withUntracedRequests } from "../http.ts";
import * as Hooks from "./hooks.ts";
import * as Reach from "./reach.ts";
import { type App, boot, FAKE_ORIGIN, makeFakeThreads, tempBaseDir } from "./testkit.ts";
import { sign } from "./transports/webhook.ts";

class HooksApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.groupChatHooks) {}

const alpha = ThreadId.make("alpha");

const setup = Effect.gen(function* () {
  const fake = yield* makeFakeThreads;
  const app = yield* boot(fake, yield* tempBaseDir);
  const created = yield* app.dispatch({ _tag: "group.create", title: "Crew", threadIds: [alpha] });
  const group = created._tag === "group" ? created.group : assert.fail("group");
  const external = (secret: string) =>
    Effect.gen(function* () {
      const added = yield* app.dispatch({
        _tag: "member.addExternal",
        groupId: group.id,
        handle: "",
        kind: "webhook",
        config: {
          url: "http://127.0.0.1:1/inbox",
          headers: {},
          bodyTemplate: "",
          replyPath: "",
          secret,
          callbackOrigin: "",
        },
      });
      const member = added._tag === "member" ? added.member : assert.fail("member");
      const row = (yield* app.store.member(member.id))!;
      return { id: member.id, token: row.external!.inboundToken, secret };
    });
  return { app, group, external };
});

const inboundPath = (memberId: GroupChatMemberId, token: string) =>
  `/api/hooks/group-chat/inbound/${memberId}?token=${encodeURIComponent(token)}`;

const serveOnNodeSocket = (app: App, exposed: boolean) =>
  Effect.gen(function* () {
    const groupChat = { store: Effect.succeed(app.store), engine: Effect.succeed(app.engine) };
    const services = yield* Layer.build(
      withUntracedRequests(
        HttpRouter.serve(
          HttpApiBuilder.layer(HooksApi).pipe(
            Layer.provide(Hooks.makeLayer(groupChat)),
            Layer.provide(Reach.layerFixed({ exposed, origin: FAKE_ORIGIN })),
          ),
          { disableListenLog: true },
        ),
      ).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
    );
    const client = Context.get(services, HttpClient.HttpClient);
    const address = Context.get(services, HttpServer.HttpServer).address;
    const port = "port" in address ? address.port : assert.fail("a TCP port");
    const post = (path: string, body: string, headers: Record<string, string> = {}) =>
      client.execute(
        HttpClientRequest.post(path).pipe(
          HttpClientRequest.setHeaders(headers),
          HttpClientRequest.bodyText(body, "application/json"),
        ),
      );
    return { client, port, post };
  });

const signed = (secret: string, body: string) => ({ "x-signature": sign(secret, body) });

const messageCount = (app: App, groupId: GroupChatGroupId) =>
  Effect.map(app.store.messages(groupId), (rows) => rows.length);

it.live("a body over 1 MB gets 413 before it is buffered", () =>
  Effect.gen(function* () {
    const { app, group, external } = yield* setup;
    const member = yield* external("s3cret");
    const { port, post } = yield* serveOnNodeSocket(app, false);
    const path = inboundPath(member.id, member.token);

    const declared = yield* post(path, JSON.stringify({ text: "x".repeat(1_000_001) }));
    assert.strictEqual(declared.status, 413);

    const status = yield* Effect.callback<number>((resume) => {
      const request = NodeHttp.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path,
          headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
        },
        (response) => {
          resume(Effect.succeed(response.statusCode ?? 0));
          response.resume();
          request.destroy();
        },
      );
      request.on("error", () => undefined);
      const chunk = Buffer.alloc(64 * 1024, 0x78);
      let written = 0;
      const pump = () => {
        while (written < 1_000_001) {
          const size = Math.min(chunk.length, 1_000_001 - written);
          written += size;
          if (!request.write(chunk.subarray(0, size))) {
            request.once("drain", pump);
            return;
          }
        }
      };
      pump();
    }).pipe(Effect.timeout("10 seconds"));
    assert.strictEqual(status, 413);
    assert.strictEqual(yield* messageCount(app, group.id), 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a wrong token is refused and the group gains no message", () =>
  Effect.gen(function* () {
    const { app, group, external } = yield* setup;
    const member = yield* external("s3cret");
    const { post } = yield* serveOnNodeSocket(app, false);
    const body = JSON.stringify({ text: "hello" });
    const wrong = yield* post(
      inboundPath(member.id, `${member.token}x`),
      body,
      signed("s3cret", body),
    );
    assert.strictEqual(wrong.status, 404);
    const unknown = yield* post(
      inboundPath("mem_nobody" as GroupChatMemberId, member.token),
      body,
      signed("s3cret", body),
    );
    assert.strictEqual(unknown.status, 404);
    assert.strictEqual(yield* messageCount(app, group.id), 0);
    const right = yield* post(inboundPath(member.id, member.token), body, signed("s3cret", body));
    assert.strictEqual(right.status, 200);
    assert.strictEqual(yield* messageCount(app, group.id), 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("the rate limit answers 429", () =>
  Effect.gen(function* () {
    const { app, group, external } = yield* setup;
    const member = yield* external("s3cret");
    const { post } = yield* serveOnNodeSocket(app, false);
    const body = JSON.stringify({ text: "burst" });
    const statuses = yield* Effect.forEach(
      Array.from({ length: Hooks.HOOK_RATE_LIMIT.capacity + 1 }),
      () =>
        Effect.map(
          post(inboundPath(member.id, member.token), body, signed("s3cret", body)),
          (response) => response.status,
        ),
    );
    assert.strictEqual(statuses.filter((s) => s === 200).length, Hooks.HOOK_RATE_LIMIT.capacity);
    assert.strictEqual(statuses.at(-1), 429);
    assert.strictEqual(yield* messageCount(app, group.id), Hooks.HOOK_RATE_LIMIT.capacity);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("an unsigned post is refused when signatures are required", () =>
  Effect.gen(function* () {
    const { app, group, external } = yield* setup;
    const open = yield* external("");
    const body = JSON.stringify({ text: "hello" });
    const exposed = yield* serveOnNodeSocket(app, true);
    const refused = yield* exposed.post(inboundPath(open.id, open.token), body);
    assert.strictEqual(refused.status, 401);
    assert.deepStrictEqual(JSON.parse(yield* refused.text), { error: "signature_required" });
    assert.strictEqual(yield* messageCount(app, group.id), 0);

    const loopback = yield* serveOnNodeSocket(app, false);
    const accepted = yield* loopback.post(inboundPath(open.id, open.token), body);
    assert.strictEqual(accepted.status, 200);

    const locked = yield* external("s3cret");
    const badSignature = yield* loopback.post(
      inboundPath(locked.id, locked.token),
      body,
      signed("other", body),
    );
    assert.strictEqual(badSignature.status, 401);
    assert.deepStrictEqual(JSON.parse(yield* badSignature.text), { error: "invalid_signature" });
    assert.strictEqual(yield* messageCount(app, group.id), 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a logged path carries no token", () => {
  const logs: Array<string> = [];
  const spans: Array<Tracer.NativeSpan> = [];
  const logger = Logger.make(({ fiber, message }) => {
    logs.push(
      JSON.stringify({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) }),
    );
  });
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return Effect.gen(function* () {
    const { app, external } = yield* setup;
    const member = yield* external("s3cret");
    const { post } = yield* serveOnNodeSocket(app, false);
    const body = JSON.stringify({ text: "hello" });
    const response = yield* post(
      inboundPath(member.id, member.token),
      body,
      signed("s3cret", body),
    );
    assert.strictEqual(response.status, 200);
    const recorded = [
      ...logs,
      ...spans.flatMap((span) =>
        span.kind === "client" ? [] : [span.name, ...[...span.attributes.values()].map(String)],
      ),
    ];
    assert.isTrue(
      recorded.some((entry) => entry.includes("/api/hooks/group-chat/inbound/")),
      "the request was logged",
    );
    assert.isFalse(
      spans.some((span) => span.kind === "server"),
      "a hook request gets no server span, like the scheduled-task webhooks",
    );
    assert.isFalse(
      recorded.some((entry) => entry.includes(member.token)),
      `the token leaked: ${recorded.find((entry) => entry.includes(member.token))}`,
    );
  }).pipe(
    Effect.scoped,
    Effect.provideService(Tracer.Tracer, tracer),
    Effect.provide(
      Layer.merge(Logger.layer([logger], { mergeWithExisting: false }), NodeServices.layer),
    ),
  );
});
