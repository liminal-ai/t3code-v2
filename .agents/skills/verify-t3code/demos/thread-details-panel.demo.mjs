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
const VIEWPORT = { width: 1440, height: 680 };
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
  for (const item of ["Usage limits", "Context window"]) {
    // Automations shows at full density, which the default window gives both sides.
    await card.getByText("Automations", { exact: true }).click({ button: "right" });
    const option = page.getByRole("menuitemcheckbox", { name: item });
    await option.waitFor();
    if ((await option.getAttribute("aria-checked")) !== "true") await option.click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
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

  await page.setViewportSize(VIEWPORT);
  await sidebar.locator(sidebarRow(PLAIN)).first().click();
  await card.waitFor();
  await page.mouse.move(VIEWPORT.width / 2, 8);
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
const LIMBASE_ROW = sidebarRow(LIMBASE);
const ROW = "role=button[name=/^Limbase compaction:/]";
const EDITOR = 'role=dialog[name="Limbase compaction"]';
const DOWN_TO = 'role=textbox[name="Down to"]';
const PINNED = "[data-testid=thread-details-agent-row]";

const typeKeys = (startMs, keys) =>
  keys.map((key, index) => ({ atMs: startMs + index * 120, action: "press", key }));

const plain = {
  id: "plain",
  say: "At this window height, a plain thread's details show the machine, Commit, Automations and Previous agents.",
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
      say: "Open a Limbase thread that is pinned as an agent. A pinned block and a tall settings card push the machine, Commit, Automations and Previous agents out.",
      caption: "The Limbase thread loses sections",
      ready: LIMBASE_ROW,
      highlight: [CARD],
      steps: [{ atMs: 1200, action: "click", target: LIMBASE_ROW }],
      tailMs: 1600,
    },
  ],
  after: [
    plain,
    {
      id: "limbase",
      say: "Open the same Limbase thread, pinned as an agent. Every section stays, and its two rows sit at the foot, under Context.",
      caption: "Every section stays",
      ready: LIMBASE_ROW,
      highlight: [CARD],
      steps: [{ atMs: 1200, action: "click", target: LIMBASE_ROW }],
      tailMs: 1600,
      key: true,
    },
    {
      id: "editor",
      say: "Limbase compaction is one row with the policy Limbase holds. Click it to edit both values side by side.",
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
      id: "pinned",
      say: "Pinned as agent is one row at the foot, with Unpin a click away.",
      caption: "Pinned as agent, one row",
      ready: PINNED,
      highlight: [PINNED],
      steps: [{ atMs: 300, action: "click", target: `${PINNED} >> text=Pinned as agent` }],
      tailMs: 1400,
    },
  ],
};
