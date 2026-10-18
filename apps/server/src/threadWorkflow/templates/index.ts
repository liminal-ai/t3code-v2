// @effect-diagnostics nodeBuiltinImport:off - the Crypto service has no hash function.
import * as NodeCrypto from "node:crypto";

import type {
  ThreadWorkflowTemplate,
  ThreadWorkflowTemplateFreshness,
  ThreadWorkflowTemplateId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { openEnded } from "./openEnded.ts";
import { orchestrate } from "./orchestrate.ts";
import { singleTask } from "./singleTask.ts";

export const builtInTemplates: ReadonlyMap<ThreadWorkflowTemplateId, ThreadWorkflowTemplate> =
  new Map([singleTask, orchestrate, openEnded].map((template) => [template.id, template]));

/**
 * Compares the installed playbook with the hash the template was derived from. A stale template
 * still starts; the flag tells the user a fork sync changed the playbook under it.
 */
export const freshness = (
  template: ThreadWorkflowTemplate,
  playbookDir: string,
): Effect.Effect<ThreadWorkflowTemplateFreshness, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (template.source === null) return "no-source";
    const { sha256 } = template.source;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fileSystem.readFile(path.join(playbookDir, template.source.playbook)).pipe(
      Effect.map((bytes) =>
        NodeCrypto.createHash("sha256").update(bytes).digest("hex") === sha256 ? "fresh" : "stale",
      ),
      // Unreadable counts as missing: either way nothing installed vouches for the template.
      Effect.orElseSucceed(() => "source-missing" as const),
    );
  });
