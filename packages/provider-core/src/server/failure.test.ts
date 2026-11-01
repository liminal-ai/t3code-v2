import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
  MAX_PROVIDER_FAILURE_MESSAGE_LENGTH,
  ContextHandoffBudgetError,
  ContextHandoffBackgroundWorkError,
} from "./failure.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

it("redacts credentials and URL secrets from provider failures", () => {
  const failure = makeProviderFailure({
    message:
      'request failed: Authorization: Bearer bearer-secret https://user:pass@example.test/path?access_token=url-secret#fragment {"token":"json-secret"} api_key=key-secret sk-abcdefghijklmnop',
    code: "provider_rejected",
    class: "provider_error",
  });

  assert.equal(failure.class, "provider_error");
  assert.equal(failure.code, "provider_rejected");
  assert.include(failure.message, "[REDACTED]");
  assert.include(failure.message, "https://example.test/path");
  assert.notInclude(failure.message, "bearer-secret");
  assert.notInclude(failure.message, "user:pass");
  assert.notInclude(failure.message, "url-secret");
  assert.notInclude(failure.message, "json-secret");
  assert.notInclude(failure.message, "key-secret");
  assert.notInclude(failure.message, "sk-abcdefghijklmnop");
});

it("does not split a surrogate pair at the truncation boundary", () => {
  const failure = makeProviderFailure({
    message: `${"a".repeat(MAX_PROVIDER_FAILURE_MESSAGE_LENGTH - 2)}🚀tail`,
  });

  assert.equal(failure.message.length, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH - 1);
  assert.equal(failure.message.at(-1), "…");
  assert.notMatch(failure.message.slice(0, -1), /[\uD800-\uDBFF]$/u);
});

it("does not expose arbitrary cause messages and preserves explicit messages", () => {
  const cause = new Error("Adapter failed", {
    cause: new Error("Session expired. Sign in again."),
  });
  for (const value of [
    cause,
    Cause.fail(cause),
    "Session expired. Sign in again.",
    { message: "Session expired. Sign in again." },
  ]) {
    assert.equal(makeProviderFailure({ cause: value }).message, "Provider turn failed.");
    assert.equal(
      makeProviderFailure({ cause: value, message: "Provider connection closed." }).message,
      "Provider connection closed.",
    );
  }
});

it("preserves actionable handoff errors wrapped by turn startup", () => {
  for (const error of [new ContextHandoffBudgetError(), new ContextHandoffBackgroundWorkError()]) {
    const cause = new ProviderAdapter.ProviderAdapterTurnStartError({
      driver: ProviderDriverKind.make("codex"),
      threadId: ThreadId.make("thread:handoff-error"),
      providerThreadId: ProviderThreadId.make("provider-thread:handoff-error"),
      runId: RunId.make("run:handoff-error"),
      cause: error,
    });
    assert.equal(makeProviderFailure({ cause: Cause.fail(cause) }).message, error.message);
  }
});

it("shows why Claude LHC could not open the query", () => {
  for (const [tag, reason] of [
    ["ClaudeLhcRuntimeProblem", "claude-lhc sidecar not found at /opt/t3/lhc-runtime/sidecar.js."],
    [
      "ClaudeLhcOpenRefusedError",
      "Claude LHC cannot open thread thread:lhc, because its engine binding has no compact policy.",
    ],
  ] as const) {
    const cause = new ProviderAdapter.ProviderAdapterTurnStartError({
      driver: ProviderDriverKind.make("claudeAgent"),
      threadId: ThreadId.make("thread:lhc"),
      providerThreadId: ProviderThreadId.make("provider-thread:lhc"),
      runId: RunId.make("run:lhc"),
      cause: {
        _tag: "ClaudeQueryOpenError",
        message: "Claude Agent SDK query failed.",
        cause: {
          _tag: "ClaudeAgentSdkQueryRunnerError",
          method: "query",
          message: "Claude Agent SDK query failed.",
          cause: { _tag: tag, message: reason },
        },
      },
    });
    assert.equal(makeProviderFailure({ cause: Cause.fail(cause) }).message, reason);
  }
});

it("explains each continuation mismatch without ids, keys or homes", () => {
  const lhcKey = "claude-lhc:home:/home/lee/.claude%3Alhc";
  for (const [rowContinuationKey, instanceContinuationKey, says] of [
    [
      lhcKey,
      null,
      'This thread uses long-horizon context, but its Claude instance "claude-a" now runs as Claude Code.',
    ],
    [
      lhcKey,
      "claude-lhc:home:/home/lee/other",
      'its Claude instance "claude-a" now uses a different Claude home.',
    ],
    [
      null,
      lhcKey,
      'This thread runs on Claude Code, but its Claude instance "claude-a" now runs long-horizon context.',
    ],
  ] as const) {
    const cause = new ProviderAdapter.ProviderAdapterEnsureThreadError({
      driver: ProviderDriverKind.make("claudeAgent"),
      threadId: ThreadId.make("thread:lhc"),
      cause: new ProviderAdapter.ProviderAdapterContinuationMismatchError({
        driver: ProviderDriverKind.make("claudeAgent"),
        providerThreadId: ProviderThreadId.make("provider-thread:lhc%3Arun"),
        providerInstanceId: ProviderInstanceId.make("claude-a"),
        rowContinuationKey,
        instanceContinuationKey,
      }),
    });
    const { message } = makeProviderFailure({ cause: Cause.fail(cause) });
    assert.include(message, says);
    assert.include(message, "T3 Code won't continue it there, so its history is unchanged.");
    for (const internal of ["provider-thread", "/", ":home:", "%3A"]) {
      assert.notInclude(message, internal);
    }
  }
});

it("keeps unrecognized reasons and provider text out of category messages", () => {
  for (const cause of [
    "Private launch command",
    { _tag: "ProviderAdapterProtocolError", detail: "Pi model 'private-config' is invalid" },
    { _tag: "ProviderAdapterProtocolError", reason: "private-config" },
    { _tag: "ProviderAdapterProtocolError", reason: "constructor" },
    { _tag: "constructor", cause: "private-config" },
  ]) {
    assert.equal(
      makeProviderFailure({ cause: { _tag: "ProviderAdapterTurnStartError", cause } }).message,
      "The provider could not start this turn. Retry the turn; if it keeps failing, check the provider setup and server logs.",
    );
  }
  assert.equal(
    makeProviderFailure({
      cause: { _tag: "ProviderAdapterProtocolError", reason: "previous_turn_active" },
    }).message,
    "Provider turn failed.",
  );
});

it("uses the innermost category without carrying an outer reason into it", () => {
  assert.equal(
    makeProviderFailure({
      cause: {
        _tag: "ProviderAdapterTurnStartError",
        cause: {
          _tag: "ProviderAdapterProtocolError",
          reason: "previous_turn_active",
          cause: Cause.fail({ _tag: "ProviderAdapterOpenSessionError" }),
        },
      },
    }).message,
    "The provider session could not be opened. Check that the provider is installed and signed in, then retry the turn.",
  );
});

it("does not expose defect text nested inside a known error category", () => {
  const failure = makeProviderFailure({
    cause: {
      _tag: "ProviderAdapterEventStreamError",
      cause: new Error(
        `Session rejected: Bearer nested-secret https://user:pass@example.test/path?token=secret ${"x".repeat(5000)}`,
      ),
    },
  });
  assert.include(failure.message, "provider event stream closed unexpectedly");
  assert.notInclude(failure.message, "Session rejected:");
  assert.notInclude(failure.message, "nested-secret");
  assert.notInclude(failure.message, "user:pass");
  assert.notInclude(failure.message, "token=secret");
  assert.isBelow(failure.message.length, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
});

it("handles cyclic causes and throwing accessors", () => {
  const cyclic: { message: string; cause?: unknown } = {
    message: "Provider disconnected. Retry the turn.",
  };
  cyclic.cause = cyclic;
  assert.equal(makeProviderFailure({ cause: cyclic }).message, "Provider turn failed.");
  assert.equal(
    makeProviderFailure({
      cause: {
        get message() {
          throw new Error("unreadable");
        },
        get cause() {
          throw new Error("unreadable");
        },
      },
    }).message,
    "Provider turn failed.",
  );
});

it("does not serialize arbitrary provider causes", () => {
  const failure = makeProviderFailure({
    cause: {
      payload: { authorization: "Bearer nested-secret" },
      stack: "private provider stack",
    },
    class: "transport_error",
  });

  assert.deepEqual(failure, {
    class: "transport_error",
    message: "Provider turn failed.",
    code: null,
    retryable: null,
  });
});

it.effect("keys terminal failure items by provider turn across retries and fallback paths", () =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const driver = ProviderDriverKind.make("codex");
    const runId = RunId.make("run:provider-failure-id");
    const base = {
      idAllocator,
      driver,
      threadId: ThreadId.make("thread:provider-failure-id"),
      runId,
      nodeId: NodeId.make("node:provider-failure-id"),
      providerThreadId: ProviderThreadId.make("provider-thread:provider-failure-id"),
      itemOrdinal: 101,
      failure: makeProviderFailure({ message: "Provider failed" }),
      occurredAt: DateTime.makeUnsafe("2026-06-22T12:00:00.000Z"),
    } as const;
    const firstTurnId = ProviderTurnId.make("provider-turn:provider-failure-id:first");
    const secondTurnId = ProviderTurnId.make("provider-turn:provider-failure-id:second");

    const firstAttempt = makeProviderFailureTurnItem({
      ...base,
      providerTurnId: firstTurnId,
    });
    const retriedAttempt = makeProviderFailureTurnItem({
      ...base,
      providerTurnId: secondTurnId,
    });
    const ingestorFallback = makeProviderFailureTurnItem({
      ...base,
      runId: null,
      nodeId: null,
      providerTurnId: firstTurnId,
    });

    assert.notEqual(firstAttempt.id, retriedAttempt.id);
    assert.equal(firstAttempt.id, ingestorFallback.id);
    assert.equal(firstAttempt.ordinal, 101);
  }).pipe(Effect.provide(IdAllocator.layer)),
);
