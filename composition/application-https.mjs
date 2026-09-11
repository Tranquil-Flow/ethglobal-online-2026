import { resolve } from "node:path";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { isIP } from "node:net";
import { createSecureContext } from "node:tls";
import { fileURLToPath } from "node:url";
import { createHttpsProxy } from "../operations/src/proxy.mjs";
import { readPrivateFile } from "../operations/src/private-files.mjs";

/** Explicit loopback TLS ingress; external exposure remains a deployment gate. */
function loadTlsMaterial({ configFile, now = Date.now() }) {
  const bytes = readPrivateFile(configFile, {
    maxBytes: 16384,
    code: "PRIVATE_CONFIG_REQUIRED",
  }).data;
  let config;
  try {
    config = JSON.parse(bytes.toString("utf8"));
  } finally {
    bytes.fill(0);
  }
  const required = ["upstream", "publicOrigin", "certFile", "keyFile", "port"];
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    required.some((key) => !Object.hasOwn(config, key)) ||
    Object.keys(config).some(
      (key) => ![...required, "upstreamTimeoutMs"].includes(key),
    )
  )
    throw Error("INVALID_TLS_CONFIG");
  if (!Object.hasOwn(config, "upstreamTimeoutMs"))
    config.upstreamTimeoutMs = 30000;
  if (
    !Number.isSafeInteger(config.upstreamTimeoutMs) ||
    config.upstreamTimeoutMs < 1 ||
    config.upstreamTimeoutMs > 300000
  )
    throw Error("INVALID_TLS_TIMEOUT");
  let origin;
  try {
    origin = new URL(config.publicOrigin);
  } catch {
    throw Error("INVALID_PUBLIC_ORIGIN");
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== config.publicOrigin ||
    origin.username ||
    origin.password
  )
    throw Error("INVALID_PUBLIC_ORIGIN");
  const cert = readPrivateFile(config.certFile, {
    maxBytes: 1048576,
    code: "PRIVATE_CERT_REQUIRED",
  }).data;
  let key;
  try {
    key = readPrivateFile(config.keyFile, {
      maxBytes: 16384,
      code: "PRIVATE_KEY_REQUIRED",
    }).data;
    let certificate, privateKey;
    try {
      certificate = new X509Certificate(cert);
      privateKey = createPrivateKey(key);
    } catch {
      throw Error("INVALID_TLS_MATERIAL");
    }
    const host = origin.hostname.replace(/^\[|\]$/g, "");
    if (!(isIP(host) ? certificate.checkIP(host) : certificate.checkHost(host)))
      throw Error("TLS_CERTIFICATE_HOST_MISMATCH");
    if (
      !Number.isSafeInteger(now) ||
      now < Date.parse(certificate.validFrom) ||
      now >= Date.parse(certificate.validTo)
    )
      throw Error("TLS_CERTIFICATE_TIME_INVALID");
    if (!certificate.checkPrivateKey(privateKey))
      throw Error("TLS_CERTIFICATE_KEY_MISMATCH");
    createSecureContext({ cert, key });
    let upstream;
    try {
      upstream = new URL(config.upstream);
    } catch {
      throw Error("INVALID_TLS_UPSTREAM");
    }
    if (
      !["http:", "https:"].includes(upstream.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(upstream.hostname) ||
      upstream.username ||
      upstream.password ||
      upstream.pathname !== "/" ||
      upstream.search ||
      upstream.hash
    )
      throw Error("INVALID_TLS_UPSTREAM");
    if (
      !Number.isInteger(config.port) ||
      config.port < 0 ||
      config.port > 65535
    )
      throw Error("INVALID_TLS_PORT");
    return { config, origin, cert, key, certificate };
  } catch (e) {
    cert.fill(0);
    key?.fill(0);
    throw e;
  }
}
export function inspectApplicationHttps(options) {
  const { config, cert, key, certificate } = loadTlsMaterial(options);
  try {
    return {
      status: "tls-material-checked-offline",
      upstream: config.upstream,
      publicOrigin: config.publicOrigin,
      port: config.port,
      upstreamTimeoutMs: config.upstreamTimeoutMs,
      certificateFingerprint: certificate.fingerprint256,
      validFrom: certificate.validFrom,
      validTo: certificate.validTo,
      networkContacted: false,
      chainTrustVerified: false,
    };
  } finally {
    cert.fill(0);
    key.fill(0);
  }
}
export async function startApplicationHttps({ configFile }) {
  const { config, origin, cert, key } = loadTlsMaterial({ configFile });
  let proxy;
  try {
    proxy = createHttpsProxy({
      upstream: config.upstream,
      cert,
      key,
      allowedHosts: [origin.hostname],
      allowedOrigins: [config.publicOrigin],
      allowedPaths: ["/"],
      upstreamTimeoutMs: config.upstreamTimeoutMs,
    });
    await proxy.listen({ host: "127.0.0.1", port: config.port });
    return { publicOrigin: config.publicOrigin, close: () => proxy.close() };
  } catch (error) {
    await proxy?.close();
    throw error;
  } finally {
    cert.fill(0);
    key.fill(0);
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  let server;
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--config")
      throw Error("USAGE_CONFIG_REQUIRED");
    server = await startApplicationHttps({ configFile: args[1] });
    console.log(
      JSON.stringify({
        status: "listening-loopback-tls",
        publicOrigin: server.publicOrigin,
        externalExposureQualified: false,
      }),
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () =>
        server.close().then(
          () => process.exit(0),
          () => process.exit(1),
        ),
      );
  } catch (error) {
    await server?.close();
    console.error(
      JSON.stringify({
        status: "error",
        reason: /^[A-Z][A-Z0-9_]{0,100}$/.test(error.message)
          ? error.message
          : "TLS_START_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}
