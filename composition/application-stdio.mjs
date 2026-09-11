import { createHash } from "node:crypto";
import { readPrivateFile } from "../operations/src/private-files.mjs";
import { validate } from "../packages/contracts/index.mjs";
import {
  digest,
  loadNativeBinding,
  createRetainedNExecutor,
} from "./vendor/a-native-executor-v1.mjs";
const fail = (code) => {
  throw Error(code);
};
export function inspectStdioRuntime({ spec, mode, providerId, resolvePath }) {
  const keys = [
    "kind",
    "bindingFile",
    "bindingSha256",
    "credentialFile",
    "accessFile",
  ];
  if (
    !spec ||
    Object.keys(spec).sort().join() !== keys.sort().join() ||
    spec.kind !== "native-stdio" ||
    mode !== "live" ||
    !/^[a-f0-9]{64}$/.test(spec.bindingSha256)
  )
    fail("INVALID_STDIO_BINDING");
  const bindingFile = resolvePath(spec.bindingFile),
    credentialFile = resolvePath(spec.credentialFile),
    accessFile = resolvePath(spec.accessFile);
  const { data } = readPrivateFile(bindingFile, {
    maxBytes: 262144,
    code: "PRIVATE_NATIVE_BINDING_REQUIRED",
  });
  if (createHash("sha256").update(data).digest("hex") !== spec.bindingSha256)
    fail("NATIVE_BINDING_CHANGED");
  let b;
  try {
    b = JSON.parse(data.toString("utf8"));
  } finally {
    data.fill(0);
  }
  if (
    b.mode !== "live" ||
    b.verification_claim !== false ||
    b.physical_independence !== false ||
    !Number.isFinite(b.expiresAtUnix) ||
    !Array.isArray(b.sourceFiles) ||
    b.sourceFiles.length < 1 ||
    b.sourceFiles.length > 64
  )
    fail("INVALID_STDIO_BINDING");
  const admitted = loadNativeBinding(bindingFile);
  if (digest(admitted) !== digest(b)) fail("NATIVE_BINDING_CHANGED");
  validate("Profile", b.profile);
  const bindingDigest = digest(b);
  function authorize() {
    const { data } = readPrivateFile(accessFile, {
      maxBytes: 8192,
      code: "PRIVATE_NATIVE_ACCESS_REQUIRED",
    });
    let grant;
    try {
      grant = JSON.parse(data.toString("utf8"));
    } finally {
      data.fill(0);
    }
    if (
      !grant ||
      Object.keys(grant).sort().join() !==
        ["schema", "providerId", "bindingDigest", "expiresAt"].sort().join() ||
      grant.schema !== "mycelium.application-native-access/v1" ||
      grant.providerId !== providerId ||
      grant.bindingDigest !== bindingDigest ||
      !Number.isFinite(Date.parse(grant.expiresAt)) ||
      Date.parse(grant.expiresAt) <= Date.now() ||
      Date.parse(grant.expiresAt) !== Math.floor(b.expiresAtUnix * 1000)
    )
      fail("NATIVE_ACCESS_INVALID");
  }
  return {
    kind: "native-stdio",
    mode: "live",
    profiles: [b.profile],
    bindingDigest,
    authorize,
    async create({ store } = {}) {
      authorize();
      const { data } = readPrivateFile(credentialFile, {
        maxBytes: 4096,
        code: "PRIVATE_NATIVE_CREDENTIAL_REQUIRED",
      });
      try {
        if (!/^[\x21-\x7e]{32,4096}\n?$/.test(data.toString("utf8")))
          fail("INVALID_NATIVE_CREDENTIAL");
      } finally {
        data.fill(0);
      }
      if (typeof store?.set !== "function" || typeof store?.list !== "function")
        fail("NATIVE_PRIVATE_STORE_REQUIRED");
      const executor = createRetainedNExecutor({
        bindingFile,
        credentialFile,
        onRecord(record) {
          const size = Buffer.byteLength(JSON.stringify(record));
          const rows = store
            .list("native-evidence-v1")
            .filter((x) => x.jobId !== record.request.job_id);
          if (
            size > 1048576 ||
            rows.reduce((n, x) => n + (x.size ?? 0), 0) + size > 67108864
          )
            fail("NATIVE_EVIDENCE_LIMIT");
          store.set("native-evidence-v1", record.request.job_id, {
            jobId: record.request.job_id,
            providerId,
            profileId: b.profileId,
            record,
            size,
            evidenceDigest: record.record_digest,
          });
        },
      });
      let ready;
      try {
        ready = await executor.client.status();
      } catch {
        fail("NATIVE_UNAVAILABLE");
      }
      if (
        ready.status !== "ready" ||
        ready.protocol !== b.protocol ||
        ready.expires_unix !== b.expiresAtUnix ||
        Date.now() / 1000 >= ready.expires_unix
      )
        fail("NATIVE_NOT_READY");
      // Each exchange owns its socket. Application close must never call
      // client.close(): that shuts down the separately owned native model.
      return { executor };
    },
  };
}
