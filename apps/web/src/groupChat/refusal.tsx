import { useState } from "react";

/**
 * A refusal must show where the operator acted. A toast would sit behind a dialog, so each
 * action keeps its refusal's sentence, verbatim, next to the control that asked.
 */
export function useRefusal() {
  const [refusal, setRefusal] = useState<string | null>(null);
  const run = async <A,>(action: () => Promise<A>): Promise<A | undefined> => {
    try {
      const result = await action();
      setRefusal(null);
      return result;
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };
  return { refusal, run };
}

export function Refusal({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <p className="text-xs text-destructive-foreground" data-testid="refusal">
      {text}
    </p>
  );
}
