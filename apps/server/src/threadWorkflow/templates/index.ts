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

import { authoringASkill } from "./authoringASkill.ts";
import { autonomousRun } from "./autonomousRun.ts";
import { autopilotFull } from "./autopilotFull.ts";
import { babysit } from "./babysit.ts";
import { bugFix } from "./bugFix.ts";
import { evalRun } from "./evalRun.ts";
import { feature } from "./feature.ts";
import { hillclimb } from "./hillclimb.ts";
import { multiPhasePlan } from "./multiPhasePlan.ts";
import { openEnded } from "./openEnded.ts";
import { orchestrate } from "./orchestrate.ts";
import { perfIssue } from "./perfIssue.ts";
import { prototype } from "./prototype.ts";
import { refactoring } from "./refactoring.ts";
import { shipping } from "./shipping.ts";
import { visualParity } from "./visualParity.ts";

/** One per pstack playbook in use, in poteto-mode's order, then open-ended for work none fits. */
export const builtInTemplates: ReadonlyMap<ThreadWorkflowTemplateId, ThreadWorkflowTemplate> =
  new Map(
    [
      bugFix,
      perfIssue,
      hillclimb,
      feature,
      refactoring,
      prototype,
      authoringASkill,
      evalRun,
      babysit,
      shipping,
      autonomousRun,
      orchestrate,
      autopilotFull,
      multiPhasePlan,
      visualParity,
      openEnded,
    ].map((template) => [template.id, template]),
  );

/**
 * Compares the installed playbook with the hash the template was derived from. A stale template
 * still starts; the flag tells the user a fork sync changed the playbook under it.
 */
export const freshness = Effect.fn("threadWorkflow.templates.freshness")(function* (
  template: ThreadWorkflowTemplate,
  playbookDir: string,
): Effect.fn.Return<ThreadWorkflowTemplateFreshness, never, FileSystem.FileSystem | Path.Path> {
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
