import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export default {
  playwright: (checkout) =>
    NodeModule.createRequire(NodePath.join(checkout, "apps", "web", "package.json"))("playwright"),

  origin: (checkout) =>
    new URL(
      JSON.parse(
        NodeFS.readFileSync(
          NodePath.join(checkout, ".t3", "userdata", "server-runtime.json"),
          "utf8",
        ),
      ).devUrl,
    ).origin,

  seedContext: ({ checkout }) => ({
    t3v: async (...args) => {
      const script = NodePath.join(checkout, ".agents/skills/verify-t3code/scripts/t3v.mjs");
      try {
        const { stdout } = await execFile(process.execPath, [script, ...args], {
          cwd: checkout,
          maxBuffer: 1 << 26,
        });
        return stdout;
      } catch (error) {
        throw new Error(
          `t3v ${args.join(" ")} exited ${error.code}: ${String(error.stderr ?? "")
            .trim()
            .slice(-500)}`,
          { cause: error },
        );
      }
    },
  }),
};
