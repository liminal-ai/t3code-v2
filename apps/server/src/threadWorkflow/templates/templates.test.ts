import { ThreadWorkflowTemplate } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

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

  it("ships single-task, orchestrate and open-ended with user steps where the addendum puts them", () => {
    assert.deepStrictEqual(
      [...builtInTemplates.keys()],
      ["single-task", "orchestrate", "open-ended"],
    );
    const waits = (id: string) =>
      builtInTemplates
        .get(id as never)
        ?.steps.filter((step) => step.waitsForUser)
        .map((step) => step.title);
    assert.deepStrictEqual(waits("single-task"), [
      "Talk it through with the user",
      "Merge to main",
    ]);
    assert.deepStrictEqual(waits("orchestrate"), ["Approve the program plan", "Land continuously"]);
    assert.deepStrictEqual(waits("open-ended"), ["Confirm done with the user"]);
  });
});
