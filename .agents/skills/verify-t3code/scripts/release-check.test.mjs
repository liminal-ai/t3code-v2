import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeTest from "node:test";

import {
  copyProblems,
  copySettings,
  isPong,
  parseEnvFile,
  parseModels,
  passed,
  pickPort,
  planRows,
  renderTable,
  SAFETY_SETTINGS,
} from "./release-check.mjs";

const prod = {
  sidebarAutoSettleAfterDays: 3,
  favorites: [{ provider: "antigravity", model: "gemini-4-neon" }],
  projectSettingsOverrides: { "/repo": { defaultAutoPull: true } },
  providerInstances: {
    claudeAgent: { driver: "claudeAgent", config: { idleCompaction: "off" } },
    codex: {
      driver: "codex",
      config: { binaryPath: "/bin/codex", homePath: "/prod/codex-home" },
    },
    cursor: { driver: "cursor", enabled: true },
    claudeLimbase: {
      driver: "claudeAgent",
      displayName: "Claude on Limbase",
      enabled: true,
      config: { limbaseHome: "/prod/limbase/home", binaryPath: "/prod/limbase/claude" },
    },
    antigravity: {
      driver: "antigravity",
      enabled: true,
      config: { binaryPath: "/home/u/.local/share/antigravity-cli/1.5.16/antigravity" },
    },
    old: { driver: "muse", enabled: false },
  },
};

const scratch = {
  codexHome: (id) => `/scratch/codex-home/${id}`,
  limbaseHome: "/scratch/lane/home",
};

const UT_PREPARE_PROD_COPY_JQ = `
  .providerInstances as $instances | $safety[0] |
  .providerInstances = ($instances | with_entries(
    .value |= ({driver, displayName, config: (.config // {} | {limbaseHome} | with_entries(select(.value != null)))} | with_entries(select(.value != null)))
  ))
`;

NodeTest.test("the copy keeps every instance verbatim, binaryPath and enabled included", () => {
  const copy = copySettings(prod, scratch);
  NodeAssert.deepEqual(copyProblems(prod, copy), []);
  NodeAssert.equal(
    copy.providerInstances.antigravity.config.binaryPath,
    prod.providerInstances.antigravity.config.binaryPath,
  );
  NodeAssert.equal(copy.providerInstances.antigravity.enabled, true);
  NodeAssert.equal(copy.providerInstances.old.enabled, false);
  NodeAssert.deepEqual(copy.providerInstances.cursor, prod.providerInstances.cursor);
});

NodeTest.test(
  "codex homePath and Limbase homes move to scratch, nothing else in their config does",
  () => {
    const copy = copySettings(prod, scratch);
    NodeAssert.deepEqual(copy.providerInstances.codex.config, {
      binaryPath: "/bin/codex",
      homePath: "/scratch/codex-home/codex",
    });
    NodeAssert.deepEqual(copy.providerInstances.claudeLimbase.config, {
      limbaseHome: "/scratch/lane/home",
      binaryPath: "/prod/limbase/claude",
    });
    NodeAssert.equal(
      prod.providerInstances.codex.config.homePath,
      "/prod/codex-home",
      "input is not mutated",
    );
  },
);

NodeTest.test("safety settings win over prod's, and other prod settings carry over", () => {
  const copy = copySettings(prod, scratch);
  for (const [key, value] of Object.entries(SAFETY_SETTINGS))
    NodeAssert.deepEqual(copy[key], value, key);
  NodeAssert.deepEqual(copy.favorites, prod.favorites);
});

NodeTest.test("the UT stripping jq fails the same check: binaryPath and enabled are gone", () => {
  const stripped = JSON.parse(
    NodeChildProcess.execFileSync(
      "jq",
      ["--argjson", "safety", JSON.stringify([SAFETY_SETTINGS]), UT_PREPARE_PROD_COPY_JQ],
      {
        input: JSON.stringify(prod),
      },
    ),
  );
  NodeAssert.equal(
    stripped.providerInstances.antigravity.config?.binaryPath,
    undefined,
    "UT copy boots the managed runtime",
  );
  const problems = copyProblems(prod, stripped);
  NodeAssert.ok(problems.includes("antigravity: enabled changed"), problems.join("\n"));
  NodeAssert.ok(problems.includes("antigravity: config.binaryPath changed"), problems.join("\n"));
  NodeAssert.ok(problems.includes("codex: config.homePath missing"), problems.join("\n"));
});

NodeTest.test("a copy that leaves codex on prod's home fails the check", () => {
  NodeAssert.deepEqual(copyProblems(prod, { ...prod }), [
    "codex: config.homePath still points at prod",
    "claudeLimbase: config.limbaseHome still points at prod",
  ]);
});

const provider = (instanceId, driver, enabled = true) => ({ instanceId, driver, enabled });

NodeTest.test("rows come from what the release enables, plus every instance prod enables", () => {
  const providers = [
    provider("claudeAgent", "claudeAgent"),
    provider("codex", "codex"),
    provider("cursor", "cursor"),
    provider("claudeLimbase", "claudeAgent"),
    provider("antigravity", "antigravity", false),
    provider("grok", "grok", false),
    provider("old", "muse", false),
  ];
  const rows = planRows(prod, providers, { claudeLimbase: "claude-sonnet-5-5" });
  NodeAssert.deepEqual(
    rows.map((r) => [r.instance, r.model, r.error]),
    [
      ["claudeAgent", "claude-haiku-5-5", undefined],
      ["codex", "gpt-6-astra", undefined],
      ["cursor", "grok-4.7", undefined],
      ["claudeLimbase", "claude-sonnet-5-5", undefined],
      ["antigravity", "gemini-3.8-flash", "prod enables it, the release reports it disabled"],
    ],
  );
  NodeAssert.equal(rows.find((r) => r.instance === "codex").binaryPath, "/bin/codex");
  NodeAssert.equal(rows.find((r) => r.instance === "claudeAgent").binaryPath, "(managed)");
});

NodeTest.test("an instance the release drops, or one with no proof model, is a failure row", () => {
  const rows = planRows(prod, [provider("fx", "fx"), provider("claudeAgent", "claudeAgent")]);
  const byId = Object.fromEntries(rows.map((r) => [r.instance, r.error]));
  NodeAssert.equal(byId.fx, "no proof model for driver fx; pass --model fx=<slug>");
  NodeAssert.equal(byId.cursor, "prod enables it, the release does not list it");
  NodeAssert.equal(byId.old, undefined);
});

NodeTest.test("the port skips listeners and prod's ports", () => {
  const ss =
    'LISTEN 0 511 127.0.0.1:13987 0.0.0.0:* users:(("node",pid=1,fd=2))\nLISTEN 0 511 127.0.0.1:13988 0.0.0.0:*\n';
  NodeAssert.equal(pickPort(ss, 13987, 14000), 13989);
  NodeAssert.equal(pickPort("", 13977, 13978), 13978);
  NodeAssert.throws(() => pickPort("", 13995, 13995), /no free port/);
});

NodeTest.test("env files parse like systemd's", () => {
  NodeAssert.deepEqual(
    parseEnvFile('# note\nPATH=/a:/b\nKEY="quoted value"\nexport X=1\n\nbad line\n'),
    {
      PATH: "/a:/b",
      KEY: "quoted value",
      X: "1",
    },
  );
});

NodeTest.test("model overrides parse as instance=slug", () => {
  NodeAssert.deepEqual(parseModels(["codex=gpt-6.1-sol", "a=b=c"]), {
    codex: "gpt-6.1-sol",
    a: "b=c",
  });
  NodeAssert.throws(() => parseModels(["codex"]), /instance>=<slug/);
});

NodeTest.test("only a completed pong passes, and exit needs every row passed and archived", () => {
  NodeAssert.ok(isPong({ status: "completed", reply: "Pong." }));
  NodeAssert.ok(!isPong({ status: "completed", reply: "ping pong" }));
  NodeAssert.ok(!isPong({ status: "failed", reply: "pong" }));
  NodeAssert.ok(passed([{ pass: true, archived: true }]));
  NodeAssert.ok(!passed([{ pass: true, archived: false }]));
  NodeAssert.ok(!passed([]));
});

NodeTest.test("the table has one row per instance and escapes pipes", () => {
  const table = renderTable([
    {
      instance: "codex",
      driver: "codex",
      binaryPath: "/bin/codex",
      model: "m",
      pass: true,
      reply: "pong",
      threadId: "t1",
      archived: true,
    },
    {
      instance: "x",
      driver: "d",
      binaryPath: "(managed)",
      model: "m",
      error: "a | b",
      archived: false,
    },
  ]);
  NodeAssert.equal(
    table,
    [
      "| instance | driver | binaryPath | model | result | reply or error | thread | archived |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| codex | codex | /bin/codex | m | PASS | pong | t1 | yes |",
      "| x | d | (managed) | m | FAIL | a \\| b |  | no |",
    ].join("\n"),
  );
});
