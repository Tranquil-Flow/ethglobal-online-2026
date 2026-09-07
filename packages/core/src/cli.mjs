import { mkdirSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import {
  createApp,
  createStore,
  createSigner,
  createDevelopmentExecutor,
  createDevelopmentPayments,
  developmentProfile,
} from "./index.mjs";
import { digestOf } from "../../contracts/index.mjs";

// This entrypoint is deliberately development-only; production composition injects its ports.
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--development") options.development = true;
  else if (["--data-dir", "--port", "--delay-ms"].includes(args[i]))
    options[args[i].slice(2)] = args[++i];
  else throw Error("Unknown option");
}
if (!options.development || !options["data-dir"])
  throw Error("Use --development --data-dir <private-directory> [--port 4310]");
process.umask(0o077);
const dir = resolve(options["data-dir"]);
mkdirSync(dir, { recursive: true, mode: 0o700 });
if (
  !lstatSync(dir).isDirectory() ||
  lstatSync(dir).isSymbolicLink() ||
  lstatSync(dir).mode & 0o077
)
  throw Error("Data directory must be a private regular directory (0700)");
const keyPath = join(dir, "development-ed25519.pem");
let privateKey;
try {
  const s = lstatSync(keyPath);
  if (!s.isFile() || s.isSymbolicLink() || s.mode & 0o077)
    throw Error("Signing file must be private and regular");
  privateKey = createPrivateKey(readFileSync(keyPath));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  privateKey = generateKeyPairSync("ed25519").privateKey;
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), {
    flag: "wx",
    mode: 0o600,
  });
}
const keyId = digestOf(createPublicKey(privateKey).export({ format: "jwk" }));
const store = createStore({ path: join(dir, "core.sqlite") });
const delayMs = Number(options["delay-ms"] ?? 5),
  port = Number(options.port ?? 4310);
if (
  !Number.isSafeInteger(delayMs) ||
  delayMs < 0 ||
  delayMs > 1000 ||
  !Number.isSafeInteger(port) ||
  port < 0 ||
  port > 65535
)
  throw Error("Invalid local process bounds");
const app = createApp({
  config: {
    mode: "development",
    profiles: [developmentProfile],
    providerIds: ["development.invalid"],
    maintenanceMs: 50,
  },
  store,
  signer: createSigner({ privateKey, keyId }),
  executor: createDevelopmentExecutor({ delayMs }),
  payments: createDevelopmentPayments({ store }),
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  store.close();
}
process.once("SIGTERM", () => {
  stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
process.once("SIGINT", () => {
  stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
try {
  const { url } = await app.listen({ port });
  console.log(
    JSON.stringify({
      url,
      mode: "development",
      profileId: digestOf(developmentProfile),
      keyId,
      execution: "synthetic-not-inference",
      payment: "free-development-not-x402",
    }),
  );
} catch {
  await stop();
  console.error("Local development service unavailable");
  process.exitCode = 1;
}
