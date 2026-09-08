// Owned loopback service rehearsal only. No live deployment or model execution.
import { createRequire } from "node:module";
import { join } from "node:path";
import { localChain } from "../packages/discovery/test/local-chain.mjs";
import { startLocalGraph } from "../packages/indexing/local/graph.mjs";
import { createEnsV2Resolver } from "../packages/discovery/src/index.mjs";
import {
  createIndexingAdapters,
  createPublicationStore,
} from "../packages/indexing/src/index.mjs";
import { terms } from "./synthetic.mjs";
const { namehash, zeroAddress } = createRequire(
  new URL("../packages/discovery/package.json", import.meta.url),
)("viem");
export const fixtureMethod = "test-only-fixture",
  fixtureVerifier = "test-only-verifier";
export async function startRehearsalInfrastructure() {
  let graph, ens;
  try {
    graph = await startLocalGraph();
    ens = await localChain();
    const registered = new Set(["worker.example.eth"]);
    return {
      graph,
      ens,
      descriptor: {
        mode: "development",
        chainId: 31337,
        rpcUrl: ens.url,
        graphEndpoint: graph.endpoint,
        async create({
          url,
          providerId,
          profileId,
          catalog = [{ providerId }],
          assessor,
        }) {
          const verifier = assessor?.verifierId ?? fixtureVerifier,
            method = assessor?.method ?? fixtureMethod;
          for (const entry of catalog) {
            if (!/^[a-z0-9-]+\.example\.eth$/.test(entry.providerId))
              throw Error("LOCAL_PROVIDER_NAMESPACE_REQUIRED");
            if (!registered.has(entry.providerId)) {
              await ens.write(ens.parent, "RootRegistry", "register", [
                entry.providerId.split(".")[0],
                ens.accounts[0],
                zeroAddress,
                ens.resolver,
                BigInt("0x" + "1".repeat(64)),
                (await ens.client.getBlock()).timestamp + 3600n,
              ]);
              registered.add(entry.providerId);
            }
            const records = {
              "ethonline.endpoint": url,
              "ethonline.profiles": JSON.stringify([profileId]),
              "ethonline.payment.network": terms.network,
              "ethonline.payment.asset": terms.asset,
              "ethonline.payment.receiver": terms.receiver,
              "ethonline.history": graph.endpoint,
            };
            for (const [key, value] of Object.entries(records))
              await ens.write(
                ens.resolver,
                "PermissionedResolverImpl",
                "setText",
                [namehash(entry.providerId), key, value],
              );
          }
          const resolver = createEnsV2Resolver({
            mode: "development",
            rpcUrl: ens.url,
            universal: ens.universal,
            root: ens.root,
            ttlMs: catalog.length > 1 ? 10000 : 1000,
          });
          const adapters = createIndexingAdapters({
            config: {
              deployment: graph.deployment,
              graph: {
                endpoint: graph.endpoint,
                deploymentId: graph.deploymentId,
                maxAgeMs: 10000,
                timeoutMs: 1000,
                trustedVerifiers: [verifier],
              },
              publication: {
                enabled: true,
                maxGasPriceWei: "100000000000",
                timeoutMs: 10000,
              },
            },
            signer: graph.evm.signer,
            store: createPublicationStore({
              directory: join(graph.work, "publication"),
            }),
          });
          return {
            resolver,
            history: adapters.history,
            eventSink: adapters.eventSink,
            async close() {},
            discoveryPolicy: {
              trustedVerifiers: [verifier],
              trustedMethods: [method],
            },
          };
        },
      },
      async close() {
        try {
          await ens.close();
        } finally {
          await graph.close();
        }
      },
    };
  } catch (error) {
    try {
      await ens?.close();
    } finally {
      await graph?.close();
    }
    throw error;
  }
}
