export class DiscoveryError extends Error {
  constructor(code) {
    super(`Discovery: ${code}`);
    this.code = code;
    this.retryable = ["TIMEOUT", "UNAVAILABLE", "REORG"].includes(code);
  }
}
export const fail = (code) => {
  throw new DiscoveryError(code);
};
export function aborted(signal) {
  if (signal?.aborted) fail("ABORTED");
}
export async function bounded(fn, signal, timeoutMs = 5000) {
  aborted(signal);
  const ac = new AbortController();
  let timer, listener;
  const stop = new Promise((_, reject) => {
    listener = () => {
      ac.abort();
      reject(new DiscoveryError("ABORTED"));
    };
    signal?.addEventListener("abort", listener, { once: true });
    timer = setTimeout(() => {
      ac.abort();
      reject(new DiscoveryError("TIMEOUT"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => fn(ac.signal)),
      stop,
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", listener);
    ac.abort();
  }
}
