import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHttpsProxy } from "../operations/src/proxy.mjs";
import { readPrivateFile } from "../operations/src/private-files.mjs";

/** Explicit loopback TLS ingress; external exposure remains a deployment gate. */
export async function startApplicationHttps({ configFile }) {
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
  if (
    !config ||
    Object.keys(config).sort().join(",") !==
      ["upstream", "publicOrigin", "certFile", "keyFile", "port"]
        .sort()
        .join(",")
  )
    throw Error("INVALID_TLS_CONFIG");
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
  const key = readPrivateFile(config.keyFile, {
    maxBytes: 16384,
    code: "PRIVATE_KEY_REQUIRED",
  }).data;
  let proxy;
  try {
    proxy = createHttpsProxy({
      upstream: config.upstream,
      cert,
      key,
      allowedHosts: [origin.hostname],
      allowedOrigins: [config.publicOrigin],
      allowedPaths: ["/"],
      upstreamTimeoutMs: 30000,
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
