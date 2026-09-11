import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createReceiptGatedSink,
  startPublicWindow,
} from "../wave5-public-window.mjs";
test("public window refuses startup without explicit authority", async () => {
  await assert.rejects(
    startPublicWindow({ approved: false }),
    /PUBLIC_WINDOW_APPROVAL_REQUIRED/,
  );
});
test("only an explicitly permitted receipt can reach the real publisher factory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "receipt-permit-"));
  const file = join(dir, "allow.json");
  let creates = 0,
    calls = 0;
  const digest = "sha256:" + "a".repeat(64);
  const event = { kind: "receipt", mode: "live", objectDigest: digest };
  await writeFile(file, JSON.stringify({ receiptDigests: [] }), {
    mode: 0o600,
  });
  const sink = createReceiptGatedSink({
    authorizationFile: file,
    createSink: async () => {
      creates++;
      return {
        publish: async () => {
          calls++;
          return { status: "confirmed" };
        },
        close: async () => {},
      };
    },
  });
  try {
    assert.equal((await sink.publish({ event })).status, "pending");
    assert.equal(creates, 0);
    await writeFile(file, JSON.stringify({ receiptDigests: [digest] }));
    assert.equal(
      (await sink.publish({ event: { ...event, kind: "assessment" } })).status,
      "unavailable",
    );
    assert.equal(creates, 0);
    assert.equal((await sink.publish({ event })).status, "confirmed");
    assert.equal(creates, 1);
    assert.equal(calls, 1);
    await sink.close();
    await assert.rejects(sink.publish({ event }), /PUBLICATION_CLOSED/);
  } finally {
    await sink.close();
    await rm(dir, { recursive: true, force: true });
  }
});
