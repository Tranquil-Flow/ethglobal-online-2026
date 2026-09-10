import http from "node:http";
import { createRecoveryRoutes } from "./recovery.mjs";
import { createOpenAIIngress, isOpenAIPath, openAIError } from "./openai.mjs";
import {
  readHeaderPolicy,
  requestHeaders,
  responseHeaders,
} from "./header-policy.mjs";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  canonicalBytes,
  digestOf,
  requestHash,
  validate,
} from "../../contracts/index.mjs";
export { createStore } from "./store.mjs";
export { createSigner, verifyEvidence } from "./receipts.mjs";
export {
  developmentProfile,
  createDevelopmentExecutor,
  createDevelopmentPayments,
} from "./development.mjs";

const hash = (s) => createHash("sha256").update(s).digest("hex");
const iso = () => new Date().toISOString();
const terminal = (j) =>
  ["succeeded", "failed", "cancelled"].includes(j.executionStatus);
class Failure extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code) => {
  throw new Failure(status, code);
};
const errorBody = (code, retryable = false) => ({
  error: { code, message: code.replaceAll("_", " ").toLowerCase(), retryable },
});
const exact = (v, keys) => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    fail(400, "INVALID_INPUT");
};
const checked = (name, value) => {
  try {
    validate(name, value);
    return structuredClone(value);
  } catch {
    fail(400, "INVALID_INPUT");
  }
};
const recordDigest = (p) => {
  const { resolvedAt, expiresAt, ...source } = p.source;
  return digestOf({ ...p, source });
};
const adapterChecked = (name, value) => {
  try {
    validate(name, value);
    return structuredClone(value);
  } catch {
    fail(503, "INVALID_PORT_RESULT");
  }
};

/** No listeners, implicit credentials, live adapters or successful runtime defaults. */
export function createApp({
  config = {},
  store,
  signer,
  executor,
  payments,
  discovery,
  history,
  eventSink,
  assessor,
  offers,
} = {}) {
  if (!store) throw new Error("Explicit durable store required");
  if (!["development", "live"].includes(config.mode))
    throw new Error("Explicit operation mode required");
  const c = {
    sessionTtlMs: 3600000,
    jobDeadlineMs: 30000,
    portTimeoutMs: 5000,
    maxBodyBytes: 65536,
    maxOutputBytes: 1048576,
    maxExportBytes: 2097152,
    maxQueue: 32,
    concurrency: 2,
    maxEvents: 512,
    retentionMs: 86400000,
    evidenceRetentionMs: 3600000,
    maxRecords: 1000,
    sessionRate: 60,
    requestRate: 120,
    maintenanceMs: 1000,
    ...config,
  };
  for (const key of [
    "sessionTtlMs",
    "jobDeadlineMs",
    "portTimeoutMs",
    "maxBodyBytes",
    "maxOutputBytes",
    "maxExportBytes",
    "maxQueue",
    "concurrency",
    "maxEvents",
    "retentionMs",
    "evidenceRetentionMs",
    "maxRecords",
    "sessionRate",
    "requestRate",
    "maintenanceMs",
  ])
    if (!Number.isSafeInteger(c[key]) || c[key] < 1)
      throw new Error("Invalid bounded configuration");
  if (
    c.sessionTtlMs > 86400000 ||
    c.jobDeadlineMs > 300000 ||
    c.portTimeoutMs > 30000 ||
    c.maxOutputBytes > 1048576 ||
    c.maxExportBytes > 8388608 ||
    c.maxBodyBytes > 1048576 ||
    c.maxRecords > 100000 ||
    c.maxEvents > 8192 ||
    c.maxQueue > 1024 ||
    c.concurrency > 32 ||
    c.retentionMs > 2592000000 ||
    c.evidenceRetentionMs > 604800000 ||
    c.sessionRate > 10000 ||
    c.requestRate > 10000 ||
    c.maintenanceMs > 60000
  )
    throw new Error("Configuration exceeds safety ceiling");
  const profiles = new Map(
    (config.profiles || []).map((p) => {
      checked("Profile", p);
      return [digestOf(p), structuredClone(p)];
    }),
  );
  const providers = new Set(config.providerIds || []);
  if (
    config.assessor &&
    (!/^[A-Za-z0-9_.:-]{1,256}$/.test(config.assessor.method) ||
      !/^[A-Za-z0-9_.:-]{1,256}$/.test(config.assessor.verifierId))
  )
    throw Error("Invalid trusted assessment configuration");
  if (executor?.mode === "development" && c.mode !== "development")
    throw new Error("Development executor cannot serve live mode");
  if (config.paymentHeaderAllowlist !== undefined)
    throw Error("Use PaymentsPort.headerPolicy, not a config header allowlist");
  const headerPolicy = readHeaderPolicy(
    payments ? payments.headerPolicy : { request: [], response: [] },
  );
  const active = new Map(),
    streams = new Set();
  let server,
    timer,
    closing = false,
    maintaining = false,
    requests = 0,
    ownerReady = false;
  const inFlight = new Map();
  function emit(id, type, data) {
    const e = store.get("events", id) || { next: 1, items: [] };
    e.items.push({ id: e.next++, type, data });
    while (e.items.length > c.maxEvents) e.items.shift();
    store.set("events", id, e);
  }
  function save(rec) {
    checked("Job", rec.job);
    rec.job.updatedAt = iso();
    store.set("jobs", rec.job.jobId, rec);
  }
  function rate(id, limit) {
    const now = Date.now(),
      r = store.get("rates", id);
    const v = r && r.until > now ? r : { count: 0, until: now + 60000 };
    if (v.count >= limit) fail(429, "RATE_LIMIT");
    v.count++;
    store.set("rates", id, v);
  }
  function session(req, jobId) {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
      req.headers.authorization || "",
    )?.[1];
    if (!token) fail(401, "ACCESS_REQUIRED");
    const tokenHash = hash(token),
      s = store.get("sessions", tokenHash),
      child = store.get("capabilities", tokenHash);
    const parent = s || (child && store.get("sessions", child.sessionHash));
    if (child?.recoveryId) {
      const recovery = store.get("recoveries", child.recoveryId);
      if (!recovery || recovery.revoked || recovery.expiresAt <= Date.now())
        fail(401, "ACCESS_REQUIRED");
      if (
        !(
          ["GET", "DELETE"].includes(req.method) ||
          (req.method === "POST" &&
            req.url === `/v1/jobs/${child.jobId}/cancel`)
        )
      )
        fail(403, "RECOVERY_SCOPE_DENIED");
    }
    if (
      !parent ||
      parent.revoked ||
      parent.expiresAt <= Date.now() ||
      (child && child.expiresAt <= Date.now())
    )
      fail(401, "ACCESS_REQUIRED");
    if (child && (!jobId || child.jobId !== jobId)) fail(404, "NOT_FOUND");
    return { ...parent, sessionHash: s ? tokenHash : child.sessionHash };
  }
  function scoped(req, id) {
    const s = session(req, id);
    const rec = store.get("jobs", id);
    if (!rec || rec.principalId !== s.principalId) fail(404, "NOT_FOUND");
    return { s, rec };
  }
  function childCapability(s, id, recoveryId) {
    const existing = store.list("capabilities").filter((x) => x.jobId === id);
    if (existing.length >= 32) store.delete("capabilities", existing[0].id);
    const token = randomBytes(32).toString("base64url");
    store.set("capabilities", hash(token), {
      jobId: id,
      sessionHash: s.sessionHash,
      expiresAt: s.expiresAt,
      ...(recoveryId ? { recoveryId } : {}),
    });
    return token;
  }
  async function bounded(fn, outer) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (outer?.aborted) controller.abort();
    else outer?.addEventListener("abort", abort, { once: true });
    let timeout;
    const expired = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Failure(503, "PORT_UNAVAILABLE"));
      }, c.portTimeoutMs);
    });
    const aborted = new Promise((_, reject) =>
      controller.signal.addEventListener(
        "abort",
        () => reject(new Failure(503, "PORT_UNAVAILABLE")),
        { once: true },
      ),
    );
    try {
      if (controller.signal.aborted) fail(503, "PORT_UNAVAILABLE");
      return await Promise.race([
        Promise.resolve().then(() => fn(controller.signal)),
        expired,
        aborted,
      ]);
    } finally {
      clearTimeout(timeout);
      outer?.removeEventListener("abort", abort);
    }
  }
  function request(value) {
    const r = checked("Request", value);
    if (!profiles.has(r.profileId) || !providers.has(r.providerId))
      fail(400, "UNSUPPORTED_PROFILE_OR_PROVIDER");
    if (typeof executor.validateRequest === "function") {
      try {
        const result = executor.validateRequest(structuredClone(r));
        if (result && typeof result.then === "function") {
          Promise.resolve(result).catch(() => {});
          throw Error("ASYNC_REQUEST_POLICY");
        }
      } catch {
        fail(400, "UNSUPPORTED_EXECUTION_REQUEST");
      }
    }
    return r;
  }
  function quoteFor(id, s, r) {
    const saved = store.get("quotes", id);
    if (!saved || saved.principalId !== s.principalId)
      fail(400, "QUOTE_UNAVAILABLE");
    const q = saved.quote;
    if (Date.parse(q.expiresAt) <= Date.now()) fail(400, "QUOTE_EXPIRED");
    if (
      (r &&
        (q.requestHash !== requestHash(r) ||
          q.profileId !== r.profileId ||
          q.providerId !== r.providerId)) ||
      q.mode !== c.mode
    )
      fail(409, "QUOTE_CONFLICT");
    return q;
  }
  function headers(values) {
    try {
      return responseHeaders(values, headerPolicy);
    } catch {
      fail(503, "INVALID_PORT_RESULT");
    }
  }
  function paymentFor(value, q) {
    const p = adapterChecked("Payment", value);
    if (
      p.mode !== c.mode ||
      p.quoteId !== q.quoteId ||
      p.requestHash !== q.requestHash
    )
      fail(503, "PAYMENT_BINDING_MISMATCH");
    return p;
  }
  function enqueuePublication(rec, kind, object) {
    if (!rec.publishConsent) return;
    const event = {
      version: "1",
      kind,
      objectDigest: digestOf(object),
      receiptDigest: rec.job.receiptDigest,
      providerKey: digestOf(rec.providerId),
      mode: c.mode,
    };
    if (kind === "assessment")
      Object.assign(event, {
        outcome: object.outcome,
        verifierKey: digestOf(object.verifierId),
        methodKey: digestOf(object.method),
        assessment: object,
      });
    adapterChecked("PublicEvent", event);
    const id = digestOf(event);
    if (!store.get("outbox", id))
      store.set("outbox", id, {
        event,
        status: eventSink ? "pending" : "unavailable",
        attempts: 0,
        nextAt: 0,
        jobId: rec.job.jobId,
      });
  }
  function finish(rec, status, code, output, receipt) {
    const id = rec.job.jobId;
    store.transaction(() => {
      rec.job.executionStatus = status;
      if (code) rec.job.failureCode = code;
      if (output) {
        rec.job.output = output;
        rec.job.receiptDigest = digestOf(receipt);
        const bundle = store.get("private", id);
        bundle.output = output;
        store.set("private", id, bundle);
        store.set("receipts", id, { receipt });
      }
      if (rec.job.payment) {
        store.set("outcomes", id, {
          paymentId: rec.job.payment.paymentId,
          jobId: id,
          outcome: status,
          nextAt: 0,
          attempts: 0,
        });
        if (status !== "succeeded" && rec.job.payment.status === "settled")
          rec.job.payment = { ...rec.job.payment, status: "paid_but_failed" };
      }
      save(rec);
      if (receipt) enqueuePublication(rec, "receipt", receipt);
      emit(id, "job", rec.job);
      if (code) emit(id, "error", errorBody(code));
      emit(id, "done", { jobId: id });
    });
    setImmediate(() => void maintain());
  }
  async function run(id) {
    let rec = store.get("jobs", id);
    if (!rec || rec.job.executionStatus !== "queued") return;
    const controller = new AbortController();
    active.set(id, controller);
    const deadline = setTimeout(() => controller.abort(), c.jobDeadlineMs);
    rec.job.executionStatus = "running";
    store.transaction(() => {
      save(rec);
      emit(id, "job", rec.job);
    });
    try {
      const bundle = store.get("private", id);
      if (!bundle || !executor || !signer) fail(503, "EXECUTOR_UNAVAILABLE");
      const iterator = executor
        .execute({
          jobId: id,
          request: structuredClone(bundle.request),
          profile: structuredClone(bundle.profile),
          signal: controller.signal,
        })
        [Symbol.asyncIterator]();
      let text = "",
        tokens = [],
        completed,
        steps = 0;
      const next = () =>
        new Promise((resolve, reject) => {
          const abort = () => reject(new Failure(503, "EXECUTION_DEADLINE"));
          if (controller.signal.aborted) return abort();
          controller.signal.addEventListener("abort", abort, { once: true });
          Promise.resolve()
            .then(() => iterator.next())
            .then(resolve, reject)
            .finally(() =>
              controller.signal.removeEventListener("abort", abort),
            );
        });
      try {
        while (true) {
          const result = await next();
          if (result.done) break;
          const e = result.value;
          if (completed || ++steps > 8192) fail(503, "INVALID_EXECUTION");
          if (e?.type === "delta") {
            exact(e, ["type", "text", "tokenIds"]);
            adapterChecked("Output", {
              text: e.text,
              tokenIds: e.tokenIds,
              finishReason: "stop",
            });
            text += e.text;
            tokens.push(...e.tokenIds);
            if (
              tokens.length > bundle.request.maxOutputTokens ||
              Buffer.byteLength(text) > c.maxOutputBytes
            )
              fail(413, "OUTPUT_LIMIT");
            emit(id, "delta", { text: e.text, tokenIds: e.tokenIds });
          } else if (e?.type === "completed") {
            const out = adapterChecked("Output", e.output);
            if (
              e.profileId !== rec.profileId ||
              out.text !== text ||
              digestOf(out.tokenIds) !== digestOf(tokens) ||
              out.finishReason === "cancelled"
            )
              fail(503, "EXECUTION_MISMATCH");
            if (
              e.evidenceDigest !== undefined &&
              !/^sha256:[0-9a-f]{64}$/.test(e.evidenceDigest)
            )
              fail(503, "INVALID_EXECUTION");
            completed = e;
          } else fail(503, "INVALID_EXECUTION");
        }
      } finally {
        Promise.resolve()
          .then(() => iterator.return?.())
          .catch(() => {});
      }
      if (!completed) fail(503, "MISSING_COMPLETION");
      if (controller.signal.aborted) fail(503, "EXECUTION_DEADLINE");
      rec = store.get("jobs", id);
      if (rec.job.executionStatus !== "running") return;
      const payload = {
        version: "1",
        jobId: id,
        requestHash: rec.job.requestHash,
        profileId: rec.profileId,
        outputHash: digestOf(completed.output),
        providerId: rec.providerId,
        quoteId: rec.job.payment.quoteId,
        paymentId: rec.job.payment.paymentId,
        mode: c.mode,
        issuedAt: iso(),
        ...(completed.evidenceDigest
          ? { evidenceDigest: completed.evidenceDigest }
          : {}),
      };
      const receipt = adapterChecked("SignedReceipt", signer.sign(payload));
      if (signer.verify(receipt) !== true)
        fail(503, "RECEIPT_INTEGRITY_FAILED");
      finish(rec, "succeeded", null, completed.output, receipt);
    } catch (e) {
      controller.abort();
      rec = store.get("jobs", id);
      if (rec && rec.job.executionStatus === "running")
        finish(
          rec,
          "failed",
          e instanceof Failure ? e.code : "EXECUTION_FAILED",
        );
    } finally {
      clearTimeout(deadline);
      active.delete(id);
      void maintain();
    }
  }
  async function outcomes() {
    if (!payments) return;
    for (const item of store
      .list("outcomes")
      .filter((x) => x.nextAt <= Date.now())
      .slice(0, 8)) {
      try {
        const value = await bounded((signal) =>
          payments.recordExecutionOutcome({
            paymentId: item.paymentId,
            jobId: item.jobId,
            outcome: item.outcome,
            signal,
          }),
        );
        const rec = store.get("jobs", item.jobId);
        if (!rec) {
          store.delete("outcomes", item.id);
          continue;
        }
        const p = paymentFor(value, {
          quoteId: rec.job.payment.quoteId,
          requestHash: rec.job.requestHash,
        });
        if (
          p.paymentId !== item.paymentId ||
          (item.outcome !== "succeeded" && p.status === "settled")
        )
          fail(503, "INVALID_PAYMENT_OUTCOME");
        store.transaction(() => {
          rec.job.payment = p;
          save(rec);
          store.delete("outcomes", item.id);
        });
      } catch {
        store.set("outcomes", item.id, {
          ...item,
          attempts: item.attempts + 1,
          nextAt:
            Date.now() +
            Math.min(60000, c.maintenanceMs * 2 ** Math.min(item.attempts, 10)),
        });
      }
    }
  }
  async function publish() {
    if (!eventSink) return;
    for (const item of store
      .list("outbox")
      .filter((x) => x.status !== "confirmed" && x.nextAt <= Date.now())
      .sort(
        (a, b) =>
          (a.event.kind === "receipt" ? 0 : 1) -
          (b.event.kind === "receipt" ? 0 : 1),
      )
      .slice(0, 8)) {
      try {
        const result = await bounded((signal) =>
          eventSink.publish({
            event: structuredClone(item.event),
            idempotencyKey: item.id,
            signal,
          }),
        );
        if (!["confirmed", "pending", "unavailable"].includes(result?.status))
          throw Error("Invalid publication");
        store.set("outbox", item.id, {
          ...item,
          status: result.status,
          attempts: item.attempts + 1,
          nextAt:
            Date.now() +
            Math.min(60000, c.maintenanceMs * 2 ** Math.min(item.attempts, 10)),
          ...(typeof result.transactionRef === "string" &&
          result.transactionRef.length <= 2048
            ? { transactionRef: result.transactionRef }
            : {}),
        });
      } catch {
        store.set("outbox", item.id, {
          ...item,
          status: "pending",
          attempts: item.attempts + 1,
          nextAt:
            Date.now() +
            Math.min(60000, c.maintenanceMs * 2 ** Math.min(item.attempts, 10)),
        });
      }
    }
  }
  function deleteEvidence(id) {
    store.transaction(() => {
      store.delete("private", id);
      const rec = store.get("jobs", id);
      if (rec) {
        delete rec.job.output;
        save(rec);
      }
      const e = store.get("events", id);
      if (e) {
        e.items = [];
        store.set("events", id, e);
        if (rec && terminal(rec.job)) {
          emit(id, "job", rec.job);
          emit(id, "done", { jobId: id });
        }
      }
    });
    store.compact();
  }
  function cleanup() {
    const now = Date.now();
    for (const x of store.list("rates"))
      if (x.until <= now) store.delete("rates", x.id);
    for (const x of store.list("quotes"))
      if (Date.parse(x.quote.expiresAt) <= now) store.delete("quotes", x.id);
    for (const x of store.list("capabilities"))
      if (x.expiresAt <= now) store.delete("capabilities", x.id);
    for (const x of store.list("jobs"))
      if (terminal(x.job)) {
        if (x.evidenceExpiresAt <= now && store.get("private", x.id))
          deleteEvidence(x.id);
        if (
          x.expiresAt <= now &&
          !store.get("outcomes", x.id) &&
          !store
            .list("outbox")
            .some(
              (v) => v.jobId === x.id && v.status !== "confirmed" && eventSink,
            )
        ) {
          store.transaction(() => {
            for (const ns of [
              "jobs",
              "private",
              "receipts",
              "events",
              "assessments",
            ])
              store.delete(ns, x.id);
            for (const ns of ["capabilities", "outbox"])
              for (const v of store.list(ns))
                if (v.jobId === x.id) store.delete(ns, v.id);
          });
        }
      }
    for (const x of store.list("sessions"))
      if (x.expiresAt <= now) {
        store.delete("sessions", x.id);
        for (const a of store.list("attempts"))
          if (a.principalId === x.principalId) store.delete("attempts", a.id);
      }
  }
  async function maintain() {
    if (maintaining || closing) return;
    maintaining = true;
    try {
      cleanup();
      for (const rec of store.list("jobs"))
        if (rec.job.executionStatus === "queued" && active.size < c.concurrency)
          void run(rec.job.jobId);
      await outcomes();
      await publish();
    } finally {
      maintaining = false;
    }
  }
  async function body(req) {
    let n = 0,
      chunks = [];
    for await (const chunk of req) {
      n += chunk.length;
      if (n > c.maxBodyBytes) fail(413, "INPUT_LIMIT");
      chunks.push(chunk);
    }
    if (
      !/^application\/json(?:\s*;.*)?$/i.test(req.headers["content-type"] || "")
    )
      fail(400, "JSON_REQUIRED");
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      fail(400, "INVALID_JSON");
    }
  }
  function send(res, status, value, extra = {}) {
    const text = value === undefined ? "" : JSON.stringify(value);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    });
    res.end(text);
  }
  function sse(req, res, id) {
    const raw = req.headers["last-event-id"];
    if (raw !== undefined && !/^\d{1,15}$/.test(raw))
      fail(400, "INVALID_CURSOR");
    let cursor = raw === undefined ? 0 : Number(raw);
    let state = store.get("events", id) || { next: 1, items: [] };
    if (
      raw !== undefined &&
      (cursor > state.next - 1 ||
        cursor < (state.items[0]?.id ?? state.next) - 1)
    )
      fail(409, "CURSOR_EXPIRED");
    if (streams.size >= 64) fail(429, "STREAM_LIMIT");
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.flushHeaders();
    streams.add(res);
    const tick = () => {
      try {
        scoped(req, id);
        state = store.get("events", id);
        if (!state) {
          res.end();
          return;
        }
        if (cursor && (state.items[0]?.id ?? state.next) > cursor + 1) {
          res.end();
          return;
        }
        for (const e of state.items)
          if (e.id > cursor) {
            cursor = e.id;
            if (
              !res.write(
                `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`,
              )
            ) {
              res.destroy();
              return;
            }
          }
        const rec = store.get("jobs", id);
        if (rec && terminal(rec.job)) res.end();
      } catch {
        res.end();
      }
    };
    const interval = setInterval(tick, 20);
    res.on("close", () => {
      clearInterval(interval);
      streams.delete(res);
    });
    tick();
  }
  async function submit(s, b, key, req) {
    const id = digestOf({ principalId: s.principalId, key }),
      bodyHash = digestOf(b);
    let paymentHeaders;
    try {
      paymentHeaders = requestHeaders(req, headerPolicy);
    } catch {
      fail(400, "INVALID_PAYMENT_HEADERS");
    }
    const previous = store.get("attempts", id);
    if (previous && previous.bodyHash !== bodyHash)
      fail(409, "IDEMPOTENCY_CONFLICT");
    if (inFlight.has(id)) return inFlight.get(id);
    const task = (async () => {
      const prior = store.get("attempts", id);
      if (prior?.jobId) {
        const rec = store.get("jobs", prior.jobId);
        if (!rec) fail(409, "JOB_RETIRED");
        return {
          status: 202,
          value: { job: rec.job, capability: childCapability(s, prior.jobId) },
          headers: {},
        };
      }
      const recovering = prior?.state === "authorizing";
      const r = request(b.request),
        q = recovering ? prior.quote : quoteFor(b.quoteId, s, r);
      if (
        !q ||
        q.quoteId !== b.quoteId ||
        q.requestHash !== requestHash(r) ||
        q.mode !== c.mode ||
        q.providerId !== r.providerId ||
        q.profileId !== r.profileId
      )
        fail(409, "PAYMENT_ATTEMPT_UNCERTAIN");
      if (!payments || !executor || !signer) fail(503, "EXECUTION_UNAVAILABLE");
      if (
        store.list("jobs").length >= c.maxRecords ||
        (!prior && store.list("attempts").length >= c.maxRecords) ||
        store.list("jobs").filter((x) => !terminal(x.job)).length +
          inFlight.size >=
          c.maxQueue
      )
        fail(429, "QUEUE_LIMIT");
      const quoteRecord = store.get("quotes", q.quoteId) || {
        quote: q,
        principalId: s.principalId,
        attemptId: id,
      };
      if (quoteRecord.attemptId && quoteRecord.attemptId !== id)
        fail(409, "QUOTE_ALREADY_BOUND");
      store.transaction(() => {
        store.set("quotes", q.quoteId, { ...quoteRecord, attemptId: id });
        store.set("attempts", id, {
          principalId: s.principalId,
          bodyHash,
          state: "authorizing",
          quote: q,
        });
      });

      let auth;
      try {
        auth = await bounded((signal) =>
          payments.authorize({
            request: structuredClone(r),
            quoteId: q.quoteId,
            principalId: s.principalId,
            paymentHeaders,
            idempotencyKey: key,
            signal,
          }),
        );
      } catch {
        fail(503, "PAYMENT_UNAVAILABLE");
      }
      if (auth?.kind === "required") {
        if (auth.status !== 402) fail(503, "INVALID_PORT_RESULT");
        let bytes;
        try {
          bytes = canonicalBytes(auth.body);
        } catch {
          fail(503, "INVALID_PORT_RESULT");
        }
        if (bytes.length > c.maxBodyBytes) fail(503, "INVALID_PORT_RESULT");
        const h = headers(auth.headers);
        store.set("attempts", id, {
          principalId: s.principalId,
          bodyHash,
          state: "required",
        });
        return { status: 402, value: auth.body, headers: h };
      }
      if (auth?.kind !== "authorized") fail(503, "INVALID_PORT_RESULT");
      const p = paymentFor(auth.payment, q);
      if (!["authorized", "settled"].includes(p.status))
        fail(503, "PAYMENT_NOT_AUTHORIZED");
      const h = headers(auth.responseHeaders);
      if (
        store
          .list("attempts")
          .some((a) => a.paymentId === p.paymentId && a.id !== id)
      )
        fail(503, "PAYMENT_ALREADY_BOUND");
      const jobId = randomUUID(),
        now = iso(),
        job = {
          version: "1",
          jobId,
          requestHash: requestHash(r),
          executionStatus: "queued",
          mode: c.mode,
          payment: p,
          assessmentIds: [],
          createdAt: now,
          updatedAt: now,
        };
      const rec = {
        job,
        principalId: s.principalId,
        providerId: r.providerId,
        profileId: r.profileId,
        publishConsent: r.publishConsent,
        expiresAt: Date.now() + c.retentionMs,
        evidenceExpiresAt: Date.now() + c.evidenceRetentionMs,
      };
      let capability;
      store.transaction(() => {
        save(rec);
        store.set("private", jobId, {
          request: r,
          profile: profiles.get(r.profileId),
        });
        store.set("attempts", id, {
          principalId: s.principalId,
          bodyHash,
          state: "created",
          jobId,
          paymentId: p.paymentId,
        });
        emit(jobId, "job", job);
        capability = childCapability(s, jobId);
      });
      const liveSession = store.get("sessions", s.sessionHash);
      if (
        closing ||
        !liveSession ||
        liveSession.revoked ||
        liveSession.expiresAt <= Date.now()
      ) {
        finish(rec, "cancelled", "ACCESS_REVOKED");
        return {
          status: 401,
          value: errorBody("ACCESS_REQUIRED"),
          headers: {},
        };
      }
      setImmediate(() => void maintain());
      return { status: 202, value: { job, capability }, headers: h };
    })();
    inFlight.set(id, task);
    try {
      return await task;
    } finally {
      inFlight.delete(id);
    }
  }
  function idempotency(req) {
    const k = req.headers["idempotency-key"];
    if (
      typeof k !== "string" ||
      !k.length ||
      k.length > 256 ||
      !/^[\x21-\x7e]+$/.test(k)
    )
      fail(400, "IDEMPOTENCY_KEY_REQUIRED");
    return k;
  }
  async function assess(rec, method, key) {
    const id = rec.job.jobId,
      record = store.get("assessments", id) || { items: [], keys: {} };
    const old = record.keys[hash(key)];
    if (old) {
      if (old.method !== method) fail(409, "IDEMPOTENCY_CONFLICT");
      return record.items.find((a) => a.assessmentId === old.id);
    }
    if (record.items.length >= 1024) fail(429, "ASSESSMENT_LIMIT");
    const receipt = store.get("receipts", id)?.receipt;
    if (!receipt) fail(409, "RECEIPT_UNAVAILABLE");
    if (signer.verify(receipt) !== true) fail(503, "RECEIPT_INTEGRITY_FAILED");
    const bundle = store.get("private", id);
    let a = {
      version: "1",
      assessmentId: randomUUID(),
      receiptDigest: rec.job.receiptDigest,
      method,
      profileId: rec.profileId,
      verifierId: "core-unavailable",
      outcome: "unavailable",
      mode: c.mode,
      createdAt: iso(),
      reasonCode: bundle ? "VERIFIER_UNAVAILABLE" : "EVIDENCE_UNAVAILABLE",
    };
    if (
      bundle &&
      rec.evidenceExpiresAt > Date.now() &&
      assessor &&
      config.assessor?.method === method
    ) {
      try {
        a = adapterChecked(
          "Assessment",
          await bounded((signal) =>
            assessor.assess({
              receipt: structuredClone(receipt),
              profile: structuredClone(bundle.profile),
              evidenceRef: `core-local:${id}`,
              signal,
            }),
          ),
        );
        if (
          a.receiptDigest !== rec.job.receiptDigest ||
          a.profileId !== rec.profileId ||
          a.mode !== c.mode ||
          a.method !== method ||
          a.verifierId !== config.assessor.verifierId ||
          (a.outcome === "passed" && !a.evidenceDigest)
        )
          fail(503, "ASSESSMENT_BINDING_MISMATCH");
      } catch {
        a = {
          version: "1",
          assessmentId: randomUUID(),
          receiptDigest: rec.job.receiptDigest,
          method,
          profileId: rec.profileId,
          verifierId: config.assessor.verifierId,
          outcome: "unavailable",
          mode: c.mode,
          createdAt: iso(),
          reasonCode: "VERIFIER_UNAVAILABLE",
        };
      }
    }
    if (!store.get("private", id) || rec.evidenceExpiresAt <= Date.now())
      a = {
        version: "1",
        assessmentId: randomUUID(),
        receiptDigest: rec.job.receiptDigest,
        method,
        profileId: rec.profileId,
        verifierId: "core-unavailable",
        outcome: "unavailable",
        mode: c.mode,
        createdAt: iso(),
        reasonCode: "EVIDENCE_UNAVAILABLE",
      };
    store.transaction(() => {
      const current = store.get("assessments", id) || { items: [], keys: {} };
      if (current.items.some((x) => x.assessmentId === a.assessmentId))
        fail(503, "ASSESSMENT_ID_CONFLICT");
      current.items.push(a);
      current.keys[hash(key)] = { method, id: a.assessmentId };
      store.set("assessments", id, current);
      rec = store.get("jobs", id);
      rec.job.assessmentIds.push(a.assessmentId);
      save(rec);
      emit(id, "assessment", a);
      enqueuePublication(rec, "assessment", a);
    });
    return a;
  }
  async function createQuote(s, r) {
    if (!payments) fail(503, "PAYMENTS_UNAVAILABLE");
    if (store.list("quotes").length >= c.maxRecords) fail(429, "QUOTE_LIMIT");
    const q = adapterChecked(
      "Quote",
      await bounded((signal) =>
        payments.quote({
          request: structuredClone(r),
          principalId: s.principalId,
          signal,
        }),
      ),
    );
    if (
      q.mode !== c.mode ||
      q.requestHash !== requestHash(r) ||
      q.providerId !== r.providerId ||
      q.profileId !== r.profileId ||
      Date.parse(q.expiresAt) <= Date.now() ||
      Date.parse(q.expiresAt) > Date.now() + 86400000
    )
      fail(503, "QUOTE_BINDING_MISMATCH");
    const old = store.get("quotes", q.quoteId);
    if (
      old &&
      (old.principalId !== s.principalId || digestOf(old.quote) !== digestOf(q))
    )
      fail(503, "QUOTE_ID_CONFLICT");
    if (!old && store.list("quotes").length >= c.maxRecords)
      fail(429, "QUOTE_LIMIT");
    store.set("quotes", q.quoteId, {
      ...old,
      quote: q,
      principalId: s.principalId,
    });
    return q;
  }
  const assessmentLocks = new Map();
  const recoveryRoutes = createRecoveryRoutes({
    store,
    config: c,
    fail,
    session,
    childCapability,
    body,
    send,
    exact,
    quoteFor,
    rate,
  });
  const openai = createOpenAIIngress({
    profiles,
    providers,
    store,
    config: c,
    fail,
    body,
    request,
    quote: createQuote,
    submit,
    idempotency,
    scoped,
    streams,
    verifyReceipt(rec) {
      try {
        const receipt = store.get("receipts", rec.job.jobId)?.receipt;
        return (
          !!receipt &&
          signer.verify(receipt) === true &&
          digestOf(receipt) === rec.job.receiptDigest &&
          receipt.payload.outputHash === digestOf(rec.job.output) &&
          receipt.payload.jobId === rec.job.jobId &&
          receipt.payload.profileId === rec.profileId &&
          receipt.payload.requestHash === rec.job.requestHash
        );
      } catch {
        return false;
      }
    },
  });
  async function route(req, res) {
    if (closing) fail(503, "UNAVAILABLE");
    const url = new URL(req.url, "http://localhost");
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((x) => decodeURIComponent(x));
    const method = req.method;
    if (isOpenAIPath(url.pathname)) {
      const hosts = ["127.0.0.1", "localhost", "[::1]"].map(
        (host) => `${host}:${server.address().port}`,
      );
      const names = req.rawHeaders
        .filter((_, i) => i % 2 === 0)
        .map((x) => x.toLowerCase());
      if (
        !hosts.includes(req.headers.host) ||
        new Set(names).size !== names.length ||
        Object.keys(req.headers).some(
          (x) => x === "forwarded" || x.startsWith("x-forwarded-"),
        ) ||
        (req.headers.origin &&
          req.headers.origin !== `http://${req.headers.host}`)
      )
        fail(403, "ORIGIN_REJECTED");
      if (url.search) fail(400, "INVALID_QUERY");
      const s = session(req);
      rate(s.principalId, c.requestRate);
      rate("openai-global", c.requestRate);
      return openai.handle(req, res, url.pathname, s);
    }
    if ([...url.searchParams.keys()].some((k) => k !== "name"))
      fail(400, "INVALID_QUERY");
    if (await recoveryRoutes.handle(req, res, url.pathname)) return;
    if (method === "GET" && url.pathname === "/healthz")
      return send(res, 200, { status: "ok", mode: c.mode });
    if (method === "POST" && url.pathname === "/v1/sessions") {
      exact(await body(req), []);
      rate("session-bootstrap", c.sessionRate);
      if (store.list("sessions").length >= c.maxRecords)
        fail(429, "SESSION_LIMIT");
      const capability = randomBytes(32).toString("base64url"),
        expiresAt = Date.now() + c.sessionTtlMs;
      store.set("sessions", hash(capability), {
        principalId: randomUUID(),
        expiresAt,
        revoked: false,
      });
      return send(res, 201, {
        capability,
        expiresAt: new Date(expiresAt).toISOString(),
      });
    }
    if (method === "POST" && url.pathname === "/v1/sessions/revoke") {
      const s = session(req);
      exact(await body(req), []);
      store.set("sessions", s.sessionHash, {
        principalId: s.principalId,
        expiresAt: s.expiresAt,
        revoked: true,
      });
      for (const ch of store.list("capabilities"))
        if (ch.sessionHash === s.sessionHash)
          store.delete("capabilities", ch.id);
      return send(res, 204);
    }
    if (
      method === "GET" &&
      parts[0] === "v1" &&
      parts[1] === "profiles" &&
      parts.length === 3
    ) {
      const p = profiles.get(parts[2]);
      if (!p) fail(404, "NOT_FOUND");
      return send(res, 200, p);
    }
    if (
      method === "GET" &&
      parts[0] === "v1" &&
      parts[1] === "keys" &&
      parts.length === 3
    ) {
      try {
        return send(res, 200, signer.publicKey(parts[2]));
      } catch {
        fail(404, "NOT_FOUND");
      }
    }
    if (method === "GET" && url.pathname === "/v2/offers") {
      if (!offers) fail(503, "OFFERS_UNAVAILABLE");
      return send(res, 200, await bounded((signal) => offers.list({ signal })));
    }
    if (method === "GET" && url.pathname === "/v1/providers") {
      const names = url.searchParams.getAll("name");
      if (names.length > 32 || names.some((n) => !n.length || n.length > 256))
        fail(400, "INVALID_INPUT");
      if (!discovery) fail(503, "DISCOVERY_UNAVAILABLE");
      const result = await bounded((signal) =>
        discovery.list({ names, signal }),
      );
      return send(res, 200, validateDiscovery(result));
    }
    if (
      method === "GET" &&
      parts[0] === "v1" &&
      parts[1] === "providers" &&
      parts.length === 4 &&
      parts[3] === "history"
    ) {
      if (!parts[2] || parts[2].length > 256) fail(400, "INVALID_INPUT");
      const value = history
        ? await bounded((signal) =>
            history.getHistory({ providerId: parts[2], signal }),
          )
        : {
            version: "1",
            providerId: parts[2],
            observations: [],
            freshness: "unavailable",
            chainId: "unavailable",
            observedAt: iso(),
            mode: c.mode,
          };
      const h = adapterChecked("History", value);
      if (h.providerId !== parts[2] || h.mode !== c.mode)
        fail(503, "INVALID_PORT_RESULT");
      return send(res, 200, h);
    }
    if (method === "POST" && url.pathname === "/v1/providers/select") {
      const s = session(req);
      rate(s.principalId, c.requestRate);
      const b = await body(req);
      exact(b, [
        "providers",
        "quotes",
        "profileId",
        "maxAmountBaseUnits",
        "network",
        "asset",
      ]);
      if (
        !Array.isArray(b.providers) ||
        b.providers.length > 32 ||
        !Array.isArray(b.quotes) ||
        b.quotes.length > 32 ||
        !profiles.has(b.profileId) ||
        typeof b.maxAmountBaseUnits !== "string" ||
        !/^(0|[1-9][0-9]{0,77})$/.test(b.maxAmountBaseUnits) ||
        !["network", "asset"].every(
          (k) =>
            typeof b[k] === "string" && b[k].length > 0 && b[k].length <= 256,
        )
      )
        fail(400, "INVALID_INPUT");
      b.providers.forEach((p) => checked("Provider", p));
      b.quotes.forEach((q) => checked("Quote", q));
      if (!discovery) fail(503, "DISCOVERY_UNAVAILABLE");
      const resolved = await bounded((signal) =>
        discovery.list({ names: b.providers.map((p) => p.name), signal }),
      );
      validateDiscovery(resolved);
      const authoritativeProviders = b.providers.map((p) => {
        const found = resolved.providers.find(
          (a) => recordDigest(a) === recordDigest(p),
        );
        if (
          !found ||
          Date.parse(p.source.expiresAt) <= Date.now() ||
          Date.parse(found.source.expiresAt) <= Date.now()
        )
          fail(409, "PROVIDER_CHANGED");
        return found;
      });
      const quotes = b.quotes.map((q) => {
        const actual = quoteFor(q.quoteId, s);
        if (digestOf(q) !== digestOf(actual)) fail(409, "QUOTE_CONFLICT");
        return actual;
      });
      const result = await bounded((signal) =>
        discovery.select({
          ...b,
          providers: structuredClone(authoritativeProviders),
          quotes: structuredClone(quotes),
          signal,
        }),
      );
      portExact(result, ["selected", "reasons"]);
      if (
        !result ||
        !Array.isArray(result.reasons) ||
        result.reasons.length > 32 ||
        result.reasons.some(
          (r) =>
            !r ||
            typeof r.providerId !== "string" ||
            typeof r.eligible !== "boolean" ||
            !Array.isArray(r.codes) ||
            r.codes.length > 32 ||
            r.providerId.length > 256 ||
            r.codes.some((x) => typeof x !== "string" || x.length > 256),
        )
      )
        fail(503, "INVALID_PORT_RESULT");
      for (const reason of result.reasons)
        portExact(reason, ["providerId", "eligible", "codes"]);
      if (result.selected !== null) {
        adapterChecked("Provider", result.selected);
        if (
          !authoritativeProviders.some(
            (p) => digestOf(p) === digestOf(result.selected),
          )
        )
          fail(503, "INVALID_PORT_RESULT");
      }
      return send(res, 200, result);
    }
    if (method === "POST" && url.pathname === "/v1/quotes") {
      const s = session(req);
      rate(s.principalId, c.requestRate);
      const b = await body(req);
      exact(b, ["request"]);
      return send(res, 201, await createQuote(s, request(b.request)));
    }
    if (method === "POST" && url.pathname === "/v1/jobs") {
      const s = session(req);
      rate(s.principalId, c.requestRate);
      const key = idempotency(req),
        b = await body(req);
      exact(b, ["request", "quoteId"]);
      if (
        typeof b.quoteId !== "string" ||
        !b.quoteId.length ||
        b.quoteId.length > 256
      )
        fail(400, "INVALID_INPUT");
      checked("Request", b.request);
      const r = await submit(s, b, key, req);
      return send(res, r.status, r.value, r.headers);
    }
    if (
      parts[0] === "v1" &&
      parts[1] === "jobs" &&
      parts.length >= 3 &&
      parts.length <= 4
    ) {
      const id = parts[2];
      if (!/^[a-f0-9-]{36}$/.test(id)) fail(404, "NOT_FOUND");
      const { s, rec } = scoped(req, id);
      const action = parts[3];
      if (method === "GET" && !action) return send(res, 200, rec.job);
      if (method === "GET" && action === "events") return sse(req, res, id);
      if (method === "GET" && action === "publication") {
        const value = {
          version: "1",
          jobId: id,
          consent: rec.publishConsent,
          events: store
            .list("outbox")
            .filter((row) => row.jobId === id)
            .map((row) => ({
              kind: row.event.kind,
              objectDigest: row.event.objectDigest,
              status: row.status,
              ...(typeof row.transactionRef === "string" &&
              row.transactionRef.length &&
              row.transactionRef.length <= 256
                ? { transactionRef: row.transactionRef }
                : {}),
            })),
        };
        checked("PublicationState", value);
        return send(res, 200, value);
      }
      if (method === "POST" && action === "cancel") {
        exact(await body(req), []);
        if (!terminal(rec.job)) {
          active.get(id)?.abort();
          finish(rec, "cancelled", "CANCELLED");
        }
        return send(res, 200, store.get("jobs", id).job);
      }
      if (method === "GET" && action === "receipt") {
        const receipt = store.get("receipts", id)?.receipt;
        if (!receipt) fail(409, "RECEIPT_UNAVAILABLE");
        if (signer.verify(receipt) !== true)
          fail(503, "RECEIPT_INTEGRITY_FAILED");
        return send(res, 200, receipt);
      }
      if (method === "DELETE" && action === "evidence") {
        if (!terminal(rec.job)) fail(409, "JOB_ACTIVE");
        deleteEvidence(id);
        return send(res, 204);
      }
      if (method === "GET" && action === "evidence") {
        if (rec.evidenceExpiresAt <= Date.now()) deleteEvidence(id);
        const bundle = store.get("private", id),
          receipt = store.get("receipts", id)?.receipt;
        if (!bundle || !receipt || !bundle.output) fail(404, "NOT_FOUND");
        if (signer.verify(receipt) !== true)
          fail(503, "RECEIPT_INTEGRITY_FAILED");
        const assessments = store.get("assessments", id)?.items || [],
          value = {
            version: "1",
            mode: c.mode,
            receipt,
            ...bundle,
            assessments,
          };
        if (
          receipt.payload.requestHash !== requestHash(bundle.request) ||
          receipt.payload.profileId !== digestOf(bundle.profile) ||
          receipt.payload.outputHash !== digestOf(bundle.output) ||
          rec.job.receiptDigest !== digestOf(receipt) ||
          receipt.payload.providerId !== bundle.request.providerId ||
          receipt.payload.jobId !== id ||
          receipt.payload.mode !== c.mode ||
          assessments.some(
            (a) =>
              a.receiptDigest !== rec.job.receiptDigest ||
              a.profileId !== rec.profileId ||
              a.mode !== c.mode,
          )
        )
          fail(503, "EVIDENCE_CORRUPTED");
        if (canonicalBytes(value).length > c.maxExportBytes)
          fail(413, "EXPORT_LIMIT");
        return send(res, 200, value);
      }
      if (method === "GET" && action === "assessments")
        return send(res, 200, {
          assessments: store.get("assessments", id)?.items || [],
        });
      if (method === "POST" && action === "assessments") {
        rate(s.principalId, c.requestRate);
        const b = await body(req);
        exact(b, ["method"]);
        if (
          typeof b.method !== "string" ||
          !b.method.length ||
          b.method.length > 256
        )
          fail(400, "INVALID_INPUT");
        const key = idempotency(req);
        const previous = assessmentLocks.get(id) || Promise.resolve();
        const task = previous
          .catch(() => {})
          .then(() => assess(store.get("jobs", id), b.method, key));
        assessmentLocks.set(id, task);
        try {
          return send(res, 202, await task);
        } finally {
          if (assessmentLocks.get(id) === task) assessmentLocks.delete(id);
        }
      }
    }
    fail(404, "NOT_FOUND");
  }
  function portExact(value, keys) {
    try {
      exact(value, keys);
      canonicalBytes(value);
    } catch {
      fail(503, "INVALID_PORT_RESULT");
    }
  }
  function validateDiscovery(result) {
    portExact(result, ["providers", "errors"]);
    if (
      !result ||
      !Array.isArray(result.providers) ||
      result.providers.length > 32 ||
      !Array.isArray(result.errors) ||
      result.errors.length > 32
    )
      fail(503, "INVALID_PORT_RESULT");
    for (const p of result.providers) {
      adapterChecked("Provider", p);
      if (p.mode !== c.mode) fail(503, "MODE_MISMATCH");
    }
    for (const e of result.errors) {
      portExact(e, ["name", "code"]);
      if (
        typeof e.name !== "string" ||
        e.name.length > 256 ||
        typeof e.code !== "string" ||
        e.code.length > 256
      )
        fail(503, "INVALID_PORT_RESULT");
    }
    return structuredClone(result);
  }
  return {
    async listen({ host = "127.0.0.1", port = 4310 } = {}) {
      if (server) throw Error("Already listening");
      if (
        !["127.0.0.1", "::1", "localhost"].includes(host) &&
        !config.allowRemoteBind
      )
        throw Error("Remote bind requires explicit operator approval");
      store.acquire?.();
      const persistedMode = store.get("metadata", "mode");
      if (persistedMode && persistedMode.value !== c.mode) {
        store.release?.();
        throw Error("Database mode cannot be relabelled");
      }
      store.set("metadata", "mode", { value: c.mode });
      ownerReady = true;
      for (const rec of store.list("jobs"))
        if (!terminal(rec.job)) finish(rec, "failed", "ORPHANED_EXECUTION");
      server = http.createServer({ maxHeaderSize: 32768 }, (req, res) => {
        if (requests >= 128) {
          send(res, 429, errorBody("CONNECTION_LIMIT", true), {
            "retry-after": "60",
          });
          return;
        }
        requests++;
        res.once("close", () => requests--);
        route(req, res).catch((e) => {
          if (res.headersSent) {
            res.destroy();
            return;
          }
          const status = e instanceof Failure ? e.status : 503,
            code = e instanceof Failure ? e.code : "UNAVAILABLE";
          send(
            res,
            status,
            isOpenAIPath(new URL(req.url, "http://localhost").pathname)
              ? openAIError(code, status)
              : errorBody(code, status === 503 || status === 429),
            status === 429 ? { "retry-after": "60" } : {},
          );
        });
      });
      server.maxConnections = 256;
      server.maxRequestsPerSocket = 1000;
      server.requestTimeout = 10000;
      server.headersTimeout = 10000;
      server.timeout = 15000;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      timer = setInterval(() => void maintain(), c.maintenanceMs);
      void maintain();
      const address = server.address();
      return {
        url: `http://${address.family === "IPv6" ? "[" + address.address + "]" : address.address}:${address.port}`,
      };
    },
    async close() {
      if (!ownerReady) return;
      closing = true;
      clearInterval(timer);
      for (const rec of store.list("jobs"))
        if (!terminal(rec.job)) {
          active.get(rec.job.jobId)?.abort();
          finish(rec, "failed", "SERVICE_STOPPED");
        }
      for (const res of streams) res.end();
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      while (
        maintaining ||
        active.size ||
        inFlight.size ||
        assessmentLocks.size
      )
        await new Promise((r) => setTimeout(r, 5));
      store.release?.();
      ownerReady = false;
    },
  };
}
