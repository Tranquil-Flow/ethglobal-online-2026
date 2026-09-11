import { isIP } from "node:net";
import { request } from "node:https";
import { connect } from "node:tls";
import { Readable } from "node:stream";
export const WAVE5_ORIGIN = "https://m4pro.tail53d0d3.ts.net";
function publicIP(ip) {
  if (isIP(ip) === 6) return /^[23]/i.test(ip);
  if (isIP(ip) !== 4) return false;
  const n = ip.split(".").map(Number);
  return (
    n[0] > 0 &&
    n[0] < 224 &&
    ![10, 127].includes(n[0]) &&
    !(n[0] === 100 && n[1] >= 64 && n[1] <= 127) &&
    !(n[0] === 169 && n[1] === 254) &&
    !(n[0] === 172 && n[1] >= 16 && n[1] <= 31) &&
    !(n[0] === 192 && [0, 168].includes(n[1])) &&
    !(n[0] === 198 && [18, 19].includes(n[1]))
  );
}
export async function resolveFunnelAddress(signal) {
  for (const type of ["A", "AAAA"]) {
    const r = await fetch(
      "https://dns.google/resolve?name=m4pro.tail53d0d3.ts.net&type=" + type,
      {
        signal: AbortSignal.any([
          signal ?? new AbortController().signal,
          AbortSignal.timeout(10000),
        ]),
      },
    );
    if (!r.ok) throw Error("PUBLIC_DNS_UNAVAILABLE");
    const d = await r.json();
    const value = d.Answer?.find(
      (x) => (x.type === 1 || x.type === 28) && publicIP(x.data),
    );
    if (value) return { address: value.data, family: isIP(value.data), dns: d };
  }
  throw Error("PUBLIC_FUNNEL_ADDRESS_UNAVAILABLE");
}
function lookup(address) {
  if (!publicIP(address)) throw Error("PUBLIC_ADDRESS_REQUIRED");
  return (_host, options, callback) => {
    const value = { address, family: isIP(address) };
    options?.all
      ? callback(null, [value])
      : callback(null, address, value.family);
  };
}
export function publicFetch(address, origin = WAVE5_ORIGIN) {
  const expected = new URL(origin);
  if (
    expected.hostname !== "m4pro.tail53d0d3.ts.net" ||
    expected.protocol !== "https:" ||
    !["", "8443"].includes(expected.port)
  )
    throw Error("PUBLIC_ORIGIN_REQUIRED");
  const resolve = lookup(address);
  return (target, init = {}) =>
    new Promise((accept, reject) => {
      const url = new URL(target);
      if (url.origin !== expected.origin || url.username || url.password)
        return reject(Error("PUBLIC_ORIGIN_MISMATCH"));
      const req = request(
        url,
        {
          method: init.method ?? "GET",
          headers: Object.fromEntries(new Headers(init.headers)),
          signal: init.signal,
          lookup: resolve,
          servername: url.hostname,
          rejectUnauthorized: true,
        },
        (res) => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers))
            if (v !== undefined)
              headers.set(k, Array.isArray(v) ? v.join(", ") : v);
          accept(
            new Response(
              [204, 304].includes(res.statusCode) ? null : Readable.toWeb(res),
              { status: res.statusCode, headers },
            ),
          );
        },
      );
      req.on("error", reject);
      req.end(init.body);
    });
}
export function publicTlsObservation(address, origin = WAVE5_ORIGIN) {
  return new Promise((accept, reject) => {
    const u = new URL(origin);
    const socket = connect({
      host: u.hostname,
      port: Number(u.port || 443),
      servername: u.hostname,
      lookup: lookup(address),
      rejectUnauthorized: true,
    });
    const timer = setTimeout(
      () => socket.destroy(Error("PUBLIC_TLS_TIMEOUT")),
      10000,
    );
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const cert = socket.getPeerCertificate();
      const observation = {
        authorized: socket.authorized,
        publicAddress: address,
        hostname: u.hostname,
        fingerprint256: cert.fingerprint256,
        issuer: cert.issuer,
        protocol: socket.getProtocol(),
      };
      socket.end();
      accept(observation);
    });
    socket.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
