// Explicit host handoff to the actual access MCP server. Never accepts a capability in argv.
import { readFileSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import {
  createAccessMcp,
  NON_ECONOMIC_MCP_SUBMISSION_POLICY,
} from "../packages/access/src/mcp.mjs";
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
  const [file, policyFlag] = process.argv.slice(2);
  if (
    !file ||
    process.argv.length > 4 ||
    (policyFlag !== undefined && policyFlag !== "--allow-non-economic")
  )
    throw Error();
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
  if (
    typeof session.capability !== "string" ||
    !session.capability ||
    !Number.isFinite(Date.parse(session.expiresAt)) ||
    Date.parse(session.expiresAt) <= Date.now()
  )
    throw Error();
  // Preserve legacy authenticated read-only sessions. Signed-offer operations
  // still require SDK pins, and enabling submission always requires them.
  if (policyFlag && !session.pins) throw Error();
  if (
    session.pins !== undefined &&
    (!session.pins ||
      Array.isArray(session.pins) ||
      !session.pins.providerId ||
      !session.pins.keyId ||
      session.pins.publicKeyJwk?.kty !== "OKP" ||
      session.pins.publicKeyJwk?.crv !== "Ed25519" ||
      !session.pins.publicKeyJwk?.x ||
      "d" in session.pins.publicKeyJwk)
  )
    throw Error();
  const client = createClient({
    baseUrl,
    capability: session.capability,
    pins: session.pins,
  });
  const server = createAccessMcp({
    client,
    hostSubmissionPolicy:
      policyFlag === "--allow-non-economic"
        ? NON_ECONOMIC_MCP_SUBMISSION_POLICY
        : undefined,
  });
  await server.connect(new StdioServerTransport());
} catch {
  console.error("MCP_PRIVATE_SESSION_REQUIRED");
  process.exitCode = 1;
}
