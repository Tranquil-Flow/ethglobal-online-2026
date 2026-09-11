import { createHash } from "node:crypto";
import { digestOf, validate } from "../packages/contracts/index.mjs";
const ns = "assessor-artifacts-v1";
const fail = (c) => {
  const e = Error(c);
  e.code = c;
  throw e;
};
const digest = (bytes) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");
const exact = (x, keys) =>
  x &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  Object.keys(x).sort().join() === keys.sort().join();
export function createAssessorArtifactHelper({
  store,
  providerId,
  profileIds,
  loadEvidence,
  bounds,
  clock = Date.now,
}) {
  if (
    !store ||
    !["get", "set", "list", "delete"].every(
      (k) => typeof store[k] === "function",
    ) ||
    typeof loadEvidence !== "function"
  )
    fail("INVALID_ASSESSOR_ARTIFACT_CONTEXT");
  for (const k of [
    "maxEvidenceBytes",
    "maxArtifactBytes",
    "maxArtifactsPerJob",
    "maxArtifactBytesPerJob",
    "maxTotalArtifacts",
    "maxTotalArtifactBytes",
    "retentionMs",
  ])
    if (!Number.isSafeInteger(bounds?.[k]) || bounds[k] < 1)
      fail("INVALID_ASSESSOR_ARTIFACT_BOUNDS");
  const now = () => {
    const n = clock();
    if (!Number.isSafeInteger(n)) fail("INVALID_ASSESSOR_CLOCK");
    return n;
  };
  const remove = (job) => {
    let n = 0;
    for (const x of store.list(ns))
      if (x.providerId === providerId && x.jobId === job) {
        store.delete(ns, x.id);
        n++;
      }
    return n;
  };
  function purgeExpired() {
    let n = 0;
    const time = now();
    for (const x of store.list(ns))
      if (
        x.providerId === providerId &&
        (!Number.isSafeInteger(x.expiresAt) || x.expiresAt <= time)
      ) {
        store.delete(ns, x.id);
        n++;
      }
    return n;
  }
  async function scope({ receipt, profile, evidenceRef, signal }) {
    const jobId = receipt?.payload?.jobId,
      profileId = digestOf(profile);
    if (
      typeof jobId !== "string" ||
      receipt.payload.providerId !== providerId ||
      !profileIds.includes(profileId) ||
      receipt.payload.profileId !== profileId ||
      evidenceRef !== "core-local:" + jobId
    )
      fail("ASSESSOR_BINDING_MISMATCH");
    async function evidence() {
      if (signal?.aborted) fail("ASSESSOR_CANCELLED");
      let value;
      try {
        value = await loadEvidence(evidenceRef, { signal });
      } catch {
        remove(jobId);
        fail("EVIDENCE_UNAVAILABLE");
      }
      if (signal?.aborted) fail("ASSESSOR_CANCELLED");
      try {
        validate("SignedReceipt", receipt);
        validate("Request", value.request);
        validate("Profile", value.profile);
        validate("Output", value.output);
        if (
          digestOf(value.receipt) !== digestOf(receipt) ||
          value.request.providerId !== providerId ||
          value.request.profileId !== profileId ||
          digestOf(value.profile) !== profileId ||
          digestOf(value.request) !== receipt.payload.requestHash ||
          digestOf(value.output) !== receipt.payload.outputHash
        )
          fail("ASSESSOR_BINDING_MISMATCH");
      } catch {
        fail("ASSESSOR_BINDING_MISMATCH");
      }
      if (Buffer.byteLength(JSON.stringify(value)) > bounds.maxEvidenceBytes)
        fail("ASSESSOR_EVIDENCE_LIMIT");
      return value;
    }
    await evidence();
    purgeExpired();
    const handle = (row) =>
      Object.freeze({
        version: "1",
        id: row.id,
        providerId,
        jobId,
        profileId,
        kind: row.kind,
        digest: row.digest,
      });
    return Object.freeze({
      evidence,
      async put({ kind, digest: expected, bytes, expiresAt }) {
        await evidence();
        purgeExpired();
        if (
          typeof kind !== "string" ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(kind) ||
          !(bytes instanceof Uint8Array)
        )
          fail("ASSESSOR_ARTIFACT_INVALID");
        const value = Buffer.from(bytes),
          until = Date.parse(expiresAt),
          time = now();
        if (
          value.length > bounds.maxArtifactBytes ||
          value.length < 1 ||
          !Number.isSafeInteger(until) ||
          until <= time ||
          until > time + bounds.retentionMs
        )
          fail("ASSESSOR_ARTIFACT_LIMIT");
        if (expected !== digest(value))
          fail("ASSESSOR_ARTIFACT_DIGEST_MISMATCH");
        const id = digestOf([providerId, jobId, profileId, kind, expected]);
        const write = () => {
          const old = store.get(ns, id);
          if (old) return handle({ ...old, id });
          const rows = store
              .list(ns)
              .filter((x) => x.providerId === providerId),
            job = rows.filter((x) => x.jobId === jobId);
          if (
            rows.length >= bounds.maxTotalArtifacts ||
            job.length >= bounds.maxArtifactsPerJob ||
            rows.reduce((n, x) => n + x.size, 0) + value.length >
              bounds.maxTotalArtifactBytes ||
            job.reduce((n, x) => n + x.size, 0) + value.length >
              bounds.maxArtifactBytesPerJob
          )
            fail("ASSESSOR_ARTIFACT_LIMIT");
          const row = {
            id,
            providerId,
            jobId,
            profileId,
            kind,
            digest: expected,
            size: value.length,
            expiresAt: until,
            data: value.toString("base64"),
          };
          store.set(ns, id, row);
          return handle(row);
        };
        return typeof store.transaction === "function"
          ? store.transaction(write)
          : write();
      },
      async get(h) {
        await evidence();
        purgeExpired();
        if (
          !exact(h, [
            "version",
            "id",
            "providerId",
            "jobId",
            "profileId",
            "kind",
            "digest",
          ]) ||
          h.version !== "1" ||
          h.providerId !== providerId ||
          h.jobId !== jobId ||
          h.profileId !== profileId
        )
          fail("ASSESSOR_BINDING_MISMATCH");
        const row = store.get(ns, h.id);
        if (
          !row ||
          digestOf(handle(row)) !== digestOf(h) ||
          row.expiresAt <= now()
        )
          fail("ASSESSOR_ARTIFACT_UNAVAILABLE");
        if (
          typeof row.data !== "string" ||
          row.data.length > Math.ceil(bounds.maxArtifactBytes / 3) * 4 ||
          !Number.isSafeInteger(row.size) ||
          row.size < 1 ||
          row.size > bounds.maxArtifactBytes
        )
          fail("ASSESSOR_ARTIFACT_UNAVAILABLE");
        const bytes = Buffer.from(row.data, "base64");
        if (
          bytes.toString("base64") !== row.data ||
          bytes.length !== row.size ||
          digest(bytes) !== row.digest
        )
          fail("ASSESSOR_ARTIFACT_UNAVAILABLE");
        return bytes;
      },
    });
  }
  return Object.freeze({
    scope,
    purgeExpired,
    async deleteEvidence({ providerId: id, jobId, evidenceRef }) {
      if (
        id !== providerId ||
        typeof jobId !== "string" ||
        evidenceRef !== "core-local:" + jobId
      )
        fail("ASSESSOR_BINDING_MISMATCH");
      return remove(jobId);
    },
  });
}
