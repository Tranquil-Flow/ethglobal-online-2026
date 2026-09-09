import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevelopment } from "../index.mjs";
import { createMyceliumRuntimeBinding } from "../mycelium-binding.mjs";
import { startGatewayFixture } from "./fixtures/v3-gateway.mjs";
import { conformanceOptions } from "./fixtures/v3-bindings.mjs";
import {
  createClient,
  createRequest,
} from "../../packages/access/src/index.mjs";

test(
  "v3 assessor loads signature-bound private evidence from actual host SQLite, never caller exports",
  { timeout: 30000 },
  async () => {
    const f = await startGatewayFixture(),
      dir = await mkdtemp(join(tmpdir(), "v3-store-"));
    let app, store, ports;
    try {
      const binding = await createMyceliumRuntimeBinding(
        conformanceOptions(f.descriptor),
      );
      const create = binding.create;
      binding.create = (ctx) => {
        store = ctx.store;
        ports = create(ctx);
        return ports;
      };
      app = await startDevelopment({
        development: true,
        dataDir: dir,
        port: 0,
        runtimeDefinition: binding,
        providerCatalog: [
          { providerId: "alpha.example.eth", amountBaseUnits: "2" },
        ],
      });
      const c = createClient({
        baseUrl: app.url,
        pins: app.pins,
        paymentAuthorizer: app.authorizeDevelopment,
      });
      await c.connect();
      const request = await createRequest({
        providerId: "alpha.example.eth",
        profileId: app.profileId,
        prompt: "private synthetic native store check",
        maxOutputTokens: 3,
        seed: 0,
        publishConsent: false,
      });
      const quote = await c.createQuote(request),
        paid = await c.submitJob({
          request,
          quoteId: quote.quoteId,
          idempotencyKey: "store-job",
          authorization: {
            maxAmountBaseUnits: "2",
            network: quote.network,
            asset: quote.asset,
          },
        });
      for await (const e of c.streamJob(paid.job.jobId)) {
      }
      const receipt = await c.getReceipt(paid.job.jobId),
        id = paid.job.jobId,
        ref = "core-local:" + id;
      const assess = (evidenceRef = ref) =>
        ports.assessor.assess({
          receipt,
          profile: binding.profile,
          evidenceRef,
          method: "native-replay-v1",
        });
      assert.equal((await assess()).outcome, "passed");
      const before = (await f.command("stats")).peers.map((p) => p.submissions);
      for (const reference of [
        "https://untrusted.invalid/export",
        "core-local:00000000-0000-0000-0000-000000000000",
        undefined,
      ])
        assert.equal((await assess(reference ?? "")).outcome, "unavailable");
      const cases = [
        [
          "jobs",
          (x) => {
            x.evidenceExpiresAt = 0;
          },
        ],
        [
          "private",
          (x) => {
            x.request.prompt = "substituted";
          },
        ],
        [
          "private",
          (x) => {
            x.output.tokenIds = [103, 102, 101];
          },
        ],
        [
          "private",
          (x) => {
            x.output.text = "substituted";
          },
        ],
        [
          "receipts",
          (x) => {
            x.receipt.signature = "AAAA";
          },
        ],
        [
          "private",
          (x) => {
            x.profile.model = "substituted";
          },
        ],
      ];
      for (const [ns, mutate] of cases) {
        const original = store.get(ns, id),
          copy = structuredClone(original);
        mutate(copy);
        store.set(ns, id, copy);
        try {
          assert.equal((await assess()).outcome, "unavailable", ns);
        } finally {
          store.set(ns, id, original);
        }
      }
      assert.deepEqual(
        (await f.command("stats")).peers.map((p) => p.submissions),
        before,
      );
      await c.deleteEvidence(id);
      assert.equal((await assess()).outcome, "unavailable");
      assert.deepEqual(
        (await f.command("stats")).peers.map((p) => p.submissions),
        before,
      );
    } finally {
      await app?.close();
      await f.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "v3 constructor trust is explicit; mode, metadata, mapping and replay guards precede submissions",
  { timeout: 30000 },
  async () => {
    const f = await startGatewayFixture();
    try {
      const options = () => conformanceOptions(f.descriptor);
      await assert.rejects(
        createMyceliumRuntimeBinding({ ...options(), mode: "live" }),
        /RUNTIME_MODE_MISMATCH/,
      );
      await assert.rejects(
        createMyceliumRuntimeBinding({ ...options(), protocol: undefined }),
        /AMBIGUOUS_RUNTIME_PROTOCOL/,
      );
      await assert.rejects(
        createMyceliumRuntimeBinding({
          ...options(),
          replayGateway: f.descriptor.primary,
        }),
        /SEPARATE_REPLAY_GATEWAY_REQUIRED/,
      );
      const wrong = options();
      wrong.profilePolicy.profile.tokenizerDigest = "sha256:" + "0".repeat(64);
      await assert.rejects(
        createMyceliumRuntimeBinding(wrong),
        /RUNTIME_PROFILE_MAPPING_MISMATCH/,
      );
      const remote = options();
      remote.providers[0].baseUrl = "https://untrusted.invalid";
      await assert.rejects(
        createMyceliumRuntimeBinding(remote),
        /LOCAL_CONFORMANCE_ONLY/,
      );
      const drift = options();
      drift.providers[0].qualification = {
        ...drift.providers[0].qualification,
        qualification_digest: "sha256:" + "0".repeat(64),
      };
      await assert.rejects(
        createMyceliumRuntimeBinding(drift),
        /QUALIFICATION_MISMATCH/,
      );
      const stale = options();
      delete stale.localConformanceNowMs;
      await assert.rejects(
        createMyceliumRuntimeBinding(stale),
        /STALE_QUALIFICATION/,
      );
      assert.deepEqual(
        (await f.command("stats")).peers.map((p) => p.submissions),
        [0, 0],
      );
    } finally {
      await f.close();
    }
  },
);
