import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import {
  archiveOwn,
  codexSeeds,
  copyProblems,
  copySettings,
  isPong,
  parseEnvFile,
  parseModels,
  passed,
  pickPort,
  planRows,
  renderTable,
  runTurns,
  SAFETY_SETTINGS,
  serverEnv,
  stageScratch,
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
  codexShadowHome: (id) => `/scratch/codex-home/${id}.shadow`,
  limbaseHome: "/scratch/lane/home",
};

const provider = (instanceId, driver, enabled = true) => ({ instanceId, driver, enabled });

const tempDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "release-check-test-"));

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

NodeTest.test("a codex shadow home moves to scratch, and one left on prod fails the check", () => {
  const shadowed = {
    providerInstances: {
      work: { driver: "codex", config: { homePath: "~/.codex", shadowHomePath: "~/.codex-work" } },
      plain: { driver: "codex", config: { shadowHomePath: "  " } },
    },
  };
  const copy = copySettings(shadowed, scratch);
  NodeAssert.equal(
    copy.providerInstances.work.config.shadowHomePath,
    "/scratch/codex-home/work.shadow",
  );
  NodeAssert.equal(copy.providerInstances.plain.config.shadowHomePath, "  ");
  NodeAssert.deepEqual(copyProblems(shadowed, copy), []);
  const leaked = structuredClone(copy);
  leaked.providerInstances.work.config.shadowHomePath = "~/.codex-work";
  NodeAssert.deepEqual(copyProblems(shadowed, leaked), [
    "work: config.shadowHomePath still points at prod",
  ]);
});

NodeTest.test(
  "codex seeds read the account the prod layout uses, with ~ and blank resolved",
  () => {
    const to = { home: "/s/home", shadowHome: "/s/shadow" };
    NodeAssert.deepEqual(
      codexSeeds({ homePath: "~/.codex-a", shadowHomePath: "~/acct" }, to, "/h").map((s) => [
        s.from,
        s.to,
      ]),
      [
        ["/h/acct/auth.json", "/s/shadow/auth.json"],
        ["/h/.codex-a/config.toml", "/s/home/config.toml"],
      ],
    );
    NodeAssert.deepEqual(
      codexSeeds({ homePath: " " }, to, "/h").map((s) => s.from),
      ["/h/.codex/auth.json", "/h/.codex/config.toml"],
    );
    NodeAssert.equal(codexSeeds(undefined, to, "/h")[0].from, "/h/.codex/auth.json");
  },
);

NodeTest.test(
  "a setup failure partway through credential copies leaves no copy behind",
  async () => {
    const dir = tempDir();
    const home = NodePath.join(dir, "home");
    NodeFS.mkdirSync(NodePath.join(home, ".codex"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(home, ".codex/auth.json"), "{}");
    NodeFS.writeFileSync(NodePath.join(home, ".codex/config.toml"), "");
    const work = NodePath.join(dir, "work");
    const userdata = NodePath.join(work, "base/userdata");
    NodeFS.mkdirSync(userdata, { recursive: true });
    const teardown = [];
    NodeAssert.throws(
      () =>
        stageScratch(
          {
            prod: {
              providerInstances: {
                codex: { driver: "codex", config: {} },
                second: { driver: "codex", config: { homePath: "~/missing" } },
              },
            },
            expected: [provider("codex", "codex"), provider("second", "codex")],
            work,
            userdata,
            prodUserdata: NodePath.join(dir, "prod-userdata"),
            home,
          },
          teardown,
        ),
      /ENOENT/,
    );
    NodeAssert.ok(NodeFS.existsSync(NodePath.join(work, "codex-home/codex/auth.json")));
    for (const step of teardown.reverse()) await step();
    const left = NodeFS.readdirSync(work, { recursive: true });
    NodeAssert.deepEqual(
      left.filter((f) => /auth\.json|config\.toml/.test(f)),
      [],
    );
    NodeFS.rmSync(dir, { recursive: true });
  },
);

NodeTest.test("only expected codex instances get a seeded home", async () => {
  const dir = tempDir();
  const work = NodePath.join(dir, "work");
  const userdata = NodePath.join(work, "base/userdata");
  NodeFS.mkdirSync(userdata, { recursive: true });
  const teardown = [];
  stageScratch(
    {
      prod: { providerInstances: { off: { driver: "codex", enabled: false, config: {} } } },
      expected: [],
      work,
      userdata,
      prodUserdata: dir,
      home: NodePath.join(dir, "no-home"),
    },
    teardown,
  );
  NodeAssert.ok(!NodeFS.existsSync(NodePath.join(work, "codex-home")));
  for (const step of teardown.reverse()) await step();
  NodeFS.rmSync(dir, { recursive: true });
});

NodeTest.test("prod env files cannot set T3CODE_ keys on the scratch server", () => {
  const dir = tempDir();
  const file = NodePath.join(dir, "service.env");
  NodeFS.writeFileSync(file, "T3CODE_TAILSCALE_SERVE=1\nT3CODE_DEV_AUTH_TOKEN=x\nPATH=/p\n");
  const env = serverEnv("/scratch/base", "/scratch/codex", [file]);
  NodeAssert.equal(env.PATH, "/p");
  NodeAssert.deepEqual(
    Object.keys(env)
      .filter((k) => k.startsWith("T3CODE_"))
      .sort(),
    [
      "T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
      "T3CODE_HOME",
      "T3CODE_NO_BROWSER",
      "T3CODE_TELEMETRY_ENABLED",
    ],
  );
  NodeFS.rmSync(dir, { recursive: true });
});

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

NodeTest.test("rows come from what the release enables, plus every instance prod enables", () => {
  const expected = [
    provider("claudeAgent", "claudeAgent"),
    provider("codex", "codex"),
    provider("cursor", "cursor"),
    provider("claudeLimbase", "claudeAgent"),
    provider("antigravity", "antigravity"),
    provider("old", "muse", false),
  ];
  const providers = [
    provider("claudeAgent", "claudeAgent"),
    provider("codex", "codex"),
    provider("cursor", "cursor"),
    provider("claudeLimbase", "claudeAgent"),
    provider("antigravity", "antigravity", false),
    provider("grok", "grok", false),
    provider("old", "muse", false),
  ];
  const rows = planRows(expected, providers, prod, { claudeLimbase: "claude-sonnet-5-5" });
  NodeAssert.deepEqual(
    rows.map((r) => [r.instance, r.model, r.error]),
    [
      ["claudeAgent", "claude-haiku-5-5", undefined],
      ["codex", "gpt-6-astra", undefined],
      ["cursor", "grok-4.7", undefined],
      ["claudeLimbase", "claude-sonnet-5-5", undefined],
      ["antigravity", "gemini-4-neon", "prod enables it, the release reports it disabled"],
    ],
  );
  NodeAssert.equal(rows.find((r) => r.instance === "codex").binaryPath, "/bin/codex");
  NodeAssert.equal(rows.find((r) => r.instance === "claudeAgent").binaryPath, "(managed)");
});

NodeTest.test("an instance the release drops, or one with no proof model, is a failure row", () => {
  const rows = planRows(
    [provider("cursor", "cursor"), provider("old", "muse", false)],
    [provider("fx", "fx"), provider("claudeAgent", "claudeAgent")],
    prod,
  );
  const byId = Object.fromEntries(rows.map((r) => [r.instance, r.error]));
  NodeAssert.equal(byId.fx, "no proof model for driver fx; pass --model fx=<slug>");
  NodeAssert.equal(byId.cursor, "prod enables it, the release does not list it");
  NodeAssert.ok(!("old" in byId));
});

NodeTest.test("an instance prod leaves disabled by its driver default gets no row", () => {
  const settings = { providerInstances: { muse: { driver: "muse", config: {} } } };
  const rows = planRows(
    [provider("muse", "muse", false)],
    [provider("muse", "muse", false)],
    settings,
  );
  NodeAssert.deepEqual(rows, []);
});

NodeTest.test("one malformed turn output fails only its row", async () => {
  const rows = [{ instance: "a" }, { instance: "b" }];
  await runTurns(rows, async (row) =>
    row.instance === "a"
      ? { code: 0, stdout: '{"threadId":"t1","status":"completed","reply":"pong"}\n' }
      : { code: 0, stdout: "{not json\n" },
  );
  NodeAssert.equal(rows[0].pass, true);
  NodeAssert.equal(rows[0].threadId, "t1");
  NodeAssert.equal(rows[1].pass, false);
  NodeAssert.match(rows[1].error, /unreadable turn output/);
});

NodeTest.test("archiving touches only this run's threads and notes leftovers", async () => {
  const title = (row) => `release-check n1 ${row.instance}`;
  const rows = [
    { instance: "a", threadId: "t-a", pass: true },
    { instance: "b", pass: false, error: "timeout" },
    { instance: "c", pass: false, error: "no model" },
  ];
  const archived = [];
  const notes = await archiveOwn(rows, {
    title,
    archive: async (id) => archived.push(id),
    show: async (id) => ({ thread: { archived: true, id } }),
    list: async () => [
      { threadId: "t-a", title: title({ instance: "a" }) },
      { threadId: "t-b", title: title({ instance: "b" }) },
      { threadId: "old", title: "release-check n0 c" },
    ],
  });
  NodeAssert.deepEqual(archived, ["t-a", "t-b"]);
  NodeAssert.equal(rows[2].threadId, undefined);
  NodeAssert.deepEqual(notes, ["Left alone 1 unarchived threads this run did not start: old"]);
});

NodeTest.test("an archive failure fails its own row with the reason", async () => {
  const rows = [{ instance: "a", threadId: "t-a", pass: true, reply: "pong" }];
  await archiveOwn(rows, {
    title: () => "",
    archive: async () => {
      throw new Error("socket closed");
    },
    show: async () => undefined,
    list: async () => [],
  });
  NodeAssert.match(
    renderTable(rows),
    /\| a \|.*\| FAIL \| pong \(archive failed: socket closed\) \| t-a \| no \|/,
  );
  NodeAssert.ok(!passed(rows));
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
