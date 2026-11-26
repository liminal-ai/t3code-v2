import {
  EnvironmentId,
  type ForkSettingsPatch,
  type LimbaseCompactionThreadView,
  ProviderInstanceId,
  ThreadId,
  type ThreadSettingsView,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

type View = ThreadSettingsView;

const state = vi.hoisted(() => ({
  serverHolds: new Map<string, unknown>(),
  cardSees: new Map<string, unknown>(),
  owners: new Map<unknown, string>(),
  queried: [] as string[],
  saved: [] as Array<{ owner: string; patch: unknown }>,
  refuse: null as string | null,
  reload: async (): Promise<"fresh" | "stale"> => "fresh",
  listeners: new Set<() => void>(),
  limbaseHomes: new Set<string>(["claudeLimbase"]),
}));

const notify = () => {
  for (const listener of state.listeners) listener();
};

const publish = (owner: string, view: unknown) => {
  state.serverHolds.set(owner, view);
  state.cardSees.set(owner, view);
  notify();
};

const reloadAll = async () => {
  for (const [owner, view] of state.serverHolds) state.cardSees.set(owner, view);
  notify();
  return "fresh" as const;
};

vi.mock(import("~/state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: ((atom: unknown) => {
    const owner = state.owners.get(atom) ?? "thread";
    state.queried.push(owner);
    const data = useSyncExternalStore(
      (listener) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      () => state.cardSees.get(owner) ?? null,
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
        const current = state.serverHolds.get(owner) as {
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
        state.serverHolds.set(owner, next);
        return AsyncResult.success(next);
      }) as never,
  };
});

vi.mock(import("./forkSettingsState"), async (importOriginal) => ({
  ...(await importOriginal()),
  useRefreshAndWait: (() => () => state.reload()) as never,
}));
vi.mock(import("~/state/server"), async (importOriginal) => {
  const original = await importOriginal();
  const config = Atom.make(() => ({
    settings: {
      providerInstances: Object.fromEntries(
        ["claudeLimbase", "claudeAgent"].map((id) => [
          id,
          {
            driver: "claudeAgent",
            config: state.limbaseHomes.has(id) ? { limbaseHome: "~/limbase" } : {},
          },
        ]),
      ),
    },
  }));
  return {
    ...original,
    serverEnvironment: { ...original.serverEnvironment, configValueAtom: (() => config) as never },
  };
});
vi.mock(import("~/state/threads"), async (importOriginal) => {
  const original = await importOriginal();
  const shells = Atom.family((threadId: string) =>
    Atom.make({
      providerInstanceId: threadId.startsWith("plain") ? "claudeAgent" : "claudeLimbase",
    }),
  );
  return {
    ...original,
    environmentThreadShells: {
      ...original.environmentThreadShells,
      threadShellAtom: ((ref: { threadId: string }) => shells(ref.threadId)) as never,
    },
  };
});

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  instanceSettingsQuery,
  threadSettingsSignal,
  threadSettingsQuery,
} from "./forkSettingsState";
import { LimbaseInstanceCompaction } from "./LimbaseInstanceCompaction";
import { LimbaseCompactionRow } from "./LimbaseCompactionRow";

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
  state.serverHolds.clear();
  state.cardSees.clear();
  state.queried = [];
  state.saved = [];
  state.refuse = null;
  state.reload = reloadAll;
  ownThread(owner);
  publish(owner, view);
};

const holdReloads = () => {
  const held: Array<() => void> = [];
  state.reload = () =>
    new Promise<"fresh" | "stale">((resolve) => {
      held.push(() => resolve(reloadAll()));
    });
  return async () => {
    await expect.poll(() => held.length).toBeGreaterThan(0);
    held.shift()!();
  };
};

const serverValue = (owner = "thread") =>
  (state.serverHolds.get(owner) as View | undefined)?.limbaseCompaction?.value;

const compactionRow = () => page.getByRole("button", { name: /^Limbase compaction:/ });

const openEditor = async () => {
  await userEvent.click(compactionRow());
  await expect.element(page.getByRole("dialog", { name: "Limbase compaction" })).toBeVisible();
};

it("asks for nothing and shows nothing on a thread whose instance has no Limbase home", async () => {
  reset({}, "plain-thread");
  await using _screen = await render(
    <LimbaseCompactionRow environmentId={environmentId} threadId={ownThread("plain-thread")} />,
  );
  await expect.element(page.getByText("Limbase compaction")).not.toBeInTheDocument();
  expect(state.queried).toEqual([]);
});

it("shows what each empty field inherits, and what Limbase holds now", async () => {
  reset(limbaseThread({ instance: { compactAt: { percent: 70 } } }));
  await using _screen = await render(
    <LimbaseCompactionRow environmentId={environmentId} threadId={threadId} />,
  );
  await expect.element(compactionRow()).toHaveAccessibleName("Limbase compaction: 700k to 100k");
  await expect.element(compactionRow()).toHaveAttribute("aria-expanded", "false");
  await openEditor();
  await expect.element(compactionRow()).toHaveAttribute("aria-expanded", "true");
  await expect.element(page.getByText("claude-opus-4-6 · 1M window")).toBeVisible();
  await expect
    .element(page.getByLabelText("Compact at"))
    .toHaveAttribute("placeholder", "Instance: 70% (700k)");
  await expect
    .element(page.getByLabelText("Down to"))
    .toHaveAttribute("placeholder", "Default for 1M models: 120k");
});

it.each([
  {
    instance: { compactAt: { tokens: 700_000 }, downTo: { tokens: 100_000 } },
    hint: "Blank uses the instance setting.",
  },
  { instance: {}, hint: "Blank uses Limbase's default for the model." },
  {
    instance: { compactAt: { tokens: 700_000 } },
    hint: "Blank uses the instance setting, or Limbase's default for the model.",
  },
])("says what a blank field uses: $hint", async ({ instance, hint }) => {
  reset(limbaseThread({ instance }));
  await using _screen = await render(
    <LimbaseCompactionRow environmentId={environmentId} threadId={threadId} />,
  );
  await openEditor();
  await expect.element(page.getByText(hint, { exact: true })).toBeVisible();
});

it("closes the editor on Escape and gives focus back to the row", async () => {
  reset(limbaseThread());
  await using _screen = await render(
    <LimbaseCompactionRow environmentId={environmentId} threadId={threadId} />,
  );
  await openEditor();
  await expect.element(page.getByLabelText("Compact at")).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(compactionRow()).toHaveFocus();
  await expect.element(compactionRow()).toHaveAttribute("aria-expanded", "false");
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
    <LimbaseCompactionRow environmentId={environmentId} threadId={threadId} />,
  );
  await openEditor();
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

it("saves a share on a model whose window is unknown, and says nothing reaches Limbase yet", async () => {
  reset(
    limbaseThread({
      model: "gateway-sonnet[1m]",
      contextWindow: null,
      hardLimit: null,
      profile: null,
      applied: { trigger: 640_000, target: 95_000 },
    }),
  );
  await using _screen = await render(
    <LimbaseCompactionRow environmentId={environmentId} threadId={threadId} />,
  );
  await openEditor();
  await expect
    .element(page.getByText(/^Nothing you save reaches Limbase until Claude reports the window\./))
    .toBeVisible();
  await expect.element(page.getByText("gateway-sonnet[1m] · window unknown")).toBeVisible();
  await userEvent.fill(page.getByLabelText("Down to"), "15%");
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => savedCompaction()).toEqual([{ downTo: { percent: 15 } }]);
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(compactionRow()).toHaveAccessibleName("Limbase compaction: 640k to 95k");
});

it("warns that a down to of 300k or more turns cold return off", async () => {
  reset(limbaseThread({ value: { downTo: { tokens: 300_000 } } }));
  await using _screen = await render(
    <LimbaseCompactionRow environmentId={environmentId} threadId={threadId} />,
  );
  await openEditor();
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
    <LimbaseCompactionRow environmentId={environmentId} threadId={threadId} />,
  );
  await openEditor();
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
    return "stale";
  };
  await using _screen = await render(
    <LimbaseCompactionRow environmentId={environmentId} threadId={threadId} />,
  );
  await openEditor();
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

it("drops a refused draft and its alert on a move to another thread, and saves only to the thread it was typed on", async () => {
  reset(limbaseThread());
  const wide = ownThread("thread");
  const narrow = ownThread("thread-200k");
  publish(
    "thread-200k",
    limbaseThread({
      model: "claude-sonnet-4-6",
      contextWindow: 200_000,
      hardLimit: 184_000,
      profile: "standard",
      applied: { trigger: 140_000, target: 70_000 },
    }),
  );
  await using screen = await render(
    <LimbaseCompactionRow environmentId={environmentId} threadId={wide} />,
  );
  await openEditor();
  await userEvent.fill(page.getByLabelText("Compact at"), "2M");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Compact at (2M) must fit the model's 1M window.");

  await screen.rerender(<LimbaseCompactionRow environmentId={environmentId} threadId={narrow} />);
  await openEditor();
  await expect.element(page.getByText("claude-sonnet-4-6 · 200k window")).toBeVisible();
  await expect.element(page.getByLabelText("Compact at")).toHaveValue("");
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();

  await userEvent.fill(page.getByLabelText("Compact at"), "150k");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  expect(state.saved).toEqual([
    { owner: "thread-200k", patch: { compactAt: { tokens: 150_000 } } },
  ]);
});

it("leaves a save in flight with its thread when the card moves to another", async () => {
  reset(limbaseThread());
  const first = ownThread("thread");
  const second = ownThread("thread-second");
  publish("thread-second", limbaseThread());
  const finishReload = holdReloads();
  await using screen = await render(
    <LimbaseCompactionRow environmentId={environmentId} threadId={first} />,
  );
  await openEditor();
  await userEvent.fill(page.getByLabelText("Compact at"), "650k");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("status")).toHaveTextContent("Saving…");

  await screen.rerender(<LimbaseCompactionRow environmentId={environmentId} threadId={second} />);
  await openEditor();
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  await expect.element(page.getByLabelText("Compact at")).not.toHaveAttribute("readonly");
  await expect.element(page.getByLabelText("Compact at")).toHaveValue("");
  await finishReload();
  expect(serverValue("thread")).toEqual({ compactAt: { tokens: 650_000 } });
  expect(serverValue("thread-second")).toEqual({});
});

it("clears a field's alert when the field goes back to its saved value", async () => {
  reset(limbaseThread({ value: { compactAt: { tokens: 500_000 } } }));
  await using _screen = await render(
    <LimbaseCompactionRow environmentId={environmentId} threadId={threadId} />,
  );
  await openEditor();
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
    <LimbaseCompactionRow environmentId={environmentId} threadId={threadId} />,
  );
  await openEditor();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(
      "Compact at (500k) must fit the model's 200k window. Limbase keeps 500k → 150k until you change it.",
    );
  await expect.element(compactionRow()).toHaveAccessibleName("Limbase compaction: 500k to 150k");
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
  const before = threadSettingsSignal(shell({ latestRun: run(false) }), false);
  expect(threadSettingsSignal(shell({ latestRun: run(false), title: "Renamed" }), false)).toBe(
    before,
  );
  expect(threadSettingsSignal(shell({ latestRun: run(true) }), false)).not.toBe(before);
  const picked = shell({
    latestRun: run(false),
    modelSelection: { instanceId: ProviderInstanceId.make("claudeLimbase"), model: "b" },
  });
  expect(threadSettingsSignal(picked, true)).not.toBe(before);
  expect(
    threadSettingsSignal(picked, false),
    "a picked model refreshes the card again once the server has it",
  ).not.toBe(threadSettingsSignal(picked, true));
});
