# Narrated demo videos

`scripts/demo.mjs` turns a scene file into a narrated mp4 of the web UI, with highlight rings, real mouse clicks, burned-in captions and title cards. It then publishes the mp4 to Cloudflare Stream and keeps one comment on the PR. A PR that changes what a user sees or does in the web or desktop UI carries one as its acceptance video (`.agents/merge-brief.md`). This file is the how-to and the running log. The acceptance-video runbook grows from it.

## Run it

Start a dev server and its browser per [SKILL.md](../SKILL.md) for each checkout you record, with `up`, `browser open` and `doctor`. Then run the stages in order.

```bash
DEMO=.agents/skills/verify-t3code/scripts/demo.mjs
SCENES=.agents/skills/verify-t3code/demos/<feature>.demo.mjs
OUT=<main checkout>/.pstack/runs/<run>/proof/<pr-id>/demo
node $DEMO tts --demo $SCENES --out $OUT
node $DEMO record --demo $SCENES --side before --checkout <base worktree> --cdp <base cdp> --out $OUT
node $DEMO record --demo $SCENES --side after --checkout <head worktree> --cdp <head cdp> --out $OUT
node $DEMO mux --out $OUT
```

- `tts` writes one wav per scene under `$OUT/clips/`, for every scene list in the file, and the probe's tone. It exits 1 when a scene breaks the pacing grammar. It prints the characters it sent, the seconds of new speech and a rough cost.
- `record` runs the file's `seed`, then plays one scene list on the browser at `--cdp` and writes `$OUT/<side>/recording.webm` and `timeline.json`. A plain `{ scenes }` file takes no `--side` and writes `$OUT/run/`. It records the page on the dev server of `--checkout`, which it reads from that checkout's `.t3/userdata/server-runtime.json`.
- `mux` writes `$OUT/demo.mp4`, `contact-sheet.png`, `frames/` with one full-size frame per second, `narration.txt`, `drift.json` and `video.json`. It exits 1 when a scene's drift is unmeasured or over budget, or when the whole video runs over 75 seconds.
- Each stage prints how long it took, for the running log.

**The CDP URL.** `node <checkout>/.agents/skills/verify-t3code/scripts/t3v.mjs browser info` prints `{"cdp": ..., "origin": ...}` for that checkout's browser. Pass the CDP URL explicitly, because t3v finds its checkout from its own path and `demo.mjs` may run from another one. A checkout whose t3v predates `browser info` keeps the same URL in the `cdp` key of `<main checkout>/.pstack/runs/<run>/scratch/t3v/<checkout folder>-<hash>/browser.json`.

**Before and after.** Record the before run from a worktree at the PR's merge base and the after run from the PR head, each with its own dev server, side by side (SKILL.md, "Isolation"). Both run the same `seed`, so both show the same threads. Record both runs at the same viewport, because `mux` refuses runs of different sizes. The title cards read `Before` and `After` with each run's SHA.

## Write a scene file

A scene file is a JS module under `demos/`. It exports a `seed` function by name, and a default object with one `scenes` list, or a `before` and an `after` list.

```js
export async function seed({ page, t3v, checkout }) {
  await t3v("outcome", "sql", "select count(*) as n from projection_projects");
  await page.goto(new URL("/", page.url()).href);
}

export default {
  before: [/* scenes on the merge base */],
  after: [
    {
      id: "open-menu",
      say: "Right-click a thread to open its menu. Pin as agent is new here.",
      caption: "Pin a thread as an agent",
      ready: 'role=button[name="New thread, server"]',
      highlight: ['role=button[name="New thread, server"]'],
      steps: [
        { action: "click", target: 'role=button[name="New thread, server"]', button: "right" },
      ],
      tailMs: 900,
      key: true,
    },
  ],
};
```

`seed` runs before the screencast starts. `page` is the attached Playwright page on the checkout's dev server. `t3v(...args)` runs the recorded checkout's `t3v.mjs` with the same `T3V_RUN`. It resolves to the command's stdout as a string and rejects on a non-zero exit. `checkout` is the path `--checkout` named.

| Field       | Meaning                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------- |
| `id`        | Unique within its list. A `before` and an `after` scene may share an id.                          |
| `say`       | The narration, at most two sentences.                                                             |
| `caption`   | Three to six words, burned in at the bottom while the scene holds.                                |
| `ready`     | A locator that must be visible before the scene's narration clock starts. Required.               |
| `highlight` | Locators to ring while the scene runs. Optional.                                                  |
| `steps`     | Actions at offsets from the narration start. Optional.                                            |
| `tailMs`    | How long the result holds after the narration and the last action end. At least 900, default 900. |
| `key`       | Marks the scene the animated PR thumbnail frames. The last `key` scene wins, else the last scene. |

A locator is a Playwright selector string, such as `role=button[name="Settings"]` or `text=Working section`. When it matches more than one element, the tool uses the first. A quoted role name matches the whole accessible name, case included, so `role=button[name="New thread"]` does not match the card named `New thread, server`. Use a regular expression for part of a name, as in `role=button[name=/^New thread, /]`.

**Steps.** Each step is `{ action, atMs, ... }`. `atMs` counts from the narration start. When you leave it out, the step lands in the middle of the narration.

| Action   | Fields                               | Does                                                                                          |
| -------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `click`  | `target`, optional `button: "right"` | Moves the real mouse to the target's centre, then clicks. A right-click opens a context menu. |
| `hover`  | `target`                             | Moves the real mouse to the target.                                                           |
| `press`  | `key`                                | Presses a key, such as `Enter` or `Escape`.                                                   |
| `scroll` | `dy`, optional `target`              | Moves the mouse over the target first, then scrolls by `dy` pixels.                           |

A scene whose `ready` never shows, or whose step fails, stops the recording with an error that names the scene.

## Pacing grammar

The tool enforces these rules. They are the defaults for every video.

1. The ring appears when the scene starts.
2. The narration names the ringed thing.
3. A click lands mid-sentence.
4. The result holds at least 900 ms after the narration ends, and after the last action ends when it ends later.
5. A scene has at most two sentences.
6. The whole video, title cards included, runs at most 75 seconds.

A scene's narration clock starts when its `ready` locator is visible and the page has painted twice since. The clip is placed at that real moment. A slow page therefore moves the scene and its narration together, and they never drift apart.

## Highlights and the cursor

The rings, the cursor dot and the probe flash are drawn in one fixed overlay above the page, with pointer events off, so they never block a click. Each ring comes from the locator's `boundingBox()` and is measured again every 100 ms until the scene ends, so it follows the element through layout changes and animations. A ring hides while its element is gone. The cursor dot follows the real mouse, which moves in 20 steps to each target, and shrinks while a button is down. The app gets no demo hooks.

## The sync probe

The probe checks the recorder's real offset between picture and sound. `record --probe` appends a probe scene at the end of the run. The probe plays a 400 ms 1 kHz tone at its start and paints the screen magenta for 300 ms at the same moment. `mux` finds the first frame change after the title card cut with ffmpeg's `scene` score and the tone onset with `silencedetect`, and reports the difference as the probe's drift. The budget is 250 ms.

Use the probe only in a dry run, never in the video you publish. Before the final recording of a feature's video, record its `after` side once with `--probe` and mux it. The probe then sits at the end of a full-length run, where any offset that grows with the length of the recording is largest. Record the measured drift in the running log, then record again without `--probe` for the video.

For a scene without the probe, `drift.json` reports the gap between the scene's start in the timeline and its narration onset in the final audio. That checks only that the mux placed each clip where the timeline says. It cannot see an offset between the recorder and the clock, which is what the probe is for.

Run the sample against any dev server to check the tool after a change.

```bash
node $DEMO tts --demo .agents/skills/verify-t3code/demos/sample.demo.mjs --out $OUT
node $DEMO record --demo .agents/skills/verify-t3code/demos/sample.demo.mjs --checkout . --cdp <cdp> --out $OUT --probe
node $DEMO mux --out $OUT
```

## Voice

`VOICE` at the top of `demo.mjs` holds the model, the voice and the instructions. Lee picks the voice. Until he does, it is `coral` with the instructions he heard in the samples. Clips are cached in `<main checkout>/.pstack/demo-tts-cache/` by a hash of the text, voice, instructions and model, so a re-record costs nothing and a changed line costs one clip. Each clip is written under a temporary name and renamed into place, so a killed run leaves no truncated clip. Each clip is trimmed of leading and trailing silence and normalized to -16 LUFS. The OpenAI key is read from `~/.config/lim-keys/models.env` by a child process only. `demo.mjs` itself never reads, prints or writes it. The cost line uses OpenAI's estimate of $0.015 per minute of speech.

## Privacy check

Stream videos are public to anyone with the link. Before any upload, someone checks three things for private data, such as pairing URLs, home paths, real thread titles, and any project or host name that should not leave the machine.

- `contact-sheet.png`, with three frames per scene, at the narration start, after its last action and at its end.
- Every full-size frame in `frames/`, one per second of the video.
- `narration.txt`, the words the video says.

A dev server's own `.t3` holds only disposable data, so record from one and never from prod data. Then record the check.

```bash
node $DEMO privacy $OUT --by <who> --note "<what was checked>"
```

`privacy.json` records the sha256 of `demo.mp4`, `contact-sheet.png`, `narration.txt` and the frames. `publish` refuses when no check is recorded or when any of those files changed since.

## Publish and embed

```bash
node $DEMO publish $OUT --pr <n> --dry-run   # print the comment, upload nothing
node $DEMO publish $OUT --pr <n>
```

`publish` refuses a video whose drift check failed, a video over 75 seconds, and a video without a current privacy check. It then asks `cf stream videos direct-upload create` for a one-time upload URL (account `e8e382d5bf8ec24ee2125188819b995c`, `maxDurationSeconds` 600, unsigned, no scheduled deletion). It posts the mp4 there and never prints the URL. It waits until Stream can play the video and checks that the watch page and the animated thumbnail answer 200. Then it adds or updates the one PR comment that starts with `<!-- t3code-demo -->`. `published.json` records the uid as soon as the upload lands, so a rerun after a timeout or a failed step waits on the same video instead of uploading again. It gains the URLs and the comment link at the end.

GitHub renders no iframe or player for an external video, so the comment shows Stream's animated GIF thumbnail linked to the watch page. A line says the preview is silent and links the narrated video. The thumbnail frames the `key` scene. `time` is that scene's start in the final video to a tenth of a second, `duration` is its hold up to 6 seconds, `width` is 600 and `fps` is 8. Stream answers 400 to a `width` over 600, and ends a `duration` that runs past the video at its last frame.

Delete a test upload with `CLOUDFLARE_ACCOUNT_ID=e8e382d5bf8ec24ee2125188819b995c cf stream videos delete <uid> --force`. Delete only videos you uploaded.

## Gotchas

- `boundingBox()` waits for its element, up to 30 s by default. The ring loop passes an 80 ms timeout, or a ringed element that leaves the page stalls the scene.
- ffmpeg reads commands from an open stdin and waits on it. Every child the tool runs gets no stdin.
- A busy page can add and remove an element before painting it. The probe flash starts its timer only after it has painted.
- The scene clock starts at the recording's first frame, read from the timestamp Playwright gives that frame. The webm can still run a few hundred ms longer or shorter than the timeline at its end, because the recorder pads and drops there, so `mux` cuts or pads each run to its timeline length.
- Vite compiles a route the first time it is visited, so on a cold dev server the first click into a page can take seconds. The next scene's `ready` absorbs that wait. Visit each page once in `seed` to keep that wait out of the video.
- The Stream watch page of a deleted video still answers 200, because it is a player shell. `cf stream videos get <uid>` answering 404 is the proof of deletion.

## Running log

Add a dated entry for each finished video. Give the PR, the voice and instructions strings, the probe's drift from the dry run, the thumbnail parameters that rendered on GitHub, any re-records and why, and the time per stage and the TTS cost.

- 2026-11-14, V1 (#87), `sample.demo.mjs`. Voice `coral` with the placeholder instructions.
  - At `ceda2c08e9` the probe sat between the two scenes, and the scene clock started when `screencast.start()` resolved. The probe measured -27 ms from flash to tone at load average 7, and +32 ms at load 60.
  - With the probe at the end of the run and the clock at the first frame's own timestamp, the probe measured 0 ms. An independent `signalstats` and `astats` read put the first magenta frame at 16.167 s and the tone onset in the audio block from 16.149 s to 16.171 s.
  - The thumbnail that rendered on GitHub was `time=9.8s&duration=6s&width=600&fps=8`. GitHub's image proxy served it with 200 on the first request. `width=640` answered 400.
  - TTS was 2 clips, about 11.5 s of speech and about $0.003, synthesized in 4 s. Recording took 15 s for 15 s of scenes, the mux took 5 s, and the publish took 25 s from upload to a ready video.
  - The test upload, uid `bbd8897413c79329df1959129ae8198c`, was deleted after its checks.
  - Re-records during the build had four causes, all fixed above. A hold overran by 29 s on the `boundingBox` wait. A mux hung on stdin. A flash never painted. A first-scene probe measured the title card cut.
