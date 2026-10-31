import {
  OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2EngineBinding,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  checkClaudeEngineBinding,
  copyEngineBinding,
  rowEngineBinding,
  stampEngineBinding,
  type ClaudeEngineBindingTemplate,
} from "./binding.ts";

const INSTANCE_ID = ProviderInstanceId.make("claude-lhc");

const BINDING = {
  providerInstanceId: INSTANCE_ID,
  engine: "claude-lhc",
  continuationKey: "claude-lhc:home:/lhc/home",
  claudeHome: "/lhc/home",
  compact: { trigger: 700_000, target: 140_000 },
  nativeContinuation: "required",
  compaction: "provider",
} satisfies OrchestrationV2EngineBinding;

const { providerInstanceId: _providerInstanceId, ...TEMPLATE } = BINDING;

const ROW = {
  id: ProviderThreadId.make("provider-thread-binding"),
  driver: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: INSTANCE_ID,
  providerSessionId: ProviderSessionId.make("provider-session-binding"),
  appThreadId: ThreadId.make("thread-binding"),
  ownerNodeId: null,
  nativeThreadRef: {
    driver: ProviderDriverKind.make("claudeAgent"),
    nativeId: "n",
    strength: "strong",
  },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: DateTime.makeUnsafe(0),
  updatedAt: DateTime.makeUnsafe(0),
} satisfies OrchestrationV2ProviderThread;

const bound = (engineBinding: OrchestrationV2EngineBinding): OrchestrationV2ProviderThread => ({
  ...ROW,
  nativeMetadata: { forkHeadMessageId: "msg-head", engineBinding },
});

const isMismatch = Schema.is(ProviderAdapter.ProviderAdapterContinuationMismatchError);

describe("claudeLhc binding", () => {
  it("reads a row's binding, or null for an unbound row and a row with no metadata", () => {
    assert.deepEqual(rowEngineBinding(bound(BINDING)), BINDING);
    assert.isNull(rowEngineBinding({ ...ROW, nativeMetadata: { forkHeadMessageId: "msg-head" } }));
    assert.isNull(rowEngineBinding(ROW));
  });

  it("stamps a seed only onto a row of the instance it names", () => {
    assert.deepEqual(stampEngineBinding(BINDING, INSTANCE_ID), {
      nativeMetadata: { engineBinding: BINDING },
    });
    assert.deepEqual(stampEngineBinding(BINDING, ProviderInstanceId.make("claude-other")), {});
    assert.deepEqual(stampEngineBinding(undefined, INSTANCE_ID), {});
  });

  it("copies the source row's binding beside the new row's own metadata", () => {
    assert.deepEqual(copyEngineBinding(bound(BINDING), { forkHeadMessageId: "msg-fork" }), {
      nativeMetadata: { forkHeadMessageId: "msg-fork", engineBinding: BINDING },
    });
    assert.deepEqual(copyEngineBinding(bound(BINDING)), {
      nativeMetadata: { engineBinding: BINDING },
    });
    assert.deepEqual(copyEngineBinding(ROW, { forkHeadMessageId: "msg-fork" }), {
      nativeMetadata: { forkHeadMessageId: "msg-fork" },
    });
    assert.deepEqual(copyEngineBinding(ROW), {});
  });

  describe("checkClaudeEngineBinding", () => {
    const check = (row: OrchestrationV2ProviderThread, template?: ClaudeEngineBindingTemplate) =>
      Effect.result(checkClaudeEngineBinding(row, template, INSTANCE_ID));

    it.effect(
      "passes a stock row on a stock instance and a bound row on its own engine and home",
      () =>
        Effect.gen(function* () {
          assert.equal((yield* check(ROW))._tag, "Success");
          assert.equal((yield* check(bound(BINDING), TEMPLATE))._tag, "Success");
        }),
    );

    it.effect(
      "passes a row whose compact pair, null or not, or instance id differs from the template",
      () =>
        Effect.gen(function* () {
          const passes = [
            yield* check(bound(BINDING), {
              ...TEMPLATE,
              compact: { trigger: 400_000, target: 80_000 },
            }),
            yield* check(bound(BINDING), { ...TEMPLATE, compact: null }),
            yield* check(bound({ ...BINDING, compact: null }), TEMPLATE),
            yield* check(
              bound({
                ...BINDING,
                providerInstanceId: ProviderInstanceId.make("claude-same-home"),
              }),
              TEMPLATE,
            ),
          ];
          assert.deepEqual(
            passes.map((result) => result._tag),
            ["Success", "Success", "Success", "Success"],
          );
        }),
    );

    it.effect.each([
      {
        name: "a bound row on a stock instance",
        row: bound(BINDING),
        template: undefined,
        rowContinuationKey: BINDING.continuationKey,
        instanceContinuationKey: null,
      },
      {
        name: "an unbound row on an LHC instance",
        row: ROW,
        template: TEMPLATE,
        rowContinuationKey: null,
        instanceContinuationKey: TEMPLATE.continuationKey,
      },
      {
        name: "a row bound to another Claude home",
        row: bound({
          ...BINDING,
          continuationKey: "claude-lhc:home:/lhc/other",
          claudeHome: "/lhc/other",
        }),
        template: TEMPLATE,
        rowContinuationKey: "claude-lhc:home:/lhc/other",
        instanceContinuationKey: TEMPLATE.continuationKey,
      },
    ])("refuses $name", ({ row, template, rowContinuationKey, instanceContinuationKey }) =>
      Effect.gen(function* () {
        const result = yield* check(row, template);
        assert.equal(result._tag, "Failure");
        if (result._tag !== "Failure") return;
        assert.isTrue(isMismatch(result.failure));
        assert.deepInclude(result.failure, {
          driver: ROW.driver,
          providerThreadId: ROW.id,
          providerInstanceId: INSTANCE_ID,
          rowContinuationKey,
          instanceContinuationKey,
        });
      }),
    );
  });
});
