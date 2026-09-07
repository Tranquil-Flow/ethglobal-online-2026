import { fail } from "./safety.mjs";
const forbidden = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "host",
  "proxy-authorization",
  "proxy-authenticate",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "content-length",
]);
/** Snapshot the injected policy; never inherit subsequent caller mutations. */
export function validateHeaderPolicy(policy) {
  if (
    !policy ||
    typeof policy !== "object" ||
    Object.keys(policy).sort().join(",") !== "request,response"
  )
    fail("INVALID_HEADER_POLICY");
  const result = {};
  for (const side of ["request", "response"]) {
    const names = policy[side];
    if (
      !Array.isArray(names) ||
      !names.length ||
      names.length > 16 ||
      new Set(names).size !== names.length ||
      names.some(
        (name) =>
          typeof name !== "string" ||
          name.length > 128 ||
          !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
          forbidden.has(name),
      )
    )
      fail("INVALID_HEADER_POLICY");
    result[side] = Object.freeze([...names]);
  }
  return Object.freeze(result);
}
export function validateResponseHeaders(headers, policy) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers))
    fail("INVALID_PAYMENT_HEADERS");
  const entries = Object.entries(headers);
  if (entries.length > policy.response.length) fail("INVALID_PAYMENT_HEADERS");
  for (const [name, value] of entries) {
    if (
      !policy.response.includes(name) ||
      typeof value !== "string" ||
      value.length > 16384 ||
      /[^\x20-\x7e]/.test(value)
    )
      fail("INVALID_PAYMENT_HEADERS");
  }
  return entries;
}
