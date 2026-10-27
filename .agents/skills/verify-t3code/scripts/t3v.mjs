#!/usr/bin/env node
// t3v.mjs: launch, check, drive and tear down a T3 Code dev server from this worktree.
// Usage is in ../SKILL.md. It always drives the worktree that holds this copy of the script.
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  browser click (--role <role> --name <name> | --text <text> | --at <x>,<y>) [--in <text>] [--nth <n>]
  browser fill --role <role> --name <name> --value <text>
  browser type <text>        type into whatever has focus
  browser scroll <dy> [--at <x>,<y>]  mouse wheel, down when dy is positive
  browser press <key>        Enter, Escape, Tab, Control+Enter, ...
  browser wait (--text <text> | --gone <text> | --role <role> --name <name>) [--timeout <ms>]
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
  execFileSync("git", args, { cwd: import.meta.dirname, encoding: "utf8" }).trim();
const worktree = git("rev-parse", "--show-toplevel");
const mainCheckout = path.dirname(path.resolve(worktree, git("rev-parse", "--git-common-dir")));
const runName = flag("run") ?? process.env.T3V_RUN ?? "verify-t3code";
const runDir = path.join(mainCheckout, ".pstack", "runs", runName);
const scratch = path.join(runDir, "scratch", "t3v", path.basename(worktree));
const proof = path.join(runDir, "proof");
const stateDir = path.join(worktree, ".t3", "userdata");
const files = {
  devLog: path.join(scratch, "dev.log"),
  devPid: path.join(scratch, "dev.pid"),
  pairingUrl: path.join(scratch, "pairing-url"),
  browser: path.join(scratch, "browser.json"),
  profile: path.join(scratch, "browser-profile"),
  runtime: path.join(stateDir, "server-runtime.json"),
};
const LIVE_STATE_DIRS = [
  path.join(os.homedir(), ".t3", "userdata"),
  path.join(os.homedir(), "lim-v2", "service", "t3code", "prod", "data"),
];

const fail = (message) => {
  console.error(`t3v: ${message}`);
  process.exit(1);
};
const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);
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
const listeners = () => execFileSync("ss", ["-H", "-ltnp"], { encoding: "utf8" });
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
  fs.mkdirSync(scratch, { recursive: true });
  const log = fs.openSync(files.devLog, "w", 0o600);
  const child = spawn("vp", ["run", "dev"], {
    cwd: worktree,
    detached: true,
    stdio: ["ignore", log, log],
  });
  fs.writeFileSync(files.devPid, String(child.pid));
  child.unref();
  console.log(`dev server pid ${child.pid} (process group), log ${files.devLog}`);

  const deadline = Date.now() + 180_000;
  let pairingUrl;
  while (!pairingUrl) {
    if (Date.now() > deadline) fail(`no pairing URL after 180s; read ${files.devLog}`);
    if (!alive(child.pid)) fail(`dev server exited; read ${files.devLog}`);
    pairingUrl = /pairingUrl: (\S+)/.exec(fs.readFileSync(files.devLog, "utf8"))?.[1];
    await sleep(1000);
  }
  fs.writeFileSync(files.pairingUrl, pairingUrl, { mode: 0o600 });
  const runner = /\[dev-runner\] mode=\S+ .*/.exec(fs.readFileSync(files.devLog, "utf8"))?.[0];
  console.log(runner);
  const { port } = runtime();
  const origin = webOrigin();
  if ((await httpStatus(`http://127.0.0.1:${port}/.well-known/t3/environment`)) !== 200)
    fail(`server port ${port} does not answer`);
  if ((await httpStatus(`${origin}/`)) !== 200) fail(`web origin ${origin} does not answer`);
  console.log(`ready: server ${port}, web ${origin}, pairing URL in ${files.pairingUrl}`);
}

async function doctor() {
  const problems = [];
  const ok = (message) => console.log(`ok   ${message}`);
  const bad = (message) => {
    problems.push(message);
    console.log(`FAIL ${message}`);
  };
  const info = runtime();
  if (!info) {
    bad(`no ${files.runtime}: no dev server has started on this worktree's .t3`);
    process.exit(1);
  }
  alive(info.pid) ? ok(`server pid ${info.pid} is alive`) : bad(`server pid ${info.pid} is gone`);
  const owner = portOwner(info.port);
  owner === info.pid
    ? ok(`port ${info.port} is owned by pid ${info.pid}`)
    : bad(`port ${info.port} is owned by ${owner ?? "nobody"}, not pid ${info.pid}`);
  try {
    const cwd = fs.readlinkSync(`/proc/${info.pid}/cwd`);
    cwd.startsWith(worktree)
      ? ok(`server cwd ${cwd}`)
      : bad(`server cwd ${cwd} is outside ${worktree}`);
    const open = fs
      .readdirSync(`/proc/${info.pid}/fd`)
      .map((fd) => {
        try {
          return fs.readlinkSync(`/proc/${info.pid}/fd/${fd}`);
        } catch {
          return "";
        }
      })
      .filter((target) => target.endsWith(".sqlite"));
    const live = open.filter((target) => LIVE_STATE_DIRS.some((dir) => target.startsWith(dir)));
    if (live.length > 0) bad(`server has the live install open: ${live.join(", ")}`);
    else if (open.some((target) => target === path.join(stateDir, "statev2.sqlite")))
      ok(`state is ${stateDir}`);
    else
      bad(
        `server has no ${path.join(stateDir, "statev2.sqlite")} open (${open.join(", ") || "none"})`,
      );
  } catch (error) {
    bad(`cannot read /proc/${info.pid}: ${error.message}`);
  }
  const envStatus = await httpStatus(`http://127.0.0.1:${info.port}/.well-known/t3/environment`);
  envStatus === 200
    ? ok(`server answers on ${info.port}`)
    : bad(`server on ${info.port} answered ${envStatus}`);
  const origin = webOrigin();
  const webStatus = await httpStatus(`${origin}/`);
  webStatus === 200
    ? ok(`web answers on ${origin}`)
    : bad(`web on ${origin} answered ${webStatus}`);
  console.log(
    `info server ${info.serverVersion}, worktree HEAD ${git("rev-parse", "--short", "HEAD")}`,
  );
  const browser = readJson(files.browser);
  if (browser && alive(browser.pid)) {
    const session = await withPage((page) =>
      page.evaluate(() => fetch("/api/auth/session").then((r) => r.json())),
    );
    session.authenticated
      ? ok("the t3v browser is paired")
      : bad("the t3v browser is not paired; run `t3v.mjs pair`, then `browser open`");
  } else {
    fs.existsSync(files.pairingUrl)
      ? ok(`pairing URL saved in ${files.pairingUrl} (unused until \`browser open\`)`)
      : bad("no pairing URL saved; run `t3v.mjs pair`");
  }
  if (problems.length > 0) process.exit(1);
}

function settings() {
  const file = path.join(stateDir, "settings.json");
  const current = readJson(file) ?? {};
  for (const assignment of argv) {
    const at = assignment.indexOf("=");
    if (at < 1) fail(`expected <key>=<json>, got ${assignment}`);
    current[assignment.slice(0, at)] = JSON.parse(assignment.slice(at + 1));
  }
  if (argv.length > 0) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
  }
  console.log(`${file}\n${JSON.stringify(current, null, 2)}`);
}

function pair() {
  const out = execFileSync(
    process.execPath,
    ["apps/server/src/bin.ts", "pair", "--base-dir", path.join(worktree, ".t3")],
    { cwd: worktree, encoding: "utf8" },
  );
  const url = /https?:\/\/\S+#token=\S+/.exec(out)?.[0];
  if (!url) fail(`bin.ts pair printed no pairing URL:\n${out}`);
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(files.pairingUrl, url, { mode: 0o600 });
  console.log(`fresh pairing URL in ${files.pairingUrl}`);
}

const playwright = () =>
  createRequire(path.join(worktree, "apps", "web", "package.json"))("playwright");

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
  const text = flag("text");
  const within = flag("in");
  const nth = Number(flag("nth") ?? 0);
  const target = role
    ? page.getByRole(role, { name, exact: true })
    : text
      ? page.getByText(text, { exact: true }).filter({ visible: true })
      : fail("give --role and --name, or --text");
  if (!within) return target.nth(nth);
  // The innermost element holding both the text and the target, such as one card in a list.
  const scope = page.locator("*").filter({ hasText: within }).filter({ has: target }).last();
  return scope.locator(target).nth(nth);
};

async function browserServe() {
  const context = await playwright().chromium.launchPersistentContext(files.profile, {
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ["--remote-debugging-port=0"],
    handleSIGTERM: false,
  });
  // This process owns the browser, so `down` stops both through this PID.
  process.on("SIGTERM", () => context.close().finally(() => process.exit(0)));
  setInterval(() => {}, 1 << 30);
}

async function browserOpen() {
  const existing = readJson(files.browser);
  if (existing && alive(existing.pid)) fail(`t3v browser already runs (pid ${existing.pid})`);
  if (!fs.existsSync(files.pairingUrl)) fail("no pairing URL; run `t3v.mjs up` or `t3v.mjs pair`");
  fs.rmSync(path.join(files.profile, "DevToolsActivePort"), { force: true });
  const child = spawn(process.execPath, [process.argv[1], "--run", runName, "__serve"], {
    cwd: worktree,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const portFile = path.join(files.profile, "DevToolsActivePort");
  for (let i = 0; i < 60 && !fs.existsSync(portFile); i++) await sleep(500);
  if (!fs.existsSync(portFile)) fail("Chromium did not start");
  const cdp = `http://127.0.0.1:${fs.readFileSync(portFile, "utf8").split("\n")[0]}`;
  fs.writeFileSync(files.browser, JSON.stringify({ pid: child.pid, cdp }));
  const pairingUrl = fs.readFileSync(files.pairingUrl, "utf8").trim();
  await withPage(async (page) => {
    await page.goto(pairingUrl);
    await page.getByRole("navigation", { name: "Threads" }).waitFor({ timeout: 60_000 });
  });
  fs.rmSync(files.pairingUrl);
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
      fs.rmSync(files.browser, { force: true });
      return console.log("browser closed");
    }
    case "goto":
      return withPage(async (page) => {
        await page.goto(new URL(argv[0] ?? "/", webOrigin()).href);
        console.log(page.url());
      });
    case "shot":
      return withPage(async (page) => {
        const file = path.join(proof, `${argv[0] ?? "shot"}.png`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await page.screenshot({ path: file });
        console.log(file);
      });
    case "aria":
      return withPage(async (page) => {
        const file = path.join(proof, `${argv[0] ?? "page"}.aria.txt`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, await page.locator("body").ariaSnapshot());
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

function outcome(sub) {
  if (sub === "workflow") {
    const dir = path.join(stateDir, "thread-workflows", "threads");
    if (!fs.existsSync(dir)) return console.log(`no workflow logs under ${dir}`);
    const wanted = argv[0];
    for (const name of fs.readdirSync(dir).sort()) {
      if (wanted && name !== `${wanted}.jsonl`) continue;
      console.log(`# ${path.join(dir, name)}`);
      process.stdout.write(fs.readFileSync(path.join(dir, name), "utf8"));
    }
    return;
  }
  if (sub === "note") {
    if (!argv[0]) fail("outcome note needs a thread id");
    const db = new DatabaseSync(path.join(stateDir, "statev2.sqlite"), { readOnly: true });
    const rows = db
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id = ?",
      )
      .all(argv[0]);
    db.close();
    const nativeIds = rows.flatMap(
      (row) => /"nativeId":"([^"]+)"/.exec(row.payload_json)?.[1] ?? [],
    );
    if (nativeIds.length === 0) fail(`thread ${argv[0]} has no provider thread yet`);
    // A shared provider session logs every thread it serves into the file of the first one.
    const dir = path.join(stateDir, "logs", "provider");
    const notes = new Set();
    for (const name of fs.readdirSync(dir)) {
      for (const line of fs.readFileSync(path.join(dir, name), "utf8").split("\n")) {
        if (!nativeIds.some((id) => line.includes(`"threadId":"${id}"`))) continue;
        for (const note of line.match(/<thread-workflow>.*?<\/thread-workflow>/g) ?? [])
          notes.add(note);
      }
    }
    for (const note of notes) console.log(`${JSON.parse(`"${note}"`)}\n`);
    if (notes.size === 0) console.log(`no workflow note sent to ${nativeIds.join(", ")}`);
    return;
  }
  if (sub === "sql") {
    const sql = argv.join(" ");
    if (!/^\s*(select|pragma|with)\b/i.test(sql))
      fail("outcome sql runs SELECT, WITH or PRAGMA only");
    const db = new DatabaseSync(path.join(stateDir, "statev2.sqlite"), { readOnly: true });
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
  fs.rmSync(files.browser, { force: true });
  const pid = fs.existsSync(files.devPid) ? Number(fs.readFileSync(files.devPid, "utf8")) : null;
  if (pid && alive(pid)) {
    // `up` started the dev server as its own process group, so this reaches vp, the runner,
    // the server and Vite, and nothing else.
    process.kill(-pid, "SIGTERM");
    console.log(`stopped dev server process group ${pid}`);
  } else console.log("no dev server started by t3v is running");
  fs.rmSync(files.devPid, { force: true });
  fs.rmSync(files.pairingUrl, { force: true });
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
