import {
  threadWorkflowStageLine,
  threadWorkflowStepPhase,
  threadWorkflowStepResult,
  type ThreadWorkflowStepPhase,
} from "@t3tools/client-runtime/state/thread-workflow";
import type { ThreadWorkflowInstanceSummary, ThreadWorkflowStepSummary } from "@t3tools/contracts";
import { View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";

const DOT: Record<
  ThreadWorkflowStepPhase,
  { readonly name: AppSymbolName; readonly tintColorClassName: string }
> = {
  done: { name: "checkmark.circle.fill", tintColorClassName: "accent-foreground-muted" },
  current: { name: "circle.inset.filled", tintColorClassName: "accent-primary" },
  upcoming: { name: "circle", tintColorClassName: "accent-icon-subtle" },
  skipped: { name: "circle.dashed", tintColorClassName: "accent-icon-subtle" },
  removed: { name: "circle.dashed", tintColorClassName: "accent-icon-subtle" },
};

const TITLE_CLASS: Record<ThreadWorkflowStepPhase, string> = {
  done: "text-foreground-muted",
  current: "font-t3-medium text-foreground",
  upcoming: "text-foreground",
  skipped: "text-foreground-muted",
  removed: "text-foreground-muted line-through",
};

const RESULT_PREFIX: Partial<Record<ThreadWorkflowStepPhase, string>> = {
  skipped: "Skipped · ",
  removed: "Removed · ",
};

function StepRow({
  step,
  phase,
}: {
  readonly step: ThreadWorkflowStepSummary;
  readonly phase: ThreadWorkflowStepPhase;
}) {
  const result = threadWorkflowStepResult(step);
  const yourCall = step.waitsForUser && (phase === "current" || phase === "upcoming");
  return (
    <View
      testID={`thread-workflow-step-${step.id}`}
      className={cn(
        "flex-row items-start gap-3 py-2.5",
        phase === "current" && "-mx-3 rounded-xl bg-subtle px-3",
      )}
    >
      <View className="pt-0.5">
        <SymbolView
          name={DOT[phase].name}
          size={16}
          tintColorClassName={DOT[phase].tintColorClassName}
          type="monochrome"
        />
      </View>
      <View className="min-w-0 flex-1">
        <Text className={cn("text-sm", TITLE_CLASS[phase])}>
          {step.title}
          {yourCall ? (
            <Text className="text-xs text-warning-foreground">{"  your call"}</Text>
          ) : null}
        </Text>
        {result !== null ? (
          <Text numberOfLines={1} className="text-xs text-foreground-muted">
            {RESULT_PREFIX[phase] ?? ""}
            {result}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The whole arc in one read-only list: done steps with their result, the current step
 * emphasized, upcoming steps as titles. Skipped and removed steps stay in order, muted.
 */
export function ThreadWorkflowArc({
  instance,
}: {
  readonly instance: ThreadWorkflowInstanceSummary;
}) {
  return (
    <View className="pt-2">
      <Text className="font-t3-medium text-base text-foreground">{instance.title}</Text>
      <Text className="pb-2 text-xs text-foreground-muted">
        {threadWorkflowStageLine(instance)}
      </Text>
      <View accessibilityRole="list">
        {instance.steps.map((step) => (
          <StepRow key={step.id} step={step} phase={threadWorkflowStepPhase(step, instance)} />
        ))}
      </View>
    </View>
  );
}
