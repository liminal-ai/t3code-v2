#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

const USAGE = `t3v.mjs [--run <name>] <command>
  up                         start \`vp run dev\` here, wait for the pairing URL and both ports
  doctor                     read-only: is this worktree's dev server worth driving?
  settings [<key>=<json> ...] print the dev server's settings.json, or merge keys into it
  pair                       mint a fresh pairing URL with \`bin.ts pair\` (after the startup one is used)
  browser open               headless Chromium with its own profile, paired to the dev server
  browser goto <path>        load a path on the web origin, such as /settings
  browser shot <name>        screenshot to proof/<name>.png
  browser aria <name>        ARIA snapshot to proof/<name>.aria.txt
  browser text               print the page's visible text
  browser click (--role <role> (--name <name> | --name-prefix <text>) | --text <text> | --at <x>,<y>) [--in <text>] [--nth <n>]
  browser hover (--role <role> (--name <name> | --name-prefix <text>) | --text <text>) [--in <text>] [--nth <n>]
  browser fill --role <role> --name <name> --value <text>
  browser type <text>        type into whatever has focus
  browser scroll <dy> [--at <x>,<y>]  mouse wheel, down when dy is positive
  browser press <key>        Enter, Escape, Tab, Control+Enter, ...
  browser wait (--text <text> | --gone <text> | --role <role> (--name <name> | --name-prefix <text>)) [--timeout <ms>]
  browser close
  outcome workflow [<thread-id>]   read-only: the thread workflow logs
  outcome note <thread-id>         read-only: each workflow note the provider was sent
  outcome sql <select>             read-only: one query against statev2.sqlite
  down                       stop the browser and dev server this run started, by their PIDs
Options: --run <name> picks <main checkout>/.pstack/runs/<name>/ (default T3V_RUN, else verify-t3code).`;

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
};

const git = (...args) =>
  NodeChildProcess.execFileSync("git", args, { cwd: import.meta.dirname, encoding: "utf8" }).trim();
const worktree = git("rev-parse", "--show-toplevel");
const mainCheckout = NodePath.dirname(
  NodePath.resolve(worktree, git("rev-parse", "--git-common-dir")),
);
const runName = flag("run") ?? process.env.T3V_RUN ?? "verify-t3code";
const runDir = NodePath.join(mainCheckout, ".pstack", "runs", runName);
const scratch = NodePath.join(runDir, "scratch", "t3v", NodePath.basename(worktree));
const proof = NodePath.join(runDir, "proof");
const stateDir = NodePath.join(worktree, ".t3", "userdata");
const files = {
  devLog: NodePath.join(scratch, "dev.log"),
  devPgid: NodePath.join(scratch, "dev.pgid"),
  pairingUrl: NodePath.join(scratch, "pairing-url"),
  browser: NodePath.join(scratch, "browser.json"),
  profile: NodePath.join(scratch, "browser-profile"),
  runtime: NodePath.join(stateDir, "server-runtime.json"),
};
const LIVE_STATE_DIRS = [
  NodePath.join(NodeOS.homedir(), ".t3", "userdata"),
  NodePath.join(NodeOS.homedir(), "lim-v2", "service", "t3code", "prod", "data"),
];

const fail = (message) => {
  console.error(`t3v: ${message}`);
  process.exit(1);
};
const readJson = (file) =>
  NodeFS.existsSync(file) ? JSON.parse(NodeFS.readFileSync(file, "utf8")) : null;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const httpStatus = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return response.status;
  } catch {
    return null;
  }
};
const listeners = () => NodeChildProcess.execFileSync("ss", ["-H", "-ltnp"], { encoding: "utf8" });
const portOwner = (port) => {
  const line = listeners()
    .split("\n")
    .find((l) => new RegExp(`:${port}\\s`).test(l));
  return line ? Number(/pid=(\d+)/.exec(line)?.[1]) : null;
};
const runtime = () => readJson(files.runtime);
const webOrigin = () => {
  const devUrl = runtime()?.devUrl;
  if (!devUrl) fail(`no devUrl in ${files.runtime}; run \`t3v.mjs up\` first`);
  return new URL(devUrl).origin;
};

async function up() {
  const previous = runtime();
  if (previous && alive(previous.pid)) {
    fail(
      `a dev server (pid ${previous.pid}) already runs on ${stateDir}; drive it or stop it first`,
    );
  }
  for (const name of ["VITE_HTTP_URL", "VITE_WS_URL"]) {
    if (process.env[name]) fail(`${name} is set; unset it, dev is single-origin`);
  }
  NodeFS.mkdirSync(scratch, { recursive: true });
  const log = NodeFS.openSync(files.devLog, "w", 0o600);
  const child = NodeChildProcess.spawn("vp", ["run", "dev"], {
    cwd: worktree,
    detached: true,
    stdio: ["ignore", log, log],
  });
  NodeFS.writeFileSync(files.devPgid, String(child.pid));
  child.unref();
  console.log(`dev server pid ${child.pid} (process group), log ${files.devLog}`);

  const deadline = Date.now() + 180_000;
  let pairingUrl;
  while (!pairingUrl) {
    if (Date.now() > deadline) fail(`no pairing URL after 180s; read ${files.devLog}`);
    if (!alive(child.pid)) fail(`dev server exited; read ${files.devLog}`);
    pairingUrl = /pairingUrl: (\S+)/.exec(NodeFS.readFileSync(files.devLog, "utf8"))?.[1];
    await sleep(1000);
  }
  NodeFS.writeFileSync(files.pairingUrl, pairingUrl, { mode: 0o600 });
  const runner = /\[dev-runner\] mode=\S+ .*/.exec(NodeFS.readFileSync(files.devLog, "utf8"))?.[0];
  console.log(runner);
  const { port } = runtime();
  const origin = webOrigin();
  // The server prints its pairing URL before Vite listens, so both ports are polled to the deadline.
  const pending = new Map([
    [`server port ${port}`, `http://127.0.0.1:${port}/.well-known/t3/environment`],
    [`web origin ${origin}`, `${origin}/`],
  ]);
  while (pending.size > 0) {
    for (const [what, url] of pending) {
      if ((await httpStatus(url)) === 200) pending.delete(what);
    }
    if (pending.size === 0) break;
    if (Date.now() > deadline)
      fail(
        `${[...pending.keys()].join(" and ")} did not answer 200 by the startup deadline; read ${files.devLog}`,
      );
    if (!alive(child.pid)) fail(`dev server exited; read ${files.devLog}`);
    await sleep(1000);
  }
  console.log(`ready: server ${port}, web ${origin}, pairing URL in ${files.pairingUrl}`);
}

async function doctor() {
  const problems = [];
  const ok = (message) => console.log(`ok   ${message}`);
  const bad = (message) => {
    problems.push(message);
    console.log(`FAIL ${message}`);
  };
  const check = (pass, good, failure) => (pass ? ok(good) : bad(failure));
  const info = runtime();
  if (!info) {
    bad(`no ${files.runtime}: no dev server has started on this worktree's .t3`);
    process.exit(1);
  }
  check(alive(info.pid), `server pid ${info.pid} is alive`, `server pid ${info.pid} is gone`);
  const owner = portOwner(info.port);
  check(
    owner === info.pid,
    `port ${info.port} is owned by pid ${info.pid}`,
    `port ${info.port} is owned by ${owner ?? "nobody"}, not pid ${info.pid}`,
  );
  try {
    const cwd = NodeFS.readlinkSync(`/proc/${info.pid}/cwd`);
    check(
      cwd.startsWith(worktree),
      `server cwd ${cwd}`,
      `server cwd ${cwd} is outside ${worktree}`,
    );
    const open = NodeFS.readdirSync(`/proc/${info.pid}/fd`)
      .map((fd) => {
        try {
          return NodeFS.readlinkSync(`/proc/${info.pid}/fd/${fd}`);
        } catch {
          return "";
        }
      })
      .filter((target) => target.endsWith(".sqlite"));
    const live = open.filter((target) => LIVE_STATE_DIRS.some((dir) => target.startsWith(dir)));
    if (live.length > 0) bad(`server has the live install open: ${live.join(", ")}`);
    else if (open.some((target) => target === NodePath.join(stateDir, "statev2.sqlite")))
      ok(`state is ${stateDir}`);
    else
      bad(
        `server has no ${NodePath.join(stateDir, "statev2.sqlite")} open (${open.join(", ") || "none"})`,
      );
  } catch (error) {
    bad(`cannot read /proc/${info.pid}: ${error.message}`);
  }
  const envStatus = await httpStatus(`http://127.0.0.1:${info.port}/.well-known/t3/environment`);
  check(
    envStatus === 200,
    `server answers on ${info.port}`,
    `server on ${info.port} answered ${envStatus}`,
  );
  const origin = webOrigin();
  const webStatus = await httpStatus(`${origin}/`);
  check(webStatus === 200, `web answers on ${origin}`, `web on ${origin} answered ${webStatus}`);
  console.log(
    `info server ${info.serverVersion}, worktree HEAD ${git("rev-parse", "--short", "HEAD")}`,
  );
  const browser = readJson(files.browser);
  if (browser && alive(browser.pid)) {
    const session = await withPage((page) =>
      page.evaluate(() => fetch("/api/auth/session").then((r) => r.json())),
    );
    check(
      session.authenticated,
      "the t3v browser is paired",
      "the t3v browser is not paired; run `t3v.mjs pair`, then `browser open`",
    );
  } else {
    check(
      NodeFS.existsSync(files.pairingUrl),
      `pairing URL saved in ${files.pairingUrl} (unused until \`browser open\`)`,
      "no pairing URL saved; run `t3v.mjs pair`",
    );
  }
  if (problems.length > 0) process.exit(1);
}

function settings() {
  const file = NodePath.join(stateDir, "settings.json");
  const current = readJson(file) ?? {};
  for (const assignment of argv) {
    const at = assignment.indexOf("=");
    if (at < 1) fail(`expected <key>=<json>, got ${assignment}`);
    current[assignment.slice(0, at)] = JSON.parse(assignment.slice(at + 1));
  }
  if (argv.length > 0) {
    NodeFS.mkdirSync(stateDir, { recursive: true });
    NodeFS.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
  }
  console.log(`${file}\n${JSON.stringify(current, null, 2)}`);
}

function pair() {
  const out = NodeChildProcess.execFileSync(
    process.execPath,
    ["apps/server/src/bin.ts", "pair", "--base-dir", NodePath.join(worktree, ".t3")],
    { cwd: worktree, encoding: "utf8" },
  );
  const url = /https?:\/\/\S+#token=\S+/.exec(out)?.[0];
  if (!url) fail(`bin.ts pair printed no pairing URL:\n${out}`);
  NodeFS.mkdirSync(scratch, { recursive: true });
  NodeFS.writeFileSync(files.pairingUrl, url, { mode: 0o600 });
  console.log(`fresh pairing URL in ${files.pairingUrl}`);
}

const playwright = () =>
  NodeModule.createRequire(NodePath.join(worktree, "apps", "web", "package.json"))("playwright");

async function withPage(action) {
  const state = readJson(files.browser);
  if (!state || !alive(state.pid)) fail("no t3v browser; run `t3v.mjs browser open`");
  const browser = await playwright().chromium.connectOverCDP(state.cdp);
  const page = browser.contexts()[0].pages()[0];
  try {
    return await action(page);
  } finally {
    // Dropping the CDP connection leaves the browser and its page running for the next command.
    await browser.close().catch(() => {});
  }
}

const locate = (page) => {
  const role = flag("role");
  const name = flag("name");
  const prefix = flag("name-prefix");
  const text = flag("text");
  const within = flag("in");
  const nth = Number(flag("nth") ?? 0);
  const target = role
    ? page.getByRole(
        role,
        prefix ? { name: new RegExp(`^${RegExp.escape(prefix)}`) } : { name, exact: true },
      )
    : text
      ? page.getByText(text, { exact: true }).filter({ visible: true })
      : fail("give --role and --name, or --text");
  return (within ? innermostContaining(page, within, target).locator(target) : target).nth(nth);
};

const innermostContaining = (page, text, target) =>
  page.locator("*").filter({ hasText: text }).filter({ has: target }).last();

async function browserServe() {
  const context = await playwright().chromium.launchPersistentContext(files.profile, {
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ["--remote-debugging-port=0"],
    handleSIGTERM: false,
  });
  process.on("SIGTERM", () => context.close().finally(() => process.exit(0)));
  setInterval(() => {}, 1 << 30);
}

async function browserOpen() {
  const existing = readJson(files.browser);
  if (existing && alive(existing.pid)) fail(`t3v browser already runs (pid ${existing.pid})`);
  if (!NodeFS.existsSync(files.pairingUrl))
    fail("no pairing URL; run `t3v.mjs up` or `t3v.mjs pair`");
  NodeFS.rmSync(NodePath.join(files.profile, "DevToolsActivePort"), { force: true });
  const child = NodeChildProcess.spawn(
    process.execPath,
    [process.argv[1], "--run", runName, "__serve"],
    {
      cwd: worktree,
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
  const portFile = NodePath.join(files.profile, "DevToolsActivePort");
  for (let i = 0; i < 60 && !NodeFS.existsSync(portFile); i++) await sleep(500);
  if (!NodeFS.existsSync(portFile)) fail("Chromium did not start");
  const cdp = `http://127.0.0.1:${NodeFS.readFileSync(portFile, "utf8").split("\n")[0]}`;
  NodeFS.writeFileSync(files.browser, JSON.stringify({ pid: child.pid, cdp }));
  const pairingUrl = NodeFS.readFileSync(files.pairingUrl, "utf8").trim();
  await withPage(async (page) => {
    await page.goto(pairingUrl);
    await page.getByRole("navigation", { name: "Threads" }).waitFor({ timeout: 60_000 });
  });
  NodeFS.rmSync(files.pairingUrl);
  console.log(`browser pid ${child.pid}, paired, on ${webOrigin()}`);
}

async function browser(sub) {
  const timeout = Number(flag("timeout") ?? 15_000);
  switch (sub) {
    case "open":
      return browserOpen();
    case "close": {
      const state = readJson(files.browser);
      if (state && alive(state.pid)) process.kill(state.pid, "SIGTERM");
      NodeFS.rmSync(files.browser, { force: true });
      return console.log("browser closed");
    }
    case "goto":
      return withPage(async (page) => {
        await page.goto(new URL(argv[0] ?? "/", webOrigin()).href);
        console.log(page.url());
      });
    case "shot":
      return withPage(async (page) => {
        const file = NodePath.join(proof, `${argv[0] ?? "shot"}.png`);
        NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
        await page.screenshot({ path: file });
        console.log(file);
      });
    case "aria":
      return withPage(async (page) => {
        const file = NodePath.join(proof, `${argv[0] ?? "page"}.aria.txt`);
        NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
        NodeFS.writeFileSync(file, await page.locator("body").ariaSnapshot());
        console.log(file);
      });
    case "text":
      return withPage(async (page) => console.log(await page.locator("body").innerText()));
    case "click": {
      const at = flag("at");
      return withPage(async (page) => {
        if (at) {
          const [x, y] = at.split(",").map(Number);
          await page.mouse.click(x, y);
        } else await locate(page).click({ timeout });
        await page.waitForTimeout(300);
        console.log(`clicked; now ${page.url()}`);
      });
    }
    case "hover":
      return withPage(async (page) => {
        await locate(page).hover({ timeout });
        await page.waitForTimeout(300);
        console.log("hovered");
      });
    case "fill": {
      const value = flag("value");
      return withPage(async (page) => {
        await locate(page).fill(value ?? "", { timeout });
        console.log("filled");
      });
    }
    case "type":
      return withPage(async (page) => {
        await page.keyboard.type(argv.join(" "));
        console.log("typed");
      });
    case "scroll": {
      const at = flag("at");
      return withPage(async (page) => {
        if (at) await page.mouse.move(...at.split(",").map(Number));
        await page.mouse.wheel(0, Number(argv[0] ?? 400));
        await page.waitForTimeout(300);
        console.log("scrolled");
      });
    }
    case "press":
      return withPage(async (page) => {
        await page.keyboard.press(argv[0]);
        await page.waitForTimeout(300);
        console.log(`pressed ${argv[0]}`);
      });
    case "wait": {
      const text = flag("text");
      const gone = flag("gone");
      return withPage(async (page) => {
        if (gone) {
          await page
            .getByText(gone, { exact: true })
            .first()
            .waitFor({ state: "detached", timeout });
          return console.log(`no "${gone}" on the page`);
        }
        const target = text ? page.getByText(text).filter({ visible: true }).first() : locate(page);
        await target.waitFor({ timeout });
        console.log("found");
      });
    }
    default:
      fail(`unknown browser command ${sub}\n${USAGE}`);
  }
}

// Codex records name the native thread; Claude records name the provider session, which
// carries the T3 thread id. Every provider logs into the file of whichever thread opened its
// session first, so read them all.
const providerLogLinesForThread = (threadId, nativeIds) => {
  const dir = NodePath.join(stateDir, "logs", "provider");
  const marks = [`:thread:${threadId}:`, ...nativeIds.map((id) => `"threadId":"${id}"`)];
  return NodeFS.readdirSync(dir)
    .flatMap((name) => NodeFS.readFileSync(NodePath.join(dir, name), "utf8").split("\n"))
    .filter((line) => marks.some((mark) => line.includes(mark)));
};

function outcome(sub) {
  if (sub === "workflow") {
    const dir = NodePath.join(stateDir, "thread-workflows", "threads");
    if (!NodeFS.existsSync(dir)) return console.log(`no workflow logs under ${dir}`);
    const wanted = argv[0];
    for (const name of NodeFS.readdirSync(dir).sort()) {
      if (wanted && name !== `${wanted}.jsonl`) continue;
      console.log(`# ${NodePath.join(dir, name)}`);
      process.stdout.write(NodeFS.readFileSync(NodePath.join(dir, name), "utf8"));
    }
    return;
  }
  if (sub === "note") {
    if (!argv[0]) fail("outcome note needs a thread id");
    const db = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, "statev2.sqlite"), {
      readOnly: true,
    });
    const rows = db
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id = ?",
      )
      .all(argv[0]);
    db.close();
    const nativeIds = rows.flatMap(
      (row) => /"nativeId":"([^"]+)"/.exec(row.payload_json)?.[1] ?? [],
    );
    const notes = new Set(
      providerLogLinesForThread(argv[0], nativeIds).flatMap(
        (line) => line.match(/<thread-workflow>.*?<\/thread-workflow>/g) ?? [],
      ),
    );
    for (const note of notes) console.log(`${JSON.parse(`"${note}"`)}\n`);
    if (notes.size === 0) console.log(`no workflow note sent to thread ${argv[0]}`);
    return;
  }
  if (sub === "sql") {
    const sql = argv.join(" ");
    if (!/^\s*(select|pragma|with)\b/i.test(sql))
      fail("outcome sql runs SELECT, WITH or PRAGMA only");
    const db = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, "statev2.sqlite"), {
      readOnly: true,
    });
    console.log(JSON.stringify(db.prepare(sql).all(), null, 2));
    db.close();
    return;
  }
  fail(`unknown outcome command ${sub}\n${USAGE}`);
}

function down() {
  const state = readJson(files.browser);
  if (state && alive(state.pid)) {
    process.kill(state.pid, "SIGTERM");
    console.log(`stopped browser pid ${state.pid}`);
  }
  NodeFS.rmSync(files.browser, { force: true });
  const devPgid = NodeFS.existsSync(files.devPgid)
    ? Number(NodeFS.readFileSync(files.devPgid, "utf8"))
    : null;
  if (devPgid && alive(devPgid)) {
    process.kill(-devPgid, "SIGTERM");
    console.log(`stopped dev server process group ${devPgid}`);
  } else console.log("no dev server started by t3v is running");
  NodeFS.rmSync(files.devPgid, { force: true });
  NodeFS.rmSync(files.pairingUrl, { force: true });
  console.log(`proof kept in ${proof}`);
}

const command = argv.shift();
const sub = command === "browser" || command === "outcome" ? argv.shift() : undefined;
switch (command) {
  case "up":
    await up();
    break;
  case "doctor":
    await doctor();
    break;
  case "settings":
    settings();
    break;
  case "pair":
    pair();
    break;
  case "browser":
    await browser(sub);
    break;
  case "outcome":
    outcome(sub);
    break;
  case "down":
    down();
    break;
  case "__serve":
    await browserServe();
    break;
  default:
    console.log(USAGE);
    process.exit(command ? 1 : 0);
}
