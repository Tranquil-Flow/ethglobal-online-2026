import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { digestOf } from "../../packages/contracts/index.mjs";
import {
  createClient,
  createRequest,
  checkBuyerEvidenceJson,
} from "../../packages/access/src/index.mjs";
import { createManagedHistory } from "../application-history.mjs";
import { mirrorTransactionId } from "../../packages/payments/src/protocol.mjs";
import {
  resolveFunnelAddress,
  publicFetch,
  publicTlsObservation,
  WAVE5_ORIGIN,
} from "../wave5-https-client.mjs";
const require = createRequire(
  new URL("../../packages/access/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const { JsonRpcProvider, FetchRequest } = createRequire(
  new URL("../../packages/indexing/package.json", import.meta.url),
)("ethers");
function save(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

test(
  "public HTTPS journey: real TLS, ENS, model, receipt publication and indexed next selection",
  { timeout: 600000 },
  async (t) => {
    const manifestFile = process.env.WAVE5_PUBLIC_MANIFEST;
    if (!manifestFile) {
      assert.notEqual(
        process.env.WAVE5_PUBLIC_LIVE_APPROVED,
        "1",
        "Explicit public manifest required",
      );
      console.log(
        "Public journey preflight-only: no public window or transaction authorized by ordinary test discovery",
      );
      return;
    }
    assert.equal(process.env.WAVE5_PUBLIC_LIVE_APPROVED, "1");
    const m = JSON.parse(readFileSync(manifestFile, "utf8"));
    assert.equal(m.publicOrigin, WAVE5_ORIGIN);
    const root = m.privateRoot,
      packetFile = join(root, "journey-packet.json"),
      attemptFile = join(root, "journey-attempt.json");
    const dns = await resolveFunnelAddress(t.signal),
      wire = publicFetch(dns.address),
      tls = await publicTlsObservation(dns.address);
    assert.equal(tls.authorized, true);
    assert.equal(tls.fingerprint256, m.tlsInspection.certificateFingerprint);
    let packet, browser, history, rpc;
    try {
      const chosen = m.providerIds[1];
      if (existsSync(packetFile)) {
        packet = JSON.parse(readFileSync(packetFile, "utf8"));
      } else {
        assert.equal(
          process.env.WAVE5_PUBLIC_EXECUTE,
          "1",
          "First public journey requires explicit execution approval",
        );
        assert.equal(
          existsSync(attemptFile),
          false,
          "Existing ambiguous public attempt must be reconciled, never silently resubmitted",
        );
        browser = await chromium.launch({
          headless: true,
          args: [
            `--host-resolver-rules=MAP m4pro.tail53d0d3.ts.net ${dns.address}`,
          ],
        });
        const context = await browser.newContext({ acceptDownloads: true });
        const page = await context.newPage();
        page.setDefaultTimeout(120000);
        const session = {};
        page.on("response", async (response) => {
          if (
            response.url() === WAVE5_ORIGIN + "/v1/sessions" &&
            response.status() === 201
          )
            Object.assign(session, await response.json());
        });
        await page.route(WAVE5_ORIGIN + "/v1/jobs", async (route) => {
          if (route.request().method() === "POST") {
            save(attemptFile, {
              request: route.request().postDataJSON(),
              idempotencyKey: route.request().headers()["idempotency-key"],
              capability: session.capability,
            });
          }
          await route.continue();
        });
        await page.goto(WAVE5_ORIGIN);
        await page.locator("#provider-choice").waitFor();
        const status = async (prefix) => {
          await page.waitForFunction(
            (p) =>
              document
                .querySelector("[role=status]")
                .textContent.startsWith(p) ||
              document.querySelector("#error").textContent,
            prefix,
          );
          assert.equal(await page.locator("#error").textContent(), "");
        };
        await page.selectOption("#provider-choice", chosen);
        await page.click("#connect");
        await status("Connected");
        await page.click("#find");
        await status("Provider selected");
        assert.equal(
          await page.locator("#history-url a").getAttribute("href"),
          m.graph.queryUrl,
        );
        await page.fill(
          "#prompt",
          "Continue briefly: Public collaboration can help",
        );
        await page.fill("#tokens", "16");
        await page.check("#publish-consent");
        await page.click("#quote-button");
        await status("Quote ready");
        await page.check("#consent");
        await page.click("#submit");
        await status("Stream finished");
        assert.equal(
          await page.locator("#job-state").textContent(),
          "Completed",
        );
        assert.match(
          await page.locator("#output-state").textContent(),
          /not computation-checked/,
        );
        const download = async (id, file) => {
          const next = page.waitForEvent("download");
          await page.click(id);
          await (await next).saveAs(file);
          chmodSync(file, 0o600);
          return JSON.parse(readFileSync(file, "utf8"));
        };
        const bundle = await download(
          "#download",
          join(root, "public-job-evidence.json"),
        );
        await status("Private evidence downloaded");
        const buyer = await download(
          "#download-context",
          join(root, "public-buyer-context.json"),
        );
        assert.equal(
          (
            await checkBuyerEvidenceJson(
              JSON.stringify(bundle),
              m.pins[chosen],
              buyer.expected,
            )
          ).integrity,
          true,
        );
        assert.equal(bundle.receipt.payload.providerId, chosen);
        assert.equal(bundle.request.publishConsent, true);
        assert.ok(bundle.output.text.length);
        packet = {
          jobId: bundle.receipt.payload.jobId,
          capability: session.capability,
          receiptDigest: digestOf(bundle.receipt),
          bundle,
          buyer,
          providerId: chosen,
        };
        save(packetFile, packet);
        await page.screenshot({
          path: join(root, "public-model-result.png"),
          fullPage: true,
        });
        await browser.close();
        browser = undefined;
      }
      assert.equal(
        (
          await checkBuyerEvidenceJson(
            JSON.stringify(packet.bundle),
            m.pins[packet.providerId],
            packet.buyer.expected,
          )
        ).integrity,
        true,
      );
      const client = createClient({
        baseUrl: WAVE5_ORIGIN,
        fetch: wire,
        capability: packet.capability,
        pins: m.pins[packet.providerId],
        timeoutMs: 30000,
      });
      const listed = await client.listProviders(m.providerIds, {
        signal: t.signal,
      });
      assert.deepEqual(
        listed.providers.map((p) => p.providerId).sort(),
        [...m.providerIds].sort(),
      );
      for (const p of listed.providers) {
        assert.equal(p.mode, "live");
        assert.equal(p.source.chainId, "11155111");
        assert.equal(p.endpoint, WAVE5_ORIGIN);
      }
      // Only this independently checked, consented receipt is admitted to the budgeted publisher.
      save(m.authorizationFile, { receiptDigests: [packet.receiptDigest] });
      let publication;
      const until = Date.now() + 300000;
      while (Date.now() < until) {
        const p = await client.getPublication(packet.jobId, {
          signal: t.signal,
        });
        publication = p.events.find(
          (e) =>
            e.kind === "receipt" && e.objectDigest === packet.receiptDigest,
        );
        if (publication?.status === "confirmed") break;
        await delay(3000, undefined, { signal: t.signal });
      }
      assert.equal(
        publication?.status,
        "confirmed",
        "Real publication did not confirm within the bound",
      );
      const request = new FetchRequest(
        "https://ethereum-sepolia-rpc.publicnode.com",
      );
      request.timeout = 15000;
      rpc = new JsonRpcProvider(request, undefined, { cacheTimeout: -1 });
      assert.equal((await rpc.getNetwork()).chainId, 11155111n);
      const receipt = await rpc.getTransactionReceipt(
        publication.transactionRef,
      );
      assert.equal(receipt.status, 1);
      assert.equal(
        receipt.to.toLowerCase(),
        m.graph.deployment.address.toLowerCase(),
      );
      assert.ok((await receipt.confirmations()) >= 12);
      history = createManagedHistory({
        mode: "live",
        spec: {
          endpoint: m.graph.queryUrl,
          deployment: m.graph.deployment,
          deploymentId: m.graph.deploymentId,
          rpcUrl: request.url,
        },
      });
      let report;
      const indexedUntil = Date.now() + 180000;
      while (Date.now() < indexedUntil) {
        report = await history.getReport({
          providerId: packet.providerId,
          signal: t.signal,
        });
        if (
          report.history.freshness === "fresh" &&
          report.receiptObservations.some(
            (x) => x.receiptDigest === packet.receiptDigest,
          )
        )
          break;
        await delay(3000, undefined, { signal: t.signal });
      }
      assert.equal(report.history.freshness, "fresh");
      const observed = report.receiptObservations.find(
        (x) => x.receiptDigest === packet.receiptDigest,
      );
      assert.ok(observed, "Hosted Graph did not index the actual receipt");
      assert.equal(
        observed.transactionHash.toLowerCase(),
        publication.transactionRef.toLowerCase(),
      );
      const next = await createRequest({
        providerId: packet.providerId,
        profileId: packet.bundle.receipt.payload.profileId,
        prompt: "Next decision only; no execution",
        maxOutputTokens: 16,
        seed: 0,
        publishConsent: false,
      });
      const quote = await client.createQuote(next, { signal: t.signal });
      const decision = await client.selectProviders(
        {
          providers: listed.providers,
          quotes: [quote],
          profileId: next.profileId,
          maxAmountBaseUnits: "0",
          network: quote.network,
          asset: quote.asset,
        },
        { signal: t.signal },
      );
      assert.equal(decision.selected.providerId, packet.providerId);
      const reasons = decision.reasons.find(
        (r) => r.providerId === packet.providerId,
      ).codes;
      assert.ok(reasons.includes("INDEXED_RECEIPT_OBSERVED_NOT_PROOF"));
      assert.ok(reasons.includes("HISTORY_UNKNOWN"));
      const prior = JSON.parse(
        readFileSync(
          new URL(
            "../../docs/handoffs/hedera-qualification.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const historicalId = prior.runs[0].transactionId;
      const mirror = await (
        await fetch(
          "https://testnet.mirrornode.hedera.com/api/v1/transactions/" +
            mirrorTransactionId(historicalId),
          { signal: AbortSignal.timeout(15000) },
        )
      ).json();
      const transfer = mirror.transactions.find(
        (x) => x.result === "SUCCESS" && x.nonce === 0,
      );
      assert.ok(transfer);
      const net = (id) =>
        transfer.transfers
          .filter((x) => x.account === id)
          .reduce((n, x) => n + BigInt(x.amount), 0n);
      assert.equal(net(prior.payer), -1n);
      assert.equal(net(prior.receiver), 1n);
      const result = {
        status: "passed",
        observedAt: new Date().toISOString(),
        sourceRevision: m.sourceRevision,
        inferenceVerified: false,
        receiptIntegrityVerified: true,
        tls,
        ens: listed.providers,
        receiptDigest: packet.receiptDigest,
        publicationTransaction: publication.transactionRef,
        receiptRegistry: receipt.to,
        graph: {
          queryUrl: m.graph.queryUrl,
          deploymentId: m.graph.deploymentId,
          observedReceipt: observed,
        },
        history: report.history,
        selection: decision,
        hedera: {
          historical: true,
          transactionId: historicalId,
          result: transfer.result,
          amountTinybars: "1",
          note: "Readback of pre-existing paid-call evidence; Wave 5 new paid call is Step 6, not claimed here",
        },
      };
      save(join(root, "external-revalidation.json"), result);
      mkdirSync(new URL("../../artifacts/closeout/", import.meta.url), {
        recursive: true,
      });
      save(
        fileURLPath(
          new URL(
            "../../artifacts/closeout/external-revalidation.json",
            import.meta.url,
          ),
        ),
        result,
      );
      console.log(
        JSON.stringify({
          status: result.status,
          artifact: join(root, "external-revalidation.json"),
          publicationTransaction: result.publicationTransaction,
          receiptDigest: result.receiptDigest,
          inferenceVerified: false,
        }),
      );
    } finally {
      await browser?.close();
      await history?.close();
      rpc?.destroy();
    }
  },
);
function fileURLPath(url) {
  return decodeURIComponent(url.pathname);
}
