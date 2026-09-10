import { randomBytes, randomUUID, createPublicKey, verify } from "node:crypto";
import { canonicalBytes, digestOf, validate } from "../../contracts/index.mjs";
const DOMAIN = Buffer.from("mycelium:attempt-recovery:v1\n");

/** Recovery is observation/revocation only. This module cannot call payments or an executor. */
export function createRecoveryRoutes({
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
}) {
  const checkAttempt = (b) => {
    exact(b, ["request", "quoteId", "idempotencyKey"]);
    if (
      !validate("Request", b.request) ||
      typeof b.quoteId !== "string" ||
      !b.quoteId ||
      b.quoteId.length > 256 ||
      typeof b.idempotencyKey !== "string" ||
      !b.idempotencyKey ||
      b.idempotencyKey.length > 256 ||
      !/^[\x21-\x7e]+$/.test(b.idempotencyKey)
    )
      fail(400, "INVALID_RECOVERY_BINDING");
    return {
      bodyHash: digestOf({ request: b.request, quoteId: b.quoteId }),
      key: b.idempotencyKey,
    };
  };
  const authority = (id) => {
    const r = store.get("recoveries", id),
      s = r && store.get("sessions", r.sessionHash);
    if (
      !r ||
      r.revoked ||
      r.expiresAt <= Date.now() ||
      !s ||
      s.revoked ||
      s.expiresAt <= Date.now()
    )
      fail(401, "RECOVERY_UNAVAILABLE");
    return { r, s: { ...s, sessionHash: r.sessionHash } };
  };
  const reconcile = (s, attemptId, bodyHash, recoveryId) => {
    const a = store.get("attempts", attemptId);
    if (!a) return { version: "2", status: "unresolved" };
    if (a.principalId !== s.principalId || a.bodyHash !== bodyHash)
      fail(409, "RECOVERY_BINDING_CONFLICT");
    if (!a.jobId) return { version: "2", status: "unresolved" };
    const rec = store.get("jobs", a.jobId);
    if (!rec) fail(410, "RESULT_RETIRED");
    if (rec.principalId !== s.principalId)
      fail(409, "RECOVERY_BINDING_CONFLICT");
    if (rec.job.executionStatus === "succeeded" && !rec.job.output)
      fail(410, "RESULT_UNAVAILABLE");
    return {
      version: "2",
      status: "accepted",
      job: rec.job,
      capability: childCapability(s, a.jobId, recoveryId),
    };
  };
  const prune = () => {
    for (const ns of ["recoveries", "recovery-challenges"])
      for (const r of store.list(ns))
        if (r.expiresAt <= Date.now()) store.delete(ns, r.id);
  };
  return {
    prune,
    async handle(req, res, path) {
      if (
        req.method !== "POST" ||
        ![
          "/v2/attempts/reconcile",
          "/v2/recoveries",
          "/v2/recoveries/challenge",
          "/v2/recoveries/prove",
        ].includes(path)
      )
        return false;
      const b = await body(req);
      if (path === "/v2/attempts/reconcile") {
        const s = session(req);
        rate(s.principalId, c.requestRate);
        const a = checkAttempt(b);
        send(
          res,
          200,
          reconcile(
            s,
            digestOf({ principalId: s.principalId, key: a.key }),
            a.bodyHash,
          ),
        );
        return true;
      }
      if (path === "/v2/recoveries") {
        const s = session(req);
        rate(s.principalId, c.requestRate);
        exact(b, ["attempt", "publicKeyJwk"]);
        const a = checkAttempt(b.attempt);
        exact(b.publicKeyJwk, ["kty", "crv", "x"]);
        if (
          b.publicKeyJwk.kty !== "OKP" ||
          b.publicKeyJwk.crv !== "Ed25519" ||
          !/^[A-Za-z0-9_-]{43}$/.test(b.publicKeyJwk.x)
        )
          fail(400, "INVALID_RECOVERY_KEY");
        try {
          createPublicKey({ key: b.publicKeyJwk, format: "jwk" });
        } catch {
          fail(400, "INVALID_RECOVERY_KEY");
        }
        quoteFor(b.attempt.quoteId, s, b.attempt.request);
        prune();
        if (
          store.list("recoveries").length >= c.maxRecords ||
          store
            .list("recoveries")
            .filter((r) => r.principalId === s.principalId).length >= 32
        )
          fail(429, "RECOVERY_LIMIT");
        const recoveryId = randomUUID(),
          expiresAt = Math.min(s.expiresAt, Date.now() + c.retentionMs);
        store.set("recoveries", recoveryId, {
          principalId: s.principalId,
          sessionHash: s.sessionHash,
          attemptId: digestOf({ principalId: s.principalId, key: a.key }),
          bodyHash: a.bodyHash,
          publicKeyJwk: b.publicKeyJwk,
          expiresAt,
          revoked: false,
        });
        send(res, 201, {
          version: "1",
          recoveryId,
          expiresAt: new Date(expiresAt).toISOString(),
          bindingDigest: a.bodyHash,
        });
        return true;
      }
      rate("recovery-proof", c.requestRate);
      prune();
      if (path === "/v2/recoveries/challenge") {
        exact(b, ["recoveryId", "action"]);
        if (!["reconcile", "revoke"].includes(b.action))
          fail(400, "INVALID_RECOVERY_ACTION");
        const { r } = authority(b.recoveryId);
        if (
          store.list("recovery-challenges").length >= c.maxRecords ||
          store
            .list("recovery-challenges")
            .filter((x) => x.recoveryId === b.recoveryId).length >= 8
        )
          fail(429, "RECOVERY_LIMIT");
        const challenge = {
          version: "1",
          recoveryId: b.recoveryId,
          challengeId: randomUUID(),
          nonce: randomBytes(32).toString("base64url"),
          action: b.action,
          bindingDigest: r.bodyHash,
          expiresAt: new Date(
            Math.min(r.expiresAt, Date.now() + 30000),
          ).toISOString(),
        };
        store.set("recovery-challenges", challenge.challengeId, {
          recoveryId: b.recoveryId,
          payload: challenge,
          expiresAt: Date.parse(challenge.expiresAt),
          used: false,
        });
        send(res, 201, challenge);
        return true;
      }
      exact(b, ["challenge", "signature"]);
      const ch = b.challenge;
      if (
        !ch ||
        typeof ch.challengeId !== "string" ||
        typeof b.signature !== "string" ||
        !/^[A-Za-z0-9_-]{86}$/.test(b.signature)
      )
        fail(400, "INVALID_RECOVERY_PROOF");
      const saved = store.get("recovery-challenges", ch.challengeId);
      if (
        !saved ||
        saved.used ||
        saved.expiresAt <= Date.now() ||
        digestOf(saved.payload) !== digestOf(ch)
      )
        fail(409, "INVALID_RECOVERY_PROOF");
      const { r, s } = authority(ch.recoveryId);
      store.set("recovery-challenges", ch.challengeId, {
        ...saved,
        used: true,
      });
      let valid = false;
      try {
        valid = verify(
          null,
          Buffer.concat([DOMAIN, canonicalBytes(ch)]),
          createPublicKey({ key: r.publicKeyJwk, format: "jwk" }),
          Buffer.from(b.signature, "base64url"),
        );
      } catch {}
      if (!valid) fail(403, "INVALID_RECOVERY_PROOF");
      if (ch.action === "revoke") {
        store.set("recoveries", ch.recoveryId, { ...r, revoked: true });
        send(res, 200, { version: "2", status: "revoked" });
      } else
        send(res, 200, reconcile(s, r.attemptId, r.bodyHash, ch.recoveryId));
      return true;
    },
  };
}
