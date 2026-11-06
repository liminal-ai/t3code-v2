import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SheetHeader } from "../../components/ui/SheetHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useActiveThreadWorkflow } from "../../state/thread-workflow";
import { ThreadWorkflowArc } from "./ThreadWorkflowArc";

type WorkflowTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

export function ThreadWorkflowSheet({ route }: StaticScreenProps<WorkflowTarget>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const target = route.params;
  const instance = useActiveThreadWorkflow(scopeThreadRef(target.environmentId, target.threadId));

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader title="Workflow" onClose={() => navigation.goBack()} />
      <ScreenContent>
        <ScrollView
          nestedScrollEnabled
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="px-5 pb-6"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          {instance === null ? (
            <Text className="pt-6 text-center text-sm text-foreground-muted">
              This thread has no open workflow.
            </Text>
          ) : (
            <ThreadWorkflowArc instance={instance} />
          )}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
