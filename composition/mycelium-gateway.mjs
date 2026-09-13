// Clean-room consumer of the ASGI wire contract at abe291c3. No Mycelium imports.
// Text-only v1/v2 events are transport observations, NOT ExecutionPort token evidence.
const fail = (code) => {
  throw new Error(code);
};
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const protocols = new Set([
  "mycelium.request_event.v1",
  "mycelium.request_event.v2",
]);
export const GATEWAY_PROPOSAL = "workbench.mycelium_gateway_candidate.v1";

export async function* parseGatewayEvents(
  chunks,
  { requestId, maxEventBytes = 65536, nativeProposal = false } = {},
) {
  if (!requestIdPattern.test(requestId || "")) fail("INVALID_REQUEST_ID");
  if (
    !Number.isSafeInteger(maxEventBytes) ||
    maxEventBytes < 128 ||
    maxEventBytes > 1048576
  )
    fail("INVALID_EVENT_LIMIT");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "",
    sequence = 0,
    generation = null,
    tokens = 0,
    terminal = false;
  const parse = (frame) => {
    if (terminal) fail("AFTER_TERMINAL");
    const fields = new Map();
    const data = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      if (colon < 0) fail("INVALID_SSE");
      const name = line.slice(0, colon),
        value = line.slice(colon + 1).replace(/^ /, "");
      if (name === "data") data.push(value);
      else if ((name === "id" || name === "event") && !fields.has(name))
        fields.set(name, value);
      else fail("INVALID_SSE");
    }
    if (!data.length && !fields.size) return null;
    let e;
    try {
      e = JSON.parse(data.join("\n"));
    } catch {
      fail("INVALID_EVENT_JSON");
    }
    if (
      !e ||
      typeof e !== "object" ||
      Array.isArray(e) ||
      (nativeProposal
        ? e.protocol !== GATEWAY_PROPOSAL
        : !protocols.has(e.protocol))
    )
      fail("UNSUPPORTED_EVENT_PROTOCOL");
    if (e.request_id !== requestId) fail("REQUEST_MISMATCH");
    if (!integer(e.sequence) || e.sequence !== sequence) fail("EVENT_ORDER");
    if (!integer(e.publisher_generation) || e.publisher_generation < 1)
      fail("INVALID_GENERATION");
    if (generation !== null && generation !== e.publisher_generation)
      fail("GENERATION_CHANGED");
    if (
      fields.get("id") !== `${e.publisher_generation}:${e.sequence}` ||
      fields.get("event") !== e.type
    )
      fail("SSE_BINDING_MISMATCH");
    const keys = [
      "protocol",
      "request_id",
      "sequence",
      "type",
      "publisher_generation",
    ];
    if (nativeProposal && ["accepted", "completed"].includes(e.type)) {
      keys.push(
        "profile_id",
        "request_hash",
        "generation_config_digest",
        "execution_kind",
      );
      if (
        ![e.profile_id, e.request_hash, e.generation_config_digest].every(
          (x) => typeof x === "string" && /^sha256:[a-f0-9]{64}$/.test(x),
        ) ||
        !["model", "conformance", "policy_response"].includes(e.execution_kind)
      )
        fail("INVALID_NATIVE_BINDING");
      if (e.type === "completed") {
        keys.push("finish_reason");
        if (!["stop", "length"].includes(e.finish_reason))
          fail("INVALID_FINISH_REASON");
      }
    }
    if (e.type === "token") {
      keys.push("token_index", "text");
      if (nativeProposal) {
        keys.push("token_id");
        if (!integer(e.token_id)) fail("MISSING_NATIVE_TOKEN_ID");
      } else if (
        e.protocol === "mycelium.request_event.v2" &&
        Object.hasOwn(e, "token_id")
      ) {
        // The native contract keeps token_id optional for compatibility, but
        // validates it strictly whenever a v2 producer supplies it.
        keys.push("token_id");
        if (!integer(e.token_id)) fail("MISSING_NATIVE_TOKEN_ID");
      }
      if (
        !integer(e.token_index) ||
        e.token_index !== tokens ||
        typeof e.text !== "string"
      )
        fail("TOKEN_ORDER");
      tokens++;
    } else if (e.type === "failed") {
      keys.push("code");
      if (typeof e.code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(e.code))
        fail("INVALID_FAILURE");
    } else if (e.type === "lifecycle") {
      keys.push("phase");
      if (
        e.protocol !== "mycelium.request_event.v2" ||
        ![
          "admission",
          "queue",
          "prefill",
          "first_token",
          "decode",
          "completion",
        ].includes(e.phase)
      )
        fail("INVALID_LIFECYCLE");
    } else if (!["accepted", "completed", "cancelled"].includes(e.type))
      fail("INVALID_EVENT_TYPE");
    if (Object.keys(e).sort().join(",") !== keys.sort().join(","))
      fail("INVALID_EVENT_FIELDS");
    if ((sequence === 0) !== (e.type === "accepted")) fail("ACCEPTED_ORDER");
    generation = e.publisher_generation;
    sequence++;
    terminal = ["completed", "cancelled", "failed"].includes(e.type);
    return e;
  };
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) fail("INVALID_STREAM_CHUNK");
    // Slice before decoding: even an unusually large network chunk cannot enlarge
    // the parser's retained incomplete frame beyond the configured bound.
    for (let start = 0; start < chunk.length; start += 4096) {
      pending += decoder.decode(chunk.subarray(start, start + 4096), {
        stream: true,
      });
      pending = pending.replace(/\r\n/g, "\n");
      let end;
      while ((end = pending.indexOf("\n\n")) !== -1) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (Buffer.byteLength(frame) > maxEventBytes) fail("EVENT_TOO_LARGE");
        if (frame) {
          const e = parse(frame);
          if (e) yield e;
        }
      }
      if (Buffer.byteLength(pending) > maxEventBytes) fail("EVENT_TOO_LARGE");
    }
  }
  pending += decoder.decode();
  if (pending.trim()) fail("TRUNCATED_EVENT");
  if (!terminal) fail("MISSING_TERMINAL");
}

export function createGatewayTransport({
  baseUrl,
  bearerToken,
  timeoutMs = 30000,
  fetchImpl = fetch,
  nativeProposal = false,
  eventParser = parseGatewayEvents,
  qualificationPath = "/v1/qualification/current",
  allowPendingCancel = false,
} = {}) {
  if (!["/v1/qualification/current", "/v3/qualification/current"].includes(qualificationPath) || typeof eventParser !== "function") fail("INVALID_GATEWAY_OPTIONS");
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    fail("INVALID_GATEWAY_URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    fail("INVALID_GATEWAY_URL");
  if (
    url.protocol === "http:" &&
    !["127.0.0.1", "[::1]"].includes(url.hostname)
  )
    fail("INSECURE_GATEWAY");
  if (
    typeof bearerToken !== "string" ||
    !/^[\x21-\x7e]{1,4096}$/.test(bearerToken)
  )
    fail("INVALID_GATEWAY_TOKEN");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
    fail("INVALID_TIMEOUT");
  const headers = (session) => ({
    Authorization: `Bearer ${bearerToken}`,
    "Cache-Control": "no-store",
    ...(session ? { "X-Mycelium-Session": session } : {}),
  });
  const request = async (method, path, { body, session, signal } = {}) => {
    const bounded = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, bounded]) : bounded;
    let response;
    try {
      response = await fetchImpl(new URL(path, url), {
        method,
        redirect: "manual",
        signal: combined,
        headers: {
          ...headers(session),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      fail(method === "POST" ? "SUBMISSION_UNKNOWN" : "GATEWAY_UNAVAILABLE");
    }
    if (!response.ok) {
      await response.body?.cancel();
      fail(`GATEWAY_HTTP_${response.status}`);
    }
    return response;
  };
  const json = async (response) => {
    if (!response.headers.get("content-type")?.startsWith("application/json")) {
      await response.body?.cancel();
      fail("INVALID_CONTENT_TYPE");
    }
    const parts = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 65536) {
        fail("RESPONSE_TOO_LARGE");
      }
      parts.push(chunk);
    }
    let d;
    try {
      d = JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch {
      fail("INVALID_GATEWAY_JSON");
    }
    if (!d || typeof d !== "object" || Array.isArray(d))
      fail("INVALID_GATEWAY_JSON");
    return d;
  };
  return Object.freeze({
    async qualification({ signal } = {}) {
      return json(
        await request("GET", qualificationPath, { signal }),
      );
    },
    async submit(body, { signal } = {}) {
      // The caller supplies a strictly validated versioned submission. No automatic
      // retry: the current gateway provides no client-chosen idempotency key.
      const response = await request("POST", "/v1/inference", { body, signal });
      if (response.status !== 202) {
        await response.body?.cancel();
        fail("SUBMISSION_UNKNOWN");
      }
      let d;
      try {
        d = await json(response);
      } catch {
        fail("SUBMISSION_UNKNOWN");
      }
      if (
        !requestIdPattern.test(d.request_id || "") ||
        d.stream_path !== `/v1/inference/${d.request_id}/events` ||
        d.cancel_path !== `/v1/inference/${d.request_id}` ||
        typeof d.session_token !== "string" ||
        !/^[\x21-\x7e]{32,256}$/.test(d.session_token)
      )
        fail("SUBMISSION_UNKNOWN");
      const id = d.request_id,
        secret = d.session_token;
      return Object.freeze({
        requestId: id,
        async cancel({ signal } = {}) {
          const response = await request("DELETE", `/v1/inference/${id}`, {
            session: secret,
            signal,
          });
          const result = await json(response);
          if (
            result.request_id !== id ||
            !(allowPendingCancel ? ["pending", "cancelling", "terminal"] : ["cancelling", "terminal"]).includes(result.status)
          )
            fail("INVALID_CANCEL_RESPONSE");
          // 'cancelling' is only an acknowledgement; it is NOT proven cleanup.
          return result.status;
        },
        async *events({ signal } = {}) {
          const response = await request("GET", `/v1/inference/${id}/events`, {
            session: secret,
            signal,
          });
          if (
            !response.headers
              .get("content-type")
              ?.startsWith("text/event-stream")
          ) {
            await response.body?.cancel();
            fail("INVALID_CONTENT_TYPE");
          }
          yield* eventParser(response.body, {
            requestId: id,
            nativeProposal,
          });
        },
      });
    },
  });
}
