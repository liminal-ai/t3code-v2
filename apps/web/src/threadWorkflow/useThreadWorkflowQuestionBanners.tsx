import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { MessageCircleQuestionIcon } from "lucide-react";

import type { ComposerBannerStackItem } from "~/components/chat/ComposerBannerStack";
import { Button } from "~/components/ui/button";
import { threadWorkflowOpenQuestionsAtom } from "~/state/threadWorkflow";
import { questionSubline } from "./ThreadWorkflowQuestions";
import { revealThreadWorkflowQuestion } from "./threadWorkflowQuestionReveal";

/**
 * One notice above the composer per open workflow question, so a question the agent asked does
 * not wait unseen in the Workflow tab. Answering stays in the tab, where the button opens it.
 */
export function useThreadWorkflowQuestionBanners(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<ComposerBannerStackItem> {
  const questions = useAtomValue(threadWorkflowOpenQuestionsAtom(threadRef));
  if (threadRef === null) return [];
  return questions.map((question) => {
    const subline = questionSubline(question);
    return {
      id: `workflow-question:${question.id}`,
      variant: "warning",
      icon: <MessageCircleQuestionIcon />,
      title: question.title,
      ...(subline === null ? {} : { description: subline }),
      actions: (
        <Button
          size="xs"
          variant="outline"
          aria-label={`Answer in Workflow: ${question.title}`}
          onClick={() => revealThreadWorkflowQuestion(threadRef, question.id)}
        >
          Answer in Workflow
        </Button>
      ),
    };
  });
}
