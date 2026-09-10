import { digestOf } from "../../contracts/index.mjs";

export const isOpenAIPath = (path) =>
  ["/v1/models", "/v1/chat/completions"].includes(path);
export const openAIError = (code, status) => ({
  error: {
    message: code.replaceAll("_", " ").toLowerCase(),
    type:
      status === 401
        ? "authentication_error"
        : status === 429
          ? "rate_limit_error"
          : status >= 500
            ? "server_error"
            : "invalid_request_error",
    param: null,
    code,
  },
});

/** Protocol projection only. The host supplies its EXISTING session, quote,
 * submission, durable event/receipt store and limits; there is no executor here.
 */
export function createOpenAIIngress({
  profiles,
  providers,
  store,
  config,
  fail,
  body,
  request,
  quote,
  submit,
  idempotency,
  scoped,
  streams,
  verifyReceipt,
}) {
  const models = new Map();
  for (const providerId of providers)
    for (const [profileId] of profiles) {
      const id =
        "mycelium-" +
        digestOf({ providerId, profileId, chat: "single-user-v1" }).slice(7);
      models.set(id, {
        id,
        object: "model",
        created: 0,
        owned_by: providerId,
        mycelium: {
          profile_id: profileId,
          provider_id: providerId,
          chat_format: "single-user-v1",
          execution_mode: config.mode,
        },
      });
    }
  const quoteLocks = new Map();
  function parse(b, s, key) {
    if (
      !b ||
      typeof b !== "object" ||
      Array.isArray(b) ||
      Object.keys(b).some(
        (k) => !["model", "messages", "max_tokens", "stream"].includes(k),
      )
    )
      fail(400, "UNSUPPORTED_CHAT_OPTION");
    if (!models.has(b.model)) fail(404, "MODEL_NOT_FOUND");
    if (!Array.isArray(b.messages) || b.messages.length !== 1)
      fail(400, "UNSUPPORTED_CHAT_MESSAGES");
    const message = b.messages[0];
    if (
      !message ||
      Object.keys(message).sort().join(",") !== "content,role" ||
      message.role !== "user" ||
      typeof message.content !== "string" ||
      !message.content.isWellFormed()
    )
      fail(400, "UNSUPPORTED_CHAT_MESSAGES");
    if (
      !message.content.length ||
      [...message.content].length > 256 ||
      Buffer.byteLength(message.content) > 1024
    )
      fail(413, "CHAT_INPUT_LIMIT");
    if (
      !Number.isSafeInteger(b.max_tokens) ||
      b.max_tokens < 1 ||
      b.max_tokens > 64 ||
      (b.stream !== undefined && typeof b.stream !== "boolean")
    )
      fail(400, "UNSUPPORTED_CHAT_OPTION");
    const model = models.get(b.model);
    const r = request({
      version: "1",
      providerId: model.mycelium.provider_id,
      profileId: model.mycelium.profile_id,
      nonce: digestOf({
        domain: "openai-single-user-v1",
        principalId: s.principalId,
        key,
      }).slice(7),
      prompt: message.content,
      maxOutputTokens: b.max_tokens,
      seed: 0,
      sampling: "greedy",
      publishConsent: false,
    });
    return { model, r, stream: b.stream === true };
  }
  async function intent(s, r, key) {
    const id = digestOf({
        domain: "openai-intent-v1",
        principalId: s.principalId,
        key,
      }),
      inputDigest = digestOf(r);
    const prior = store.get("openai-intents", id);
    if (prior?.inputDigest !== undefined && prior.inputDigest !== inputDigest)
      fail(409, "IDEMPOTENCY_CONFLICT");
    if (quoteLocks.has(id)) return quoteLocks.get(id);
    if (prior) {
      if (prior.quoteId) return { request: r, quoteId: prior.quoteId };
      fail(409, "QUOTE_ATTEMPT_UNCERTAIN");
    }
    if (store.list("openai-intents").length >= config.maxRecords)
      fail(429, "CHAT_INTENT_LIMIT");
    // No prompts/capabilities duplicated in this retention-independent tombstone.
    store.set("openai-intents", id, {
      inputDigest,
      principalId: s.principalId,
      state: "quoting",
    });
    const task = Promise.resolve().then(async () => {
      const q = await quote(s, r);
      store.set("openai-intents", id, {
        inputDigest,
        principalId: s.principalId,
        state: "quoted",
        quoteId: q.quoteId,
      });
      return { request: r, quoteId: q.quoteId };
    });
    quoteLocks.set(id, task);
    try {
      return await task;
    } finally {
      quoteLocks.delete(id);
    }
  }
  function completion(rec, model) {
    const job = rec.job;
    if (job.executionStatus !== "succeeded")
      fail(
        job.executionStatus === "cancelled" ? 409 : 503,
        job.executionStatus === "cancelled"
          ? "EXECUTION_CANCELLED"
          : "EXECUTION_FAILED",
      );
    if (!job.output || !verifyReceipt(rec)) fail(503, "RECEIPT_UNAVAILABLE");
    return {
      id: "chatcmpl-" + job.jobId,
      object: "chat.completion",
      created: Math.floor(Date.parse(job.createdAt) / 1000),
      model: model.id,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: job.output.text },
          finish_reason: job.output.finishReason,
        },
      ],
      mycelium: {
        job_id: job.jobId,
        profile_id: rec.profileId,
        receipt_path: `/v1/jobs/${job.jobId}/receipt`,
        evidence_path: `/v1/jobs/${job.jobId}/evidence`,
        completion_tokens: job.output.tokenIds.length,
        execution_mode: job.mode,
        output_provisional: false,
        execution_verified: false,
        financial_protection: false,
      },
    };
  }
  function json(res, status, value, headers = {}) {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    });
    res.end(JSON.stringify(value));
  }
  async function respond(req, res, id, model, stream, headers) {
    const raw = req.headers["last-event-id"];
    if (raw !== undefined && (!stream || !/^\d{1,15}$/.test(raw)))
      fail(400, "INVALID_CURSOR");
    let cursor = raw === undefined ? 0 : Number(raw);
    const initial = store.get("events", id);
    if (
      !initial ||
      (raw !== undefined &&
        (cursor > initial.next - 1 ||
          cursor < (initial.items[0]?.id ?? initial.next) - 1))
    )
      fail(409, "CURSOR_EXPIRED");
    if (res.destroyed) return;
    if (stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
        ...headers,
      });
      res.flushHeaders();
    }
    streams.add(res);
    await new Promise((resolve) => {
      let interval;
      const started = Date.now();
      let heartbeat = started;
      const close = () => {
        clearInterval(interval);
        streams.delete(res);
        resolve();
      };
      res.once("close", close);
      const write = (value, eventId) => {
        if (
          !res.write(
            `${eventId === undefined ? "" : `id: ${eventId}\n`}data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`,
          )
        )
          res.destroy();
      };
      const chunk = (rec, delta, finish_reason = null) => ({
        id: "chatcmpl-" + id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.parse(rec.job.createdAt) / 1000),
        model: model.id,
        choices: [{ index: 0, delta, finish_reason }],
      });
      const tick = () => {
        if (res.destroyed) {
          close();
          return;
        }
        try {
          if (!stream && Date.now() - started >= 14000)
            fail(504, "CHAT_WAIT_DEADLINE");
          if (stream && Date.now() - heartbeat >= 1000) {
            heartbeat = Date.now();
            if (!res.write(": heartbeat\n\n")) {
              res.destroy();
              return;
            }
          }
          const { rec } = scoped(req, id);
          if (stream) {
            const events = store.get("events", id);
            if (!events || (events.items[0]?.id ?? events.next) > cursor + 1)
              fail(409, "CURSOR_EXPIRED");
            for (const e of events.items)
              if (e.id > cursor) {
                cursor = e.id;
                if (e.type === "delta")
                  write(
                    chunk(rec, { role: "assistant", content: e.data.text }),
                    e.id,
                  );
                if (res.destroyed) return;
              }
          }
          if (
            !["succeeded", "failed", "cancelled"].includes(
              rec.job.executionStatus,
            )
          )
            return;
          const result = completion(rec, model);
          if (stream) {
            write(chunk(rec, {}, result.choices[0].finish_reason), cursor);
            write("[DONE]");
            res.end();
          } else json(res, 200, result, headers);
          close();
        } catch (e) {
          const status = e.status ?? 503,
            code = e.code ?? "UNAVAILABLE";
          if (stream) {
            write(openAIError(code, status));
            res.end();
          } else json(res, status, openAIError(code, status), headers);
          close();
        }
      };
      interval = setInterval(tick, 20);
      tick();
    });
  }
  return {
    async handle(req, res, path, s) {
      if (path === "/v1/models") {
        if (req.method !== "GET") fail(405, "METHOD_NOT_ALLOWED");
        return json(res, 200, { object: "list", data: [...models.values()] });
      }
      if (req.method !== "POST") fail(405, "METHOD_NOT_ALLOWED");
      const key = idempotency(req),
        b = await body(req),
        parsed = parse(b, s, key);
      const raw = req.headers["last-event-id"];
      if (raw !== undefined) {
        if (!parsed.stream || !/^\d{1,15}$/.test(raw))
          fail(400, "INVALID_CURSOR");
        const prior = store.get(
          "attempts",
          digestOf({ principalId: s.principalId, key }),
        );
        const events = prior?.jobId && store.get("events", prior.jobId);
        if (
          !events ||
          Number(raw) > events.next - 1 ||
          Number(raw) < (events.items[0]?.id ?? events.next) - 1
        )
          fail(409, "CURSOR_EXPIRED");
      }
      if (streams.size >= 64) fail(429, "STREAM_LIMIT");
      streams.add(res);
      res.once("close", () => streams.delete(res));
      // All retries use the same core body/quote/key. Never auto-requote after ambiguity.
      const coreBody = await intent(s, parsed.r, key);
      const accepted = await submit(s, coreBody, key, req);
      if (accepted.status !== 202) {
        return json(
          res,
          accepted.status,
          {
            ...openAIError(
              accepted.status === 402 ? "PAYMENT_REQUIRED" : "ACCESS_REQUIRED",
              accepted.status,
            ),
            mycelium: {
              quote_id: coreBody.quoteId,
              quote:
                accepted.status === 402
                  ? store.get("quotes", coreBody.quoteId)?.quote
                  : undefined,
              payment_required:
                accepted.status === 402 ? accepted.value : undefined,
            },
          },
          accepted.headers,
        );
      }
      const id = accepted.value.job.jobId;
      const headers = {
        ...accepted.headers,
        "x-mycelium-job-id": id,
        "x-request-id": id,
      };
      return respond(req, res, id, parsed.model, parsed.stream, headers);
    },
  };
}
