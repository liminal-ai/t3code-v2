import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const PROJECTS = ["web-client", "api-server", "release-tools"];
const THREADS_OLDEST_FIRST = [
  ["web-client", "Fix the settings page tab order"],
  ["api-server", "Paginate the audit log endpoint"],
  ["release-tools", "Tag the weekly build"],
  ["web-client", "Add dark mode to onboarding"],
  ["api-server", "Lead: API reliability"],
  ["api-server", "Retry webhook deliveries with backoff"],
  ["release-tools", "Check the changelog generator"],
  ["web-client", "Profile the thread list scroll"],
  ["api-server", "Migrate sessions to the new store"],
  ["release-tools", "Sign the desktop artifacts"],
  ["web-client", "Trim the composer bundle"],
  ["release-tools", "Lead: release train"],
  ["api-server", "Rate-limit the search API"],
  ["web-client", "Review the image upload retry"],
  ["release-tools", "Update the install script"],
  ["api-server", "Add health checks to the worker"],
  ["web-client", "Draft the keyboard shortcuts doc"],
  ["web-client", "Lead: web client roadmap"],
  ["api-server", "Investigate the slow export job"],
  ["release-tools", "Smoke-test the nightly release"],
  ["web-client", "Polish the empty project state"],
  ["web-client", "Write the performance report"],
];
const SETTLED = [
  "Fix the settings page tab order",
  "Paginate the audit log endpoint",
  "Tag the weekly build",
  "Add dark mode to onboarding",
  "Check the changelog generator",
];

const sqlString = (value) => `'${value.replaceAll("'", "''")}'`;

export async function seed({ page, t3v, checkout }) {
  const cli = (...args) =>
    execFile(process.execPath, ["apps/server/src/bin.ts", ...args, "--base-dir", ".t3"], {
      cwd: checkout,
    });
  const titles = async (sql) =>
    new Set(JSON.parse(await t3v("outcome", "sql", sql)).map((row) => row.title));
  const projectFolder = (name) => NodePath.join(checkout, ".t3", "demo-projects", name);

  await removeCheckoutProject(cli, t3v, checkout);

  const projects = await titles("select title from projection_projects where deleted_at is null");
  for (const name of PROJECTS) {
    if (projects.has(name)) continue;
    await initOwnRepository(projectFolder(name));
    await cli("project", "add", projectFolder(name), "--title", name);
  }

  const threads = await titles(
    "select title from orchestration_v2_projection_threads where deleted_at is null",
  );
  for (const [project, title] of THREADS_OLDEST_FIRST) {
    if (threads.has(title)) continue;
    await cli(
      "thread",
      "start",
      projectFolder(project),
      "Summarize where this stands.",
      "--title",
      title,
      "--provider",
      "devReplay",
      "--model",
      "multi-turn",
      "--wait",
    );
  }

  const settled = await titles(
    `select title from orchestration_v2_projection_threads where json_extract(payload_json, '$.settledOverride') = 'settled' and title in (${SETTLED.map(sqlString).join(", ")})`,
  );
  await page.reload();
  const sidebar = page.getByRole("navigation", { name: "Threads" });
  await sidebar.waitFor();
  const row = (title) =>
    sidebar.getByRole("button", { name: new RegExp(`^${RegExp.escape(title)},`) });
  for (const title of SETTLED) {
    if (settled.has(title)) continue;
    await row(title).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Settle thread", exact: true }).click();
    await row(title).waitFor({ state: "hidden" });
  }
  const newest = THREADS_OLDEST_FIRST.at(-1)[1];
  await row(newest).click();
}

async function removeCheckoutProject(cli, t3v, checkout) {
  const root = NodePath.join(checkout, "apps", "server");
  const found = JSON.parse(
    await t3v(
      "outcome",
      "sql",
      `select project_id from projection_projects where deleted_at is null and workspace_root = ${sqlString(root)}`,
    ),
  );
  if (found.length > 0) await cli("project", "remove", root, "--force");
}

async function initOwnRepository(folder) {
  NodeFS.mkdirSync(folder, { recursive: true });
  const git = (...args) => execFile("git", args, { cwd: folder });
  await git("init", "-q", "-b", "main");
  await git(
    "-c",
    "user.name=Demo",
    "-c",
    "user.email=demo@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "Start",
  );
}

const SIDEBAR = 'role=navigation[name="Threads"]';
const LEAD_ROW = "role=button[name=/^Lead: web client roadmap,/]";
const AGENTS_HEADER = "role=button[name=/^Agents \\d/]";

export default {
  before: [
    {
      id: "sidebar",
      say: "This sidebar holds twenty-two threads. A few are lead threads that run other work for days.",
      caption: "A busy thread list",
      ready: LEAD_ROW,
      highlight: [LEAD_ROW],
    },
    {
      id: "menu",
      say: "Before this change, a lead thread's menu can only pin it like any other thread.",
      caption: "No way to mark agents",
      ready: LEAD_ROW,
      highlight: ['role=menuitem[name="Pin thread"]'],
      steps: [{ atMs: 300, action: "click", target: LEAD_ROW, button: "right" }],
      tailMs: 1200,
    },
  ],
  after: [
    {
      id: "menu",
      say: "Now right-click a lead thread. Pin as agent sits right under Pin thread.",
      caption: "Pin as agent in the menu",
      ready: LEAD_ROW,
      highlight: [LEAD_ROW, 'role=menuitem[name="Pin as agent"]'],
      steps: [{ atMs: 300, action: "click", target: LEAD_ROW, button: "right" }],
    },
    {
      id: "pin",
      say: "Choose it, and the thread leaves the active list.",
      caption: "Pin the lead thread",
      ready: 'role=menuitem[name="Pin as agent"]',
      highlight: ['role=menuitem[name="Pin as agent"]'],
      steps: [{ action: "click", target: 'role=menuitem[name="Pin as agent"]' }],
    },
    {
      id: "group",
      say: "It joins the Agents group at the bottom of the sidebar, one line per thread, with its status where the time goes.",
      caption: "The Agents group",
      ready: AGENTS_HEADER,
      highlight: [AGENTS_HEADER],
      steps: [{ atMs: 0, action: "scroll", dy: 3000, target: SIDEBAR }],
      tailMs: 1500,
      key: true,
    },
    {
      id: "details",
      say: "Open it, and the details pane says Pinned as agent.",
      caption: "Pinned as agent in details",
      ready: AGENTS_HEADER,
      highlight: ["text=Pinned as agent"],
      steps: [{ atMs: 300, action: "click", target: LEAD_ROW }],
      tailMs: 1200,
    },
    {
      id: "unpin",
      say: "Unpin returns it to the active list, and the empty group goes away.",
      caption: "Unpin returns it",
      ready: 'role=button[name="Unpin"]',
      highlight: ['role=button[name="Unpin"]'],
      steps: [{ action: "click", target: 'role=button[name="Unpin"]' }],
      tailMs: 1500,
    },
  ],
};
