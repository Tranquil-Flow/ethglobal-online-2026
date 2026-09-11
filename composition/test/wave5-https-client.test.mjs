import test from "node:test";
import assert from "node:assert/strict";
import { publicFetch, WAVE5_ORIGIN } from "../wave5-https-client.mjs";
test("public qualification transport rejects loopback, tailnet and credentialed origins", async () => {
  for (const ip of [
    "127.0.0.1",
    "100.84.252.4",
    "100.126.111.123",
    "10.0.0.1",
    "192.168.1.1",
    "::1",
    "fd7a:115c:a1e0::1",
  ])
    assert.throws(() => publicFetch(ip), /PUBLIC_ADDRESS_REQUIRED/);
  assert.throws(
    () => publicFetch("8.8.8.8", "https://other.example"),
    /PUBLIC_ORIGIN_REQUIRED/,
  );
  const fetch = publicFetch("8.8.8.8");
  await assert.rejects(
    fetch("https://other.example/v1/jobs"),
    /PUBLIC_ORIGIN_MISMATCH/,
  );
  await assert.rejects(
    fetch(WAVE5_ORIGIN.replace("https://", "https://user:secret@")),
    /PUBLIC_ORIGIN_MISMATCH/,
  );
});
