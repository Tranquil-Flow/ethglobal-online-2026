import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createFixtureServer, fixtureProfile } from "../src/fixture.mjs";

function parse(result) {
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}

test("MCP stdio tools use SDK; reads decide on compatibility, budget and fresh history", async (t) => {
  const fixture = createFixtureServer();
  const { url } = await fixture.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => fixture.close());
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/mcp.mjs"],
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      ETHONLINE_BASE_URL: url,
      ETHONLINE_DEVELOPMENT_PAYMENT: "1",
    },
  });
  const client = new Client({ name: "access-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  const listed = await client.listTools();
  const names = listed.tools.map((t) => t.name);
  assert.deepEqual(
    names.sort(),
    [
      "access_assess",
      "access_buyer_context",
      "access_evidence_check",
      "access_assessments",
      "access_delete_evidence",
      "access_export",
      "access_inspect",
      "access_publication",
      "access_receipt",
      "access_connect",
      "access_history",
      "access_offers",
      "access_quote",
      "access_recovery_export",
      "access_recovery_import",
      "access_recovery_revoke",
      "access_select",
      "access_submit",
      "access_watch",
      "mycelium.provider_stats",
    ].sort(),
  );
  await client.callTool({ name: "access_connect", arguments: {} });
  const { readFile } = await import("node:fs/promises");
  const golden = JSON.parse(
    await readFile(
      new URL("./fixtures/historical-v1.json", import.meta.url),
      "utf8",
    ),
  );
  const { bundle, pins } = golden;
  const expected = {
    request: bundle.request,
    jobId: bundle.receipt.payload.jobId,
    quoteId: bundle.receipt.payload.quoteId,
    paymentId: bundle.receipt.payload.paymentId,
    output: bundle.output,
  };
  const checked = parse(
    await client.callTool({
      name: "access_evidence_check",
      arguments: { evidenceJson: JSON.stringify(bundle), pins, expected },
    }),
  );
  assert.equal(checked.originalRequestBound, true);
  assert.equal(checked.executionVerified, false);
  const quote = parse(
    await client.callTool({
      name: "access_quote",
      arguments: {
        providerId: "safe.eth",
        profileId: fixtureProfile.profileId,
        prompt: "synthetic",
        maxOutputTokens: 8,
        seed: 7,
      },
    }),
  );
  const decision = parse(
    await client.callTool({
      name: "access_select",
      arguments: {
        names: ["safe.eth"],
        quotes: [quote.quote],
        profileId: fixtureProfile.profileId,
        maxAmountBaseUnits: "10",
        network: "eip155:84532",
        asset: "USDC",
      },
    }),
  );
  assert.equal(decision.selected.providerId, "safe.eth");
  assert.equal(decision.decision.historyFreshness, "fresh");
  assert.equal(decision.decision.compatible, true);
  const denied = await client.callTool({
    name: "access_submit",
    arguments: {
      request: quote.request,
      quoteId: quote.quote.quoteId,
      idempotencyKey: "mcp-denied",
    },
  });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /explicit bounded authorization/i);
  const submitted = parse(
    await client.callTool({
      name: "access_submit",
      arguments: {
        request: quote.request,
        quoteId: quote.quote.quoteId,
        idempotencyKey: "mcp-ok",
        authorization: {
          explicit: true,
          maxAmountBaseUnits: "10",
          asset: "USDC",
          network: "eip155:84532",
          developmentPayment: true,
        },
      },
    }),
  );
  assert.equal(submitted.job.executionStatus, "running");
  const watched = parse(
    await client.callTool({
      name: "access_watch",
      arguments: { jobId: submitted.job.jobId },
    }),
  );
  assert.equal(watched.events.at(-1).event, "done");
});
