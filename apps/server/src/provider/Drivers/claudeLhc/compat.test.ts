import { describe, expect, it } from "@effect/vitest";

import { stockMessage } from "./compat.ts";

// The sidecar sends each SDK message as one JSON line, as these are.
const wire = (message: object) => stockMessage(JSON.parse(JSON.stringify(message)));

const USER = {
  type: "user",
  message: { role: "user", content: "inbox delivery" },
  parent_tool_use_id: null,
  session_id: "session",
  uuid: "0b9a8c1e-0000-4000-8000-000000000001",
};

const RESULT_ERROR = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  num_turns: 0,
  errors: ["startup refused"],
  session_id: "session",
  uuid: "0b9a8c1e-0000-4000-8000-000000000002",
};

describe("stockMessage", () => {
  it("keeps a session-inbox delivery a task notification and drops the subkind stock cannot name", () => {
    expect(
      wire({
        ...USER,
        origin: { kind: "task-notification", subkind: "session-inbox", runId: "r1" },
      }),
    ).toEqual({ ...USER, origin: { kind: "task-notification", runId: "r1" } });
    expect(
      wire({
        ...RESULT_ERROR,
        origin: { kind: "task-notification", subkind: "session-inbox" },
      }),
    ).toEqual({ ...RESULT_ERROR, origin: { kind: "task-notification" } });
  });

  it("keeps a subkind stock can name", () => {
    const origin = { kind: "task-notification", subkind: "scheduled-trigger" };
    expect(wire({ ...USER, origin })).toEqual({ ...USER, origin });
  });

  it("drops a startup failure reason only SDK 0.3.312 names and keeps a stock one", () => {
    expect(wire({ ...RESULT_ERROR, startup_failure_reason: "provider_not_allowed" })).toEqual(
      RESULT_ERROR,
    );
    expect(wire({ ...RESULT_ERROR, startup_failure_reason: "cwd_unavailable" })).toEqual({
      ...RESULT_ERROR,
      startup_failure_reason: "cwd_unavailable",
    });
  });

  it("passes every other message through unchanged", () => {
    const status = { type: "system", subtype: "status", status: "compacting", session_id: "s" };
    expect(wire(status)).toEqual(status);
    expect(wire(USER)).toEqual(USER);
  });
});
