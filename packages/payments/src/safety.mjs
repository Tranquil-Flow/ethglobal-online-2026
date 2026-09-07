import { parse, parseNumberAndBigInt } from "lossless-json";
export class PaymentError extends Error {
  constructor(code, retryable = false) {
    super(code);
    this.name = "PaymentError";
    this.code = code;
    this.retryable = retryable;
  }
}
export function fail(code, retryable = false) {
  throw new PaymentError(code, retryable);
}
export function checkAbort(signal) {
  if (signal?.aborted) fail("ABORTED");
}
export function textId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9:._@-]{1,256}$/.test(value))
    fail("INVALID_INPUT");
  return value;
}
export function amount(value) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,18})$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    fail("INVALID_AMOUNT");
  return BigInt(value);
}
export function account(value) {
  if (typeof value !== "string" || !/^0\.0\.(0|[1-9][0-9]{0,18})$/.test(value))
    fail("INVALID_ACCOUNT");
  return value;
}
export function loopback(value) {
  const u = new URL(value);
  return (
    u.protocol === "http:" &&
    u.hostname === "127.0.0.1" &&
    !u.username &&
    !u.password &&
    !u.search &&
    !u.hash
  );
}
export function endpoint(value, mode, live) {
  let u;
  try {
    u = new URL(value);
  } catch {
    fail("INVALID_CONFIG");
  }
  if (mode === "development" ? !loopback(value) : u.href !== live)
    fail("INVALID_CONFIG");
  return u.href.replace(/\/$/, "");
}
export async function readJson(
  response,
  limit = 65536,
  preserveIntegers = false,
) {
  const reader = response.body?.getReader();
  if (!reader) fail("INVALID_RESPONSE");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) fail("RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return preserveIntegers
      ? parse(text, undefined, { parseNumber: parseNumberAndBigInt })
      : JSON.parse(text);
  } catch (e) {
    await reader.cancel().catch(() => {});
    if (e instanceof PaymentError) throw e;
    fail("INVALID_RESPONSE");
  } finally {
    reader.releaseLock();
  }
}
export async function jsonFetch(
  url,
  {
    signal,
    timeoutMs = 5000,
    body,
    limit = 65536,
    fetchImpl = fetch,
    preserveIntegers = false,
  } = {},
) {
  checkAbort(signal);
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([deadline, signal]) : deadline;
  try {
    const response = await fetchImpl(url, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: combined,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      fail("REMOTE_UNAVAILABLE", true);
    }
    return await readJson(response, limit, preserveIntegers);
  } catch (e) {
    if (signal?.aborted) fail("ABORTED");
    if (e instanceof PaymentError) throw e;
    fail("REMOTE_UNAVAILABLE", true);
  }
}
