#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const USAGE = `usage:
  release-check.mjs pre --release <unpacked release dir> --run <run folder> [--prod-settings <path>] [--model <instance>=<slug> ...]
  release-check.mjs smoke <host> --run <run folder> [--providers a,b] [--model <instance>=<slug> ...]
exit 0 when every checked instance replied pong and every thread was archived, 1 when any did not, 2 on bad usage`;

const HOME = NodeOS.homedir();
const PROD = NodePath.join(HOME, "lim-v2/service/t3code/prod");
const PROD_USERDATA = NodePath.join(PROD, "data/userdata");
const PROD_ENV_FILES = ["config/service.env", "config/cliproxy.env"].map((f) =>
  NodePath.join(PROD, f),
);
const ENVIRONMENTS = NodePath.join(HOME, "lim-v2/config/environments.json");
const LIM_THREAD = NodePath.join(HOME, "lim-v2/bin/lim-thread");
const LIMBASE_REPO = NodePath.join(HOME, "lim-v2/code/membase");
const LANE_SH = ".agents/skills/verify-limbase/scripts/lane.sh";
const RESERVED_PORTS = new Set([13977, 13987, 13995]);
const PROMPT = "Reply with the single word pong. Do not call tools or change files.";
const SMOKE_PROVIDERS = ["claudeAgent", "codex", "antigravity"];
const TURN_TIMEOUT_MS = 240_000;
const SCOPES = "--scope orchestration:read --scope orchestration:operate";

export const SAFETY_SETTINGS = {
  continueThreadsAfterServerUpdate: false,
  autoResumeLimitedThreads: false,
  snoozeLimitedThreads: false,
  sidebarAutoSettleOnMerge: false,
  sidebarAutoSettleAfterDays: null,
  worktreeCleanup: { mode: "off" },
  defaultAutoPull: false,
  enableProviderUpdateChecks: false,
  projectSettingsOverrides: {},
};

const sha256 = (text) => NodeCrypto.createHash("sha256").update(text).digest("hex");

export const DRIVERS = {
  claudeAgent: { model: "claude-haiku-5-5" },
  codex: { model: "gpt-6-astra" },
  cursor: {
    model: "grok-4.7",
    credentials: (id) => [`secrets/provider-auth-${sha256(`6:cursor${id}`)}.bin`],
  },
  antigravity: {
    model: "gemini-3.8-flash",
    credentials: (id) => [
      `providers/antigravity/${sha256(id)}/antigravity-acp/antigravity-oauth-token`,
    ],
  },
  muse: { model: "muse-ember-1.0" },
};

const isLimbase = (instance) =>
  instance.driver === "claudeAgent" && Boolean(instance.config?.limbaseHome);

export function copySettings(prod, { codexHome, limbaseHome }) {
  const instances = Object.entries(prod.providerInstances ?? {}).map(([id, instance]) => {
    if (instance.driver === "codex") {
      return [id, { ...instance, config: { ...instance.config, homePath: codexHome(id) } }];
    }
    if (isLimbase(instance))
      return [id, { ...instance, config: { ...instance.config, limbaseHome } }];
    return [id, instance];
  });
  return { ...prod, ...SAFETY_SETTINGS, providerInstances: Object.fromEntries(instances) };
}

export function copyProblems(prod, copy) {
  const problems = [];
  for (const [id, source] of Object.entries(prod.providerInstances ?? {})) {
    const copied = copy.providerInstances?.[id];
    if (!copied) {
      problems.push(`${id}: missing from the copy`);
      continue;
    }
    for (const key of new Set([...Object.keys(source), ...Object.keys(copied)])) {
      if (key !== "config" && JSON.stringify(source[key]) !== JSON.stringify(copied[key])) {
        problems.push(`${id}: ${key} changed`);
      }
    }
    for (const key of Object.keys(source.config ?? {})) {
      const moved =
        (key === "homePath" && source.driver === "codex") ||
        (key === "limbaseHome" && isLimbase(source));
      const same = JSON.stringify(source.config[key]) === JSON.stringify(copied.config?.[key]);
      if (moved && same) problems.push(`${id}: config.${key} still points at prod`);
      if (!moved && !same) problems.push(`${id}: config.${key} changed`);
    }
    if (source.driver === "codex" && !copied.config?.homePath)
      problems.push(`${id}: config.homePath missing`);
  }
  return problems;
}

const settingsEnabled = (instance) =>
  instance.enabled !== false && instance.config?.enabled !== false;

export function planRows(prod, providers, models = {}) {
  const reported = new Map(providers.map((p) => [p.instanceId, p]));
  const ids = new Set(providers.filter((p) => p.enabled).map((p) => p.instanceId));
  for (const [id, instance] of Object.entries(prod.providerInstances ?? {})) {
    if (settingsEnabled(instance)) ids.add(id);
  }
  return [...ids].map((instance) => {
    const entry = prod.providerInstances?.[instance];
    const provider = reported.get(instance);
    const driver = entry?.driver ?? provider?.driver;
    const row = {
      instance,
      driver,
      binaryPath: entry?.config?.binaryPath ?? "(managed)",
      model: models[instance] ?? DRIVERS[driver]?.model ?? "",
    };
    if (!provider) return { ...row, error: "prod enables it, the release does not list it" };
    if (!provider.enabled)
      return { ...row, error: "prod enables it, the release reports it disabled" };
    if (!row.model)
      return {
        ...row,
        error: `no proof model for driver ${driver}; pass --model ${instance}=<slug>`,
      };
    return row;
  });
}

export function pickPort(ssListing, from = 14100, to = 14999) {
  const busy = new Set([...ssListing.matchAll(/:(\d+)\s/g)].map((m) => Number(m[1])));
  for (let port = from; port <= to; port++) {
    if (!busy.has(port) && !RESERVED_PORTS.has(port)) return port;
  }
  throw new Error(`no free port in ${from}-${to}`);
}

export function parseEnvFile(text) {
  const env = {};
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) env[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return env;
}

export function parseModels(pairs = []) {
  return Object.fromEntries(
    pairs.map((pair) => {
      const at = pair.indexOf("=");
      if (at < 1 || at === pair.length - 1)
        throw new UsageError(`--model wants <instance>=<slug>, got ${pair}`);
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
  );
}

export const isPong = (turn) =>
  turn?.status === "completed" && /^\W*pong\W*$/i.test(turn.reply ?? "");

const cell = (value) =>
  String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ")
    .slice(0, 300);

export function renderTable(rows) {
  const head = [
    "instance",
    "driver",
    "binaryPath",
    "model",
    "result",
    "reply or error",
    "thread",
    "archived",
  ];
  const lines = rows.map((r) =>
    [
      r.instance,
      r.driver,
      r.binaryPath,
      r.model,
      r.pass ? "PASS" : "FAIL",
      r.pass ? r.reply : r.error,
      r.threadId,
      r.archived ? "yes" : "no",
    ]
      .map(cell)
      .join(" | "),
  );
  return [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => " --- |").join("")}`,
    ...lines.map((l) => `| ${l} |`),
  ].join("\n");
}

export const passed = (rows) => rows.length > 0 && rows.every((r) => r.pass && r.archived);

class UsageError extends Error {}

const log = (message) => console.error(`release-check: ${message}`);

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = NodeChildProcess.execFile(
      command,
      args,
      { maxBuffer: 16 << 20, ...options },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
          error,
        }),
    );
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

async function must(command, args, options) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${NodePath.basename(command)} ${args[0] ?? ""} exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-400)}`,
    );
  }
  return result.stdout;
}

const lastJson = (text) => {
  const line = text
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("{"));
  return line ? JSON.parse(line) : undefined;
};

async function rpc(origin, token, tag, payload) {
  const ticketResponse = await fetch(new URL("/api/auth/websocket-ticket", origin), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!ticketResponse.ok)
    throw new Error(`websocket ticket returned HTTP ${ticketResponse.status}`);
  const { ticket } = await ticketResponse.json();
  const url = new URL("/ws", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("orchestrationProtocol", "2");
  url.searchParams.set("wsTicket", ticket);
  const socket = new WebSocket(url);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${tag} timed out`)), 30_000);
      socket.addEventListener("open", () =>
        socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
      );
      socket.addEventListener("error", () => reject(new Error(`${tag} websocket failed`)));
      socket.addEventListener("message", ({ data }) => {
        const frame = JSON.parse(data);
        if (frame._tag !== "Exit" || frame.requestId !== "1") return;
        clearTimeout(timer);
        if (frame.exit._tag === "Success") resolve(frame.exit.value);
        else reject(new Error(`${tag} failed: ${JSON.stringify(frame.exit).slice(0, 400)}`));
      });
    });
  } finally {
    socket.close();
  }
}

const archive = (origin, token, threadId) =>
  rpc(origin, token, "orchestration.dispatchCommand", {
    type: "thread.archive",
    commandId: `release-check-archive-${NodeCrypto.randomUUID()}`,
    threadId,
  });

async function archiveAll(rows, { origin, token, show, list }) {
  const listed = (await list()).filter(
    (t) => !t.archived && !rows.some((r) => r.threadId === t.threadId),
  );
  for (const thread of listed) {
    const row = rows.find((r) => !r.threadId && r.instance === thread.providerInstanceId);
    if (row) row.threadId = thread.threadId;
    else
      rows.push({
        instance: thread.providerInstanceId,
        threadId: thread.threadId,
        error: "a thread this check did not start",
      });
  }
  for (const row of rows.filter((r) => r.threadId)) {
    try {
      await archive(origin, token, row.threadId);
      row.archived = (await show(row.threadId))?.thread?.archived === true;
      if (!row.archived) row.error = `${row.error ?? ""} (archive did not stick)`.trim();
    } catch (error) {
      row.archived = false;
      row.error = `${row.error ?? row.reply ?? ""} (archive failed: ${error.message})`.trim();
    }
  }
}

function settleTurn(row, result) {
  const turn = lastJson(result.stdout);
  row.threadId = turn?.threadId;
  row.reply = turn?.reply;
  row.pass = isPong(turn);
  if (row.pass) return;
  row.error = result.error?.killed
    ? `no reply within ${TURN_TIMEOUT_MS / 1000} s`
    : (turn?.error ??
      turn?.reply ??
      ((result.stderr || result.stdout).trim().slice(-300) || `exit ${result.code}`));
}

function writeReport(file, title, facts, rows) {
  const table = renderTable(rows);
  const verdict = passed(rows) ? "PASS" : "FAIL";
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(
    file,
    `# ${title}\n\n${facts.map((f) => `- ${f}`).join("\n")}\n- Verdict: ${verdict}\n\n${table}\n`,
  );
  console.log(table);
  log(`${verdict}, wrote ${file}`);
  return verdict === "PASS" ? 0 : 1;
}

function serverEnv(base, codexHome) {
  const env = {};
  for (const key of [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const file of PROD_ENV_FILES) {
    if (NodeFS.existsSync(file))
      Object.assign(env, parseEnvFile(NodeFS.readFileSync(file, "utf8")));
  }
  return {
    ...env,
    T3CODE_HOME: base,
    T3CODE_NO_BROWSER: "1",
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    T3CODE_TELEMETRY_ENABLED: "false",
    CODEX_HOME: codexHome,
  };
}

function copySecret(from, to) {
  NodeFS.mkdirSync(NodePath.dirname(to), { recursive: true, mode: 0o700 });
  NodeFS.copyFileSync(NodeFS.realpathSync(from), to);
  NodeFS.chmodSync(to, 0o600);
}

function seedCodexHome(source, dest, secrets) {
  NodeFS.mkdirSync(dest, { recursive: true, mode: 0o700 });
  copySecret(NodePath.join(source, "auth.json"), NodePath.join(dest, "auth.json"));
  secrets.push(NodePath.join(dest, "auth.json"));
  if (NodeFS.existsSync(NodePath.join(source, "config.toml"))) {
    NodeFS.copyFileSync(NodePath.join(source, "config.toml"), NodePath.join(dest, "config.toml"));
  }
}

async function startLimbaseLane(work, releaseName) {
  const sha = /-lim\.([0-9a-f]{7,40})-/.exec(releaseName)?.[1];
  if (!sha) throw new Error(`cannot read the fork sha from ${releaseName}`);
  const repo = NodePath.dirname(
    (
      await must("git", [
        "-C",
        import.meta.dirname,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])
    ).trim(),
  );
  const pin = JSON.parse(
    await must("git", ["-C", repo, "show", `${sha}:vendor/limbase/pin.json`]),
  ).sourceSha;
  const src = NodePath.join(work, "limbase-src");
  const lane = NodePath.join(work, "limbase-lane");
  const laneSh = NodePath.join(src, LANE_SH);
  const down = async () => {
    if (NodeFS.existsSync(NodePath.join(lane, "convex/container")))
      await run(laneSh, ["down", lane]);
    await run("git", ["-C", LIMBASE_REPO, "worktree", "remove", "--force", src]);
  };
  await down();
  NodeFS.rmSync(lane, { recursive: true, force: true });
  await must("git", ["-C", LIMBASE_REPO, "worktree", "add", "--detach", src, pin]);
  try {
    await must("pnpm", ["install", "--frozen-lockfile"], { cwd: src });
    await must(laneSh, ["up", lane]);
    const env = { ...process.env, MEMBASE_HOME: NodePath.join(lane, "home") };
    const enrolled = (
      await must("pnpm", ["exec", "limbase", "enroll", "--name", "release-check"], {
        cwd: src,
        env,
      })
    ).trim();
    const approval = enrolled.split("\n").at(-1);
    const adminKey = NodePath.join(lane, "convex/admin.key");
    await must(
      "pnpm",
      ["exec", "limbase", "machine", "approve", "--yes", "--admin-key-file", adminKey, approval],
      { cwd: src, env },
    );
    const doctor = await must(laneSh, ["doctor", lane]);
    if (!/limbase api \d+ convex \S+ ok/.test(doctor))
      throw new Error(`lane doctor did not report ok: ${doctor.trim().slice(-200)}`);
    log(`Limbase lane up at pin ${pin.slice(0, 8)}`);
  } catch (error) {
    await down();
    throw error;
  }
  return down;
}

function liveServerPid(userdata) {
  try {
    const { pid } = JSON.parse(
      NodeFS.readFileSync(NodePath.join(userdata, "server-runtime.json"), "utf8"),
    );
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

async function waitFor(check, what, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const groupAlive = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

async function stopServer(pid, cwd) {
  const actual = NodeFS.readlinkSync(`/proc/${pid}/cwd`);
  if (actual !== cwd)
    throw new Error(`refusing to stop pid ${pid}: its cwd is ${actual}, not ${cwd}`);
  process.kill(-pid, "SIGTERM");
  try {
    await waitFor(() => !groupAlive(pid), `server group ${pid} to exit`, 20_000);
  } catch {
    process.kill(-pid, "SIGKILL");
  }
  log(`stopped server group ${pid}`);
}

async function pre(options) {
  if (!options.release || !options.run) throw new UsageError("pre needs --release and --run");
  const release = NodePath.resolve(options.release);
  const t3 = NodePath.join(release, "t3");
  if (!NodeFS.existsSync(t3)) throw new UsageError(`${t3} does not exist`);
  const name = NodePath.basename(release);
  const runDir = NodePath.resolve(options.run);
  const work = NodePath.join(runDir, "scratch/release-check", name);
  const base = NodePath.join(work, "base");
  const userdata = NodePath.join(base, "userdata");
  const project = NodePath.join(work, "project");
  const live = liveServerPid(userdata);
  if (live) throw new Error(`a server (pid ${live}) still runs on ${base}; stop it first`);
  const prodSettingsPath = NodePath.resolve(
    options["prod-settings"] ?? NodePath.join(PROD_USERDATA, "settings.json"),
  );
  const prod = JSON.parse(NodeFS.readFileSync(prodSettingsPath, "utf8"));
  const models = parseModels(options.model);

  NodeFS.rmSync(base, { recursive: true, force: true });
  NodeFS.rmSync(NodePath.join(work, "codex-home"), { recursive: true, force: true });
  NodeFS.mkdirSync(userdata, { recursive: true, mode: 0o700 });
  NodeFS.mkdirSync(project, { recursive: true });
  if (!NodeFS.existsSync(NodePath.join(project, ".git")))
    await must("git", ["init", "-q", project]);

  const codexHome = (id) => NodePath.join(work, "codex-home", id);
  const laneHome = NodePath.join(work, "limbase-lane/home");
  const settings = copySettings(prod, { codexHome, limbaseHome: laneHome });
  const problems = copyProblems(prod, settings);
  if (problems.length > 0) throw new Error(`settings copy is not faithful: ${problems.join("; ")}`);
  NodeFS.writeFileSync(
    NodePath.join(userdata, "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );

  const secrets = [];
  const teardown = [];
  const rows = [];
  const facts = [
    `Release \`${name}\`, t3 sha256 \`${sha256(NodeFS.readFileSync(t3))}\``,
    `Settings copied from \`${prodSettingsPath}\` with every provider instance kept, codex homes moved to scratch, Limbase homes moved to a throwaway lane`,
  ];
  let laneError;
  try {
    const codexIds = new Set(["codex"]);
    for (const [id, instance] of Object.entries(prod.providerInstances ?? {}))
      if (instance.driver === "codex") codexIds.add(id);
    for (const id of codexIds) {
      seedCodexHome(
        prod.providerInstances?.[id]?.config?.homePath ?? NodePath.join(HOME, ".codex"),
        codexHome(id),
        secrets,
      );
    }
    const instances = {
      ...Object.fromEntries(Object.keys(DRIVERS).map((d) => [d, { driver: d }])),
      ...prod.providerInstances,
    };
    for (const [id, instance] of Object.entries(instances)) {
      for (const file of DRIVERS[instance.driver]?.credentials?.(id) ?? []) {
        if (!NodeFS.existsSync(NodePath.join(PROD_USERDATA, file))) continue;
        copySecret(NodePath.join(PROD_USERDATA, file), NodePath.join(userdata, file));
        secrets.push(NodePath.join(userdata, file));
      }
    }
    teardown.push(() => {
      for (const file of secrets) NodeFS.rmSync(file, { force: true });
      log(`deleted ${secrets.length} copied credentials`);
    });

    if (Object.values(prod.providerInstances ?? {}).some(isLimbase)) {
      try {
        teardown.push(await startLimbaseLane(work, name));
      } catch (error) {
        laneError = `Limbase lane failed: ${error.message}`;
        log(laneError);
      }
    }

    const port = pickPort(await must("ss", ["-H", "-ltnp"]));
    const origin = `http://127.0.0.1:${port}`;
    const env = serverEnv(base, codexHome("codex"));
    const logFd = NodeFS.openSync(NodePath.join(work, "serve.log"), "w", 0o600);
    const server = NodeChildProcess.spawn(
      t3,
      ["serve", "--host", "127.0.0.1", "--port", String(port), "--base-dir", base, "--no-browser"],
      {
        cwd: project,
        env,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      },
    );
    NodeFS.closeSync(logFd);
    server.unref();
    teardown.push(() => stopServer(server.pid, project));
    log(`started ${name} as pid ${server.pid} on port ${port}`);
    await waitFor(
      async () => (await fetch(origin).catch(() => undefined))?.status === 200,
      `${origin} to answer 200`,
      120_000,
    );
    const listener = await must("ss", ["-H", "-ltnp", `sport = :${port}`]);
    if (!listener.includes(`pid=${server.pid},`))
      throw new Error(`port ${port} is not held by pid ${server.pid}: ${listener.trim()}`);
    facts.push(
      `Server pid ${server.pid} on 127.0.0.1:${port}, log \`${NodePath.join(work, "serve.log")}\``,
    );

    const t3Run = (args, extra) => run(t3, args, { cwd: project, env, ...extra });
    const issued = await must(
      t3,
      [
        "auth",
        "session",
        "issue",
        "--base-dir",
        base,
        ...SCOPES.split(" "),
        "--ttl",
        "30m",
        "--label",
        "release-check",
        "--token-only",
      ],
      { env },
    );
    const token = issued.trim();
    const { providers } = await rpc(origin, token, "server.getConfig", {});
    facts.push(
      `Enabled by the release: ${providers
        .filter((p) => p.enabled)
        .map((p) => p.instanceId)
        .join(", ")}`,
    );
    rows.push(...planRows(prod, providers, models));
    for (const row of rows) {
      if (laneError && isLimbase(prod.providerInstances?.[row.instance] ?? {}))
        row.error = laneError;
    }
    await must(t3, ["project", "add", "--base-dir", base, project], { cwd: project, env });
    await Promise.all(
      rows
        .filter((r) => !r.error)
        .map(async (row) => {
          log(`turn on ${row.instance} with ${row.model}`);
          const result = await t3Run(
            [
              "thread",
              "start",
              "--base-dir",
              base,
              "--provider",
              row.instance,
              "--model",
              row.model,
              "--wait",
              "--json",
              ".",
              PROMPT,
            ],
            { timeout: TURN_TIMEOUT_MS },
          );
          settleTurn(row, result);
        }),
    );
    await archiveAll(rows, {
      origin,
      token,
      show: async (id) =>
        lastJson((await t3Run(["thread", "show", "--base-dir", base, "--json", id])).stdout),
      list: async () =>
        JSON.parse(
          await must(t3, ["thread", "list", "--base-dir", base, "--project", project, "--json"], {
            cwd: project,
            env,
          }),
        ),
    });
  } catch (error) {
    rows.push({ instance: "(setup)", error: error.message });
    log(error.message);
  } finally {
    for (const step of teardown.reverse()) {
      try {
        await step();
      } catch (error) {
        rows.push({ instance: "(teardown)", error: error.message });
        log(`teardown: ${error.message}`);
      }
    }
  }
  return writeReport(
    NodePath.join(runDir, "proof", `release-check-${name}.md`),
    `Release check for ${name}`,
    facts,
    rows,
  );
}

function hostEntry(host) {
  const { environments } = JSON.parse(NodeFS.readFileSync(ENVIRONMENTS, "utf8"));
  const entry = environments.find((e) =>
    [e.label, e.ssh].some((n) => n?.toLowerCase() === host.toLowerCase()),
  );
  if (!entry) throw new UsageError(`no host ${host} in ${ENVIRONMENTS}`);
  const onHost = (p) => `"$HOME"/${p.replace(/^~\//, "")}`;
  return { url: entry.url, t3: onHost(entry.t3), base: onHost(entry.base) };
}

async function smoke(host, options) {
  if (!host || !options.run) throw new UsageError("smoke needs <host> and --run");
  const { url, t3, base } = hostEntry(host);
  const sh = (command) => must(LIM_THREAD, [host, "sh", command]);
  const models = parseModels(options.model);
  const rows = [];
  const facts = [`Host \`${host}\` at ${url}`];
  let session;
  try {
    facts.push(`t3 ${(await sh(`${t3} --version`)).trim()}`);
    session = JSON.parse(
      await sh(
        `${t3} auth session issue --base-dir ${base} ${SCOPES} --ttl 30m --label release-smoke --json`,
      ),
    );
    const token = session.token;
    const { providers } = await rpc(url, token, "server.getConfig", {});
    const reported = new Map(providers.map((p) => [p.instanceId, p]));
    facts.push(
      `Enabled on the host: ${providers
        .filter((p) => p.enabled)
        .map((p) => p.instanceId)
        .join(", ")}`,
    );
    const { providerInstances = {} } = JSON.parse(await sh(`cat ${base}/userdata/settings.json`));
    const wanted =
      options.providers?.split(",").filter(Boolean) ??
      SMOKE_PROVIDERS.filter((id) => reported.get(id)?.enabled);
    const project = (
      await sh(
        `p="$HOME/.cache/t3-release-smoke"; mkdir -p "$p" && cd "$p" && { [ -d .git ] || git init -q; } && { ${t3} project add --base-dir ${base} "$p" >/dev/null 2>&1 || true; } && printf %s "$p"`,
      )
    ).trim();
    facts.push(`Scratch project \`${project}\` on the host`);
    for (const id of wanted) {
      const provider = reported.get(id);
      const row = {
        instance: id,
        driver: provider?.driver,
        binaryPath: providerInstances[id]?.config?.binaryPath ?? "(managed)",
        model: models[id] ?? DRIVERS[provider?.driver]?.model ?? "",
      };
      if (!provider?.enabled) row.error = "not enabled on this host";
      else if (!row.model)
        row.error = `no proof model for driver ${provider.driver}; pass --model ${id}=<slug>`;
      rows.push(row);
    }
    await Promise.all(
      rows
        .filter((r) => !r.error)
        .map(async (row) => {
          log(`turn on ${host} ${row.instance} with ${row.model}`);
          const result = await run(
            LIM_THREAD,
            [
              host,
              "start",
              project,
              "-",
              "--provider",
              row.instance,
              "--model",
              row.model,
              "--wait",
              "--json",
            ],
            {
              input: PROMPT,
              timeout: TURN_TIMEOUT_MS,
            },
          );
          settleTurn(row, result);
        }),
    );
    await archiveAll(rows, {
      origin: url,
      token,
      show: async (id) => lastJson((await run(LIM_THREAD, [host, "show", id, "--json"])).stdout),
      list: async () =>
        JSON.parse(await must(LIM_THREAD, [host, "list", "--project", project, "--json"])),
    });
  } catch (error) {
    rows.push({ instance: "(setup)", error: error.message });
    log(error.message);
  } finally {
    if (session?.sessionId)
      await run(LIM_THREAD, [
        host,
        "sh",
        `${t3} auth session revoke --base-dir ${base} ${session.sessionId}`,
      ]);
  }
  return writeReport(
    NodePath.join(NodePath.resolve(options.run), "proof", `smoke-${host}.md`),
    `Release smoke on ${host}`,
    facts,
    rows,
  );
}

async function main(argv) {
  const { values, positionals } = NodeUtil.parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      release: { type: "string" },
      run: { type: "string" },
      "prod-settings": { type: "string" },
      model: { type: "string", multiple: true },
      providers: { type: "string" },
    },
  });
  const [command, host] = positionals;
  if (command === "pre") return pre(values);
  if (command === "smoke") return smoke(host, values);
  throw new UsageError(`unknown command ${command ?? "(none)"}`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      const usage = error instanceof UsageError || String(error.code).startsWith("ERR_PARSE_ARGS");
      console.error(usage ? `${error.message}\n${USAGE}` : error.stack);
      process.exit(usage ? 2 : 1);
    },
  );
}
