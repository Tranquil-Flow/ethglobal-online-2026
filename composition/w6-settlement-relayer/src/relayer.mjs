import { setTimeout as delay } from "node:timers/promises";
import { SettlementOutbox, DEFAULT_OUTBOX_PATH } from "./outbox.mjs";
import { consumeVerdictJsonl } from "./verdict-consumer.mjs";

export const DEFAULT_VERDICT_LOG_DIR =
  "/Users/evinova-self/Documents/playground/mycelium-verification-system-20260912/additive/ensemble-audit-v2/research";

export function logJson(event) {
  // Workbench scripts log compact JSON objects; never include key material in these fields.
  console.log(JSON.stringify({ ts: new Date().toISOString(), component: "w6-settlement-relayer", ...event }));
}

export async function pollVerdictsOnce({ logPath, outboxPath = DEFAULT_OUTBOX_PATH, outbox } = {}) {
  if (!logPath) throw new Error("MISSING_VERDICT_LOG_PATH");
  const ownedOutbox = outbox ?? new SettlementOutbox({ dbPath: outboxPath });
  try {
    const result = await consumeVerdictJsonl({ logPath, outbox: ownedOutbox });
    logJson({ status: "poll-complete", parsed: result.parsed, enqueued: result.enqueued, outboxPath });
    return result;
  } finally {
    if (!outbox) ownedOutbox.close();
  }
}

export async function runRelayerProcess({
  logPath,
  outboxPath = DEFAULT_OUTBOX_PATH,
  intervalMs = 10_000,
  once = false,
  signal,
} = {}) {
  if (!logPath) throw new Error("MISSING_VERDICT_LOG_PATH");
  const outbox = new SettlementOutbox({ dbPath: outboxPath });
  try {
    do {
      const result = await consumeVerdictJsonl({ logPath, outbox });
      logJson({ status: "poll-complete", parsed: result.parsed, enqueued: result.enqueued, pending: outbox.countRows({ status: "pending" }) });
      if (once) break;
      await delay(intervalMs, undefined, { signal });
    } while (!signal?.aborted);
  } finally {
    outbox.close();
  }
}
