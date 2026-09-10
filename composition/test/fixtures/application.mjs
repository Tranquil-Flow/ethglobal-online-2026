import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import {
  createSigner,
  developmentProfile,
} from "../../../packages/core/src/index.mjs";
import { digestOf } from "../../../packages/contracts/index.mjs";

export function setup(dataDir) {
  const counts = [0, 0];
  const profiles = [0, 1].map((i) => ({
    ...developmentProfile,
    model: "explicit-synthetic-" + i,
  }));
  const providers = profiles.map((p, i) => ({
    providerId: ["alpha.example.eth", "beta.example.eth"][i],
    profileIds: [digestOf(p)],
    keyId: "receipt-" + i,
    runtimeDigest: digestOf({ fixture: i }),
    limits: {
      maxOutputTokens: 64,
      maxPromptCharacters: 256,
      maxPromptUtf8Bytes: 1024,
    },
    aliases: { ["test-" + i]: digestOf(p) },
  }));
  const bindings = {
    providers: providers.map((p, i) => ({
      providerId: p.providerId,
      receiptSigner: createSigner({
        keyId: p.keyId,
        privateKey: generateKeyPairSync("ed25519").privateKey,
      }),
      runtime: {
        kind: "synthetic",
        mode: "development",
        bindingDigest: p.runtimeDigest,
        profiles: [profiles[i]],
        create({ store }) {
          return {
            executor: {
              mode: "development",
              async *execute({ request, signal }) {
                assert.equal(signal.aborted, false);
                counts[i]++;
                store.set("calls", "count", {
                  n: (store.get("calls", "count")?.n ?? 0) + 1,
                });
                const text = String(i);
                yield { type: "delta", text, tokenIds: [i + 1] };
                yield {
                  type: "completed",
                  profileId: request.profileId,
                  output: { text, tokenIds: [i + 1], finishReason: "stop" },
                };
              },
            },
          };
        },
      },
    })),
  };
  return {
    counts,
    profiles,
    providers,
    bindings,
    config: {
      version: "2",
      mode: "development",
      accessPolicy: "non-economic",
      dataDir,
      port: 0,
      providers,
      core: { maintenanceMs: 20, portTimeoutMs: 1000 },
    },
  };
}
