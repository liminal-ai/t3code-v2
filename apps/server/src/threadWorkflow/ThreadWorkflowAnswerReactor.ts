import {
  CommandId,
  MessageId,
  type ThreadId,
  type ThreadWorkflowQuestionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import { ThreadWorkflowService, type ThreadWorkflowUserAnswer } from "./ThreadWorkflowService.ts";

export class ThreadWorkflowAnswerReactor extends Context.Service<
  ThreadWorkflowAnswerReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/threadWorkflow/ThreadWorkflowAnswerReactor") {}

const answerDispatchId = (input: {
  readonly threadId: ThreadId;
  readonly questionId: ThreadWorkflowQuestionId;
  readonly seq: number;
}) => `server:thread-workflow-answer:${input.threadId}:${input.questionId}:${input.seq}`;

const answerMessage = (answer: Pick<ThreadWorkflowUserAnswer, "questionId" | "title" | "answer">) =>
  `Answer to workflow question ${answer.questionId}, "${answer.title}":\n${answer.answer}`;

const make = Effect.gen(function* () {
  const service = yield* ThreadWorkflowService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;

  const relay = Effect.fn("threadWorkflow.answerReactor.relay")(
    function* (answer: ThreadWorkflowUserAnswer) {
      const id = answerDispatchId(answer);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id),
        threadId: answer.threadId,
        messageId: MessageId.make(id),
        text: answerMessage(answer),
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        // The pane that answers is the web app, and only a web or mobile user send releases a
        // queue held after Stop; a server-created message would leave the answer held.
        creationSource: "web",
      });
    },
    (effect, answer) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("thread workflow answer not posted to the thread", {
            threadId: answer.threadId,
            questionId: answer.questionId,
            cause,
          }),
        ),
      ),
  );

  const start: ThreadWorkflowAnswerReactor["Service"]["start"] = () =>
    forkParked(Stream.runForEach(service.answers, relay));

  return ThreadWorkflowAnswerReactor.of({ start });
});

export const layer = Layer.effect(ThreadWorkflowAnswerReactor, make);
