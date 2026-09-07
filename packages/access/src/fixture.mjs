// DEVELOPMENT HTTP conformance fixture only. No inference, chain, ENS or Graph service.
import { createServer } from "node:http";
import { randomBytes, generateKeyPairSync, sign } from "node:crypto";
import { validate, digestOf, canonicalBytes } from "./contracts.mjs";
import {
  encodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
} from "@x402/core/http";
const profile = {
  version: "1",
  model: "fixture/model",
  artifacts: [],
  runtimeRevision: "synthetic-v1",
  tokenizerDigest: digestOf("synthetic tokenizer"),
  templateDigest: digestOf("synthetic template"),
  numerics: {
    dtype: "none",
    quantization: "none",
    backend: "fixture",
    hardwareClass: "none",
    determinism: "synthetic text; no inference",
  },
};
export const fixtureProfile = { profile, profileId: digestOf(profile) };
const now = () => new Date().toISOString();
const later = () => new Date(Date.now() + 300000).toISOString();
const uid = () => randomBytes(32).toString("hex");
const envelope = (code) => ({
  error: { code, message: code, retryable: code === "RATE_LIMITED" },
});
function assertKeys(body, keys) {
  if (
    !body ||
    Array.isArray(body) ||
    Object.keys(body).sort().join() !== keys.sort().join()
  )
    throw Error("INVALID_INPUT");
}
export function createFixtureServer(options = {}) {
  const sessions = new Map(),
    quotes = new Map(),
    jobs = new Map(),
    attempts = new Map(),
    assessments = new Map();
  const metrics = {
    paymentAttempts: 0,
    providerReads: 0,
    sseLastEventIds: [],
    executions: 0,
    authorizations: 0,
  };
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  let url,
    interrupted = false;
  const origins = new Set();
  const provider = () => ({
    version: "1",
    providerId: "safe.eth",
    name: "<img src=x onerror=alert(1)>",
    endpoint: url,
    profileIds: [fixtureProfile.profileId],
    paymentNetwork: "eip155:84532",
    paymentAsset: "USDC",
    paymentReceiver: "0x0000000000000000000000000000000000000001",
    mode: "development",
    source: {
      chainId: "fixture:no-chain",
      blockNumber: 0,
      blockHash: "synthetic-block",
      resolvedAt: now(),
      expiresAt: later(),
    },
  });
  const send = (res, status, body, schema, headers = {}) => {
    if (schema) validate(schema, body);
    res.writeHead(status, {
      "cache-control": "no-store",
      "content-type": "application/json",
      ...headers,
    });
    res.end(status === 204 ? undefined : JSON.stringify(body));
  };
  const err = (res, status, code) => send(res, status, envelope(code), "Error");
  const complete = (entry) => {
    if (entry.job.executionStatus !== "running") return;
    entry.job.executionStatus = "succeeded";
    entry.job.updatedAt = now();
    const deltas = [
      { text: "synthetic ", tokenIds: [1] },
      { text: "<img src=x onerror=alert(1)>", tokenIds: [2] },
    ].slice(0, entry.request.maxOutputTokens);
    entry.job.output = {
      text: deltas.map((d) => d.text).join(""),
      tokenIds: deltas.flatMap((d) => d.tokenIds),
      finishReason: entry.request.maxOutputTokens === 1 ? "length" : "stop",
    };
    const payload = {
      version: "1",
      jobId: entry.job.jobId,
      requestHash: digestOf(entry.request),
      profileId: fixtureProfile.profileId,
      outputHash: digestOf(entry.job.output),
      providerId: entry.request.providerId,
      quoteId: entry.job.payment.quoteId,
      paymentId: entry.job.payment.paymentId,
      mode: "development",
      issuedAt: now(),
    };
    entry.receipt = {
      payload,
      keyId: "fixture-key",
      algorithm: "Ed25519",
      signature: sign(
        null,
        Buffer.concat([
          Buffer.from("ethonline:receipt:v1\n"),
          canonicalBytes(payload),
        ]),
        privateKey,
      ).toString("base64url"),
    };
    validate("SignedReceipt", entry.receipt);
    entry.job.receiptDigest = digestOf(entry.receipt);
    entry.events.push(
      ...deltas.map((data) => ({ event: "delta", data })),
      { event: "job", data: structuredClone(entry.job) },
      { event: "done", data: { jobId: entry.job.jobId } },
    );
  };
  const server = createServer(async (req, res) => {
    try {
      const origin = req.headers.origin;
      if (origin) {
        if (!origins.has(origin)) return err(res, 403, "ORIGIN_FORBIDDEN");
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("vary", "Origin");
        res.setHeader(
          "access-control-expose-headers",
          "payment-required,payment-response,retry-after",
        );
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
          "access-control-allow-headers":
            "authorization,content-type,idempotency-key,last-event-id,payment-signature",
          "access-control-max-age": "0",
        });
        return res.end();
      }
      const u = new URL(req.url, "http://fixture.invalid"),
        path = u.pathname;
      if (options.delayMs)
        await new Promise((r) => setTimeout(r, options.delayMs));
      let body;
      if (["POST", "DELETE"].includes(req.method)) {
        let data = "";
        for await (const chunk of req) {
          data += chunk;
          if (Buffer.byteLength(data) > 1048576) return err(res, 413, "BOUNDS");
        }
        if (req.method === "POST") {
          try {
            body = JSON.parse(data);
          } catch {
            return err(res, 400, "INVALID_JSON");
          }
        }
      }
      if (req.method === "GET" && path === "/healthz")
        return send(res, 200, { status: "ok", mode: "development" });
      if (path === "/v1/sessions" && req.method === "POST") {
        assertKeys(body, []);
        const capability = uid();
        sessions.set(capability, { expiresAt: later(), revoked: false });
        return send(res, 201, {
          capability,
          expiresAt: sessions.get(capability).expiresAt,
        });
      }
      if (
        path ===
          `/v1/profiles/${encodeURIComponent(fixtureProfile.profileId)}` &&
        req.method === "GET"
      ) {
        if (options.malformedProfile) return send(res, 200, { wrong: true }); // fault injection, deliberately nonconformant
        if (options.malformedJson) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end("{");
        }
        return send(res, 200, profile, "Profile");
      }
      if (path === "/v1/keys/fixture-key" && req.method === "GET")
        return send(res, 200, {
          keyId: "fixture-key",
          algorithm: "Ed25519",
          publicKeyJwk: jwk,
        });
      if (path === "/v1/providers" && req.method === "GET") {
        metrics.providerReads++;
        if (metrics.providerReads <= (options.rateLimitReads || 0))
          return send(res, 429, envelope("RATE_LIMITED"), "Error", {
            "retry-after": "0",
          });
        const found = u.searchParams.getAll("name").includes("safe.eth");
        const providers = found ? [provider()] : [];
        providers.forEach((p) => validate("Provider", p));
        return send(res, 200, {
          providers,
          errors: found
            ? []
            : [{ name: u.searchParams.get("name") || "", code: "UNAVAILABLE" }],
        });
      }
      if (
        path.startsWith("/v1/providers/") &&
        path.endsWith("/history") &&
        req.method === "GET"
      ) {
        const providerId = decodeURIComponent(path.split("/")[3]);
        return send(
          res,
          200,
          {
            version: "1",
            providerId,
            observations: [],
            freshness: options.staleHistory ? "stale" : "fresh",
            indexedBlock: 0,
            indexedBlockHash: "synthetic-block",
            chainId: "fixture:no-graph",
            observedAt: now(),
            mode: "development",
          },
          "History",
        );
      }
      const cap = req.headers.authorization?.replace(/^Bearer /, "");
      let owner = cap;
      let session = sessions.get(cap);
      if (!session) {
        const child = [...jobs.values()].find((j) => j.capability === cap);
        if (child) {
          owner = child.owner;
          session = sessions.get(owner);
          if (
            !path.startsWith(`/v1/jobs/${encodeURIComponent(child.job.jobId)}`)
          )
            return err(res, 403, "FORBIDDEN");
        }
      }
      if (
        !session ||
        session.revoked ||
        Date.parse(session.expiresAt) <= Date.now()
      )
        return err(res, 401, "CAPABILITY_EXPIRED");
      if (path === "/v1/sessions/revoke" && req.method === "POST") {
        assertKeys(body, []);
        session.revoked = true;
        return send(res, 204);
      }
      if (path === "/v1/quotes" && req.method === "POST") {
        assertKeys(body, ["request"]);
        validate("Request", body.request);
        if (
          body.request.profileId !== fixtureProfile.profileId ||
          body.request.providerId !== "safe.eth"
        )
          return err(res, 400, "UNSUPPORTED_PROFILE");
        const quote = {
          version: "1",
          quoteId: uid(),
          requestHash: digestOf(body.request),
          providerId: body.request.providerId,
          profileId: body.request.profileId,
          amountBaseUnits: "5",
          network: "eip155:84532",
          asset: "USDC",
          receiver: provider().paymentReceiver,
          expiresAt: later(),
          mode: "development",
        };
        quotes.set(quote.quoteId, { quote, owner });
        return send(res, 201, quote, "Quote");
      }
      if (path === "/v1/providers/select" && req.method === "POST") {
        assertKeys(body, [
          "providers",
          "quotes",
          "profileId",
          "maxAmountBaseUnits",
          "network",
          "asset",
        ]);
        body.providers.forEach((p) => validate("Provider", p));
        body.quotes.forEach((q) => validate("Quote", q));
        if (!/^(0|[1-9][0-9]{0,77})$/.test(body.maxAmountBaseUnits))
          return err(res, 400, "INVALID_INPUT");
        if (
          body.quotes.some(
            (q) =>
              !quotes.has(q.quoteId) ||
              quotes.get(q.quoteId).owner !== owner ||
              digestOf(q) !== digestOf(quotes.get(q.quoteId).quote) ||
              Date.parse(q.expiresAt) <= Date.now(),
          )
        )
          return err(res, 400, "INVALID_QUOTE");
        const reasons = body.providers.map((p) => {
          const q = body.quotes.find((q) => q.providerId === p.providerId);
          const codes = [];
          if (!q) codes.push("QUOTE_REQUIRED");
          if (
            p.providerId !== "safe.eth" ||
            !p.profileIds.includes(body.profileId)
          )
            codes.push("INCOMPATIBLE");
          if (
            q &&
            (BigInt(q.amountBaseUnits) > BigInt(body.maxAmountBaseUnits) ||
              q.network !== body.network ||
              q.asset !== body.asset)
          )
            codes.push("BUDGET_OR_ASSET");
          return {
            providerId: p.providerId,
            eligible: codes.length === 0,
            codes,
          };
        });
        return send(res, 200, {
          selected: reasons.some((r) => r.eligible) ? provider() : null,
          reasons,
        });
      }
      if (path === "/v1/jobs" && req.method === "POST") {
        metrics.paymentAttempts++;
        assertKeys(body, ["request", "quoteId"]);
        validate("Request", body.request);
        const key = req.headers["idempotency-key"];
        if (!key || key.length > 256) return err(res, 400, "INVALID_INPUT");
        const attemptKey = owner + ":" + key,
          hash = digestOf(body),
          existing = attempts.get(attemptKey);
        if (existing) {
          if (existing.hash !== hash)
            return err(res, 409, "IDEMPOTENCY_CONFLICT");
          return send(res, 202, {
            job: existing.entry.job,
            capability: existing.entry.capability,
          });
        }
        const stored = quotes.get(body.quoteId),
          q = stored?.quote;
        if (
          !q ||
          stored.owner !== owner ||
          q.requestHash !== digestOf(body.request) ||
          Date.parse(q.expiresAt) <= Date.now()
        )
          return err(res, 400, "INVALID_QUOTE");
        const challenge = {
          x402Version: 2,
          resource: {
            url: url + "/v1/jobs",
            description:
              "DEVELOPMENT conformance only, no payment or inference",
            mimeType: "application/json",
          },
          accepts: [
            {
              scheme: "exact",
              network: q.network,
              asset: q.asset,
              amount: q.amountBaseUnits,
              payTo: q.receiver,
              maxTimeoutSeconds: 60,
              extra: {},
            },
          ],
        };
        if (!req.headers["payment-signature"])
          return send(res, 402, challenge, null, {
            "payment-required": encodePaymentRequiredHeader(challenge),
          });
        let proof;
        try {
          proof = decodePaymentSignatureHeader(
            req.headers["payment-signature"],
          );
        } catch {
          return err(res, 400, "INVALID_PAYMENT");
        }
        // Explicit synthetic adapter, not cryptographic payment verification or settlement.
        if (
          proof.x402Version !== 2 ||
          digestOf(proof.accepted) !== digestOf(challenge.accepts[0]) ||
          proof.payload?.developmentConformance !== true
        )
          return err(res, 400, "INVALID_PAYMENT");
        metrics.authorizations++;
        metrics.executions++;
        const job = {
          version: "1",
          jobId: uid(),
          requestHash: q.requestHash,
          executionStatus: "running",
          mode: "development",
          payment: {
            version: "1",
            paymentId: uid(),
            quoteId: q.quoteId,
            requestHash: q.requestHash,
            status: "authorized",
            mode: "development",
          },
          assessmentIds: [],
          createdAt: now(),
          updatedAt: now(),
        };
        validate("Job", job);
        const entry = {
          owner,
          job,
          request: body.request,
          capability: uid(),
          events: [{ event: "job", data: structuredClone(job) }],
          evidence: true,
        };
        jobs.set(job.jobId, entry);
        attempts.set(attemptKey, { hash, entry });
        if (options.dropAfterPayment) return req.socket.destroy();
        return send(res, 202, { job, capability: entry.capability });
      }
      const parts = path.split("/"),
        entry = jobs.get(decodeURIComponent(parts[3] || ""));
      if (
        parts[1] !== "v1" ||
        parts[2] !== "jobs" ||
        !entry ||
        entry.owner !== owner
      )
        return err(res, 404, "NOT_FOUND");
      const action = parts[4];
      if (!action && req.method === "GET")
        return send(res, 200, entry.job, "Job");
      if (action === "cancel" && req.method === "POST") {
        assertKeys(body, []);
        if (["running", "queued"].includes(entry.job.executionStatus)) {
          entry.job.executionStatus = "cancelled";
          entry.job.payment.status = "paid_but_failed";
          entry.job.updatedAt = now();
          entry.events.push(
            { event: "job", data: structuredClone(entry.job) },
            { event: "done", data: { jobId: entry.job.jobId } },
          );
        }
        return send(res, 200, entry.job, "Job");
      }
      if (action === "events" && req.method === "GET") {
        const last = req.headers["last-event-id"];
        metrics.sseLastEventIds.push(last);
        if (
          last &&
          (!/^[0-9]+$/.test(last) ||
            Number(last) > entry.events.length + 4 ||
            options.expiredCursor)
        )
          return err(res, 409, "CURSOR_EXPIRED");
        if (options.executionDelayMs)
          await new Promise((r) => setTimeout(r, options.executionDelayMs));
        complete(entry);
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        });
        const events = entry.events
          .map((e, i) => ({ ...e, id: i + 1 }))
          .filter((e) => e.id > Number(last || 0));
        for (const e of events) {
          if (e.event === "job") validate("Job", e.data);
          if (e.event === "delta") {
            if (
              typeof e.data.text !== "string" ||
              !Array.isArray(e.data.tokenIds)
            )
              throw Error("INVALID_DELTA");
          }
          res.write(
            `id: ${e.id}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`,
          );
          if (options.interruptSseOnce && !interrupted && e.id === 2) {
            interrupted = true;
            return res.end();
          }
        }
        return res.end();
      }
      if (action === "receipt" && req.method === "GET")
        return entry.receipt
          ? send(res, 200, entry.receipt, "SignedReceipt")
          : err(res, 409, "RECEIPT_UNAVAILABLE");
      if (action === "evidence") {
        if (req.method === "DELETE") {
          entry.evidence = false;
          return send(res, 204);
        }
        if (req.method !== "GET") return err(res, 400, "INVALID_INPUT");
        if (!entry.evidence) return err(res, 404, "NOT_FOUND");
        if (!entry.receipt) return err(res, 409, "RECEIPT_UNAVAILABLE");
        const output = {
          version: "1",
          mode: "development",
          receipt: entry.receipt,
          request: entry.request,
          profile,
          output: entry.job.output,
          assessments: entry.job.assessmentIds.map((id) => assessments.get(id)),
        };
        for (const [k, s] of [
          ["receipt", "SignedReceipt"],
          ["request", "Request"],
          ["profile", "Profile"],
          ["output", "Output"],
        ])
          validate(s, output[k]);
        return send(res, 200, output);
      }
      if (action === "assessments") {
        if (req.method === "GET")
          return send(res, 200, {
            assessments: entry.job.assessmentIds.map((id) =>
              assessments.get(id),
            ),
          });
        assertKeys(body, ["method"]);
        if (
          typeof body.method !== "string" ||
          !body.method ||
          body.method.length > 256
        )
          return err(res, 400, "INVALID_INPUT");
        if (!entry.receipt) return err(res, 409, "RECEIPT_UNAVAILABLE");
        const key = req.headers["idempotency-key"];
        if (!key) return err(res, 400, "INVALID_INPUT");
        const previous = entry.job.assessmentIds
          .map((id) => assessments.get(id))
          .find((a) => a.assessmentId === digestOf([entry.job.jobId, key]));
        if (previous)
          return previous.method === body.method
            ? send(res, 202, previous, "Assessment")
            : err(res, 409, "IDEMPOTENCY_CONFLICT");
        const a = {
          version: "1",
          assessmentId: digestOf([entry.job.jobId, key]),
          receiptDigest: digestOf(entry.receipt),
          method: body.method,
          profileId: fixtureProfile.profileId,
          verifierId: "fixture:unavailable",
          outcome: "unavailable",
          mode: "development",
          createdAt: now(),
          reasonCode: entry.evidence
            ? "NO_EXECUTION_VERIFIER"
            : "EVIDENCE_DELETED",
        };
        assessments.set(a.assessmentId, a);
        entry.job.assessmentIds.push(a.assessmentId);
        return send(res, 202, a, "Assessment");
      }
      return err(res, 404, "NOT_FOUND");
    } catch {
      if (!res.headersSent) err(res, 400, "INVALID_INPUT");
      else res.destroy();
    }
  });
  return {
    metrics,
    publicKeyJwk: jwk,
    allowOrigin(origin) {
      origins.add(new URL(origin).origin);
    },
    expireSessions() {
      for (const s of sessions.values()) s.expiresAt = "2000-01-01T00:00:00Z";
    },
    async listen({ host = "127.0.0.1", port = 0 } = {}) {
      if (!["127.0.0.1", "localhost", "::1"].includes(host))
        throw Error("LOOPBACK_ONLY");
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      url = `http://${host === "::1" ? "[::1]" : host}:${server.address().port}`;
      return { url };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
