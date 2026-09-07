import { validateHeaderName, validateHeaderValue } from "node:http";

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
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-type",
  "location",
]);
const invalid = () => {
  throw new Error("Invalid payment header policy or fields");
};
export function readHeaderPolicy(policy) {
  if (
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    Object.keys(policy).sort().join(",") !== "request,response"
  )
    invalid();
  const result = {};
  for (const direction of ["request", "response"]) {
    const values = policy[direction];
    if (!Array.isArray(values) || values.length > 32) invalid();
    const names = new Set();
    for (const name of values) {
      if (
        typeof name !== "string" ||
        name.length > 128 ||
        name !== name.toLowerCase() ||
        forbidden.has(name) ||
        names.has(name)
      )
        invalid();
      try {
        validateHeaderName(name);
      } catch {
        invalid();
      }
      names.add(name);
    }
    result[direction] = names;
  }
  return result;
}
function checkedValue(name, value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 16384) invalid();
  try {
    validateHeaderValue(name, value);
  } catch {
    invalid();
  }
  return value;
}
export function requestHeaders(req, policy) {
  const result = {},
    seen = new Set();
  let size = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    if (!policy.request.has(name)) continue;
    if (seen.has(name)) invalid();
    seen.add(name);
    const value = checkedValue(name, req.rawHeaders[i + 1]);
    size += Buffer.byteLength(value);
    if (size > 32768) invalid();
    result[name] = value;
  }
  const hopNames = (req.headers.connection || "")
    .toLowerCase()
    .split(",")
    .map((x) => x.trim());
  if (hopNames.some((x) => policy.request.has(x))) invalid();
  return result;
}
export function responseHeaders(values, policy) {
  if (!values || typeof values !== "object" || Array.isArray(values)) invalid();
  const result = {},
    seen = new Set();
  let size = 0;
  for (const [name, value] of Object.entries(values)) {
    const lower = name.toLowerCase();
    if (!policy.response.has(lower) || seen.has(lower)) invalid();
    seen.add(lower);
    checkedValue(name, value);
    size += Buffer.byteLength(value);
    if (size > 32768) invalid();
    result[name] = value;
  }
  return result;
}
