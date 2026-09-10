import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  initializeApplication,
  startManagedApplication,
} from "../application-operator.mjs";
import { createClient } from "../../packages/access/src/index.mjs";
import { createAccessMcp } from "../../packages/access/src/mcp.mjs";
const require = createRequire(
  new URL("../../packages/access/package.json", import.meta.url),
);
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
test("CLI and MCP choose a signed offered profile without copying opaque digests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "application-parity-"));
  let app, mcp, server;
  try {
    await initializeApplication({ dataDir: join(dir, "state") });
    app = await startManagedApplication({
      configFile: join(dir, "state/application.json"),
    });
    const providerId = app.providerIds[0],
      pinsFile = join(dir, "pins.json"),
      promptFile = join(dir, "prompt.txt");
    await writeFile(pinsFile, JSON.stringify(app.pins[providerId]), {
      mode: 0o600,
    });
    await writeFile(promptFile, "synthetic client parity", { mode: 0o600 });
    const cli = (...args) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            new URL("../../packages/access/src/cli.mjs", import.meta.url)
              .pathname,
            ...args,
            "--base-url",
            app.url,
            "--pins-file",
            pinsFile,
          ],
          { env: { ...process.env, HOME: dir }, timeout: 15000 },
        );
        let out = "",
          err = "";
        child.stdout.on("data", (b) => (out += b));
        child.stderr.on("data", (b) => (err += b));
        child.on("error", reject);
        child.on("close", (code) =>
          code ? reject(Error(err)) : resolve(JSON.parse(out)),
        );
      });
    await cli("connect");
    const offers = await cli("offers");
    assert.equal(offers.offers.length, 1);
    const q = await cli(
      "quote",
      "--provider",
      providerId,
      "--profile-index",
      "0",
      "--prompt-file",
      promptFile,
      "--max-output",
      "2",
    );
    assert.equal(q.quote.profileId, offers.offers[0].payload.profileIds[0]);
    const c = createClient({ baseUrl: app.url, pins: app.pins[providerId] });
    await c.connect();
    server = createAccessMcp({ client: c });
    mcp = new Client({ name: "synthetic-parity", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
    const offered = await mcp.callTool({
      name: "access_offers",
      arguments: {},
    });
    assert.notEqual(offered.isError, true);
    const quoted = await mcp.callTool({
      name: "access_quote",
      arguments: {
        providerId,
        profileIndex: 0,
        prompt: "synthetic MCP quote",
        maxOutputTokens: 2,
        seed: 0,
      },
    });
    assert.notEqual(quoted.isError, true);
    const parsed = JSON.parse(quoted.content[0].text);
    assert.equal(parsed.request.profileId, q.quote.profileId);
  } finally {
    await mcp?.close();
    await server?.close();
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
