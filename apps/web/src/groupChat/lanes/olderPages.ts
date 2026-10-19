import { retryDelayMs } from "../store";

export type OlderPageState =
  | { readonly kind: "idle" }
  | { readonly kind: "pending"; readonly before: number }
  | {
      readonly kind: "failed";
      readonly before: number;
      readonly failures: number;
      readonly retryAt: number;
    };

export type OlderPageReason = "scroll" | "underfill";

export const idleOlderPage: OlderPageState = { kind: "idle" };

/**
 * Whether to ask for the page before `before` now. A read that failed is asked for again on a
 * scroll near the top, or once its backoff has passed, never on every render in between.
 */
export function mayRequestOlder(
  state: OlderPageState,
  input: { readonly before: number | null; readonly reason: OlderPageReason; readonly now: number },
): boolean {
  if (input.before === null || state.kind === "pending") return false;
  if (state.kind === "idle") return true;
  if (state.before !== input.before) return true;
  return input.reason === "scroll" || input.now >= state.retryAt;
}

export const olderRequested = (before: number): OlderPageState => ({ kind: "pending", before });

export function olderRead(
  state: OlderPageState,
  outcome: "loaded" | "empty" | "failed",
  now: number,
): OlderPageState {
  if (outcome !== "failed" || state.kind !== "pending") return idleOlderPage;
  return { kind: "failed", before: state.before, failures: 1, retryAt: now + retryDelayMs(1) };
}

export function olderFailedAgain(state: OlderPageState, now: number): OlderPageState {
  if (state.kind !== "failed") return state;
  const failures = state.failures + 1;
  return { ...state, failures, retryAt: now + retryDelayMs(failures) };
}
