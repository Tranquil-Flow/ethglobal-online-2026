import { createServer } from "node:http";
import { once } from "node:events";
import { PaymentError, fail, textId } from "./safety.mjs";
import { validateHeaderPolicy, validateResponseHeaders } from "./headers.mjs";
/** Lane-local synthetic test service, NOT the application's HTTP API. Authentication
 * is explicitly injected; never accepts principalId from HTTP. No inference. */
export function createSyntheticService({
  payments,
  authenticate,
  failOperation = false,
  mode = "development",
}) {
  if (
    typeof authenticate !== "function" ||
    !["development", "live"].includes(mode)
  )
    fail("INVALID_CONFIG");
  const policy = validateHeaderPolicy(payments.headerPolicy);
  const server = createServer({ maxHeaderSize: 20000 }, async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "application/json");
    const signal = AbortSignal.timeout(10000);
    function send(status, body, headers = {}) {
      const entries = validateResponseHeaders(headers, policy);
      for (const [k, v] of entries) res.setHeader(k, v);
      res.writeHead(status).end(JSON.stringify(body));
    }
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        send(200, {
          status: "ok",
          mode,
          operation: "synthetic-utf8-byte-count",
          inference: false,
        });
        return;
      }
      const principalId = await authenticate(req.headers);
      if (!principalId) {
        send(401, {
          error: {
            code: "UNAUTHORIZED",
            message: "UNAUTHORIZED",
            retryable: false,
          },
        });
        return;
      }
      textId(principalId);
      if (
        req.method !== "POST" ||
        !["/quote", "/operation"].includes(req.url)
      ) {
        send(404, {
          error: { code: "NOT_FOUND", message: "NOT_FOUND", retryable: false },
        });
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 131072) fail("BODY_TOO_LARGE");
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        fail("INVALID_INPUT");
      }
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some(
          (k) =>
            !(
              req.url === "/quote" ? ["request"] : ["request", "quoteId"]
            ).includes(k),
        )
      )
        fail("INVALID_INPUT");
      if (req.url === "/quote") {
        const quote = await payments.quote({
          request: body.request,
          principalId,
          signal,
        });
        if (quote.mode !== mode) fail("MODE_MISMATCH");
        send(201, quote);
        return;
      }
      const paymentHeaders = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (policy.request.includes(name)) {
          if (
            typeof value !== "string" ||
            value.length > 16384 ||
            /[^\x20-\x7e]/.test(value)
          )
            fail("INVALID_PAYMENT");
          paymentHeaders[name] = value;
        } else if (name.startsWith("x-payment") || name.startsWith("payment-"))
          fail("INVALID_PAYMENT");
      }
      // Reject duplicate proof headers: Node may otherwise merge or discard them.
      if (
        policy.request.some(
          (name) =>
            req.rawHeaders.filter(
              (h, i) => i % 2 === 0 && h.toLowerCase() === name,
            ).length > 1,
        )
      )
        fail("INVALID_PAYMENT");
      const result = await payments.authorize({
        request: body.request,
        quoteId: body.quoteId,
        principalId,
        paymentHeaders,
        idempotencyKey: req.headers["idempotency-key"],
        signal,
      });
      if (result.kind === "required") {
        send(402, result.body, result.headers);
        return;
      }
      if (result.payment.mode !== mode) fail("MODE_MISMATCH");
      const jobId = "synthetic-" + result.payment.paymentId;
      const payment = await payments.recordExecutionOutcome({
        paymentId: result.payment.paymentId,
        jobId,
        outcome: failOperation ? "failed" : "succeeded",
        signal,
      });
      send(
        failOperation ? 503 : 200,
        {
          mode,
          operation: "utf8-byte-count",
          ...(failOperation
            ? {}
            : { bytes: Buffer.byteLength(body.request.prompt) }),
          execution: failOperation ? "failed" : "succeeded",
          payment,
          integrity: "not_provided",
          assessment: "unavailable",
          inference: false,
        },
        result.responseHeaders,
      );
    } catch (e) {
      const safe =
        e instanceof PaymentError ? e : new PaymentError("INTERNAL_ERROR");
      const statuses = {
        NOT_FOUND: 404,
        CONFLICT: 409,
        QUOTE_EXPIRED: 409,
        PAYMENT_PENDING: 503,
        FACILITATOR_UNAVAILABLE: 503,
        PAYMENT_CONSUMED: 409,
        BODY_TOO_LARGE: 413,
        INTERNAL_ERROR: 503,
      };
      send(statuses[safe.code] ?? 400, {
        error: {
          code: safe.code,
          message: safe.message,
          retryable: safe.retryable,
        },
      });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.timeout = 10000;
  server.maxRequestsPerSocket = 100;
  return {
    async listen({ host = "127.0.0.1", port = 0 } = {}) {
      if (host !== "127.0.0.1") fail("LOCAL_BIND_REQUIRED");
      server.listen(port, host);
      await once(server, "listening");
      return { url: `http://${host}:${server.address().port}` };
    },
    async close() {
      if (server.listening)
        await new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        });
    },
  };
}
