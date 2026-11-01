import { describe, expect, it } from "vite-plus/test";
import { makeProviderSettingsSchema, ProviderDriverKind, TrimmedString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { providerClients } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  reconcileRowsDraft,
  seedRowsDraft,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("keeps every masked field as a stored secret", () => {
    const settingsSchema = makeProviderSettingsSchema({
      token: TrimmedString.pipe(
        Schema.annotateKey({ providerSettingsForm: { control: "password" } }),
      ),
    });

    expect(deriveProviderSettingsFields({ settingsSchema })).toMatchObject([
      { key: "token", secret: true },
    ]);
  });

  it("uses a dedicated environment field instead of legacy Cursor CLI settings", () => {
    const cursor = providerClients.get(ProviderDriverKind.make("cursor"));

    expect(cursor).toBeDefined();
    expect(deriveProviderSettingsFields(cursor!).map((field) => field.key)).toEqual([
      "runtime",
      "cloudAutoCreatePR",
      "cloudOpenAsCursorGithubApp",
    ]);
    expect(cursor?.environmentFields).toEqual([
      {
        name: "CURSOR_API_KEY",
        label: "Cursor API key",
        description: "Optional. Overrides browser sign-in for this provider.",
        placeholder: "Paste API key",
        sensitive: true,
      },
    ]);
  });

  it("offers Claude's context engine and the two LHC fields", () => {
    const claude = providerClients.get(ProviderDriverKind.make("claudeAgent"));
    expect(claude).toBeDefined();

    const fields = deriveProviderSettingsFields(claude!);
    expect(fields.map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "contextEngine",
      "lhcCompactTrigger",
      "lhcCompactTarget",
      "autoCompactWindow",
      "idleCompaction",
      "launchArgs",
    ]);
    const [contextEngine, trigger, target] = fields.slice(2, 5);
    expect(contextEngine).toMatchObject({
      label: "Context",
      control: "select",
      options: [
        { value: "claude", label: "Claude Code" },
        { value: "claude-lhc", label: "Long-horizon context (LHC)" },
      ],
    });
    expect(trigger).toMatchObject({ label: "LHC compact trigger", control: "text" });
    expect(target).toMatchObject({ label: "LHC compact target", control: "text" });

    const lhc = nextProviderConfigWithFieldValue(
      nextProviderConfigWithFieldValue(
        nextProviderConfigWithFieldValue({ homePath: "~/.claude" }, contextEngine!, "claude-lhc"),
        trigger!,
        "40000",
      ),
      target!,
      "20000",
    );
    expect(lhc).toEqual({
      homePath: "~/.claude",
      contextEngine: "claude-lhc",
      lhcCompactTrigger: "40000",
      lhcCompactTarget: "20000",
    });
    expect(nextProviderConfigWithFieldValue(lhc, trigger!, " ")).toEqual({
      homePath: "~/.claude",
      contextEngine: "claude-lhc",
      lhcCompactTarget: "20000",
    });
    // The select stores its first option, Claude Code, as an empty value.
    expect(nextProviderConfigWithFieldValue(lhc, contextEngine!, "")).toEqual({
      homePath: "~/.claude",
      lhcCompactTrigger: "40000",
      lhcCompactTarget: "20000",
    });
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = providerClients.get(ProviderDriverKind.make("opencode"));
    expect(opencode).toBeDefined();

    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, serverUrl: "http://127.0.0.1:4096" },
      serverUrl!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });
});

describe("reconcileRowsDraft", () => {
  let nextId = 0;
  const toRows = (values: ReadonlyArray<string>) =>
    values.map((value) => ({ id: nextId++, value }));
  const equal = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
    left.length === right.length && left.every((value, index) => value === right[index]);

  it("keeps rows when an equal value arrives with a new identity", () => {
    const draft = seedRowsDraft(["a"], toRows);
    expect(reconcileRowsDraft(draft, ["a"], equal, toRows)).toBe(draft);
  });

  it("keeps row ids when the published value echoes back", () => {
    const seeded = seedRowsDraft(["a"], toRows);
    const edited = { rows: [...seeded.rows, { id: 99, value: "" }], seen: seeded.seen };
    const draft = { ...edited, lastPublished: ["a", ""] };
    const next = reconcileRowsDraft(draft, ["a", ""], equal, toRows);
    expect(next.rows).toBe(draft.rows);
    expect(next.seen).toEqual(["a", ""]);
    expect(next.lastPublished).toBeUndefined();
  });

  it("reseeds rows when the value changes from outside", () => {
    const draft = { ...seedRowsDraft(["a"], toRows), lastPublished: ["b"] };
    const next = reconcileRowsDraft(draft, ["c"], equal, toRows);
    expect(next.rows.map((row) => row.value)).toEqual(["c"]);
    expect(next.lastPublished).toBeUndefined();
  });
});
