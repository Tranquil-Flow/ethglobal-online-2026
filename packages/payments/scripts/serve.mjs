import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { createPayments } from "../src/index.mjs";
import { createSyntheticService } from "../src/service.mjs";
let server, payments;
async function start({
  config,
  authenticate,
  failOperation = false,
  port = 0,
}) {
  payments = createPayments({ config });
  server = createSyntheticService({
    payments,
    authenticate,
    failOperation,
    mode: config.mode,
  });
  return server.listen({ host: "127.0.0.1", port });
}
async function close() {
  await server?.close();
  payments?.close();
}
process.once("SIGTERM", async () => {
  await close();
  process.exit(0);
});
process.once("SIGINT", async () => {
  await close();
  process.exit(0);
});
if (process.send) {
  // Explicit development-only IPC harness, not a public wallet endpoint.
  process.once("message", async (message) => {
    try {
      if (message.config?.mode !== "development")
        throw new Error("DEVELOPMENT_ONLY");
      const expected = Buffer.from("Bearer " + message.capability);
      const address = await start({
        ...message,
        authenticate: (headers) => {
          const actual = Buffer.from(headers.authorization ?? "");
          return actual.length === expected.length &&
            timingSafeEqual(actual, expected)
            ? "smoke-principal"
            : null;
        },
      });
      process.send({ ready: true, ...address });
    } catch {
      process.send({ error: "START_FAILED" });
      await close();
      process.exit(1);
    }
  });
  process.once("disconnect", async () => {
    await close();
    process.exit(0);
  });
} else {
  try {
    const { values: v } = parseArgs({
      options: {
        config: { type: "string" },
        "auth-module": { type: "string" },
        port: { type: "string", default: "4320" },
      },
    });
    if (!v.config || !v["auth-module"])
      throw new Error("EXPLICIT_CONFIG_AND_AUTH_MODULE_REQUIRED");
    const config = JSON.parse(await readFile(v.config, "utf8"));
    const { authenticate } = await import(pathToFileURL(v["auth-module"]));
    const { url } = await start({ config, authenticate, port: Number(v.port) });
    console.log(JSON.stringify({ url, mode: config.mode, inference: false }));
  } catch {
    console.error("Explicit config and auth module required; see README.");
    await close();
    process.exitCode = 1;
  }
}
