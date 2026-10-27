// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { installedSha256 } from "./derive.ts";

const PLAYBOOK = "poteto-mode/playbooks/example.md";
const EXAMPLE_CONTENTS = "# Example\n";
const EXAMPLE_SHA = "8ef0b048ad51a9d2ccaf9177716d7c83159a1d8c22fd37aa2b7d03c11b21b40d";
const COMMIT = "a".repeat(40);

const withHome = (run: (home: string) => void) => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-derive-"));
  try {
    const file = NodePath.join(home, ".agents", "skills", PLAYBOOK);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, EXAMPLE_CONTENTS);
    run(home);
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
};

const derive = (home: string, ...args: Array<string>) =>
  NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(import.meta.dirname, "derive.ts"), ...args],
    { encoding: "utf8", env: { ...process.env, HOME: home } },
  );

it("hashes the installed playbook, and answers null when it is not installed", () =>
  withHome((home) => {
    const skills = NodePath.join(home, ".agents", "skills");
    assert.strictEqual(installedSha256(PLAYBOOK, skills), EXAMPLE_SHA);
    assert.isNull(installedSha256("poteto-mode/playbooks/missing.md", skills));
  }));

it("prints the source block a template pastes in", () =>
  withHome((home) => {
    const result = derive(home, PLAYBOOK, "--commit", COMMIT);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout), {
      playbook: PLAYBOOK,
      commit: COMMIT,
      sha256: EXAMPLE_SHA,
    });
  }));

it("refuses a playbook that is not installed and a bare --commit", () =>
  withHome((home) => {
    const missing = derive(home, "poteto-mode/playbooks/missing.md", "--commit", COMMIT);
    assert.strictEqual(missing.status, 1);
    assert.include(missing.stderr, "is not installed");
    assert.strictEqual(derive(home, PLAYBOOK, "--commit").status, 2);
  }));
