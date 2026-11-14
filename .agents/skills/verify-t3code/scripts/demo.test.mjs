import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  MARKER,
  drift,
  gifUrl,
  layout,
  lint,
  lintDemo,
  muxArgs,
  parseSilences,
  publishRefusal,
  renderComment,
  runScenes,
} from "./demo.mjs";

const fakeClock = (readyDelays, actMs = 0) => {
  let t = 1000;
  const acted = [];
  return {
    acted,
    now: () => t,
    sleep: async (ms) => {
      t += Math.max(0, ms);
    },
    driver: {
      ready: async (selector) => {
        t += readyDelays[selector] ?? 0;
      },
      highlight: async () => {},
      act: async (step) => {
        acted.push([step.action, t]);
        t += actMs;
      },
      clear: async () => {},
    },
  };
};

const scenes = [
  {
    id: "open",
    say: "Settings live in the sidebar.",
    caption: "Open settings from the sidebar",
    ready: "role=button[name=Settings]",
    steps: [{ action: "click", target: "role=button[name=Settings]" }],
  },
  {
    id: "slow",
    say: "The page takes a while to load.",
    caption: "Slow page still lines up",
    ready: "role=heading[name=Slow]",
    tailMs: 1200,
  },
];
const clipMs = { open: 2000, slow: 3000 };

async function record(readyDelays, actMs) {
  const clock = fakeClock(readyDelays, actMs);
  const timeline = await runScenes({
    scenes,
    clipMs: (s) => clipMs[s.id],
    driver: clock.driver,
    now: clock.now,
    sleep: clock.sleep,
    firstFrameAt: 1000,
  });
  return { timeline, acted: clock.acted };
}

NodeTest.test("a slow ready moves its scene's start, and the narration starts there", async () => {
  const fast = await record({});
  const slow = await record({ "role=heading[name=Slow]": 1500 });
  NodeAssert.equal(
    fast.timeline[1].startMs,
    2900,
    "a scene starts when the one before has held its clip and tail",
  );
  NodeAssert.equal(
    slow.timeline[1].startMs,
    4400,
    "the 1.5 s wait for ready comes before the narration clock starts",
  );
  NodeAssert.equal(slow.timeline[1].holdMs, 4200, "the scene still holds its clip plus its tail");
  NodeAssert.deepEqual(slow.acted, [["click", 2000]], "a click without atMs lands mid-narration");

  const runs = layout([
    {
      video: "run.webm",
      durationMs: 9000,
      cardFile: "card.txt",
      scenes: slow.timeline.map((s) => ({ ...s, clipFile: `${s.id}.wav`, captionFile: null })),
    },
  ]);
  const graph = muxArgs({
    runs,
    size: { width: 1440, height: 900 },
    font: "font.ttf",
    out: "demo.mp4",
  }).join(" ");
  NodeAssert.deepEqual(
    [...graph.matchAll(/adelay=delays=(\d+):all=1/g)].map((m) => Number(m[1])),
    [0, 4400],
    "each clip is delayed to its scene's real start in the run",
  );
});

NodeTest.test(
  "an action that outlasts its narration still gets the full hold after it",
  async () => {
    const { timeline } = await record({}, 3000);
    NodeAssert.equal(
      timeline[0].steps[0].doneMs,
      4000,
      "the click starts mid-narration and takes 3 s",
    );
    NodeAssert.equal(
      timeline[0].holdMs,
      4900,
      "the 900 ms tail follows the click, not the 2 s clip",
    );
  },
);

NodeTest.test("a ready that never shows names its scene", async () => {
  const clock = fakeClock({});
  clock.driver.ready = async () => {
    throw new Error("Timeout 30000ms exceeded");
  };
  await NodeAssert.rejects(
    runScenes({
      scenes,
      clipMs: (s) => clipMs[s.id],
      driver: clock.driver,
      now: clock.now,
      sleep: clock.sleep,
      firstFrameAt: 1000,
    }),
    /^Error: scene open: role=button\[name=Settings\] never became visible: Timeout/,
  );
});

NodeTest.test("each run's clips are delayed within that run, after its title card", () => {
  const scene = (id, startMs) => ({
    id,
    startMs,
    holdMs: 2000,
    clipMs: 1000,
    clipFile: `${id}.wav`,
    captionFile: null,
    steps: [],
  });
  const runs = layout(
    [
      {
        video: "before.webm",
        durationMs: 5000,
        cardFile: "b.txt",
        scenes: [scene("b1", 100), scene("b2", 2500)],
      },
      { video: "after.webm", durationMs: 6000, cardFile: "a.txt", scenes: [scene("a1", 300)] },
    ],
    2500,
  );
  const args = muxArgs({
    runs,
    size: { width: 1280, height: 720 },
    font: "font.ttf",
    out: "demo.mp4",
    cardMs: 2500,
  });
  const graph = args[args.indexOf("-filter_complex") + 1];
  NodeAssert.deepEqual(
    [...graph.matchAll(/adelay=delays=(\d+):all=1/g)].map((m) => Number(m[1])),
    [100, 2500, 300],
  );
  NodeAssert.match(graph, /concat=n=4:v=1:a=1/);
  NodeAssert.deepEqual(
    runs.flatMap((r) => r.scenes.map((s) => s.finalStartMs)),
    [2600, 5000, 10_300],
    "the after run's scenes sit after both cards and the before run",
  );
  NodeAssert.deepEqual(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2), [
    "-c:v",
    "libx264",
  ]);
  NodeAssert.deepEqual(args.slice(args.indexOf("-c:a"), args.indexOf("-c:a") + 2), ["-c:a", "aac"]);
});

NodeTest.test(
  "the comment carries the marker, the linked preview and the silent-preview line",
  () => {
    const body = renderComment({
      title: "agents-group",
      watch: "https://customer-x.cloudflarestream.com/uid/watch",
      gif: "https://customer-x.cloudflarestream.com/uid/thumbnails/thumbnail.gif?time=12s",
      durationMs: 72_400,
      runs: [
        { label: "Before", sha: "155cb40848a3f1edda96" },
        { label: "After", sha: "abcdef0123456789" },
      ],
    });
    NodeAssert.ok(
      body.startsWith(MARKER),
      "the marker opens the comment, so publish finds it again",
    );
    NodeAssert.match(body, /The preview is silent\./);
    NodeAssert.match(
      body,
      /<a href="https:\/\/customer-x\.cloudflarestream\.com\/uid\/watch"><img src="https:\/\/customer-x\.cloudflarestream\.com\/uid\/thumbnails\/thumbnail\.gif\?time=12s"/,
    );
    NodeAssert.match(body, /\(1:12\)/);
    NodeAssert.match(body, /Before `155cb40848`, After `abcdef0123`/);
  },
);

NodeTest.test(
  "the pacing grammar rejects long narration, off-size captions and short holds",
  () => {
    const problems = lint([
      { id: "a", say: "One. Two. Three.", caption: "Too short", ready: "x", tailMs: 500 },
      { id: "p", probe: true, ready: "x" },
      {
        id: "b",
        say: "Fine.",
        caption: "Four words are fine",
        ready: "x",
        steps: [{ action: "drag" }],
      },
    ]);
    NodeAssert.deepEqual(problems, [
      "scene a: tailMs under 900",
      "scene a: say has more than 2 sentences",
      "scene a: caption has 2 words, not 3 to 6",
      "scene b: unknown action drag; use click, hover, press, scroll",
    ]);
  },
);

NodeTest.test(
  "drift compares the tone with the flash for a probe, and narration onsets with scene starts",
  () => {
    const silences = parseSilences(
      [
        "[silencedetect @ 0x1] silence_start: 0",
        "[silencedetect @ 0x1] silence_end: 2.62 | silence_duration: 2.62",
        "[silencedetect @ 0x1] silence_start: 7.1",
        "[silencedetect @ 0x1] silence_end: 8.41 | silence_duration: 1.31",
      ].join("\n"),
    );
    const report = drift({
      scenes: [
        { id: "talk", finalStartMs: 2600 },
        { id: "probe", probe: true, finalStartMs: 8400 },
      ],
      onsets: silences.map((s) => s.end),
      flashes: [8.367, 8.7],
    });
    NodeAssert.deepEqual(report, [
      { id: "talk", startMs: 2600, onsetMs: 2620, driftMs: 20 },
      { id: "probe", startMs: 8400, onsetMs: 8410, flashMs: 8367, driftMs: 43 },
    ]);
  },
);

NodeTest.test("each side is linted on its own, so before and after may share scene ids", () => {
  const scene = { id: "menu", say: "Fine.", caption: "Open the thread menu", ready: "x" };
  NodeAssert.deepEqual(lintDemo({ before: [scene], after: [scene] }), []);
  NodeAssert.deepEqual(lintDemo({ after: [scene, scene] }), ["after: scene menu: id used twice"]);
});

NodeTest.test(
  "publish refuses a failed drift check, a video over 75 s, and any reviewed file that changed",
  () => {
    const onDisk = { video: "v1", contactSheet: "c1", frames: "f1", narration: "n1" };
    const ok = {
      check: { ...onDisk, by: "lead" },
      onDisk,
      drift: { passed: true },
      durationMs: 60_000,
    };
    NodeAssert.equal(publishRefusal(ok), null);
    NodeAssert.match(publishRefusal({ ...ok, drift: { passed: false } }), /drift check failed/);
    NodeAssert.match(publishRefusal({ ...ok, durationMs: 75_001 }), /over 75s/);
    NodeAssert.match(publishRefusal({ ...ok, check: null }), /no privacy check/);
    NodeAssert.match(
      publishRefusal({ ...ok, onDisk: { ...onDisk, frames: "f2" } }),
      /^frames changed/,
    );
  },
);

NodeTest.test("the animated preview stays inside Stream's 10 to 600 px width range", () => {
  const url = new URL(
    gifUrl("https://customer-x.cloudflarestream.com/uid/watch", { startS: 9.8, durationS: 6 }),
  );
  const width = Number(url.searchParams.get("width"));
  NodeAssert.ok(width >= 10 && width <= 600, `width ${width}`);
  NodeAssert.equal(url.pathname, "/uid/thumbnails/thumbnail.gif");
  NodeAssert.equal(url.searchParams.get("time"), "9.8s");
});
