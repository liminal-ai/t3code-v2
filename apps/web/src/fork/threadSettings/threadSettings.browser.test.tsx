import {
  EnvironmentId,
  type LimbaseCompaction,
  type LimbaseCompactionThreadView,
  ProviderInstanceId,
  ThreadId,
  type ThreadSettingsView,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  view: {} as ThreadSettingsView,
  saved: [] as unknown[],
  refuse: null as string | null,
  listeners: new Set<() => void>(),
}));

const publish = (view: ThreadSettingsView) => {
  state.view = view;
  for (const listener of state.listeners) listener();
};

vi.mock(import("~/state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => {
    const data = useSyncExternalStore(
      (listener) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      () => state.view,
    );
    return { data, refresh: () => {} };
  }) as never,
}));
vi.mock(import("~/state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: (() => true) as never,
}));
vi.mock(import("~/state/use-atom-command"), async () => {
  const { AsyncResult } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const { ForkSettingsError } = await import("@t3tools/contracts");
  return {
    useAtomCommand: (() => async (value: unknown) => {
      state.saved.push(value);
      return state.refuse === null
        ? AsyncResult.success(state.view)
        : AsyncResult.failure(Cause.fail(new ForkSettingsError({ message: state.refuse })));
    }) as never,
  };
});

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadSettingsSignal } from "./forkSettingsState";
import { LimbaseInstanceCompaction } from "./LimbaseInstanceCompaction";
import { ThreadSettingsCard } from "./ThreadSettingsCard";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");
const DEFAULTS = {
  profiles: {
    haiku: { trigger: 85_000, target: 42_000 },
    standard: { trigger: 140_000, target: 70_000 },
    "1m": { trigger: 700_000, target: 120_000 },
  },
  coldReturnSize: 300_000,
};

const limbaseThread = (
  overrides: Partial<LimbaseCompactionThreadView> = {},
): ThreadSettingsView => ({
  limbaseCompaction: {
    value: {},
    instance: {},
    model: "claude-opus-4-6",
    contextWindow: 1_000_000,
    hardLimit: 920_000,
    profile: "1m",
    defaults: DEFAULTS,
    applied: { trigger: 700_000, target: 100_000 },
    ...overrides,
  },
});

const savedCompaction = () =>
  state.saved.map(
    (value) =>
      (value as { input: { settings: { limbaseCompaction: LimbaseCompaction } } }).input.settings
        .limbaseCompaction,
  );

const reset = (view: ThreadSettingsView) => {
  state.saved = [];
  state.refuse = null;
  publish(view);
};

it("shows nothing for a thread that is not on Limbase", async () => {
  reset({});
  await using _screen = await render(
    <ThreadSettingsCard environmentId={environmentId} threadId={threadId} />,
  );
  await expect.element(page.getByText("Thread settings")).not.toBeInTheDocument();
});

it("shows what each empty field inherits, and what Limbase holds now", async () => {
  reset(limbaseThread({ instance: { compactAt: { percent: 70 } } }));
  await using _screen = await render(
    <ThreadSettingsCard environmentId={environmentId} threadId={threadId} />,
  );
  await expect.element(page.getByRole("region", { name: "Thread settings" })).toBeVisible();
  await expect
    .element(page.getByLabelText("Compact at"))
    .toHaveAttribute("placeholder", "Instance: 70% (700k)");
  await expect
    .element(page.getByLabelText("Down to"))
    .toHaveAttribute("placeholder", "Default for 1M models: 120k");
  await expect.element(page.getByText("700k → 100k")).toBeVisible();
});

it("refuses a value a guard rejects, saves one it accepts, and shows Limbase's refusal", async () => {
  reset(
    limbaseThread({
      model: "claude-sonnet-4-5",
      contextWindow: 200_000,
      hardLimit: 184_000,
      profile: "standard",
    }),
  );
  await using _screen = await render(
    <ThreadSettingsCard environmentId={environmentId} threadId={threadId} />,
  );
  const downTo = page.getByLabelText("Down to");
  await userEvent.fill(downTo, "150k");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Down to (150k) must be below compact at (140k).");
  expect(state.saved).toEqual([]);

  await userEvent.fill(downTo, "20%");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  expect(savedCompaction()).toEqual([{ downTo: { percent: 20 } }]);

  state.refuse =
    "Limbase: the service refused the compaction policy (limbase call failed: ThreadNotFound)";
  await userEvent.fill(page.getByLabelText("Compact at"), "150k");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("alert")).toHaveTextContent(state.refuse);
});

it("warns that a down to of 300k or more turns cold return off", async () => {
  reset(limbaseThread({ value: { downTo: { tokens: 300_000 } } }));
  await using _screen = await render(
    <ThreadSettingsCard environmentId={environmentId} threadId={threadId} />,
  );
  await expect.element(page.getByLabelText("Down to")).toHaveValue("300k");
  await expect
    .element(page.getByText("At 300k or more, Limbase turns cold return off."))
    .toBeVisible();
});

it("edits the instance's compaction only on an instance with a Limbase home", async () => {
  reset({});
  state.view = {
    limbaseCompaction: { value: { compactAt: { tokens: 700_000 } }, defaults: DEFAULTS },
  } as never;
  const instanceId = ProviderInstanceId.make("claudeLimbase");
  await using screen = await render(
    <>
      <LimbaseInstanceCompaction
        environmentId={environmentId}
        instanceId={instanceId}
        config={{}}
      />
      <LimbaseInstanceCompaction
        environmentId={environmentId}
        instanceId={instanceId}
        config={{ limbaseHome: "~/limbase" }}
      />
    </>,
  );
  await expect.element(screen.getByTestId("instance-limbase-compaction")).toBeVisible();
  const compactAt = page.getByLabelText("Limbase: compact at");
  await expect.element(compactAt).toHaveValue("700k");
  await expect
    .element(page.getByLabelText("Limbase: down to"))
    .toHaveAttribute("placeholder", "Default: 120k on 1M, 70k on 200k");
  await userEvent.fill(compactAt, "");
  await userEvent.keyboard("{Enter}");
  expect(savedCompaction()).toEqual([{}]);
});

it("refreshes the card when its thread switches model or ends a turn, not when it is renamed", () => {
  const shell = (overrides: Partial<EnvironmentThreadShell> = {}) =>
    ({
      title: "Thread",
      providerInstanceId: ProviderInstanceId.make("claudeLimbase"),
      modelSelection: { instanceId: ProviderInstanceId.make("claudeLimbase"), model: "a" },
      activeProviderThreadId: null,
      latestRun: null,
      ...overrides,
    }) as EnvironmentThreadShell;
  const run = (ended: boolean) =>
    ({
      runId: "run-1",
      status: ended ? "completed" : "running",
      completedAt: ended ? "2026-11-24T00:00:00.000Z" : null,
    }) as never;
  const before = threadSettingsSignal(shell({ latestRun: run(false) }));
  expect(threadSettingsSignal(shell({ latestRun: run(false), title: "Renamed" }))).toBe(before);
  expect(threadSettingsSignal(shell({ latestRun: run(true) }))).not.toBe(before);
  expect(
    threadSettingsSignal(
      shell({
        latestRun: run(false),
        modelSelection: { instanceId: ProviderInstanceId.make("claudeLimbase"), model: "b" },
      }),
    ),
  ).not.toBe(before);
});
