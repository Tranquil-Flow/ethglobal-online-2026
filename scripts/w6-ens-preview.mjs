// Read-only: no execute flag, wallet input or broadcast branch.
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Resolver } from "node:dns/promises";
import {
  repointWave6Ens,
  WAVE6_ENS_NAMES,
} from "../composition/ens-wave6-repoint.mjs";
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "public-dns": { type: "boolean", default: false },
    origin: { type: "string", default: "https://m4pro.tail53d0d3.ts.net" },
  },
});
if (!values.output) throw Error("OUTPUT_REQUIRED");
const config = await fetch(values.origin + "/config.json", {
  signal: AbortSignal.timeout(15000),
}).then((r) => {
  if (!r.ok) throw Error("CONFIG_UNAVAILABLE");
  return r.json();
});
if (
  config.apiUrl !== values.origin ||
  config.accessPolicy !== "ordinary-paid-x402"
)
  throw Error("PAID_ORIGIN_MISMATCH");
const targetRecords = Object.fromEntries(
  WAVE6_ENS_NAMES.map((name) => {
    const p = config.providers.find((p) => p.providerId === name);
    if (!p) throw Error("PROVIDER_MISSING");
    return [
      name,
      {
        "ethonline.endpoint": values.origin,
        "ethonline.profiles": JSON.stringify(p.profileIds),
        "ethonline.payment.network": "hedera:testnet",
        "ethonline.payment.asset": "0.0.0",
        "ethonline.payment.receiver": "0.0.10419316",
        "ethonline.history":
          "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.2.0-unchecked-20260911",
      },
    ];
  }),
);
try {
  const resolver = new Resolver({ timeout: 5000, tries: 2 });
  resolver.setServers(["1.1.1.1"]);
  const originLookup = values["public-dns"]
    ? async (host) =>
        (await resolver.resolve4(host)).map((address) => ({
          address,
          family: 4,
        }))
    : undefined;
  const result = await repointWave6Ens({
    targetRecords,
    execute: false,
    approved: false,
    originLookup,
  });
  result.reachability.dnsSource = values["public-dns"]
    ? "explicit-public-resolver-1.1.1.1"
    : "system";
  result.reachability.externalNetworkVerified = false;
  await writeFile(
    values.output,
    JSON.stringify({ targetRecords, ...result }, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    JSON.stringify({
      status: result.status,
      broadcast: result.broadcast,
      walletLoaded: result.walletLoaded,
      targetDigest: result.targetDigest,
      changes: result.previews.map((p) => ({
        name: p.name,
        resolver: p.resolver,
        changes: p.changes,
        estimatedGas: p.transactions.map((t) => t.estimatedGas),
      })),
    }),
  );
} catch (error) {
  console.error(
    /^[A-Z][A-Z0-9_]+$/.test(error.code ?? "")
      ? error.code
      : "ENS_PREVIEW_FAILED",
  );
  process.exitCode = 1;
}
