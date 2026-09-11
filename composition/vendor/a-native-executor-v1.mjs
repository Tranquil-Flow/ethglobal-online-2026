// A-owned unchecked native ExecutorPort, NOT a Mycelium v3 gateway.
import net from "node:net";
import { readFileSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
const canonical = (x) => JSON.stringify(sort(x));
function sort(x) {
  if (Array.isArray(x)) return x.map(sort);
  if (x && typeof x === "object")
    return Object.fromEntries(
      Object.keys(x)
        .sort()
        .map((k) => [k, sort(x[k])]),
    );
  return x;
}
export const digest = (x) =>
  "sha256:" + createHash("sha256").update(canonical(x)).digest("hex");
function secret(path) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.mode & 0o077)
    throw Error("PRIVATE_CREDENTIAL_REQUIRED");
  return readFileSync(path, "utf8").trim();
}
export function createNativeClient({ socketPath, credentialFile }) {
  async function* exchange(message) {
    const socket = net.createConnection(socketPath);
    socket.setTimeout(70000, () =>
      socket.destroy(Error("NATIVE_CHANNEL_TIMEOUT")),
    );
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    let failure;
    socket.on("error", (e) => {
      failure = e;
      lines.close();
    });
    socket.once("connect", () => {
      try {
        socket.write(
          JSON.stringify({ ...message, credential: secret(credentialFile) }) +
            "\n",
        );
      } catch (e) {
        socket.destroy(e);
      }
    });
    try {
      for await (const line of lines) {
        if (Buffer.byteLength(line) > 1048576)
          throw Error("NATIVE_EVENT_LIMIT");
        const e = JSON.parse(line);
        if (e.type === "error") throw Error(e.code);
        yield e;
      }
      if (failure) throw failure;
    } finally {
      lines.close();
      socket.destroy();
    }
  }
  async function command(m) {
    for await (const e of exchange(m)) return e;
    throw Error("MISSING_NATIVE_REPLY");
  }
  return {
    events: (request, afterSequence = -1) =>
      exchange({ op: "generate", request, after_sequence: afterSequence }),
    resume: (id, afterSequence = -1) =>
      exchange({ op: "resume", request_id: id, after_sequence: afterSequence }),
    status: () => command({ op: "status" }),
    cancel: (id) => command({ op: "cancel", request_id: id }),
    close: () => command({ op: "close" }),
  };
}
export function loadNativeBinding(path) {
  const b = JSON.parse(readFileSync(path, "utf8"));
  if (
    b.schema !== "mycelium.A.unchecked-native-binding.v1" ||
    b.protocol !== "mycelium.native_executor.v1" ||
    b.transport !== "unix-domain-jsonl" ||
    b.checking !== "unavailable"
  )
    throw Error("NATIVE_BINDING_SCHEMA");
  if (
    digest(b.profile) !== b.profileId ||
    digest(b.computationProfile) !== b.computationProfileId
  )
    throw Error("NATIVE_PROFILE_PIN");
  for (const f of b.sourceFiles) {
    if (
      createHash("sha256").update(readFileSync(f.path)).digest("hex") !==
      f.sha256
    )
      throw Error("NATIVE_SOURCE_CHANGED");
  }
  return b;
}
export function createRetainedNExecutor({
  bindingFile,
  credentialFile,
  onRecord,
}) {
  const b = loadNativeBinding(bindingFile);
  const client = createNativeClient({
    socketPath: b.socketPath,
    credentialFile,
  });
  const validateRequest = (request) => {
    if (
      request.profileId !== b.profileId ||
      request.seed !== 0 ||
      request.sampling !== "greedy" ||
      !Number.isSafeInteger(request.maxOutputTokens) ||
      request.maxOutputTokens < 1 ||
      request.maxOutputTokens > 64 ||
      typeof request.prompt !== "string" ||
      !request.prompt.isWellFormed() ||
      request.prompt.length > 256 ||
      Buffer.byteLength(request.prompt) > 1024
    )
      throw Error("NATIVE_REQUEST_BOUNDS");
  };
  return {
    kind: "native-stdio",
    mode: "live",
    checking: "unavailable",
    profile: b.profile,
    profiles: [b.profile],
    bindingDigest: digest(b),
    client,
    validateRequest,
    async *execute({ jobId, request, profile, signal }) {
      validateRequest(request);
      if (digest(profile) !== b.profileId)
        throw Error("NATIVE_PROFILE_MISMATCH");
      if (signal?.aborted) throw Error("EXECUTION_CANCELLED");
      const ready = await client.status();
      if (ready.status !== "ready" || Date.now() / 1000 >= ready.expires_unix)
        throw Error("NATIVE_NOT_READY");
      const original = {
        job_id: jobId,
        profile_digest: b.computationProfileId,
        messages: [{ role: "user", content: request.prompt }],
        max_tokens: request.maxOutputTokens,
        seed: 0,
        original_context: request,
      };
      let accepted = false,
        seq = 0,
        terminal = false,
        text = "",
        selected = [],
        visible = [],
        cancelError,
        completion;
      const abort = () => {
        client.cancel(jobId).catch((e) => {
          cancelError = e;
        });
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        for await (const e of client.events(original)) {
          if (
            e.protocol !== b.protocol ||
            e.request_id !== jobId ||
            e.sequence !== seq++
          )
            throw Error("NATIVE_EVENT_BINDING");
          if (e.type === "accepted") {
            if (
              accepted ||
              e.request_digest !== digest(original) ||
              e.profile_digest !== b.computationProfileId
            )
              throw Error("NATIVE_ACCEPTANCE");
            accepted = true;
            if (signal?.aborted) abort();
            continue;
          }
          if (!accepted || terminal) throw Error("NATIVE_EVENT_ORDER");
          if (e.type === "token") {
            if (
              e.token_index !== selected.length ||
              !Number.isSafeInteger(e.token_id) ||
              selected.length >= request.maxOutputTokens
            )
              throw Error("NATIVE_TOKEN_ORDER");
            selected.push(e.token_id);
            text += e.text;
            const ids = b.stopTokenIds.includes(e.token_id) ? [] : [e.token_id];
            visible.push(...ids);
            yield { type: "delta", text: e.text, tokenIds: ids };
          } else if (e.type === "completed") {
            const r = e.record;
            const unsigned = { ...r };
            delete unsigned.record_digest;
            if (
              digest(unsigned) !== r.record_digest ||
              digest(r.request) !== digest(original) ||
              r.profile_digest !== b.computationProfileId ||
              canonical(r.selected_token_ids) !== canonical(selected) ||
              canonical(r.token_ids) !== canonical(visible) ||
              text + e.final_text !== r.text ||
              e.cleanup !== "confirmed"
            )
              throw Error("NATIVE_COMPLETE_BINDING");
            const stop = b.stopTokenIds.includes(selected.at(-1));
            if (
              selected.slice(0, -1).some((x) => b.stopTokenIds.includes(x)) ||
              (r.finish_reason === "stop"
                ? !stop
                : r.finish_reason !== "length" ||
                  stop ||
                  selected.length !== request.maxOutputTokens)
            )
              throw Error("NATIVE_STOP_BINDING");
            if (e.final_text)
              yield { type: "delta", text: e.final_text, tokenIds: [] };
            terminal = true;
            if (onRecord) await onRecord(structuredClone(r));
            completion = {
              type: "completed",
              profileId: b.profileId,
              output: {
                text: r.text,
                tokenIds: r.token_ids,
                finishReason: r.finish_reason,
              },
              evidenceDigest: r.record_digest,
            };
          } else if (e.type === "cancelled") {
            if (e.cleanup !== "confirmed")
              throw Error("NATIVE_CLEANUP_UNPROVEN");
            terminal = true;
            throw Error("EXECUTION_CANCELLED");
          } else throw Error("NATIVE_EXECUTION_FAILED");
        }
        if (!terminal) throw Error("MISSING_NATIVE_TERMINAL");
        yield completion;
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}
