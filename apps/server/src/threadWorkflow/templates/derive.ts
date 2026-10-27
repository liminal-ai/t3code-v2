// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a CLI that runs under bare node, outside the Effect runtime.
/**
 * Prints the `source` block for a template built from an installed pstack playbook:
 *
 *   node apps/server/src/threadWorkflow/templates/derive.ts poteto-mode/playbooks/feature.md [--commit <sha>]
 *
 * The path is relative to `~/.agents/skills`. Without `--commit`, the commit is the last one on
 * pstack-lim's `origin/lim` that touched the playbook. Only node builtins are imported, so the
 * script runs without a build.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const SKILLS_DIR = NodePath.join(NodeOS.homedir(), ".agents", "skills");
const PSTACK_LIM = NodePath.join(
  NodeOS.homedir(),
  "lim-v2",
  "code",
  "liminal-plugins",
  "pstack-lim",
);

/** The installed playbook's sha256, or null when it is not installed on this machine. */
export const installedSha256 = (playbook: string, skillsDir = SKILLS_DIR): string | null => {
  const file = NodePath.join(skillsDir, playbook);
  if (!NodeFS.existsSync(file)) return null;
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
};

const lastCommit = (playbook: string) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-C", PSTACK_LIM, "log", "-1", "--format=%H", "origin/lim", "--", `pstack/skills/${playbook}`],
    { encoding: "utf8" },
  ).trim();

const main = (args: ReadonlyArray<string>) => {
  const [playbook, flag, commitArg] = args;
  if (playbook === undefined || (flag !== undefined && (flag !== "--commit" || !commitArg))) {
    console.error("usage: derive.ts <playbook path relative to ~/.agents/skills> [--commit <sha>]");
    return 2;
  }
  const sha256 = installedSha256(playbook);
  if (sha256 === null) {
    console.error(`derive.ts: ${NodePath.join(SKILLS_DIR, playbook)} is not installed.`);
    return 1;
  }
  const commit = commitArg ?? lastCommit(playbook);
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    console.error(`derive.ts: no pstack-lim commit on origin/lim touches ${playbook}.`);
    return 1;
  }
  console.log(JSON.stringify({ playbook, commit, sha256 }, null, 2));
  return 0;
};

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
