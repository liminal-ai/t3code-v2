#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const USAGE = `demo.mjs <command>   narrated demo videos of the T3 web UI (references/demo-video.md)
  tts --demo <file> --out <dir>
      one wav per scene from gpt-4o-mini-tts, cached by text, voice and instructions
  record --demo <file> --checkout <path> --cdp <url> --out <dir> [--side before|after]
      run seed, then record each scene on the t3v browser at <url> (\`t3v.mjs browser info\`)
  mux --out <dir>
      join <dir>/before and <dir>/after (or <dir>/run) with title cards into <dir>/demo.mp4,
      with contact-sheet.png and drift.json beside it
  privacy <dir> --by <who> --note <text>
      record that <who> checked every contact-sheet frame of <dir>/demo.mp4 for private data
  publish <dir> --pr <n> [--dry-run]
      upload <dir>/demo.mp4 to Cloudflare Stream and update the PR's <!-- t3code-demo --> comment`;

const VOICE = {
  model: "gpt-4o-mini-tts",
  voice: "coral",
  instructions:
    "Calm, clear product walkthrough narrator. Moderate pace, warm and confident, slight pause between sentences.",
};

const PACING = {
  minTailMs: 900,
  maxSentences: 2,
  captionWords: [3, 6],
  maxRunMs: 75_000,
  driftBudgetMs: 250,
  cardMs: 2500,
  fps: 30,
};

export const MARKER = "<!-- t3code-demo -->";
const ACCOUNT = "e8e382d5bf8ec24ee2125188819b995c";
const KEY_FILE = NodePath.join(process.env.HOME ?? "", ".config", "lim-keys", "models.env");
const ACTIONS = ["click", "hover", "press", "scroll"];

const sentences = (text) => text.split(/(?<=[.!?])\s+/).filter((s) => s.trim()).length;

export function lint(scenes) {
  const problems = [];
  const ids = new Set();
  for (const scene of scenes) {
    const at = `scene ${scene.id ?? "(no id)"}`;
    if (!scene.id) problems.push(`${at}: no id`);
    if (ids.has(scene.id)) problems.push(`${at}: id used twice`);
    ids.add(scene.id);
    if (!scene.ready) problems.push(`${at}: no ready locator`);
    if ((scene.tailMs ?? PACING.minTailMs) < PACING.minTailMs)
      problems.push(`${at}: tailMs under ${PACING.minTailMs}`);
    for (const step of scene.steps ?? []) {
      if (!ACTIONS.includes(step.action))
        problems.push(`${at}: unknown action ${step.action}; use ${ACTIONS.join(", ")}`);
    }
    if (scene.probe) continue;
    if (!scene.say) problems.push(`${at}: no say`);
    else if (sentences(scene.say) > PACING.maxSentences)
      problems.push(`${at}: say has more than ${PACING.maxSentences} sentences`);
    const words = (scene.caption ?? "").split(/\s+/).filter(Boolean).length;
    const [least, most] = PACING.captionWords;
    if (words < least || words > most)
      problems.push(`${at}: caption has ${words} words, not ${least} to ${most}`);
  }
  return problems;
}

function demoPart(mod, side) {
  const def = mod.default ?? {};
  const scenes = side ? def[side] : def.scenes;
  if (!Array.isArray(scenes))
    throw new Error(
      side ? `the demo has no ${side} scene list` : "the demo has no scenes; pass --side",
    );
  return { scenes, seed: mod.seed };
}

const sceneLists = (def) =>
  ["scenes", "before", "after"].filter((k) => Array.isArray(def[k])).map((k) => [k, def[k]]);

export const lintDemo = (def) =>
  sceneLists(def).flatMap(([name, list]) => lint(list).map((problem) => `${name}: ${problem}`));

const clipKey = (scene, voice = VOICE) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify(scene.probe ? { tone: 1000 } : { ...voice, text: scene.say }))
    .digest("hex")
    .slice(0, 16);

const planSteps = (scene, clipMs) =>
  [
    ...(scene.probe ? [{ action: "flash", atMs: 0 }] : []),
    ...(scene.steps ?? []).map((step) => ({ ...step, atMs: step.atMs ?? Math.round(clipMs / 2) })),
  ].sort((a, b) => a.atMs - b.atMs);

export async function runScenes({ scenes, clipMs, driver, now, sleep, firstFrameAt }) {
  const timeline = [];
  for (const scene of scenes) {
    await driver.ready(scene.ready);
    const start = now();
    await driver.highlight(scene.highlight ?? []);
    const ms = clipMs(scene);
    const steps = [];
    for (const step of planSteps(scene, ms)) {
      await sleep(start + step.atMs - now());
      const atMs = now() - start;
      await driver.act(step);
      steps.push({ action: step.action, atMs, doneMs: now() - start });
    }
    const holdMs = ms + (scene.tailMs ?? PACING.minTailMs);
    await sleep(start + holdMs - now());
    await driver.clear();
    timeline.push({
      id: scene.id,
      caption: scene.caption ?? "",
      key: Boolean(scene.key),
      probe: Boolean(scene.probe),
      clip: clipKey(scene),
      startMs: Math.round(start - firstFrameAt),
      clipMs: ms,
      holdMs: Math.round(Math.max(holdMs, now() - start)),
      steps,
    });
  }
  return timeline;
}

// Inside single quotes ffmpeg reads a filter option literally, up to the next quote.
const filterValue = (s) => {
  if (String(s).includes("'"))
    throw new Error(`a path with a quote cannot reach ffmpeg's filter: ${s}`);
  return `'${s}'`;
};
const sec = (ms) => (ms / 1000).toFixed(3);

export function layout(runs, cardMs = PACING.cardMs) {
  let at = 0;
  return runs.map((run) => {
    const offsetMs = at + cardMs;
    at = offsetMs + run.durationMs;
    return {
      ...run,
      offsetMs,
      scenes: run.scenes.map((s) => ({ ...s, finalStartMs: offsetMs + s.startMs })),
    };
  });
}

export function muxArgs({ runs, size, font, out, cardMs = PACING.cardMs, fps = PACING.fps }) {
  const inputs = [];
  const graph = [];
  const joined = [];
  runs.forEach((run, r) => {
    const video = inputs.length / 2;
    inputs.push("-i", run.video);
    const D = sec(run.durationMs);
    graph.push(
      `color=c=0x0f172a:s=${size.width}x${size.height}:r=${fps}:d=${sec(cardMs)},` +
        `drawtext=fontfile=${filterValue(font)}:textfile=${filterValue(run.cardFile)}:fontsize=56:fontcolor=white:line_spacing=18:x=(w-text_w)/2:y=(h-text_h)/2[card${r}]`,
      `anullsrc=r=48000:cl=mono,atrim=duration=${sec(cardMs)}[cardsound${r}]`,
    );
    const captions = run.scenes
      .filter((s) => s.captionFile)
      .map(
        (s) =>
          `drawtext=fontfile=${filterValue(font)}:textfile=${filterValue(s.captionFile)}:fontsize=36:fontcolor=white:box=1:boxcolor=black@0.62:boxborderw=18:x=(w-text_w)/2:y=h-text_h-64:enable='between(t,${sec(s.startMs)},${sec(s.startMs + s.holdMs)})'`,
      );
    graph.push(
      [
        `[${video}:v]fps=${fps}`,
        "tpad=stop_mode=clone:stop_duration=5",
        `trim=duration=${D}`,
        "setpts=PTS-STARTPTS",
        `scale=${size.width}:${size.height}`,
        "setsar=1",
        ...captions,
        "format=yuv420p",
      ].join(",") + `[run${r}]`,
    );
    const clips = run.scenes.map((s, c) => {
      const input = inputs.length / 2;
      inputs.push("-i", s.clipFile);
      graph.push(
        `[${input}:a]aresample=48000,adelay=delays=${Math.round(s.startMs)}:all=1[clip${r}_${c}]`,
      );
      return `[clip${r}_${c}]`;
    });
    graph.push(
      `anullsrc=r=48000:cl=mono,atrim=duration=${D}[bed${r}]`,
      `[bed${r}]${clips.join("")}amix=inputs=${clips.length + 1}:normalize=0:duration=first,atrim=duration=${D},asetpts=PTS-STARTPTS[sound${r}]`,
    );
    joined.push(`[card${r}][cardsound${r}][run${r}][sound${r}]`);
  });
  graph.push(`${joined.join("")}concat=n=${runs.length * 2}:v=1:a=1[v][a]`);
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...inputs,
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-r",
    String(fps),
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    out,
  ];
}

export function parseSilences(stderr) {
  const silences = [];
  for (const line of stderr.split("\n")) {
    const start = /silence_start: (-?[\d.]+)/.exec(line);
    if (start) silences.push({ start: Number(start[1]), end: null });
    const end = /silence_end: ([\d.]+)/.exec(line);
    if (end && silences.length > 0) silences.at(-1).end = Number(end[1]);
  }
  return silences;
}

export function drift({ scenes, onsets, flashes }) {
  const nearest = (list, ms, within) =>
    list
      .map((t) => t * 1000)
      .filter((t) => Math.abs(t - ms) <= within)
      .sort((a, b) => Math.abs(a - ms) - Math.abs(b - ms))[0] ?? null;
  return scenes.map((s) => {
    const onset = nearest(onsets, s.finalStartMs, 600);
    const flash = s.probe ? nearest(flashes, s.finalStartMs, 600) : null;
    const reference = s.probe ? flash : s.finalStartMs;
    return {
      id: s.id,
      startMs: Math.round(s.finalStartMs),
      onsetMs: onset === null ? null : Math.round(onset),
      ...(s.probe ? { flashMs: flash === null ? null : Math.round(flash) } : {}),
      driftMs: onset === null || reference === null ? null : Math.round(onset - reference),
    };
  });
}

function thumbnailWindow(runs) {
  const scenes = runs.flatMap((run) => run.scenes);
  const key = scenes.findLast((s) => s.key) ?? scenes.at(-1);
  return {
    startS: Number((key.finalStartMs / 1000).toFixed(1)),
    durationS: Math.min(6, Math.ceil(key.holdMs / 1000)),
  };
}

const gifUrl = (watch, { startS, durationS }) => {
  const url = new URL(watch.replace(/\/watch$/, "/thumbnails/thumbnail.gif"));
  url.search = new URLSearchParams({
    time: `${startS}s`,
    duration: `${durationS}s`,
    width: "600",
    fps: "8",
  });
  return url.href;
};

const clock = (ms) =>
  `${Math.floor(ms / 60_000)}:${String(Math.round(ms / 1000) % 60).padStart(2, "0")}`;

export function renderComment({ title, watch, gif, durationMs, runs }) {
  const shas = runs
    .map((run) => `${run.label}${run.sha ? ` \`${run.sha.slice(0, 10)}\`` : ""}`)
    .join(", ");
  return [
    MARKER,
    `### Narrated demo: ${title}`,
    "",
    `<a href="${watch}"><img src="${gif}" width="600" alt="Animated preview of the demo"></a>`,
    "",
    `The preview is silent. [Watch the narrated video](${watch}) (${clock(durationMs)}).`,
    "",
    `Recorded from ${shas}.`,
  ].join("\n");
}

const fail = (message) => {
  console.error(`demo: ${message}`);
  process.exit(1);
};
const run = (cmd, args, options = {}) => {
  // ffmpeg reads commands from an open stdin and waits on it, so a child gets none unless it has input.
  const stdin = options.input === undefined ? "ignore" : "pipe";
  const result = NodeChildProcess.spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 1 << 28,
    stdio: [stdin, "pipe", "pipe"],
    ...options,
  });
  if (result.status !== 0)
    fail(
      `${cmd} ${args[0] ?? ""} exited ${result.status}: ${(result.stderr || result.stdout || "").trim().slice(-800)}`,
    );
  return result;
};
const readJson = (file) => JSON.parse(NodeFS.readFileSync(file, "utf8"));
const writeJson = (file, value) =>
  NodeFS.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const sha256 = (file) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
const durationMs = (file) =>
  Math.round(
    Number(
      run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file])
        .stdout,
    ) * 1000,
  );
const worktree = () =>
  NodeChildProcess.execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: import.meta.dirname,
    encoding: "utf8",
  }).trim();
const mainCheckout = () =>
  NodePath.dirname(
    NodePath.resolve(
      worktree(),
      NodeChildProcess.execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: import.meta.dirname,
        encoding: "utf8",
      }).trim(),
    ),
  );
const loadDemo = (file) => import(NodeURL.pathToFileURL(NodePath.resolve(file)).href);

async function tts(opts) {
  const mod = await loadDemo(opts.demo);
  const scenes = sceneLists(mod.default).flatMap(([, list]) => list);
  const problems = lintDemo(mod.default);
  if (problems.length > 0)
    fail(`the scene file breaks the pacing grammar:\n  ${problems.join("\n  ")}`);
  const cache = NodePath.join(mainCheckout(), ".pstack", "demo-tts-cache");
  NodeFS.mkdirSync(cache, { recursive: true });
  const clipsDir = NodePath.join(opts.out, "clips");
  NodeFS.mkdirSync(clipsDir, { recursive: true });
  const wanted = new Map(scenes.map((s) => [clipKey(s), s]));
  const speak = [...wanted].filter(
    ([key, s]) => !s.probe && !NodeFS.existsSync(NodePath.join(cache, `${key}.wav`)),
  );
  if (speak.length > 0)
    speakInKeyedChild(
      speak.map(([key, s]) => ({ text: s.say, raw: NodePath.join(cache, `${key}.raw.wav`) })),
    );
  const clips = {};
  for (const [key, scene] of wanted) {
    const final = NodePath.join(cache, `${key}.wav`);
    if (!NodeFS.existsSync(final)) {
      const source = scene.probe
        ? [
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=1000:sample_rate=48000:duration=0.4",
            "-af",
            "volume=-12dB",
          ]
        : [
            "-i",
            NodePath.join(cache, `${key}.raw.wav`),
            "-af",
            "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,loudnorm=I=-16:TP=-1.5:LRA=11",
          ];
      run("ffmpeg", [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        ...source,
        "-ar",
        "48000",
        "-ac",
        "1",
        `${final}.${process.pid}.wav`,
      ]);
      NodeFS.renameSync(`${final}.${process.pid}.wav`, final);
      NodeFS.rmSync(NodePath.join(cache, `${key}.raw.wav`), { force: true });
    }
    NodeFS.copyFileSync(final, NodePath.join(clipsDir, `${key}.wav`));
    clips[key] = { file: NodePath.join(clipsDir, `${key}.wav`), ms: durationMs(final) };
  }
  writeJson(NodePath.join(opts.out, "clips.json"), { voice: VOICE, clips });
  for (const [label, list] of sceneLists(mod.default)) {
    const ms = list.reduce(
      (sum, s) => sum + clips[clipKey(s)].ms + (s.tailMs ?? PACING.minTailMs),
      0,
    );
    console.log(
      `${label}: ${list.length} scenes, at least ${(ms / 1000).toFixed(1)}s of narration and holds`,
    );
    if (ms > PACING.maxRunMs) fail(`${label} runs over ${PACING.maxRunMs / 1000}s; cut a scene`);
  }
  console.log(
    `clips in ${clipsDir}, ${speak.length} synthesized, ${wanted.size - speak.length} from cache`,
  );
}

const speakInKeyedChild = (jobs) => {
  const child = NodeChildProcess.spawnSync(
    "bash",
    [
      "-c",
      'set -a && . "$0" && set +a && exec "$1" "$2" __speak',
      KEY_FILE,
      process.execPath,
      import.meta.filename,
    ],
    { input: JSON.stringify(jobs), encoding: "utf8", stdio: ["pipe", "inherit", "inherit"] },
  );
  if (child.status !== 0) fail("speech synthesis failed");
};

async function speakChild() {
  const jobs = JSON.parse(NodeFS.readFileSync(0, "utf8"));
  if (!process.env.OPENAI_API_KEY) fail(`no OPENAI_API_KEY in ${KEY_FILE}`);
  for (const job of jobs) {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: VOICE.model,
        voice: VOICE.voice,
        instructions: VOICE.instructions,
        input: job.text,
        response_format: "wav",
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok)
      fail(`speech API answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
    NodeFS.writeFileSync(`${job.raw}.${process.pid}`, Buffer.from(await response.arrayBuffer()));
    NodeFS.renameSync(`${job.raw}.${process.pid}`, job.raw);
    console.log(`synthesized "${job.text.slice(0, 48)}${job.text.length > 48 ? "..." : ""}"`);
  }
}

const OVERLAY = () => {
  if (document.getElementById("t3demo")) return;
  const root = document.createElement("div");
  root.id = "t3demo";
  root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  const cursor = document.createElement("div");
  cursor.style.cssText =
    "position:fixed;left:-40px;top:-40px;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(15,23,42,.85);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.45);transition:transform .12s";
  root.append(cursor);
  document.documentElement.append(root);
  addEventListener(
    "mousemove",
    (e) => Object.assign(cursor.style, { left: `${e.clientX}px`, top: `${e.clientY}px` }),
    true,
  );
  addEventListener("mousedown", () => (cursor.style.transform = "scale(.65)"), true);
  addEventListener("mouseup", () => (cursor.style.transform = ""), true);
};

const RINGS = (boxes) => {
  const root = document.getElementById("t3demo");
  if (!root) return;
  const rings = [...root.querySelectorAll(".t3demo-ring")];
  rings.slice(boxes.length).forEach((ring) => ring.remove());
  boxes.forEach((box, i) => {
    let ring = rings[i];
    if (!ring) {
      ring = document.createElement("div");
      ring.className = "t3demo-ring";
      ring.style.cssText =
        "position:fixed;border:3px solid #f59e0b;border-radius:10px;box-shadow:0 0 0 4px rgba(245,158,11,.28),0 0 22px rgba(245,158,11,.5)";
      root.prepend(ring);
    }
    ring.style.display = box ? "block" : "none";
    if (box)
      Object.assign(ring.style, {
        left: `${box.x - 6}px`,
        top: `${box.y - 6}px`,
        width: `${box.width + 12}px`,
        height: `${box.height + 12}px`,
      });
  });
};

const PAINTED = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

// A busy main thread can drop a timed-out element before it ever paints, so the timer starts at the paint.
const FLASH = async (ms) => {
  const flash = document.createElement("div");
  flash.style.cssText =
    "position:fixed;inset:0;background:#f0f;z-index:2147483647;pointer-events:none";
  document.documentElement.append(flash);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  setTimeout(() => flash.remove(), ms);
};

function pageDriver(page) {
  let rings = null;
  const moveTo = async (selector) => {
    const target = page.locator(selector).first();
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`${selector} has no box to point at`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y, { steps: 20 });
    return { x, y };
  };
  return {
    async ready(selector) {
      await page.locator(selector).first().waitFor({ state: "visible", timeout: 30_000 });
      await page.evaluate(PAINTED);
    },
    async highlight(selectors) {
      await page.evaluate(OVERLAY);
      if (selectors.length === 0) return;
      const state = { on: true };
      const measure = async () => {
        const boxes = await Promise.all(
          selectors.map((s) =>
            page
              .locator(s)
              .first()
              .boundingBox({ timeout: 80 })
              .catch(() => null),
          ),
        );
        await page.evaluate(RINGS, boxes).catch(() => {});
      };
      await measure();
      state.loop = (async () => {
        while (state.on) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (state.on) await measure();
        }
      })();
      rings = state;
    },
    async act(step) {
      switch (step.action) {
        case "click": {
          const { x, y } = await moveTo(step.target);
          return page.mouse.click(x, y, { button: step.button ?? "left" });
        }
        case "hover":
          return moveTo(step.target);
        case "press":
          return page.keyboard.press(step.key);
        case "scroll":
          if (step.target) await moveTo(step.target);
          return page.mouse.wheel(0, step.dy);
        case "flash":
          return page.evaluate(FLASH, 300);
      }
    },
    async clear() {
      if (rings) {
        rings.on = false;
        await rings.loop;
        rings = null;
      }
      await page.evaluate(RINGS, []).catch(() => {});
    },
  };
}

async function record(opts) {
  for (const name of ["demo", "checkout", "cdp", "out"])
    if (!opts[name]) fail(`record needs --${name}\n${USAGE}`);
  const mod = await loadDemo(opts.demo);
  const { scenes, seed } = demoPart(mod, opts.side);
  const problems = lint(scenes);
  if (problems.length > 0)
    fail(`the scene file breaks the pacing grammar:\n  ${problems.join("\n  ")}`);
  const clipsFile = NodePath.join(opts.out, "clips.json");
  if (!NodeFS.existsSync(clipsFile)) fail(`no ${clipsFile}; run \`demo.mjs tts\` first`);
  const { clips } = readJson(clipsFile);
  const stale = scenes.filter((s) => !clips[clipKey(s)]);
  if (stale.length > 0)
    fail(`no clip for ${stale.map((s) => s.id).join(", ")}; run \`demo.mjs tts\` again`);
  const checkout = NodePath.resolve(opts.checkout);
  const sha = NodeChildProcess.execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const dir = NodePath.join(opts.out, opts.side ?? "run");
  NodeFS.mkdirSync(dir, { recursive: true });

  const playwright = NodeModule.createRequire(
    NodePath.join(worktree(), "apps", "web", "package.json"),
  )("playwright");
  const browser = await playwright.chromium.connectOverCDP(opts.cdp);
  const page = browser.contexts()[0].pages()[0];
  const t3vScript = NodePath.join(
    checkout,
    ".agents",
    "skills",
    "verify-t3code",
    "scripts",
    "t3v.mjs",
  );
  const t3v = async (...args) => {
    try {
      const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
        process.execPath,
        [t3vScript, ...args],
        {
          cwd: checkout,
          maxBuffer: 1 << 26,
        },
      );
      return stdout;
    } catch (error) {
      throw new Error(
        `t3v ${args.join(" ")} exited ${error.code}: ${String(error.stderr ?? "")
          .trim()
          .slice(-500)}`,
        {
          cause: error,
        },
      );
    }
  };
  const video = NodePath.join(dir, "recording.webm");
  const size = page.viewportSize() ?? { width: 1440, height: 900 };
  let timeline;
  let endMs;
  try {
    if (seed) await seed({ page, t3v, checkout });
    await page.evaluate(OVERLAY);
    await page.mouse.move(size.width / 2, size.height / 2);
    await page.screencast.start({ path: video, size });
    const firstFrameAt = performance.now();
    timeline = await runScenes({
      scenes,
      clipMs: (s) => clips[clipKey(s)].ms,
      driver: pageDriver(page),
      now: () => performance.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
      firstFrameAt,
    });
    endMs = Math.round(performance.now() - firstFrameAt);
  } finally {
    await page.screencast.stop().catch(() => {});
    await page.evaluate(() => document.getElementById("t3demo")?.remove()).catch(() => {});
    await browser.close().catch(() => {});
  }
  const label = opts.side ? `${opts.side[0].toUpperCase()}${opts.side.slice(1)}` : "Demo";
  writeJson(NodePath.join(dir, "timeline.json"), {
    demo: NodePath.resolve(opts.demo),
    label,
    sha,
    size,
    video,
    durationMs: endMs,
    scenes: timeline.map((s) => ({ ...s, clipFile: clips[s.clip].file })),
  });
  console.log(`recorded ${timeline.length} scenes, ${(endMs / 1000).toFixed(1)}s, to ${dir}`);
}

function contactSheet(video, runs, out, font) {
  const frames = NodePath.join(NodePath.dirname(out), "frames");
  NodeFS.rmSync(frames, { recursive: true, force: true });
  NodeFS.mkdirSync(frames);
  let n = 0;
  for (const r of runs) {
    for (const s of r.scenes) {
      const action = s.steps.at(-1);
      const picks = [
        ["narration start", s.finalStartMs + 150],
        [
          action ? action.action : "mid",
          s.finalStartMs + (action ? action.doneMs + 300 : s.clipMs / 2),
        ],
        ["end", s.finalStartMs + s.holdMs - 120],
      ];
      for (const [what, ms] of picks) {
        const caption = NodePath.join(frames, `${String(n).padStart(3, "0")}.txt`);
        NodeFS.writeFileSync(caption, `${r.label} / ${s.id} / ${what} @ ${sec(ms)}s`);
        run("ffmpeg", [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          sec(ms),
          "-i",
          video,
          "-frames:v",
          "1",
          "-vf",
          `scale=800:-2,drawtext=fontfile=${filterValue(font)}:textfile=${filterValue(caption)}:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=6:x=8:y=8`,
          NodePath.join(frames, `${String(n++).padStart(3, "0")}.png`),
        ]);
      }
    }
  }
  run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-framerate",
    "1",
    "-i",
    NodePath.join(frames, "%03d.png"),
    "-vf",
    `tile=3x${n / 3}:padding=6:margin=6:color=0x0f172a`,
    "-frames:v",
    "1",
    out,
  ]);
}

function mux(opts) {
  if (!opts.out) fail(`mux needs --out\n${USAGE}`);
  const sides = ["before", "after", "run"].filter((side) =>
    NodeFS.existsSync(NodePath.join(opts.out, side, "timeline.json")),
  );
  if (sides.length === 0) fail(`no recorded run under ${opts.out}`);
  const font = run("fc-match", ["-f", "%{file}", "sans-serif:bold"]).stdout.trim();
  const work = NodePath.join(opts.out, "mux");
  NodeFS.mkdirSync(work, { recursive: true });
  const recorded = sides.map((side) => {
    const t = readJson(NodePath.join(opts.out, side, "timeline.json"));
    const cardFile = NodePath.join(work, `${side}-card.txt`);
    NodeFS.writeFileSync(cardFile, `${t.label}\n${t.sha.slice(0, 10)}`);
    return {
      ...t,
      side,
      cardFile,
      scenes: t.scenes.map((s) => {
        const captionFile = NodePath.join(work, `${side}-${s.id}.txt`);
        NodeFS.writeFileSync(captionFile, s.caption);
        return { ...s, captionFile: s.caption ? captionFile : null };
      }),
    };
  });
  const sizes = new Set(recorded.map((r) => `${r.size.width}x${r.size.height}`));
  if (sizes.size > 1) fail(`the runs were recorded at different sizes: ${[...sizes].join(", ")}`);
  const runs = layout(recorded);
  const out = NodePath.join(opts.out, "demo.mp4");
  run("ffmpeg", muxArgs({ runs, size: recorded[0].size, font, out }));

  const silence = run("ffmpeg", [
    "-hide_banner",
    "-i",
    out,
    "-af",
    "silencedetect=n=-40dB:d=0.25",
    "-f",
    "null",
    "-",
  ]).stderr;
  const silences = parseSilences(silence);
  const flashes = runs.flatMap((r) =>
    r.scenes
      .filter((s) => s.probe)
      .flatMap((s) => {
        const afterCardCutMs = r.offsetMs + 100;
        const from = sec(Math.max(s.finalStartMs - 500, afterCardCutMs));
        const to = sec(s.finalStartMs + 1000);
        const shown = run("ffmpeg", [
          "-hide_banner",
          "-i",
          out,
          "-an",
          "-vf",
          `trim=start=${from}:end=${to},select='gt(scene,0.3)',showinfo`,
          "-f",
          "null",
          "-",
        ]).stderr;
        return [...shown.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
      }),
  );
  const scenes = runs.flatMap((r) => r.scenes);
  const report = drift({
    scenes,
    onsets: silences.map((s) => s.end).filter((t) => t !== null),
    flashes,
  });
  const totalMs = durationMs(out);
  const streams = run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name,r_frame_rate",
    "-of",
    "csv=p=0",
    out,
  ]).stdout.trim();
  writeJson(NodePath.join(opts.out, "drift.json"), {
    budgetMs: PACING.driftBudgetMs,
    scenes: report,
  });
  writeJson(NodePath.join(opts.out, "video.json"), {
    title: NodePath.basename(recorded[0].demo).replace(/\.demo\.mjs$/, ""),
    durationMs: totalMs,
    runs: runs.map((r) => ({ side: r.side, label: r.label, sha: r.sha })),
    thumbnail: thumbnailWindow(runs),
  });
  contactSheet(out, runs, NodePath.join(opts.out, "contact-sheet.png"), font);
  console.log(`${out}, ${(totalMs / 1000).toFixed(1)}s, streams ${streams.replace(/\n/g, "; ")}`);
  for (const d of report)
    console.log(
      `  ${d.id}: drift ${d.driftMs ?? "unmeasured"} ms${d.flashMs === undefined ? "" : " (flash to tone)"}`,
    );
  const over = report.filter(
    (d) => d.driftMs === null || Math.abs(d.driftMs) >= PACING.driftBudgetMs,
  );
  if (over.length > 0)
    fail(
      `drift unmeasured or over ${PACING.driftBudgetMs} ms in ${over.map((d) => d.id).join(", ")}`,
    );
}

function privacy(dir, opts) {
  if (!dir || !opts.by || !opts.note)
    fail(`privacy needs <dir> --by <who> --note <text>\n${USAGE}`);
  const video = NodePath.join(dir, "demo.mp4");
  const sheet = NodePath.join(dir, "contact-sheet.png");
  if (!NodeFS.existsSync(video) || !NodeFS.existsSync(sheet))
    fail(`${dir} has no demo.mp4 and contact-sheet.png; run mux`);
  writeJson(NodePath.join(dir, "privacy.json"), {
    video: sha256(video),
    contactSheet: sha256(sheet),
    by: opts.by,
    at: new Date().toISOString(),
    note: opts.note,
  });
  console.log(`privacy check recorded for ${video}`);
}

const cf = (args) =>
  run("cf", args, { env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } }).stdout;

async function publish(dir, opts) {
  if (!dir || !opts.pr) fail(`publish needs <dir> --pr <n>\n${USAGE}`);
  const video = NodePath.join(dir, "demo.mp4");
  const meta = readJson(NodePath.join(dir, "video.json"));
  const checkFile = NodePath.join(dir, "privacy.json");
  const check = NodeFS.existsSync(checkFile) ? readJson(checkFile) : null;
  if (!check || check.video !== sha256(video))
    fail(
      `refused: no privacy check recorded for these exact bytes of ${video}; check every contact-sheet frame, then run \`demo.mjs privacy\``,
    );
  const pr = JSON.parse(run("gh", ["pr", "view", String(opts.pr), "--json", "url"]).stdout);
  const repo = new URL(pr.url).pathname.split("/").slice(1, 3).join("/");
  const comment = (watch) =>
    renderComment({
      title: meta.title,
      watch,
      gif: gifUrl(watch, meta.thumbnail),
      durationMs: meta.durationMs,
      runs: meta.runs,
    });
  if (opts["dry-run"]) {
    console.log(comment("https://customer-example.cloudflarestream.com/UID/watch"));
    return;
  }
  const doneFile = NodePath.join(dir, "published.json");
  const done = NodeFS.existsSync(doneFile) ? readJson(doneFile) : null;
  let uid = done?.video === check.video ? done.uid : null;
  if (!uid) {
    const body = { maxDurationSeconds: 600, requireSignedURLs: false };
    const ticket = JSON.parse(
      cf(["stream", "videos", "direct-upload", "create", "--body", JSON.stringify(body)]),
    );
    // The upload URL lets anyone upload until it expires, so it is never printed.
    if (!ticket.uid || !ticket.uploadURL)
      fail("direct-upload create answered without a uid and an upload URL");
    const form = new FormData();
    form.append(
      "file",
      await NodeFS.openAsBlob(video, { type: "video/mp4" }),
      `t3code-demo-${repo.replace("/", "-")}-pr${opts.pr}-${meta.title}.mp4`,
    );
    const sent = await fetch(ticket.uploadURL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(300_000),
    });
    if (!sent.ok) fail(`upload to Stream video ${ticket.uid} answered ${sent.status}`);
    uid = ticket.uid;
  }
  const deadline = Date.now() + 10 * 60_000;
  let v;
  for (;;) {
    v = JSON.parse(cf(["stream", "videos", "get", uid]));
    if (v.status?.state === "error")
      fail(`Stream could not process ${uid}: ${v.status.errorReasonText ?? "no reason"}`);
    if (v.readyToStream && v.duration > 0) break;
    if (Date.now() > deadline)
      fail(`Stream video ${uid} not ready after 10 minutes; publish again to keep waiting`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  const watch = v.preview;
  const gif = gifUrl(watch, meta.thumbnail);
  for (const url of [watch, gif]) {
    const back = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!back.ok) fail(`${url} answered ${back.status}, not 200`);
  }
  const body = comment(watch);
  const found = run("gh", [
    "api",
    "--paginate",
    `repos/${repo}/issues/${opts.pr}/comments`,
    "--jq",
    `.[] | select(.body | startswith("${MARKER}")) | .id`,
  ])
    .stdout.trim()
    .split("\n")
    .filter(Boolean)[0];
  const payload = JSON.stringify({ body });
  const posted = JSON.parse(
    found
      ? run(
          "gh",
          ["api", "-X", "PATCH", `repos/${repo}/issues/comments/${found}`, "--input", "-"],
          { input: payload },
        ).stdout
      : run(
          "gh",
          ["api", "-X", "POST", `repos/${repo}/issues/${opts.pr}/comments`, "--input", "-"],
          { input: payload },
        ).stdout,
  );
  writeJson(doneFile, { video: check.video, uid, watch, gif, comment: posted.html_url });
  console.log(
    `uid ${uid}\nwatch ${watch}\npreview ${gif}\n${found ? "updated" : "posted"} ${posted.html_url}`,
  );
}

if (import.meta.main) {
  const { values, positionals } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(
      ["demo", "out", "checkout", "cdp", "side", "by", "note", "pr"]
        .map((name) => [name, { type: "string" }])
        .concat([["dry-run", { type: "boolean" }]]),
    ),
  });
  const [command, dir] = positionals;
  if (values.side && !["before", "after"].includes(values.side)) fail("--side is before or after");
  switch (command) {
    case "tts":
      if (!values.demo || !values.out) fail(`tts needs --demo and --out\n${USAGE}`);
      await tts(values);
      break;
    case "record":
      await record(values);
      break;
    case "mux":
      mux(values);
      break;
    case "privacy":
      privacy(dir, values);
      break;
    case "publish":
      await publish(dir, values);
      break;
    case "__speak":
      await speakChild();
      break;
    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
}
