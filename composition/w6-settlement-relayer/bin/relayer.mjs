#!/usr/bin/env node
import { runRelayerProcess } from "../src/relayer.mjs";
import { DEFAULT_OUTBOX_PATH } from "../src/outbox.mjs";

const args = new Set(process.argv.slice(2));
const logPath = process.env.W6_VERDICT_LOG;
const outboxPath = process.env.W6_RELAYER_OUTBOX ?? DEFAULT_OUTBOX_PATH;
const once = args.has("--once");
const intervalMs = Number(process.env.W6_RELAYER_INTERVAL_MS ?? 10_000);

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => controller.abort());
}

runRelayerProcess({ logPath, outboxPath, once, intervalMs, signal: controller.signal }).catch((error) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), component: "w6-settlement-relayer", status: "failed", error: error.message }));
  process.exitCode = 1;
});
