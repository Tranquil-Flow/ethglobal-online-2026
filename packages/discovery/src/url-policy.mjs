import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { fail, bounded } from "./errors.mjs";
export const safeGet = (url, options = {}) =>
  safeRequest(url, { ...options, body: undefined });
export async function safeRpc(url, { method, params }, options = {}) {
  if (
    ![
      "eth_chainId",
      "eth_blockNumber",
      "eth_getBlockByNumber",
      "eth_getBlockByHash",
      "eth_call",
      "eth_getStorageAt",
      "eth_getCode",
      "eth_getTransactionReceipt",
    ].includes(method)
  )
    fail("RPC_METHOD_FORBIDDEN");
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  if (body.length > 65536) fail("LIMIT");
  const raw = await safeRequest(url, { ...options, maxBytes: 262144, body });
  let result;
  try {
    result = JSON.parse(raw.toString());
  } catch {
    fail("INVALID_RPC");
  }
  if (result.jsonrpc !== "2.0" || result.id !== 1) fail("INVALID_RPC");
  if (result.error) {
    const e = new Error("RPC read rejected");
    e.code = Number.isInteger(result.error.code) ? result.error.code : -32000;
    throw e;
  }
  if (!Object.hasOwn(result, "result")) fail("INVALID_RPC");
  return result.result;
}

export function publicAddress(address) {
  try {
    const ip = ipaddr.process(address);
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}
function loopback(address) {
  try {
    return ipaddr.process(address).range() === "loopback";
  } catch {
    return false;
  }
}
export function safeUrl(value, { mode, allowLoopback = false } = {}) {
  if (typeof value !== "string" || value.length > 2048) fail("UNSAFE_URL");
  let u;
  try {
    u = new URL(value);
  } catch {
    fail("UNSAFE_URL");
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (
    u.username ||
    u.password ||
    u.hash ||
    u.search ||
    !["https:", "http:"].includes(u.protocol)
  )
    fail("UNSAFE_URL");
  const local = loopback(host);
  if (mode === "development" && allowLoopback && local) return u;
  if (
    u.protocol !== "https:" ||
    local ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    !host.includes(".") ||
    (ipaddr.isValid(host) && !publicAddress(host))
  )
    fail("UNSAFE_URL");
  return u;
}
// Only bounded, credential-free GETs. No redirect following, proxy env, cookies or user headers.
// DNS result is validated AND pinned into the socket lookup; TLS still checks the original host.
async function safeRequest(
  url,
  {
    mode,
    allowLoopback = false,
    signal,
    timeoutMs = 5000,
    maxBytes = 65536,
    lookup = dnsLookup,
    body,
  } = {},
) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 262144
  )
    fail("INVALID_CONFIG");
  const u = safeUrl(url, { mode, allowLoopback });
  return bounded(
    async (inner) => {
      const host = u.hostname.replace(/^\[|\]$/g, "");
      const addresses = ipaddr.isValid(host)
        ? [
            {
              address: host,
              family: ipaddr.parse(host).kind() === "ipv6" ? 6 : 4,
            },
          ]
        : await lookup(host, { all: true });
      if (
        !addresses.length ||
        addresses.some(
          (a) =>
            !publicAddress(a.address) &&
            !(
              mode === "development" &&
              allowLoopback &&
              loopback(host) &&
              loopback(a.address)
            ),
        )
      )
        fail("UNSAFE_ADDRESS");
      const pinned = addresses[0];
      return new Promise((resolve, reject) => {
        const req = (u.protocol === "https:" ? https : http).request(
          u,
          {
            method: body ? "POST" : "GET",
            agent: false,
            signal: inner,
            lookup: (_host, opts, cb) =>
              cb(null, opts.all ? [pinned] : pinned.address, pinned.family),
            headers: body
              ? {
                  accept: "application/json",
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(body),
                }
              : { accept: "application/json" },
          },
          (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              res.destroy();
              reject(
                Object.assign(new Error("HTTP_REJECTED"), {
                  code: "HTTP_REJECTED",
                }),
              );
              return;
            }
            let bytes = 0;
            const chunks = [];
            res.on("data", (chunk) => {
              bytes += chunk.length;
              if (bytes > maxBytes) {
                res.destroy();
                reject(Object.assign(new Error("LIMIT"), { code: "LIMIT" }));
              } else chunks.push(chunk);
            });
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", () =>
              reject(
                Object.assign(new Error("UNAVAILABLE"), {
                  code: "UNAVAILABLE",
                }),
              ),
            );
          },
        );
        req.on("error", () =>
          reject(
            Object.assign(new Error("UNAVAILABLE"), { code: "UNAVAILABLE" }),
          ),
        );
        req.end(body);
      });
    },
    signal,
    timeoutMs,
  );
}
