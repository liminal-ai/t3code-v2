import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const PROJECT = "release-notes";
const THREAD = "Draft the release notes";
const INSTANCE = "claudeLimbase";
const MODEL = "Claude Haiku 5.5, Medium";
const UNCATALOGED = "claude-sonnet-4-5-20250929";

const sqlString = (value) => `'${value.replaceAll("'", "''")}'`;

export async function seed({ page, t3v, checkout }) {
  const cli = (...args) =>
    execFile(process.execPath, ["apps/server/src/bin.ts", ...args, "--base-dir", ".t3"], {
      cwd: checkout,
    });
  const rows = async (sql) => JSON.parse(await t3v("outcome", "sql", sql));
  const folder = NodePath.join(checkout, ".t3", "demo-projects", PROJECT);

  const serverRoot = NodePath.join(checkout, "apps", "server");
  if (
    (
      await rows(
        `select project_id from projection_projects where deleted_at is null and workspace_root = ${sqlString(serverRoot)}`,
      )
    ).length > 0
  ) {
    await cli("project", "remove", serverRoot, "--force");
  }
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
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/settings/providers`);
  await page
    .getByRole("button", { name: "Select Claude Limbase", exact: true })
    .click({ timeout: 15_000 })
    .catch(() => {
      throw new Error(
        `the demo needs the ${INSTANCE} instance of features/thread-settings.md, with ${UNCATALOGED} in its custom models, on ${checkout}`,
      );
    });
  await clearTo(page, "Limbase: compact at", "700k");
  await clearTo(page, "Limbase: down to", "100k");
  if (
    (
      await rows(
        `select thread_id from orchestration_v2_projection_threads where deleted_at is null and title = ${sqlString(THREAD)}`,
      )
    ).length === 0
  ) {
    await cli(
      "thread",
      "start",
      folder,
      "Reply with the single word ready. Do not call tools or change files.",
      "--title",
      THREAD,
      "--provider",
      INSTANCE,
      "--model",
      "claude-haiku-5-5",
      "--wait",
    ).catch((error) => {
      throw new Error(
        `the demo's Limbase turn failed; is the Limbase lane up? ${error.stderr ?? error.message}`,
      );
    });
  }
  await page.goto(`${origin}/`);

  const sidebar = page.getByRole("navigation", { name: "Threads" });
  await sidebar.waitFor();
  await sidebar.getByRole("button", { name: new RegExp(`^${RegExp.escape(THREAD)},`) }).click();
  const toggle = page.getByRole("button", { name: "Toggle thread details panel", exact: true });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  const picker = page
    .getByRole("button", { name: new RegExp(`^(${RegExp.escape(MODEL)}|claude-)`) })
    .first();
  await picker.waitFor();
  if ((await page.getByRole("button", { name: MODEL, exact: true }).count()) === 0) {
    await picker.click();
    const haiku = page.getByRole("option", { name: /^Claude Haiku 5\.5 , Claude Limbase/ });
    await haiku.waitFor();
    await page.waitForTimeout(600);
    await haiku.click({ force: true });
    await page.getByRole("button", { name: MODEL, exact: true }).waitFor();
  }
  await clearTo(page, "Compact at", "");
  await clearTo(page, "Down to", "");
}

async function clearTo(page, label, value) {
  const field = page.getByRole("textbox", { name: label, exact: true });
  if ((await field.count()) === 0) return;
  if ((await field.inputValue()) === value) return;
  await field.fill(value);
  await field.press("Enter");
  await page.waitForTimeout(500);
}

async function initRepository(folder) {
  if (NodeFS.existsSync(NodePath.join(folder, ".git"))) return;
  NodeFS.mkdirSync(folder, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(folder, "NOTES.md"), "# Release notes\n");
  const git = (...args) => execFile("git", args, { cwd: folder });
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git(
    "-c",
    "user.name=Demo",
    "-c",
    "user.email=demo@example.invalid",
    "commit",
    "-q",
    "-m",
    "Start",
  );
}

const DETAILS = 'role=button[name="Toggle thread details panel"]';
const CARD = 'role=region[name="Thread settings"]';
const DOWN_TO = 'role=textbox[name="Down to"]';
const PICKER = `role=button[name="${MODEL}"]`;
const UNCATALOGED_OPTION = `role=option[name=/^${UNCATALOGED} ,/]`;
const WINDOW_LINE = `${CARD} >> text=/window/`;
const SETTINGS = 'role=button[name="Settings"]';
const PROVIDERS = 'role=button[name="Providers"]';
const INSTANCE_ROW = 'role=button[name="Select Claude Limbase"]';
const SETTINGS_CONTENT = 'role=region[name="Settings content"]';
const INSTANCE_FIELDS = [
  'role=textbox[name="Limbase: compact at"]',
  'role=textbox[name="Limbase: down to"]',
];

const typeKeys = (startMs, keys) =>
  keys.map((key, index) => ({ atMs: startMs + index * 120, action: "press", key }));

export default {
  before: [
    {
      id: "panel",
      say: "Before, a Limbase thread's details had nothing to tune. Every Limbase thread compacted at 700k tokens down to 100k, fixed in code.",
      caption: "Compaction fixed in code",
      ready: DETAILS,
      highlight: ['role=region[name="Workspace"]'],
      tailMs: 1200,
    },
  ],
  after: [
    {
      id: "card",
      say: "Now a Limbase thread has Thread settings. Each empty field shows what it inherits, here its instance's 700k and 100k.",
      caption: "Thread settings card",
      ready: CARD,
      highlight: [CARD],
      tailMs: 1200,
    },
    {
      id: "guard",
      say: "A value the guards refuse never leaves the card. Its alert goes once the field is back to its saved value.",
      caption: "Guards refuse bad values",
      ready: DOWN_TO,
      highlight: [DOWN_TO],
      steps: [
        { atMs: 200, action: "click", target: DOWN_TO },
        ...typeKeys(700, ["8", "0", "0", "k", "Enter"]),
        { atMs: 3000, action: "click", target: DOWN_TO },
        { atMs: 3300, action: "press", key: "Control+A" },
        ...typeKeys(3600, ["Backspace", "Enter"]),
      ],
      tailMs: 1800,
    },
    {
      id: "save",
      say: "Fifteen percent of this model's window is saved, and Limbase holds the new policy at once.",
      caption: "Saved and applied",
      ready: DOWN_TO,
      highlight: [DOWN_TO, `${CARD} >> text=/→/`],
      steps: [
        { atMs: 200, action: "click", target: DOWN_TO },
        { atMs: 500, action: "press", key: "Control+A" },
        ...typeKeys(800, ["1", "5", "%", "Enter"]),
      ],
      tailMs: 2000,
      key: true,
    },
    {
      id: "unknown",
      say: "Pick a model Claude has not reported a window for, and the card says so. Its fifteen percent waits, and Limbase keeps the policy it holds.",
      caption: "Unknown window waits",
      ready: PICKER,
      highlight: [PICKER, WINDOW_LINE],
      steps: [
        { atMs: 300, action: "click", target: PICKER },
        { atMs: 1800, action: "click", target: UNCATALOGED_OPTION },
      ],
      tailMs: 2200,
    },
    {
      id: "instance",
      say: "A Limbase instance carries the same two fields for its threads to inherit. A change here reaches each running thread at its next turn, with no restart.",
      caption: "Defaults for every thread",
      ready: SETTINGS,
      highlight: INSTANCE_FIELDS,
      steps: [
        { atMs: 200, action: "click", target: SETTINGS },
        { atMs: 1400, action: "click", target: PROVIDERS },
        { atMs: 2800, action: "click", target: INSTANCE_ROW },
        { atMs: 4000, action: "scroll", dy: 520, target: SETTINGS_CONTENT },
        { atMs: 5200, action: "click", target: INSTANCE_FIELDS[0] },
        { atMs: 5500, action: "press", key: "Control+A" },
        ...typeKeys(5800, ["6", "0", "%", "Enter"]),
      ],
      tailMs: 2000,
    },
  ],
};
