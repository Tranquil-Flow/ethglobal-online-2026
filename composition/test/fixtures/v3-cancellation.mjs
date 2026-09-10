import { setTimeout as delay } from "node:timers/promises";

export async function observe(fixture, label, select, accepts) {
  let last;
  for (let i = 0; i < 100; i++) {
    last = select(await fixture.command("stats"));
    if (accepts(last)) return last;
    await delay(50);
  }
  throw Error(`CONFORMANCE_CONDITION_TIMEOUT:${label}:${JSON.stringify(last)}`);
}

export async function finishHeldCancellation(fixture, requestId) {
  // The core ACK only aborts the local consumer. Keep the native worker held
  // until the owner-scoped upstream stop latch is installed after backend cancel.
  const select = (s) =>
    s.peers[0].sessions.find((x) => x.requestId === requestId);
  await observe(
    fixture,
    "upstream-stop-before-release",
    select,
    (s) => s?.stopRequested === true && s.terminal === null,
  );
  await fixture.command("release");
  return observe(
    fixture,
    "upstream-cancelled-terminal",
    (s) => s.peers[0].sessions.find((x) => x.requestId === requestId),
    (s) => s?.terminal === "cancelled" && s.cleanup === "confirmed",
  );
}
