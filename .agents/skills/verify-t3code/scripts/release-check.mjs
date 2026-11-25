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
const SCOPES = "--scope orchestration:read --scope orchestration:operate --ttl 30m";

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
    model: "gemini-4-neon",
    credentials: (id) => [
      `providers/antigravity/${sha256(id)}/antigravity-acp/antigravity-oauth-token`,
    ],
  },
  muse: { model: "muse-ember-1.0" },
};

const isLimbase = (instance) =>
  instance.driver === "claudeAgent" && Boolean(instance.config?.limbaseHome);

const blank = (value) => !value?.trim();

export function copySettings(prod, { codexHome, codexShadowHome, limbaseHome }) {
  const instances = Object.entries(prod.providerInstances ?? {}).map(([id, instance]) => {
    if (instance.driver === "codex") {
      const config = { ...instance.config, homePath: codexHome(id) };
      if (!blank(instance.config?.shadowHomePath)) config.shadowHomePath = codexShadowHome(id);
      return [id, { ...instance, config }];
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
        (key === "shadowHomePath" && source.driver === "codex" && !blank(source.config[key])) ||
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

const expandHome = (value, home) =>
  value === "~" ? home : /^~[/\\]/.test(value) ? NodePath.join(home, value.slice(2)) : value;

export function codexSeeds(config = {}, scratch, home = HOME) {
  const resolve = (value) =>
    NodePath.resolve(blank(value) ? NodePath.join(home, ".codex") : expandHome(value.trim(), home));
  const shared = resolve(config.homePath);
  const shadow = blank(config.shadowHomePath) ? undefined : resolve(config.shadowHomePath);
  return [
    {
      from: NodePath.join(shadow ?? shared, "auth.json"),
      to: NodePath.join(shadow ? scratch.shadowHome : scratch.home, "auth.json"),
    },
    {
      from: NodePath.join(shared, "config.toml"),
      to: NodePath.join(scratch.home, "config.toml"),
      optional: true,
    },
  ];
}

export function planRows(expected, candidate, settings, models = {}) {
  const reported = new Map(candidate.map((p) => [p.instanceId, p]));
  const enabled = [...expected, ...candidate].filter((p) => p.enabled);
  return [...new Set(enabled.map((p) => p.instanceId))].map((instance) => {
    const provider = reported.get(instance);
    const driver = provider?.driver ?? enabled.find((p) => p.instanceId === instance).driver;
    const row = {
      instance,
      driver,
      binaryPath: settings.providerInstances?.[instance]?.config?.binaryPath?.trim() || "(managed)",
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

export const passedRow = (row) => Boolean(row.pass && row.archived && !row.error);

export function renderTable(rows) {
  const head = "instance|driver|binaryPath|model|result|reply or error|thread|archived".split("|");
  const lines = rows.map((r) =>
    [
      r.instance,
      r.driver,
      r.binaryPath,
      r.model,
      passedRow(r) ? "PASS" : "FAIL",
      r.error ?? r.reply,
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

const enabledIds = (providers) =>
  providers
    .filter((p) => p.enabled)
    .map((p) => p.instanceId)
    .join(", ");

export const passed = (rows) => rows.length > 0 && rows.every(passedRow);

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

async function runAuth(what, command, args, options) {
  const { code, stdout } = await run(command, args, options);
  if (code !== 0) throw new Error(`${what} exited ${code}; output withheld, it can hold a token`);
  return stdout;
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

async function rpc(origin, token, tag, payload, { until, timeoutMs = 30_000 } = {}) {
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
      const timer = setTimeout(() => reject(new Error(`${tag} timed out`)), timeoutMs);
      socket.addEventListener("open", () =>
        socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
      );
      socket.addEventListener("error", () => reject(new Error(`${tag} websocket failed`)));
      socket.addEventListener("message", ({ data }) => {
        const frame = JSON.parse(data);
        if (frame.requestId !== "1") return;
        if (frame._tag === "Chunk" && until) {
          const hit = frame.values.find(until);
          if (!hit) return socket.send(JSON.stringify({ _tag: "Ack", requestId: "1" }));
          clearTimeout(timer);
          return resolve(hit);
        }
        if (frame._tag !== "Exit") return;
        clearTimeout(timer);
        if (frame.exit._tag === "Success" && until)
          reject(new Error(`${tag} ended before the state it waited for`));
        else if (frame.exit._tag === "Success") resolve(frame.exit.value);
        else reject(new Error(`${tag} failed: ${JSON.stringify(frame.exit).slice(0, 400)}`));
      });
    });
  } finally {
    socket.close();
  }
}

export async function runTurns(rows, startTurn) {
  const turnOn = async (row) => {
    log(`turn on ${row.instance} with ${row.model}`);
    const result = await startTurn(row);
    try {
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
    } catch (error) {
      row.pass = false;
      row.error = `unreadable turn output: ${error.message}`;
    }
  };
  await Promise.all(rows.filter((r) => !r.error).map(turnOn));
}

const archiver = (origin, token) => (threadId) =>
  rpc(origin, token, "orchestration.dispatchCommand", {
    type: "thread.archive",
    commandId: `release-check-archive-${NodeCrypto.randomUUID()}`,
    threadId,
  });

export async function archiveOwn(rows, { title, archive, show, list }) {
  let listed = [];
  try {
    listed = await list();
  } catch (error) {
    rows.push({ instance: "(thread list)", error: error.message });
  }
  for (const row of rows.filter((r) => !r.threadId))
    row.threadId = listed.find((t) => t.title === title(row))?.threadId;
  for (const row of rows.filter((r) => r.threadId)) {
    try {
      await archive(row.threadId);
      row.archived = (await show(row.threadId))?.thread?.archived === true;
      if (!row.archived) row.error = `${row.error ?? ""} (archive did not stick)`.trim();
    } catch (error) {
      row.archived = false;
      row.error = `${row.error ?? row.reply ?? ""} (archive failed: ${error.message})`.trim();
    }
  }
  const leftovers = listed.filter(
    (t) => !t.archived && !rows.some((r) => r.threadId === t.threadId),
  );
  return leftovers.length === 0
    ? []
    : [
        `Left alone ${leftovers.length} unarchived threads this run did not start: ${leftovers.map((t) => t.threadId).join(", ")}`,
      ];
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

export function serverEnv(base, codexHome, envFiles = PROD_ENV_FILES) {
  const env = {};
  for (const key of "HOME USER LOGNAME SHELL LANG XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS".split(
    " ",
  )) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const file of envFiles) {
    if (NodeFS.existsSync(file))
      Object.assign(env, parseEnvFile(NodeFS.readFileSync(file, "utf8")));
  }
  for (const key of Object.keys(env)) if (key.startsWith("T3CODE_")) delete env[key];
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

export function stageScratch(
  { prod, expected, work, userdata, prodUserdata, home, limbaseHome },
  teardown,
) {
  const codexRoot = NodePath.join(work, "codex-home");
  const scrub = [
    codexRoot,
    NodePath.join(userdata, "secrets"),
    NodePath.join(userdata, "providers"),
    NodePath.join(userdata, "settings.json"),
  ];
  teardown.push(() => {
    for (const path of scrub) NodeFS.rmSync(path, { recursive: true, force: true });
    log(`deleted credential-bearing scratch: ${scrub.join(", ")}`);
  });
  const codexHome = (id) => NodePath.join(codexRoot, id);
  const codexShadowHome = (id) => NodePath.join(codexRoot, `${id}.shadow`);
  const settings = copySettings(prod, { codexHome, codexShadowHome, limbaseHome });
  const problems = copyProblems(prod, settings);
  if (problems.length > 0) throw new Error(`settings copy is not faithful: ${problems.join("; ")}`);
  NodeFS.writeFileSync(
    NodePath.join(userdata, "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
    { mode: 0o600 },
  );
  const unstaged = new Map();
  for (const { instanceId: id, driver } of expected) {
    try {
      if (driver === "codex") {
        const scratch = { home: codexHome(id), shadowHome: codexShadowHome(id) };
        for (const seed of codexSeeds(prod.providerInstances?.[id]?.config, scratch, home)) {
          if (!seed.optional || NodeFS.existsSync(seed.from)) copySecret(seed.from, seed.to);
        }
      }
      for (const file of DRIVERS[driver]?.credentials?.(id) ?? []) {
        if (NodeFS.existsSync(NodePath.join(prodUserdata, file)))
          copySecret(NodePath.join(prodUserdata, file), NodePath.join(userdata, file));
      }
    } catch (error) {
      unstaged.set(id, `could not stage its credentials: ${error.message}`);
    }
  }
  return { settings, codexHome, unstaged };
}

async function startLimbaseLane(dir, releaseName, teardown) {
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
  const src = NodePath.join(dir, "src");
  const lane = NodePath.join(dir, "lane");
  const laneSh = NodePath.join(src, LANE_SH);
  NodeFS.mkdirSync(dir, { mode: 0o700 });
  teardown.push(async () => {
    const failures = [];
    if (NodeFS.existsSync(NodePath.join(lane, "convex/container"))) {
      const down = await run(laneSh, ["down", lane]);
      if (down.code !== 0)
        failures.push(`lane.sh down exited ${down.code}: ${down.stderr.trim().slice(-200)}`);
    }
    if (NodeFS.existsSync(src)) {
      const removed = await run("git", ["-C", LIMBASE_REPO, "worktree", "remove", "--force", src]);
      if (removed.code !== 0) failures.push(`worktree remove exited ${removed.code}`);
    }
    NodeFS.rmSync(NodePath.join(lane, "home"), { recursive: true, force: true });
    if (failures.length > 0) throw new Error(`Limbase lane in ${dir}: ${failures.join("; ")}`);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
  await must("git", ["-C", LIMBASE_REPO, "worktree", "add", "--detach", src, pin]);
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
}

function liveServerPid(userdata) {
  try {
    const { pid } = JSON.parse(
      NodeFS.readFileSync(NodePath.join(userdata, "server-runtime.json"), "utf8"),
    );
    return NodeFS.existsSync(`/proc/${pid}`) ? pid : undefined;
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
  if (!groupAlive(pid)) return;
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

export async function startServer({ t3, args, cwd, env, logFile, origin }, teardown) {
  const logFd = NodeFS.openSync(logFile, "w", 0o600);
  const server = NodeChildProcess.spawn(t3, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  NodeFS.closeSync(logFd);
  let spawnError;
  server.on("error", (error) => {
    spawnError = error;
  });
  server.unref();
  if (server.pid) {
    teardown.push(() => stopServer(server.pid, cwd));
    log(`started ${NodePath.basename(NodePath.dirname(t3))} as pid ${server.pid}`);
  }
  await waitFor(
    async () => {
      if (spawnError)
        throw new Error(`could not start ${t3}: ${spawnError.code ?? spawnError.message}`);
      if (server.exitCode !== null || server.signalCode !== null)
        throw new Error(
          `server exited (${server.exitCode ?? server.signalCode}) before it listened; see ${logFile}`,
        );
      return (await fetch(origin).catch(() => undefined))?.status === 200;
    },
    `${origin} to answer 200`,
    120_000,
  );
  return server.pid;
}

const INSTALL_DONE = new Set(["succeeded", "failed", "cancelled"]);

async function installManagedRuntime(origin, token, instanceId) {
  const started = await rpc(origin, token, "provider.install.start", { instanceId });
  const done = await rpc(
    origin,
    token,
    "provider.install.subscribe",
    { instanceId },
    {
      until: (s) => s.operationId === started.operationId && INSTALL_DONE.has(s.phase),
      timeoutMs: 15 * 60_000,
    },
  );
  if (done.phase !== "succeeded") throw new Error(done.message ?? done.phase);
  await waitFor(
    async () =>
      (await rpc(origin, token, "server.getConfig", {})).providers.find(
        (p) => p.instanceId === instanceId,
      )?.installed,
    `${instanceId} to report its runtime installed`,
    120_000,
  );
  return done.installedVersion;
}

async function managedAntigravity(origin, token, { instanceId, installed }) {
  const state = await rpc(
    origin,
    token,
    "provider.install.subscribe",
    { instanceId },
    { until: () => true },
  );
  if (state.installedVersion) return { binaryPath: `managed ${state.installedVersion}` };
  if (installed)
    return {
      binaryPath: "agy on PATH",
      error:
        "prod's blank binaryPath means the managed runtime, but the release has none active and resolved agy from PATH",
    };
  try {
    const version = await installManagedRuntime(origin, token, instanceId);
    return {
      binaryPath: `managed ${version}`,
      fact: `${instanceId}: blank binaryPath, so the release installed its managed runtime ${version} with provider.install.start`,
    };
  } catch (error) {
    return { binaryPath: "none", error: `managed runtime install failed: ${error.message}` };
  }
}

function hostEntry(host) {
  const { environments } = JSON.parse(NodeFS.readFileSync(ENVIRONMENTS, "utf8"));
  const entry = environments.find((e) =>
    host === undefined
      ? e.ssh === "local"
      : [e.label, e.ssh].some((n) => n?.toLowerCase() === host.toLowerCase()),
  );
  if (!entry) throw new UsageError(`no host ${host ?? "with ssh local"} in ${ENVIRONMENTS}`);
  const onHost = (p) => `"$HOME"/${p.replace(/^~\//, "")}`;
  return { label: entry.label, url: entry.url, t3: onHost(entry.t3), base: onHost(entry.base) };
}

export async function withHostSession(host, rows, use) {
  const entry = hostEntry(host);
  const sh = (command) => must(LIM_THREAD, [entry.label, "sh", command]);
  let session;
  try {
    const issued = await runAuth(`auth session issue on ${entry.label}`, LIM_THREAD, [
      entry.label,
      "sh",
      `${entry.t3} auth session issue --base-dir ${entry.base} ${SCOPES} --label release-check --json`,
    ]);
    try {
      session = JSON.parse(issued);
    } catch {
      throw new Error(`auth session issue on ${entry.label} printed no session JSON`);
    }
    const { providers } = await rpc(entry.url, session.token, "server.getConfig", {});
    return await use({ ...entry, sh, token: session.token, providers });
  } finally {
    if (session?.sessionId) {
      await runAuth(`auth session revoke ${session.sessionId} on ${entry.label}`, LIM_THREAD, [
        entry.label,
        "sh",
        `${entry.t3} auth session revoke --base-dir ${entry.base} ${session.sessionId}`,
      ]).catch((error) => {
        rows.push({ instance: "(teardown)", error: error.message });
        log(`teardown: ${error.message}`);
      });
    }
  }
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
  const title = titler();
  const laneDir = NodePath.join(work, `limbase-${NodeCrypto.randomUUID().slice(0, 8)}`);

  const teardown = [];
  const rows = [];
  const facts = [
    `Release \`${name}\`, t3 sha256 \`${sha256(NodeFS.readFileSync(t3))}\``,
    `Settings copied from \`${prodSettingsPath}\` with every provider instance kept, codex homes and shadow homes moved to scratch, Limbase homes moved to a throwaway lane`,
  ];
  try {
    const expected = await withHostSession(undefined, rows, ({ label, providers }) => {
      facts.push(`Enabled on prod (\`${label}\` server.getConfig): ${enabledIds(providers)}`);
      return providers.filter((p) => p.enabled);
    });
    if (NodeFS.existsSync(base)) await must("chmod", ["-R", "u+w", base]);
    NodeFS.rmSync(base, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.join(work, "codex-home"), { recursive: true, force: true });
    NodeFS.mkdirSync(userdata, { recursive: true, mode: 0o700 });
    NodeFS.mkdirSync(project, { recursive: true });
    if (!NodeFS.existsSync(NodePath.join(project, ".git")))
      await must("git", ["init", "-q", project]);
    const { settings, codexHome, unstaged } = stageScratch(
      {
        prod,
        expected,
        work,
        userdata,
        prodUserdata: PROD_USERDATA,
        home: HOME,
        limbaseHome: NodePath.join(laneDir, "lane/home"),
      },
      teardown,
    );

    let laneError;
    if (Object.values(prod.providerInstances ?? {}).some(isLimbase)) {
      try {
        await startLimbaseLane(laneDir, name, teardown);
      } catch (error) {
        laneError = `Limbase lane failed: ${error.message}`;
        log(laneError);
      }
    }

    const port = pickPort(await must("ss", ["-H", "-ltnp"]));
    const origin = `http://127.0.0.1:${port}`;
    const env = serverEnv(base, codexHome("codex"));
    const logFile = NodePath.join(work, "serve.log");
    const pid = await startServer(
      {
        t3,
        args: [
          ..."serve --host 127.0.0.1 --port".split(" "),
          String(port),
          "--base-dir",
          base,
          "--no-browser",
        ],
        cwd: project,
        env,
        logFile,
        origin,
      },
      teardown,
    );
    const listener = await must("ss", ["-H", "-ltnp", `sport = :${port}`]);
    if (!listener.includes(`pid=${pid},`))
      throw new Error(`port ${port} is not held by pid ${pid}: ${listener.trim()}`);
    facts.push(`Server pid ${pid} on 127.0.0.1:${port}, log \`${logFile}\``);

    const t3Run = (args, extra) => run(t3, args, { cwd: project, env, ...extra });
    const issued = await runAuth(
      "auth session issue on the scratch server",
      t3,
      [
        ..."auth session issue --token-only --label release-check".split(" "),
        ...SCOPES.split(" "),
        ..."--scope providers:manage --base-dir".split(" "),
        base,
      ],
      { env },
    );
    const token = issued.trim();
    const { providers } = await rpc(origin, token, "server.getConfig", {});
    facts.push(`Enabled by the release: ${enabledIds(providers)}`);
    rows.push(...planRows(expected, providers, settings, models));
    for (const row of rows) {
      if (laneError && isLimbase(settings.providerInstances?.[row.instance] ?? {}))
        row.error = laneError;
      row.error ??= unstaged.get(row.instance);
      if (row.error || row.driver !== "antigravity" || row.binaryPath !== "(managed)") continue;
      const runtime = await managedAntigravity(
        origin,
        token,
        providers.find((p) => p.instanceId === row.instance),
      );
      row.binaryPath = runtime.binaryPath;
      if (runtime.error) row.error = runtime.error;
      if (runtime.fact) facts.push(runtime.fact);
    }
    await must(t3, ["project", "add", "--base-dir", base, project], { cwd: project, env });
    await runTurns(rows, (row) =>
      t3Run(
        [
          ..."thread start --wait --json --base-dir".split(" "),
          base,
          "--title",
          title(row),
          "--provider",
          row.instance,
          "--model",
          row.model,
          ".",
          PROMPT,
        ],
        { timeout: TURN_TIMEOUT_MS },
      ),
    );
    facts.push(
      ...(await archiveOwn(rows, {
        title,
        archive: archiver(origin, token),
        show: async (id) =>
          lastJson((await t3Run(["thread", "show", "--base-dir", base, "--json", id])).stdout),
        list: async () =>
          JSON.parse(
            await must(t3, ["thread", "list", "--json", "--base-dir", base], {
              cwd: project,
              env,
            }),
          ),
      })),
    );
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

function titler() {
  const nonce = NodeCrypto.randomUUID().slice(0, 8);
  return (row) => `release-check ${nonce} ${row.instance}`;
}

async function smoke(host, options) {
  if (!host || !options.run) throw new UsageError("smoke needs <host> and --run");
  const models = parseModels(options.model);
  const title = titler();
  const rows = [];
  const facts = [];
  try {
    await withHostSession(host, rows, async ({ label, url, t3, base, sh, token, providers }) => {
      facts.push(
        `Host \`${label}\` at ${url}`,
        `Version \`${(await sh(`${t3} --version`)).trim()}\``,
        `Enabled on the host: ${enabledIds(providers)}`,
      );
      const settings = JSON.parse(await sh(`cat ${base}/userdata/settings.json`));
      const planned = planRows(providers, providers, settings, models);
      const wanted =
        options.providers?.split(",").filter(Boolean) ??
        SMOKE_PROVIDERS.filter((id) => planned.some((r) => r.instance === id));
      rows.push(
        ...wanted.map(
          (id) =>
            planned.find((r) => r.instance === id) ?? {
              instance: id,
              error: "not enabled on this host",
            },
        ),
      );
      const project = (
        await sh(
          `p="$HOME/.cache/t3-release-smoke"; mkdir -p "$p" && cd "$p" && { [ -d .git ] || git init -q; } && { ${t3} project add --base-dir ${base} "$p" >/dev/null 2>&1 || true; } && printf %s "$p"`,
        )
      ).trim();
      facts.push(`Scratch project \`${project}\` on the host`);
      await runTurns(rows, (row) =>
        run(
          LIM_THREAD,
          [
            label,
            "start",
            project,
            "-",
            "--title",
            title(row),
            ..."--wait --json --provider".split(" "),
            row.instance,
            "--model",
            row.model,
          ],
          { input: PROMPT, timeout: TURN_TIMEOUT_MS },
        ),
      );
      facts.push(
        ...(await archiveOwn(rows, {
          title,
          archive: archiver(url, token),
          show: async (id) =>
            lastJson((await run(LIM_THREAD, [label, "show", id, "--json"])).stdout),
          list: async () =>
            JSON.parse(await must(LIM_THREAD, [label, "list", "--project", project, "--json"])),
        })),
      );
    });
  } catch (error) {
    rows.push({ instance: "(setup)", error: error.message });
    log(error.message);
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
  const [command, host, ...extra] = positionals;
  const modes = {
    pre: { flags: ["release", "run", "prod-settings", "model"], hosts: 0 },
    smoke: { flags: ["run", "providers", "model"], hosts: 1 },
  };
  const mode = modes[command];
  if (!mode) throw new UsageError(`unknown command ${command ?? "(none)"}`);
  const foreign = Object.keys(values).filter((flag) => !mode.flags.includes(flag));
  if (foreign.length > 0)
    throw new UsageError(`${command} does not take ${foreign.map((f) => `--${f}`).join(", ")}`);
  if (extra.length > 0 || (mode.hosts === 0 && host !== undefined))
    throw new UsageError(`${command} got an extra argument`);
  return command === "pre" ? pre(values) : smoke(host, values);
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
