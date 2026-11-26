// A Limbase agent thread's details panel against a plain thread's, at a height where the plain
// panel just shows everything. Needs Claude instances `claudeAgent` and `claudeLimbase` and the
// model gateway; the Limbase thread's turns run before its instance gets a home, so no lane.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const PROJECT = "orbit-notes";
const PLAIN = "Plan the 0.4 release";
const LIMBASE = "Write the sync design note";
const INSTANCE = "claudeLimbase";
// The recorder's frame is 1440x900. This CSS page at that scale fills it and is short enough that
// the old rows push sections out; at this width the card is the floating panel narrow windows get.
const PAGE = { width: 1080, height: 675 };
const FRAME_WIDTH = 1440;
const FIRST_TURN = {
  [PLAIN]: [
    "claudeAgent",
    "Read README.md and CHANGELOG.md with your shell tool, then summarise this project and what changed in two short paragraphs. Do not change files.",
  ],
  [LIMBASE]: [
    INSTANCE,
    "Read README.md and src/version.ts with your shell tool, then outline a short design note for the new sync feature in two short paragraphs. Do not change files.",
  ],
};
const SECOND_TURN =
  "Two things. First, with your T3 schedule tool, create two automations bound to this thread: one named 'Release checklist' that runs every 12 hours, and one named 'Morning summary' that runs every 24 hours. Do not run them now. Second, use the Task tool to have a subagent count the lines in CHANGELOG.md. Then reply in one short paragraph with the automation names and the count.";

const sqlString = (value) => `'${value.replaceAll("'", "''")}'`;
const sidebarRow = (title) => `role=button[name=/^${RegExp.escape(title)},/]`;

export async function seed({ page, t3v, checkout }) {
  const cli = (...args) =>
    execFile(process.execPath, ["apps/server/src/bin.ts", ...args, "--base-dir", ".t3"], {
      cwd: checkout,
      maxBuffer: 1 << 26,
    });
  const rows = async (sql) => JSON.parse(await t3v("outcome", "sql", sql));
  const folder = NodePath.join(checkout, ".t3", "demo-projects", PROJECT);
  const settingsFile = NodePath.join(checkout, ".t3", "userdata", "settings.json");
  const settings = () => JSON.parse(NodeFS.readFileSync(settingsFile, "utf8"));
  const instances = settings().providerInstances ?? {};
  if (instances[INSTANCE]?.driver !== "claudeAgent") {
    throw new Error(`the demo needs a Claude instance named ${INSTANCE} on ${checkout}`);
  }
  const home = NodePath.join(checkout, ".t3", "limbase-home");
  const setHome = (value) => {
    const next = structuredClone(settings().providerInstances);
    if (value === null) delete next[INSTANCE].config.limbaseHome;
    else next[INSTANCE].config.limbaseHome = value;
    return t3v("settings", `providerInstances=${JSON.stringify(next)}`);
  };

  if (
    (
      await rows(
        `select project_id from projection_projects where deleted_at is null and title = ${sqlString(PROJECT)}`,
      )
    ).length === 0
  ) {
    await initRepository(folder);
    await cli("project", "add", folder, "--title", PROJECT);
  }
  const missing = [];
  for (const title of [PLAIN, LIMBASE]) {
    const found = await rows(
      `select thread_id from orchestration_v2_projection_threads where deleted_at is null and title = ${sqlString(title)}`,
    );
    if (found.length === 0) missing.push(title);
  }
  if (missing.length > 0) {
    // Turns on the Limbase instance run before it has a home, so no Limbase lane is needed.
    await setHome(null);
    for (const title of missing) {
      const [provider, prompt] = FIRST_TURN[title];
      const { stdout } = await execFile(
        process.execPath,
        [
          NodePath.join(checkout, "apps/server/src/bin.ts"),
          "thread",
          "start",
          "--base-dir",
          NodePath.join(checkout, ".t3"),
          "--title",
          title,
          "--provider",
          provider,
          "--model",
          "claude-haiku-5-5",
          "--wait",
          "--json",
          ".",
          prompt,
        ],
        { cwd: folder, maxBuffer: 1 << 26 },
      );
      const { threadId } = JSON.parse(stdout);
      await cli("thread", "send", "--wait", "--json", threadId, SECOND_TURN);
    }
  }
  NodeFS.mkdirSync(home, { recursive: true });
  if (settings().providerInstances[INSTANCE].config.limbaseHome !== home) await setHome(home);

  const origin = new URL(page.url()).origin;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    ...PAGE,
    deviceScaleFactor: FRAME_WIDTH / PAGE.width,
    mobile: false,
  });
  // The owner's instance compacts at 700k down to 100k, as one with a home at first start does.
  await page.goto(`${origin}/settings/providers`);
  await page.getByRole("button", { name: "Select Claude Limbase", exact: true }).click();
  for (const [label, value] of [
    ["Limbase: compact at", "700k"],
    ["Limbase: down to", "100k"],
  ]) {
    const field = page.getByRole("textbox", { name: label, exact: true });
    await field.waitFor();
    if ((await field.inputValue()) === value) continue;
    await field.fill(value);
    await field.press("Enter");
    await page.waitForTimeout(800);
  }
  await page.goto(`${origin}/`);
  const sidebar = page.getByRole("navigation", { name: "Threads" });
  await sidebar.waitFor();
  const card = page.locator("[data-thread-details-card]").first();

  // The Limbase thread is an agent, as the owner's was; the plain thread is not.
  for (const [title, agent] of [
    [PLAIN, false],
    [LIMBASE, true],
  ]) {
    await sidebar.locator(sidebarRow(title)).first().click({ button: "right" });
    const item = page.getByRole("menuitem", {
      name: agent ? "Pin as agent" : "Unpin agent",
      exact: true,
    });
    if ((await item.count()) > 0) await item.click();
    else await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
  }

  // Visit the Limbase thread once, so its route is compiled, and clear any value it was given.
  await sidebar.locator(sidebarRow(LIMBASE)).first().click();
  const toggle = page.getByRole("button", { name: "Toggle thread details panel", exact: true });
  await toggle.waitFor();
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await card.waitFor();
  const row = page.getByRole("button", { name: /^Limbase compaction:/ });
  if ((await row.count()) > 0) await row.click();
  for (const label of ["Compact at", "Down to"]) {
    const field = page.getByRole("textbox", { name: label, exact: true });
    if ((await field.count()) === 0 || (await field.inputValue()) === "") continue;
    await field.fill("");
    await field.press("Enter");
    await page.waitForTimeout(600);
  }
  await page.keyboard.press("Escape");

  // The plain thread's panel is full at this height, so its Automations heading opens the menu.
  await sidebar.locator(sidebarRow(PLAIN)).first().click();
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await card.getByText("Automations", { exact: true }).waitFor();
  for (const item of ["Usage limits", "Context window"]) {
    await card.getByText("Automations", { exact: true }).click({ button: "right" });
    const option = page.getByRole("menuitemcheckbox", { name: item });
    await option.waitFor();
    if ((await option.getAttribute("aria-checked")) !== "true") await option.click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await card.waitFor();
  await page.mouse.move(PAGE.width / 2, 8);
}

async function initRepository(folder) {
  if (NodeFS.existsSync(NodePath.join(folder, ".git"))) return;
  NodeFS.mkdirSync(NodePath.join(folder, "src"), { recursive: true });
  const git = (...args) =>
    execFile("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.invalid", ...args], {
      cwd: folder,
    });
  NodeFS.writeFileSync(NodePath.join(folder, "README.md"), "# Orbit notes\n\nA small notes app.\n");
  NodeFS.writeFileSync(
    NodePath.join(folder, "src/version.ts"),
    'export const version = "0.3.0";\n',
  );
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("commit", "-q", "-m", "Start the notes app");
  for (let entry = 1; entry <= 6; entry += 1) {
    NodeFS.appendFileSync(NodePath.join(folder, "CHANGELOG.md"), `- change ${entry}\n`);
    await git("add", "-A");
    await git("commit", "-q", "-m", `docs: changelog entry ${entry}`);
  }
  await git("switch", "-q", "-c", "release/0.4");
  NodeFS.writeFileSync(
    NodePath.join(folder, "src/version.ts"),
    'export const version = "0.4.0";\n',
  );
  await git("commit", "-qam", "chore: bump to 0.4.0");
  NodeFS.appendFileSync(
    NodePath.join(folder, "README.md"),
    "\n## Sync\n\nNotes sync across devices.\n",
  );
}

const CARD = "[data-thread-details-card]";
const DETAILS = 'role=button[name="Toggle thread details panel"]';
const LIMBASE_ROW = sidebarRow(LIMBASE);
const ROW = "role=button[name=/^Limbase compaction:/]";
const EDITOR = 'role=dialog[name="Limbase compaction"]';
const DOWN_TO = 'role=textbox[name="Down to"]';
const PINNED = "[data-testid=thread-details-agent-row]";

const typeKeys = (startMs, keys) =>
  keys.map((key, index) => ({ atMs: startMs + index * 120, action: "press", key }));

const plain = {
  id: "plain",
  say: "At this height, a plain thread's details show the machine, Commit, Automations and Previous agents.",
  caption: "A plain thread's details",
  ready: CARD,
  highlight: [CARD],
  tailMs: 1000,
};

export default {
  before: [
    plain,
    {
      id: "limbase",
      say: "On a Limbase thread pinned as an agent, a pinned block and a tall settings card push those sections out.",
      caption: "The Limbase thread loses sections",
      ready: LIMBASE_ROW,
      highlight: [CARD],
      steps: [
        { atMs: 900, action: "click", target: LIMBASE_ROW },
        { atMs: 2400, action: "click", target: DETAILS },
      ],
      tailMs: 1600,
    },
  ],
  after: [
    plain,
    {
      id: "limbase",
      say: "The same Limbase thread now keeps every section, with its two rows at the foot, under Context.",
      caption: "Every section stays",
      ready: LIMBASE_ROW,
      highlight: [CARD],
      steps: [
        { atMs: 900, action: "click", target: LIMBASE_ROW },
        { atMs: 2400, action: "click", target: DETAILS },
      ],
      tailMs: 1600,
      key: true,
    },
    {
      id: "editor",
      say: "Limbase compaction is one row. Click it to edit both values side by side.",
      caption: "Edit compaction on demand",
      ready: ROW,
      highlight: [ROW, EDITOR],
      steps: [{ action: "click", target: ROW }],
      tailMs: 1400,
    },
    {
      id: "refused",
      say: "A value the guards refuse says why, and nothing is saved.",
      caption: "A refused value",
      ready: DOWN_TO,
      highlight: [DOWN_TO],
      steps: [
        { atMs: 200, action: "click", target: DOWN_TO },
        ...typeKeys(600, ["8", "0", "0", "k", "Enter"]),
      ],
      tailMs: 1600,
    },
    {
      id: "kept",
      say: "Close the editor, and the row stays red. Reopen it, and the value and its reason are still there.",
      caption: "A refusal stays until fixed",
      ready: ROW,
      highlight: [ROW, EDITOR],
      steps: [
        { atMs: 300, action: "click", target: `${PINNED} >> text=Pinned as agent` },
        { atMs: 3200, action: "click", target: ROW },
      ],
      tailMs: 1400,
    },
    {
      id: "pinned",
      say: "Pinned as agent is one row, with Unpin a click away.",
      caption: "Pinned as agent, one row",
      ready: PINNED,
      highlight: [PINNED],
      steps: [{ atMs: 300, action: "click", target: `${PINNED} >> text=Pinned as agent` }],
      tailMs: 1400,
    },
  ],
};
