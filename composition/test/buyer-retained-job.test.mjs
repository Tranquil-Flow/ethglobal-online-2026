import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import {
  createApp,
  createStore,
  createSigner,
  developmentProfile,
} from "../../packages/core/src/index.mjs";
import { createDevelopmentPayments } from "../../packages/core/src/development.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";
const { chromium } = createRequire(
  new URL("../../packages/access/package.json", import.meta.url),
)("playwright");

// Real core + SQLite + built viewer; only discovery/execution are synthetic ports.
async function fixture(t, { held = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "buyer-retained-"));
  const store = createStore({ path: join(dir, "core.sqlite") });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let executions = 0,
    browser,
    proxy,
    origin;
  const requests = [],
    profileId = digestOf(developmentProfile);
  const signer = createSigner({
    privateKey: generateKeyPairSync("ed25519").privateKey,
    keyId: "buyer-test",
  });
  const pins = {
    providerId: "buyer.invalid",
    ...signer.publicKey("buyer-test"),
  };
  const app = createApp({
    config: {
      mode: "development",
      profiles: [developmentProfile],
      providerIds: [pins.providerId],
      jobDeadlineMs: 20000,
    },
    store,
    signer,
    payments: createDevelopmentPayments({ store, sponsored: true }),
    discovery: {
      async list() {
        return {
          providers: [
            {
              version: "1",
              providerId: pins.providerId,
              name: pins.providerId,
              endpoint: origin,
              profileIds: [profileId],
              paymentNetwork: "development-local",
              paymentAsset: "development-none",
              paymentReceiver: "development.invalid",
              mode: "development",
              source: {
                chainId: "synthetic-no-chain",
                blockNumber: 0,
                blockHash: "synthetic",
                resolvedAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60000).toISOString(),
              },
            },
          ],
          errors: [],
        };
      },
    },
    executor: {
      mode: "development",
      async *execute({ profile, signal }) {
        executions++;
        yield { type: "delta", text: "é", tokenIds: [11] };
        if (held)
          await Promise.race([
            gate,
            new Promise((resolve) =>
              signal.addEventListener("abort", resolve, { once: true }),
            ),
          ]);
        if (signal.aborted) throw Error("TEST_CANCELLED");
        yield { type: "delta", text: "🌙", tokenIds: [12] };
        yield {
          type: "completed",
          profileId: digestOf(profile),
          output: { text: "é🌙", tokenIds: [11, 12], finishReason: "length" },
        };
      },
    },
  });
  t.after(async () => {
    release();
    await browser?.close();
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
    }
    await app.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const { url } = await app.listen({ host: "127.0.0.1", port: 0 });
  proxy = createServer(async (req, res) => {
    requests.push({ path: req.url, method: req.method }); // No headers/private bodies.
    if (req.url.startsWith("/v1/") || req.url === "/healthz") {
      const upstream = httpRequest(
        url + req.url,
        {
          method: req.method,
          headers: {
            ...req.headers,
            host: new URL(url).host,
            ...(req.headers.origin ? { origin: url } : {}),
          },
        },
        (up) => {
          res.writeHead(up.statusCode, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => res.destroy());
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
      return;
    }
    res.setHeader("cache-control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (req.url === "/config.json") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          apiUrl: origin,
          fixture: false,
          accessPolicy: "sponsored-local",
          pins,
        }),
      );
      return;
    }
    const file = {
      "/": "index.html",
      "/app.js": "app.js",
      "/style.css": "style.css",
    }[req.url];
    if (!file) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      res.setHeader(
        "content-type",
        file.endsWith("html")
          ? "text/html"
          : file.endsWith("css")
            ? "text/css"
            : "text/javascript",
      );
      res.end(
        await readFile(
          new URL("../../packages/access/dist/" + file, import.meta.url),
        ),
      );
    } catch {
      res.writeHead(503);
      res.end();
    }
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + proxy.address().port;
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    acceptDownloads: true,
  });
  page.setDefaultTimeout(2500);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page.locator("#advanced-details > summary").click();
  await page.click("#connect");
  await page
    .locator("[role=status]")
    .filter({ hasText: "Connected" })
    .waitFor();
  await page.fill("#provider", pins.providerId);
  await page.fill("#profile", profileId);
  await page.click("#find");
  await page
    .locator("[role=status]")
    .filter({ hasText: "Provider selected" })
    .waitFor();
  await page.fill("#prompt", "Public synthetic buyer café");
  await page.fill("#tokens", "2");
  await page.fill("#budget", "0");
  const quote = async () => {
    await page.click("#quote-button");
    await page
      .locator("[role=status]")
      .filter({ hasText: "Quote ready" })
      .waitFor();
  };
  const submit = async () => {
    await quote();
    await page.check("#consent");
    await page.click("#submit");
  };
  return {
    page,
    store,
    requests,
    release,
    dir,
    errors,
    quote,
    submit,
    executions: () => executions,
    job: () => store.list("jobs")[0]?.job,
    browser,
  };
}

const completed = async (page) => {
  await page.locator("#job-state").filter({ hasText: "Completed" }).waitFor();
  await page
    .locator("[role=status]")
    .filter({ hasText: /Stream finished|Retained job refreshed/ })
    .waitFor();
};

test(
  "buyer refresh recovers durable completed output without expired events or private evidence",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await f.submit();
    await completed(f.page);
    const j = f.job(),
      events = f.store.get("events", j.jobId);
    f.store.set("events", j.jobId, {
      next: events.next,
      items: events.items.slice(-1),
    });
    f.store.delete("private", j.jobId); // Evidence unavailable, job/output still retained.
    const before = f.requests.length;
    await f.page.click("#resume");
    await f.page
      .locator("[role=status]")
      .filter({ hasText: "Retained job refreshed" })
      .waitFor();
    assert.equal(await f.page.textContent("#answer"), "é🌙");
    assert.match(
      await f.page.textContent("#receipt-state"),
      /^Receipt available — integrity unchecked · sha256:[a-f0-9]{64}$/,
    );
    assert.equal(
      await f.page.locator("#receipt-claim").getAttribute("data-state"),
      "unchecked",
    );
    assert.match(
      await f.page.textContent("#output-state"),
      /Complete.*not computation-checked/,
    );
    assert.match(await f.page.textContent("#protection-state"), /Unavailable/);
    assert.equal(
      f.requests
        .slice(before)
        .some(
          (r) =>
            r.path.endsWith("/events") ||
            r.path.endsWith("/evidence") ||
            r.method === "POST",
        ),
      false,
    );
    assert.equal(f.executions(), 1);
    const download = f.page.waitForEvent("download");
    await f.page.click("#download-context");
    const path = join(f.dir, "buyer.json");
    await (await download).saveAs(path);
    const context = JSON.parse(await readFile(path, "utf8"));
    assert.equal(
      context.expected.request.prompt,
      "Public synthetic buyer café",
    );
    assert.equal(context.expected.output.text, "é🌙");
    assert.equal(context.pins.publicKeyJwk.d, undefined);
    await f.page.click("#download");
    await f.page.locator("#error").filter({ hasText: "NOT_FOUND" }).waitFor();
    assert.match(
      await f.page.textContent("#receipt-state"),
      /^Receipt available — integrity unchecked · sha256:[a-f0-9]{64}$/,
    );
    assert.equal(
      await f.page.locator("#receipt-claim").getAttribute("data-state"),
      "unchecked",
    );
    assert.equal(
      await f.page.evaluate(() => localStorage.length + sessionStorage.length),
      0,
    );
    assert.deepEqual(f.errors, []);
    assert.equal(
      await f.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    if (process.env.FOUNDATION_BROWSER_DIR) {
      await mkdir(process.env.FOUNDATION_BROWSER_DIR, { recursive: true });
      await f.page.screenshot({
        path: join(
          process.env.FOUNDATION_BROWSER_DIR,
          "buyer-retained-mobile.png",
        ),
        fullPage: true,
      });
      await f.page.setViewportSize({ width: 1280, height: 1000 });
      assert.equal(
        await f.page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await f.page.screenshot({
        path: join(
          process.env.FOUNDATION_BROWSER_DIR,
          "buyer-retained-desktop.png",
        ),
        fullPage: true,
      });
      await writeFile(
        join(
          process.env.FOUNDATION_BROWSER_DIR,
          "buyer-retained-observation.json",
        ),
        JSON.stringify({
          scope: "real-core-browser-synthetic-executor-no-funds",
          browser: f.browser.version(),
          requests: f.requests,
          executions: f.executions(),
          pageErrors: f.errors,
        }),
      );
    }
  },
);

test(
  "buyer interrupted stream refreshes the same saved job; reconnect cannot replace its session",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, { held: true });
    await f.page.route("**/events", (route) => route.abort());
    await f.submit();
    await f.page
      .locator("#error")
      .filter({ hasText: "SSE_INTERRUPTED" })
      .waitFor();
    assert.match(await f.page.textContent("#output-state"), /Provisional/);
    const sessions = f.store.list("sessions").length;
    await f.page.click("#connect");
    await f.page
      .locator("[role=status]")
      .filter({ hasText: "already connected" })
      .waitFor();
    assert.equal(f.store.list("sessions").length, sessions);
    f.release();
    await new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        if (f.job()?.executionStatus === "succeeded") {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - start > 3000) {
          clearInterval(timer);
          reject(Error("fixture did not finish"));
        }
      }, 10);
    });
    await f.page.click("#resume");
    await completed(f.page);
    assert.equal(await f.page.textContent("#answer"), "é🌙");
    assert.equal(f.executions(), 1);
    assert.deepEqual(f.errors, []);
  },
);

test(
  "unknown accepted submission blocks fresh quote/session and exports only private attempt metadata",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await f.page.route("**/v1/jobs", async (route) => {
      await route.fetch();
      await route.abort();
    });
    await f.submit();
    await f.page
      .locator("#error")
      .filter({ hasText: /NETWORK|UNAVAILABLE/ })
      .waitFor();
    assert.match(
      await f.page.textContent("#attempt-state"),
      /unknown.*do not authorize again/i,
    );
    const before = f.requests.length;
    // U3 gating: an uncertain submission disables fresh work at the control
    // layer (button disabled with reason) instead of failing on click. The
    // server-side SUBMISSION_UNCERTAIN guard remains authoritative.
    for (const button of ["#quote-button", "#connect", "#find"]) {
      if (button === "#quote-button") {
        assert.equal(await f.page.getAttribute("#quote-button", "disabled"), "");
        assert.match(
          await f.page.textContent("#quote-reason"),
          /submission outcome unknown/i,
        );
      } else {
        await f.page.click(button);
        await f.page
          .locator("#error")
          .filter({ hasText: "SUBMISSION_UNCERTAIN" })
          .waitFor();
      }
    }
    assert.equal(
      f.requests.slice(before).some((r) => r.method === "POST"),
      false,
    );
    assert.equal(f.executions(), 1);
    assert.equal(f.store.list("jobs").length, 1);
    const download = f.page.waitForEvent("download");
    await f.page.click("#download-attempt");
    const path = join(f.dir, "attempt.json");
    await (await download).saveAs(path);
    const context = JSON.parse(await readFile(path, "utf8"));
    assert.equal(context.request.prompt, "Public synthetic buyer café");
    assert.equal(typeof context.idempotencyKey, "string");
    assert.equal(context.quote.quoteId, f.job().payment.quoteId);
    assert.equal(context.capability, undefined);
    assert.equal(context.pins.publicKeyJwk.d, undefined);
    assert.deepEqual(Object.keys(context).sort(), [
      "apiUrl",
      "budget",
      "idempotencyKey",
      "pins",
      "quote",
      "request",
      "version",
    ]);
    assert.equal(
      await f.page.evaluate(() => localStorage.length + sessionStorage.length),
      0,
    );
  },
);

test(
  "partial buyer stream resumes its retained cursor without duplicated prefix or a second job",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, { held: true });
    let streams = 0;
    await f.page.route("**/events", async (route) => {
      if (streams++) return route.abort();
      // Truncate the REAL core's retained event transcript after its first delta.
      const events = f.store.get("events", f.job().jobId).items;
      const index = events.findIndex((e) => e.type === "delta");
      assert.ok(index >= 0);
      const body = events
        .slice(0, index + 1)
        .map(
          (e) =>
            `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`,
        )
        .join("");
      await route.fulfill({ contentType: "text/event-stream", body });
    });
    await f.submit();
    await f.page
      .locator("#error")
      .filter({ hasText: "SSE_INTERRUPTED" })
      .waitFor();
    assert.equal(await f.page.textContent("#answer"), "é");
    await f.page.unroute("**/events");
    const resumed = f.page.waitForRequest((r) => r.url().endsWith("/events"));
    await f.page.click("#resume");
    assert.ok(Number((await resumed).headers()["last-event-id"]) > 0);
    assert.equal(await f.page.textContent("#answer"), "é");
    f.release();
    await completed(f.page);
    assert.equal(await f.page.textContent("#answer"), "é🌙");
    assert.equal(f.executions(), 1);
    assert.deepEqual(f.errors, []);
  },
);

test(
  "expired session is forgotten only by explicit revoke; reconnect never submits a job",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    for (const entry of f.store.list("sessions"))
      f.store.set("sessions", entry.id, { ...entry, expiresAt: 0 });
    const before = f.requests.length;
    await f.page.click("#revoke");
    await f.page
      .locator("[role=status]")
      .filter({ hasText: "local connection forgotten" })
      .waitFor();
    assert.equal(
      f.requests.slice(before).some((r) => r.path === "/v1/sessions"),
      false,
    );
    await f.page.click("#connect");
    await f.page
      .locator("[role=status]")
      .filter({ hasText: "Connected — no payment authorized" })
      .waitFor();
    assert.equal(
      f.requests.slice(before).filter((r) => r.path === "/v1/sessions").length,
      1,
    );
    assert.equal(f.executions(), 0);
  },
);

test(
  "retained buyer context rejects a substituted request on refresh",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await f.submit();
    await completed(f.page);
    const j = f.job(),
      record = f.store.get("jobs", j.jobId);
    record.job.requestHash = digestOf("substituted-original");
    f.store.set("jobs", j.jobId, record);
    await f.page.click("#resume");
    await f.page
      .locator("#error")
      .filter({ hasText: "JOB_MISMATCH" })
      .waitFor();
    assert.equal(await f.page.textContent("#answer"), "é🌙");
    assert.match(
      await f.page.textContent("#receipt-state"),
      /^Receipt available — integrity unchecked · sha256:[a-f0-9]{64}$/,
    );
    assert.equal(
      await f.page.locator("#receipt-claim").getAttribute("data-state"),
      "unchecked",
    );
    assert.equal(f.executions(), 1);
  },
);
