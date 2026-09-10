import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli, privateWrite } from "../src/cli.mjs";
import { checkBuyerEvidenceJson } from "../src/index.mjs";
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
test("offline CLI requires retained expectation and public pins, no connection or operational secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buyer-offline-"));
  try {
    for (const [name, v] of Object.entries({ bundle, pins, expected }))
      await privateWrite(join(dir, name + ".json"), v);
    const args = [
      "evidence-check",
      "--evidence-file",
      join(dir, "bundle.json"),
      "--pins-file",
      join(dir, "pins.json"),
      "--expectation-file",
      join(dir, "expected.json"),
    ];
    const result = await runCli(args);
    assert.equal(result.originalRequestBound, true);
    assert.equal(result.completeOutputBound, true);
    assert.equal(result.executionVerified, false);
    assert.equal(result.financialProtection, false);
    await assert.rejects(runCli(args.slice(0, -2)), /EXPECTATION/);
    await writeFile(join(dir, "broken.json"), '{"version":', { mode: 0o600 });
    await assert.rejects(
      runCli([...args.slice(0, 2), join(dir, "broken.json"), ...args.slice(3)]),
    );
    await assert.rejects(
      checkBuyerEvidenceJson("x".repeat(2097153), pins, expected),
    );
    await assert.rejects(
      checkBuyerEvidenceJson("PK archive data", pins, expected),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
