export function runJanitor({ outbox, now = () => Date.now(), confirmedTtlMs = 3_600_000 } = {}) {
  if (!outbox) throw new Error("MISSING_OUTBOX");
  const cutoff = now() - confirmedTtlMs;
  const deletedConfirmed = outbox.deleteConfirmedBefore(cutoff);
  // In-flight rows are intentionally not deleted; stale in-flight recovery belongs to findPending().
  return { deletedConfirmed, skippedInFlight: true, cutoff };
}
