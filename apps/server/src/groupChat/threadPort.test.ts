import type { RuntimeRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pendingInputOf } from "./threadPort.ts";

const requestId = "req-1" as RuntimeRequestId;

describe("group chat thread port", () => {
  it("carries a question's option values and multi-select flag to the group chat client", () => {
    const pending = pendingInputOf(
      {
        runtimeRequests: [{ id: requestId, kind: "user_input", status: "pending", nodeId: "n1" }],
        turnItems: [
          {
            type: "user_input_request",
            requestId,
            questions: [
              {
                id: "q1",
                header: "Fruit",
                question: "Which fruits?",
                options: [
                  { label: "Apple", description: "red", value: "apple" },
                  { label: "Pear", description: "" },
                ],
                multiSelect: true,
              },
            ],
          },
        ],
      },
      null,
    );
    expect(pending).toEqual({
      _tag: "question",
      requestId,
      questions: [
        {
          id: "q1",
          header: "Fruit",
          question: "Which fruits?",
          options: [
            { label: "Apple", description: "red", value: "apple" },
            { label: "Pear", description: "", value: null },
          ],
          multiSelect: true,
        },
      ],
    });
  });

  it("reports an approval when the pending request is not a question", () => {
    expect(
      pendingInputOf(
        {
          runtimeRequests: [{ id: requestId, kind: "approval", status: "pending", nodeId: "n1" }],
          turnItems: [],
        },
        null,
      ),
    ).toEqual({ _tag: "approval" });
  });
});
