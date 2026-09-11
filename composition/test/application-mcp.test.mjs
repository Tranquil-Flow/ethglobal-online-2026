import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initializeApplication,
  startManagedApplication,
} from "../application-operator.mjs";

const require = createRequire(
  new URL("../../packages/access/package.json", import.meta.url),
);
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");
const root = fileURLToPath(new URL("../..", import.meta.url));
const cliPath = fileURLToPath(
  new URL("../../packages/access/src/cli.mjs", import.meta.url),
);
const mcpPath = fileURLToPath(new URL("../mcp.mjs", import.meta.url));
const standaloneMcpPath = fileURLToPath(
  new URL("../../packages/access/src/mcp.mjs", import.meta.url),
);

function parse(result) {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}

function runCli(args, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, HOME: home },
      timeout: 15000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function connectRootMcp(sessionFile, { allowNonEconomic = false } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      mcpPath,
      sessionFile,
      ...(allowNonEconomic ? ["--allow-non-economic"] : []),
    ],
    cwd: root,
    env: { PATH: process.env.PATH },
    stderr: "pipe",
  });
  const client = new Client({ name: "managed-mcp-acceptance", version: "1" });
  await client.connect(transport);
  return client;
}

async function connectStandaloneMcp(baseUrl, pinsFile) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [standaloneMcpPath],
    cwd: root,
    env: {
      PATH: process.env.PATH,
      ETHONLINE_BASE_URL: baseUrl,
      ETHONLINE_PINS_FILE: pinsFile,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "standalone-mcp-acceptance",
    version: "1",
  });
  await client.connect(transport);
  return client;
}

async function quote(client, providerId, prompt) {
  return parse(
    await client.callTool({
      name: "access_quote",
      arguments: {
        providerId,
        profileIndex: 0,
        prompt,
        maxOutputTokens: 2,
        seed: 0,
      },
    }),
  );
}

const nonEconomicAuthorization = {
  explicit: true,
  nonEconomic: true,
  maxAmountBaseUnits: "0",
  asset: "none",
  network: "non-economic",
};

test(
  "private CLI pins feed actual stdio MCP; host and caller jointly allow only zero-value submission",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "application-mcp-"));
    let app;
    const clients = [];
    try {
      const dataDir = join(dir, "state");
      await initializeApplication({ dataDir });
      app = await startManagedApplication({
        configFile: join(dataDir, "application.json"),
      });
      const providerId = app.providerIds[0];
      const pinsFile = join(dir, "public-pins.json");
      await writeFile(pinsFile, JSON.stringify(app.pins[providerId]), {
        mode: 0o600,
      });

      const invalidPinsFile = join(dir, "invalid-private-pins.json");
      await writeFile(
        invalidPinsFile,
        JSON.stringify({
          ...app.pins[providerId],
          publicKeyJwk: {
            ...app.pins[providerId].publicKeyJwk,
            d: "synthetic-private-component-must-not-be-persisted",
          },
        }),
        { mode: 0o600 },
      );
      const invalidPins = await runCli(
        ["connect", "--base-url", app.url, "--pins-file", invalidPinsFile],
        dir,
      );
      assert.equal(invalidPins.code, 1);
      assert.match(invalidPins.stderr, /INVALID_PUBLIC_PINS/);
      await assert.rejects(
        stat(join(dir, ".ethonline-access", "session.json")),
        { code: "ENOENT" },
      );

      const connected = await runCli(
        ["connect", "--base-url", app.url, "--pins-file", pinsFile],
        dir,
      );
      assert.equal(connected.code, 0, connected.stderr);
      const sessionFile = join(dir, ".ethonline-access", "session.json");
      assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);
      const session = JSON.parse(await readFile(sessionFile, "utf8"));
      assert.equal(session.baseUrl, app.url);
      assert.deepEqual(session.pins, app.pins[providerId]);

      const defaultDenied = await connectRootMcp(sessionFile);
      clients.push(defaultDenied);
      const offers = parse(
        await defaultDenied.callTool({ name: "access_offers", arguments: {} }),
      );
      assert.equal(offers.offers[0].payload.providerId, providerId);
      const deniedQuote = await quote(
        defaultDenied,
        providerId,
        "synthetic default-denied MCP request",
      );
      const hostDenied = await defaultDenied.callTool({
        name: "access_submit",
        arguments: {
          request: deniedQuote.request,
          quoteId: deniedQuote.quote.quoteId,
          idempotencyKey: "mcp-host-denied",
          authorization: nonEconomicAuthorization,
        },
      });
      assert.equal(hostDenied.isError, true);
      assert.match(
        hostDenied.content[0].text,
        /host non-economic.*policy required/i,
      );
      await defaultDenied.close();
      clients.pop();

      const allowed = await connectRootMcp(sessionFile, {
        allowNonEconomic: true,
      });
      clients.push(allowed);
      const allowedQuote = await quote(
        allowed,
        providerId,
        "synthetic allowed MCP request",
      );
      assert.equal(allowedQuote.quote.amountBaseUnits, "0");
      assert.equal(allowedQuote.quote.network, "non-economic");
      assert.equal(allowedQuote.quote.asset, "none");

      const callerDenied = await allowed.callTool({
        name: "access_submit",
        arguments: {
          request: allowedQuote.request,
          quoteId: allowedQuote.quote.quoteId,
          idempotencyKey: "mcp-caller-denied",
        },
      });
      assert.equal(callerDenied.isError, true);
      assert.match(
        callerDenied.content[0].text,
        /explicit bounded authorization/i,
      );

      const widenedDenied = await allowed.callTool({
        name: "access_submit",
        arguments: {
          request: allowedQuote.request,
          quoteId: allowedQuote.quote.quoteId,
          idempotencyKey: "mcp-widened-denied",
          authorization: {
            ...nonEconomicAuthorization,
            maxAmountBaseUnits: "1",
          },
        },
      });
      assert.equal(widenedDenied.isError, true);
      assert.match(
        widenedDenied.content[0].text,
        /zero-value.*authorization required/i,
      );

      const submitted = parse(
        await allowed.callTool({
          name: "access_submit",
          arguments: {
            request: allowedQuote.request,
            quoteId: allowedQuote.quote.quoteId,
            idempotencyKey: "mcp-zero-value-ok",
            authorization: nonEconomicAuthorization,
          },
        }),
      );
      assert.equal(submitted.job.payment.status, "authorized");
      const watched = parse(
        await allowed.callTool({
          name: "access_watch",
          arguments: { jobId: submitted.job.jobId },
        }),
      );
      assert.equal(watched.events.at(-1).event, "done");
      assert.ok(watched.events.some((event) => event.event === "delta"));
      const inspected = parse(
        await allowed.callTool({
          name: "access_inspect",
          arguments: { jobId: submitted.job.jobId },
        }),
      );
      assert.equal(inspected.executionStatus, "succeeded");
      assert.equal(inspected.payment.amountBaseUnits, undefined);

      const standalone = await connectStandaloneMcp(app.url, pinsFile);
      clients.push(standalone);
      parse(
        await standalone.callTool({ name: "access_connect", arguments: {} }),
      );
      const standaloneOffers = parse(
        await standalone.callTool({ name: "access_offers", arguments: {} }),
      );
      assert.equal(standaloneOffers.offers[0].payload.providerId, providerId);
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await app?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
