import { THREAD_WORKFLOW_LIMITS, ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { installedSha256 } from "./derive.ts";
import { builtInTemplates, freshness } from "./index.ts";

const PLAYBOOK = "poteto-mode/playbooks/example.md";
// sha256 of "# Example\n".
const EXAMPLE_SHA = "8ef0b048ad51a9d2ccaf9177716d7c83159a1d8c22fd37aa2b7d03c11b21b40d";

const decodeTemplate = Schema.decodeSync(ThreadWorkflowTemplate);
const sourced = (sha256: string) =>
  decodeTemplate({
    id: "example",
    version: 1,
    title: "Example",
    description: "A template with a playbook behind it.",
    source: { playbook: PLAYBOOK, commit: "0".repeat(40), sha256 },
    steps: [{ title: "Do it", instructions: "Do it.", proofLevel: "none", waitsForUser: false }],
  });

const withPlaybookDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-thread-workflow-playbooks-",
  });
  yield* fileSystem.makeDirectory(path.join(dir, path.dirname(PLAYBOOK)), { recursive: true });
  yield* fileSystem.writeFileString(path.join(dir, PLAYBOOK), "# Example\n");
  return dir;
});

it.layer(NodeServices.layer)("thread workflow templates", (it) => {
  it.effect("is fresh when the installed playbook hashes to the recorded sha", () =>
    Effect.gen(function* () {
      const dir = yield* withPlaybookDir;
      assert.strictEqual(yield* freshness(sourced(EXAMPLE_SHA), dir), "fresh");
    }),
  );

  it.effect("is stale when the installed playbook changed", () =>
    Effect.gen(function* () {
      const dir = yield* withPlaybookDir;
      assert.strictEqual(yield* freshness(sourced("1".repeat(64)), dir), "stale");
    }),
  );

  it.effect("is source-missing when the playbook is not installed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const empty = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-thread-workflow-empty-",
      });
      assert.strictEqual(yield* freshness(sourced(EXAMPLE_SHA), empty), "source-missing");
    }),
  );

  it.effect("is no-source for a template with no playbook", () =>
    Effect.gen(function* () {
      const openEnded = builtInTemplates.get("open-ended" as never);
      assert.isDefined(openEnded);
      assert.strictEqual(yield* freshness(openEnded, "/nonexistent"), "no-source");
    }),
  );
});

it("ships the twenty playbook templates in poteto-mode's order, then open-ended", () => {
  assert.deepStrictEqual(
    [...builtInTemplates.keys()],
    [
      "investigation",
      "bug-fix",
      "perf-issue",
      "hillclimb",
      "feature",
      "refactoring",
      "prototype",
      "authoring-a-skill",
      "eval",
      "babysit",
      "shipping",
      "autonomous-run",
      "orchestrate",
      "autopilot-full",
      "session-pickup",
      "multi-phase-plan",
      "worktree-cleanup",
      "visual-parity",
      "fork-sync",
      "retro-round",
      "open-ended",
    ],
  );
  const waiting = [...builtInTemplates.values()].flatMap((template) =>
    template.steps.filter((step) => step.waitsForUser).map((step) => `${template.id}/${step.slug}`),
  );
  // Only a step the user always ends carries the flag: the note's waits-for-user line is
  // unconditional, so a step that waits only sometimes says so in its instructions instead.
  assert.deepStrictEqual(waiting, ["retro-round/record-decisions", "open-ended/confirm-done"]);
});

it("opens and closes open-ended like a playbook template, with the sign-off last and room for 3 stages", () => {
  const { steps } = builtInTemplates.get("open-ended" as never)!;
  assert.deepStrictEqual(
    steps.map((step) => step.slug),
    ["find-verify-skill", "close-out-tickets", "reflect-and-upkeep", "cleanup", "confirm-done"],
  );
  assert.strictEqual(THREAD_WORKFLOW_LIMITS.steps - steps.length, 3);
});

const OPENS_WITHOUT_VERIFY_SKILL = new Set([
  "investigation",
  "retro-round",
  "worktree-cleanup",
  "session-pickup",
]);
const VERIFY_SKILL = "project's verify skill";

const playbookTemplates = [...builtInTemplates.values()].filter(
  (template) => template.id !== "open-ended",
);

describe.each(playbookTemplates.map((template) => [template.id, template] as const))(
  "the %s template",
  (_id, template) => {
    const { steps } = template;
    const slugs = steps.map((step) => step.slug);

    it("fits the step cap with a unique hand-written slug on every step", () => {
      assert.isAtMost(steps.length, THREAD_WORKFLOW_LIMITS.steps);
      assert.notInclude(slugs, undefined);
      assert.lengthOf(new Set(slugs), slugs.length);
    });

    it("pins its playbook by commit and hash, or has none only for fork-sync", () => {
      if (template.id === "fork-sync") return assert.isNull(template.source);
      assert.match(template.source?.commit ?? "", /^[0-9a-f]{40}$/);
      assert.match(template.source?.sha256 ?? "", /^[0-9a-f]{64}$/);
    });

    it("opens by making the run folder and closes with close-out, reflect, then cleanup", () => {
      assert.include(steps[0]?.instructions, ".pstack/runs/<run>/");
      assert.include(steps[0]?.instructions, "references/cleanup-protocol.md");
      assert.strictEqual(slugs.at(-1), "cleanup");
      assert.include(steps.at(-1)?.instructions, "references/cleanup-protocol.md");
      assert.isTrue(steps.some((step) => step.instructions.includes("Linear project")));
      assert.isTrue(steps.some((step) => step.instructions.includes("`/reflect`")));
    });

    it.skipIf(OPENS_WITHOUT_VERIFY_SKILL.has(template.id))(
      "checks for the project's verify skill first and drives every verify step through it",
      () => {
        assert.strictEqual(slugs[0], "find-verify-skill");
        assert.include(steps[0]?.instructions, VERIFY_SKILL);
        for (const step of steps) {
          if (/\bverify\b/i.test(`${step.title} ${step.instructions}`)) {
            assert.include(step.instructions, VERIFY_SKILL, step.slug);
          }
        }
      },
    );

    it("asks the user only on a condition, and names the decision a waiting step ends with", () => {
      for (const step of steps) {
        if (/\bask (Lee|the user)\b/i.test(step.instructions)) {
          assert.match(step.instructions, /\b(if|when|only|otherwise)\b/i, step.slug);
        }
        if (step.waitsForUser) assert.match(step.instructions, /\bthe user decides\b/i, step.slug);
        if (/\bskip (this|the) wait\b/i.test(step.instructions)) {
          assert.isFalse(step.waitsForUser, `${step.slug} waits only sometimes`);
        }
      }
    });

    const source = template.source;
    const installed = source === null ? null : installedSha256(source.playbook);
    it.skipIf(source === null || installed === null)(
      source !== null && installed === null
        ? `matches the installed playbook (skipped: ~/.agents/skills/${source.playbook} is not installed here)`
        : "matches the installed playbook",
      () => {
        assert.strictEqual(
          source?.sha256,
          installed,
          `${source?.playbook} changed since this template was derived; refresh it and rerun derive.ts`,
        );
      },
    );
  },
);
