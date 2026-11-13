#!/usr/bin/env node
// Reads a Limbase thread through the host package the server vendors:
// node limbase-turns.mjs <limbase home> <th id> [<turn id> ...]
// prints the capture cursor, then the served text of each turn id given.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";

const [home, threadId, ...ids] = process.argv.slice(2);
if (!home || !threadId) {
  console.error("usage: limbase-turns.mjs <limbase home> <th id> [<turn id> ...]");
  process.exit(2);
}
const server = NodeModule.createRequire(
  new URL("../../../../apps/server/package.json", import.meta.url),
);
const { connectLimbase } = await import(server.resolve("@limbase/host-agent-sdk"));
const { socketPath } = JSON.parse(NodeFS.readFileSync(`${home}/config/membase.json`, "utf8"));
const limbase = await connectLimbase(socketPath);
try {
  const at = { threadId, host: "claude", conversation: "main" };
  console.log(`cursor ${JSON.stringify(await limbase.call((c) => c.CaptureCursor(at)))}`);
  if (ids.length > 0) {
    const turns = await limbase.call((c) => c.GetTurns({ threadId, ids }));
    for (const turn of turns.served) console.log(`\n${turn.text}`);
    if (turns.unserved.length > 0) console.log(`\nunserved ${JSON.stringify(turns.unserved)}`);
  }
} finally {
  await limbase.close();
}
