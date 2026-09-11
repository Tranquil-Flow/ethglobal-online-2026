import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initializeApplication,
  doctorApplication,
  startManagedApplication,
} from "../application-operator.mjs";

test("managed history wires RPC stable provenance lazily and rejects wrong-chain without weakening confirmations", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-history-rpc-"));
  let app,
    contacts = 0,
    chain = "0x7a69";
  const time = Math.floor(Date.now() / 1000);
  const block = (number) => ({
    number: "0x" + number.toString(16),
    hash: "0x" + String(number).padStart(64, "0"),
    timestamp: "0x" + time.toString(16),
    parentHash: "0x" + "00".repeat(32),
    nonce: "0x0000000000000000",
    difficulty: "0x0",
    gasLimit: "0x100000",
    gasUsed: "0x0",
    miner: "0x" + "00".repeat(20),
    extraData: "0x",
    transactions: [],
  });
  const meta = (n) => ({
    deployment: "local-controlled-index",
    hasIndexingErrors: false,
    block: { number: n, hash: block(n).hash, timestamp: time },
  });
  const server = createServer(async (req, res) => {
    contacts++;
    let raw = "";
    for await (const c of req) raw += c;
    const v = JSON.parse(raw);
    res.setHeader("content-type", "application/json");
    if (req.url === "/rpc") {
      const answer = (x) => ({
        jsonrpc: "2.0",
        id: x.id,
        result:
          x.method === "eth_chainId" ? chain : block(parseInt(x.params[0], 16)),
      });
      return res.end(
        JSON.stringify(Array.isArray(v) ? v.map(answer) : answer(v)),
      );
    }
    const n = v.variables?.block
      ? parseInt(v.variables.block.slice(2), 10)
      : 100;
    // Mimic hosted numeric historical metadata omission; hash-addressed queries are complete.
    const data =
      v.variables?.number !== undefined
        ? {
            _meta: {
              deployment: "local-controlled-index",
              hasIndexingErrors: false,
              block: { number: v.variables.number },
            },
          }
        : { _meta: meta(n), assessmentClaims: [], openAssessmentClaims: [] };
    res.end(JSON.stringify({ data }));
  });
  try {
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = "http://127.0.0.1:" + server.address().port;
    const dir = join(root, "app");
    await initializeApplication({
      dataDir: dir,
      providerIds: ["history.local"],
    });
    const manifest = JSON.parse(
      await readFile(join(dir, "operator.json"), "utf8"),
    );
    manifest.history = {
      endpoint: url + "/graph",
      rpcUrl: url + "/rpc",
      deploymentId: "local-controlled-index",
      deployment: {
        mode: "development",
        chainId: 31337,
        network: "localhost",
        address: "0x" + "11".repeat(20),
        publisher: "0x" + "22".repeat(20),
        codeHash: "0x" + "33".repeat(32),
        startBlock: 1,
        confirmations: 12,
      },
    };
    await writeFile(join(dir, "operator.json"), JSON.stringify(manifest), {
      mode: 0o600,
    });
    assert.equal(
      (await doctorApplication({ configFile: join(dir, "application.json") }))
        .networkContacted,
      false,
    );
    assert.equal(contacts, 0);
    app = await startManagedApplication({
      configFile: join(dir, "application.json"),
    });
    assert.equal(contacts, 0);
    const get = async () =>
      await (
        await fetch(app.url + "/v1/providers/history.local/history")
      ).json();
    const h = await get();
    assert.equal(h.freshness, "fresh");
    assert.equal(h.indexedBlock, 89);
    assert.deepEqual(h.observations, []);
    assert(contacts > 0);
    chain = "0x1";
    assert.equal((await get()).freshness, "unavailable");
    await app.close();
    app = undefined;
  } finally {
    await app?.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  }
});
