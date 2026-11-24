import {
  EnvironmentId,
  type ForkSettingsPatch,
  type LimbaseCompactionThreadView,
  ProviderInstanceId,
  ThreadId,
  type ThreadSettingsView,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

type View = ThreadSettingsView;

const state = vi.hoisted(() => ({
  /** What the server holds, by owner; a reload publishes it to the card. */
  server: new Map<string, unknown>(),
  published: new Map<string, unknown>(),
  owners: new Map<unknown, string>(),
  saved: [] as Array<{ owner: string; patch: unknown }>,
  refuse: null as string | null,
  reload: async (): Promise<boolean> => true,
  listeners: new Set<() => void>(),
}));

const notify = () => {
  for (const listener of state.listeners) listener();
};

const publish = (owner: string, view: unknown) => {
  state.server.set(owner, view);
  state.published.set(owner, view);
  notify();
};

const reloadAll = async () => {
  for (const [owner, view] of state.server) state.published.set(owner, view);
  notify();
  return true;
};

vi.mock(import("~/state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: ((atom: unknown) => {
    const owner = state.owners.get(atom) ?? "thread";
    const data = useSyncExternalStore(
      (listener) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      () => state.published.get(owner) ?? null,
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
  const { ForkSettingsError, patchLimbaseCompaction } = await import("@t3tools/contracts");
  return {
    useAtomCommand: (() =>
      async ({
        input,
      }: {
        input: { threadId?: string; instanceId?: string; settings: ForkSettingsPatch };
      }) => {
        const owner = input.threadId ?? input.instanceId ?? "";
        state.saved.push({ owner, patch: input.settings.limbaseCompaction });
        if (state.refuse !== null) {
          return AsyncResult.failure(Cause.fail(new ForkSettingsError({ message: state.refuse })));
        }
        const current = state.server.get(owner) as {
          limbaseCompaction: { value: Record<string, unknown> };
        };
        const next = {
          limbaseCompaction: {
            ...current.limbaseCompaction,
            value: patchLimbaseCompaction(
              current.limbaseCompaction.value,
              input.settings.limbaseCompaction ?? {},
            ),
          },
        };
        state.server.set(owner, next);
        return AsyncResult.success(next);
      }) as never,
  };
});

vi.mock(import("./forkSettingsState"), async (importOriginal) => ({
  ...(await importOriginal()),
  useRefreshAndWait: (() => () => state.reload()) as never,
}));
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  instanceSettingsQuery,
  threadSettingsSignal,
  threadSettingsQuery,
} from "./forkSettingsState";
import { LimbaseInstanceCompaction } from "./LimbaseInstanceCompaction";
import { ThreadSettingsCard } from "./ThreadSettingsCard";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");
const instanceId = ProviderInstanceId.make("claudeLimbase");
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

const ownThread = (id: string) => {
  const threadId = ThreadId.make(id);
  state.owners.set(threadSettingsQuery({ environmentId, input: { threadId } }), id);
  return threadId;
};

const savedCompaction = (owner = "thread") =>
  state.saved.filter((save) => save.owner === owner).map(({ patch }) => patch);

const reset = (view: View, owner = "thread") => {
  state.server.clear();
  state.published.clear();
  state.saved = [];
  state.refuse = null;
  state.reload = reloadAll;
  ownThread(owner);
  publish(owner, view);
};

/** Holds each reload until the test releases it, oldest first. */
const holdReloads = () => {
  const held: Array<() => void> = [];
  state.reload = () =>
    new Promise<boolean>((resolve) => {
      held.push(() => resolve(reloadAll()));
    });
  return async () => {
    await expect.poll(() => held.length).toBeGreaterThan(0);
    held.shift()!();
  };
};

const serverValue = (owner = "thread") =>
  (state.server.get(owner) as View | undefined)?.limbaseCompaction?.value;

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
  await expect.element(page.getByText(/^T3 owns this thread's Limbase policy\./)).toBeVisible();
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
  state.owners.set(
    instanceSettingsQuery({ environmentId, input: { instanceId } }),
    "claudeLimbase",
  );
  publish("claudeLimbase", {
    limbaseCompaction: { value: { compactAt: { tokens: 700_000 } }, defaults: DEFAULTS },
  });
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
  expect(savedCompaction("claudeLimbase")).toEqual([{ compactAt: null }]);
});

it("holds both fields while a save and its refresh are in flight, and sends only the field each edit changed", async () => {
  reset(limbaseThread());
  const finishReload = holdReloads();
  await using _screen = await render(
    <ThreadSettingsCard environmentId={environmentId} threadId={threadId} />,
  );
  const compactAt = page.getByLabelText("Compact at");
  const downTo = page.getByLabelText("Down to");
  await userEvent.fill(compactAt, "650k");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("status")).toHaveTextContent("Saving…");
  await expect.element(downTo).toHaveAttribute("readonly");
  await expect.element(compactAt).toHaveAttribute("readonly");

  await finishReload();
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  await expect.element(compactAt).toHaveValue("650k");
  await userEvent.fill(downTo, "90k");
  await userEvent.keyboard("{Enter}");
  await finishReload();
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  expect(savedCompaction()).toEqual([
    { compactAt: { tokens: 650_000 } },
    { downTo: { tokens: 90_000 } },
  ]);
  expect(serverValue()).toEqual({
    compactAt: { tokens: 650_000 },
    downTo: { tokens: 90_000 },
  });
});

it("keeps the saved value and the lock when the refresh fails, retries, and then builds on the save", async () => {
  reset(limbaseThread({ value: { compactAt: { tokens: 625_000 } } }));
  const attempts: string[] = [];
  let failFirstReload = () => {};
  state.reload = async () => {
    attempts.push("reload");
    if (attempts.length > 1) return reloadAll();
    await new Promise<void>((resolve) => {
      failFirstReload = resolve;
    });
    return false;
  };
  await using _screen = await render(
    <ThreadSettingsCard environmentId={environmentId} threadId={threadId} />,
  );
  const compactAt = page.getByLabelText("Compact at");
  const downTo = page.getByLabelText("Down to");
  await userEvent.fill(compactAt, "640k");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("status")).toHaveTextContent("Saving…");
  await expect.element(compactAt).toHaveValue("640k");
  await expect.poll(() => attempts.length).toBe(1);
  failFirstReload();
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Saved. The card could not reload its settings and is trying again.");
  await expect.element(compactAt).toHaveValue("640k");
  await expect.element(downTo).toHaveAttribute("readonly");
  await expect.element(compactAt).toHaveAttribute("readonly");

  await expect.element(page.getByRole("status"), { timeout: 5_000 }).not.toBeInTheDocument();
  expect(attempts).toEqual(["reload", "reload"]);
  await expect.element(compactAt).toHaveValue("640k");
  await userEvent.fill(downTo, "95k");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  expect(savedCompaction()).toEqual([
    { compactAt: { tokens: 640_000 } },
    { downTo: { tokens: 95_000 } },
  ]);
  expect(serverValue()).toEqual({
    compactAt: { tokens: 640_000 },
    downTo: { tokens: 95_000 },
  });
});

it("clears a field's alert when the field goes back to its saved value", async () => {
  reset(limbaseThread({ value: { compactAt: { tokens: 500_000 } } }));
  await using _screen = await render(
    <ThreadSettingsCard environmentId={environmentId} threadId={threadId} />,
  );
  const compactAt = page.getByLabelText("Compact at");
  await userEvent.fill(compactAt, "2M");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Compact at (2M) must fit the model's 1M window.");
  await userEvent.fill(compactAt, "500k");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(compactAt).toHaveValue("500k");
  expect(state.saved).toEqual([]);
});

it("says what to change, and what Limbase keeps, when the model no longer fits a saved value", async () => {
  reset(
    limbaseThread({
      value: { compactAt: { tokens: 500_000 } },
      model: "claude-sonnet-4-6",
      contextWindow: 200_000,
      hardLimit: 184_000,
      profile: "standard",
      applied: { trigger: 500_000, target: 150_000 },
    }),
  );
  await using _screen = await render(
    <ThreadSettingsCard environmentId={environmentId} threadId={threadId} />,
  );
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(
      "Compact at (500k) must fit the model's 200k window. Limbase keeps 500k → 150k until you change it.",
    );
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
