// Explicit host handoff to the actual access MCP server. Never accepts a capability in argv.
import { readFileSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { createAccessMcp } from "../packages/access/src/mcp.mjs";
import { createClient, safeBaseUrl } from "../packages/access/src/index.mjs";
import { assertRuntime } from "../scripts/runtime.mjs";
const require = createRequire(
  new URL("../packages/access/package.json", import.meta.url),
);
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
try {
  assertRuntime();
  const file = process.argv[2];
  if (!file || process.argv.length !== 3) throw Error();
  const s = lstatSync(file);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.mode & 0o077 ||
    s.uid !== process.getuid() ||
    s.size > 16384
  )
    throw Error();
  const session = JSON.parse(readFileSync(file, "utf8"));
  const baseUrl = safeBaseUrl(session.baseUrl);
  if (!session.capability || Date.parse(session.expiresAt) <= Date.now())
    throw Error();
  const client = createClient({ baseUrl, capability: session.capability });
  const server = createAccessMcp({ client });
  await server.connect(new StdioServerTransport());
} catch {
  console.error("MCP_PRIVATE_SESSION_REQUIRED");
  process.exitCode = 1;
}
