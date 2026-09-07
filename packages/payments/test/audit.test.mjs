import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "../src/safety.mjs";
import { spawnSync } from "node:child_process";
test("mirror JSON preserves base units larger than IEEE-754 exact integer range", async () => {
  const parsed = await readJson(
    new Response('{"amount":9007199254741033,"nonce":0}'),
    65536,
    true,
  );
  assert.equal(parsed.amount, 9007199254741033n);
  assert.equal(parsed.nonce, 0n);
});
test("optional HCS audit is consented digest-only native SDK construction; never broadcasts by default", () => {
  const args = [
    "scripts/hcs-audit.mjs",
    "--network",
    "hedera:testnet",
    "--mode",
    "development",
    "--topic",
    "0.0.123",
    "--digest",
    "sha256:" + "a".repeat(64),
    "--consent",
  ];
  const dry = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  const r = JSON.parse(dry.stdout);
  assert.equal(r.broadcast, false);
  assert.equal(r.mode, "development");
  assert(r.messageBytes > 0);
  const denied = spawnSync(
    process.execPath,
    args.filter((x) => x !== "--consent"),
    { encoding: "utf8" },
  );
  assert.notEqual(denied.status, 0);
  const noApproval = spawnSync(process.execPath, [...args, "--submit"], {
    encoding: "utf8",
  });
  assert.notEqual(noApproval.status, 0);
});
