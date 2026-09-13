// Operator tool: mutate a managed app's provider runtime options and provider
// limits, keeping every identity surface that binds `digestOf(provider.runtime)`
// in agreement.
//
// Why this exists
//   `composition/mycelium-livhttp.mjs` rejects a native qualification whose age
//   exceeds `runtime.options.maxQualificationAgeMs`, and `runtime.options` (which
//   includes `timeoutMs`) is part of the provider runtime spec. `digestOf(runtime)`
//   is compared in three places:
//
//     composition/application-workbench.mjs:259   runtime.bindingDigest !== p.runtimeDigest
//     composition/application-workbench.mjs:~440  persisted core.sqlite `application`/`identity`
//     composition/application-operator.mjs:111    (only when (re)initializing)
//
//   Editing operator.json alone leaves application.json and core.sqlite on the old
//   digest, and the next launch fails closed with RUNTIME_BINDING_MISMATCH /
//   DATASET_RUNTIME_MISMATCH (observed 2026-09-13 as an INVALID_APPLICATION_CONFIG
//   crash loop).
//
//   `application.json.providers[].limits` is NOT part of that digest — it is
//   metadata the core and viewer use to clamp requests — so changing limits needs
//   no identity migration and is applied in place.
//
// Safety
//   Refuses to run unless the three digest surfaces already agree, so it can never
//   paper over unrelated drift. Backs up every touched file (mode-preserving) and
//   replaces them atomically via a sibling temp file + rename.
//
// Usage
//   node scripts/w6-set-provider-runtime-options.mjs --app-root <dir> \
//        [--set-options timeoutMs=600000,maxQualificationAgeMs=259200000] \
//        [--age-ms 259200000] [--max-output-tokens 128] [--dry-run] [--print]
//
// Allowed runtime options (mirrors the allowlist in
// composition/application-mycelium-http.mjs):
//   timeoutMs, maxQualificationAgeMs, maxOutputBytes, expectedEvidenceClass
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digestOf } from "../packages/contracts/index.mjs";
import { createStore } from "../packages/core/src/index.mjs";

const RUNTIME_OPTION_KEYS = Object.freeze([
  "timeoutMs",
  "maxQualificationAgeMs",
  "maxOutputBytes",
  "expectedEvidenceClass",
]);

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

const appRoot = arg("app-root");
const dryRun = flag("dry-run");
const printOnly = flag("print");

function fail(code) {
  console.error(
    JSON.stringify({ status: "w6-set-provider-runtime-options", ok: false, error: code }),
  );
  process.exit(1);
}
if (!appRoot || !existsSync(appRoot)) fail("APP_ROOT_REQUIRED");

// Build the option patch: --age-ms is sugar for maxQualificationAgeMs.
const patch = {};
const rawOptions = arg("set-options");
if (rawOptions !== undefined) {
  for (const pair of String(rawOptions).split(",")) {
    const [key, value] = pair.split("=");
    if (!key || value === undefined) fail(`BAD_SET_OPTIONS:${pair}`);
    if (!RUNTIME_OPTION_KEYS.includes(key)) fail(`UNSUPPORTED_RUNTIME_OPTION:${key}`);
    if (key === "expectedEvidenceClass") {
      if (!["physical_qualification", "synthetic_test_fixture"].includes(value))
        fail("BAD_EVIDENCE_CLASS");
      patch[key] = value;
    } else {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 1) fail(`BAD_OPTION_VALUE:${pair}`);
      patch[key] = n;
    }
  }
}
const ageMs = arg("age-ms");
if (ageMs !== undefined) {
  const n = Number(ageMs);
  if (!Number.isSafeInteger(n) || n < 1 || n > 259200000) fail("AGE_MS_MUST_BE_1_TO_259200000");
  patch.maxQualificationAgeMs = n;
}
const maxOutputTokens = arg("max-output-tokens");
if (maxOutputTokens !== undefined) {
  const n = Number(maxOutputTokens);
  if (!Number.isSafeInteger(n) || n < 1 || n > 4096) fail("MAX_OUTPUT_TOKENS_MUST_BE_1_TO_4096");
  patch.limits = { maxOutputTokens: n };
}
const rawRuntime = arg("set-runtime");
const runtimePatch = {};
if (rawRuntime !== undefined) {
  for (const pair of String(rawRuntime).split(",")) {
    const [key, value] = pair.split("=");
    if (!key || value === undefined) fail(`BAD_SET_RUNTIME:${pair}`);
    if (!["baseUrl"].includes(key)) fail(`UNSUPPORTED_RUNTIME_FIELD:${key}`);
    if (!/^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/.test(value)) fail("BAD_BASE_URL");
    runtimePatch[key] = value;
  }
}
// --rebind skips the pre-state agreement check below. It exists for the W6
// fixture-gate round trip: with W6_NATIVE_FALLBACK_FIXTURE=1 the supervisor
// rewrites operator.json's runtime (baseUrl + expectedEvidenceClass) AND
// refreshes all three digest surfaces; flipping the gate back to 0 then leaves
// the persisted surfaces describing the fixture runtime while the operator
// manifest is edited back to the physical one. The guard below is exactly what
// would (correctly) refuse that edit.
const rebind = flag("rebind");
if (!Object.keys(patch).length && !Object.keys(runtimePatch).length) fail("NOTHING_TO_DO");

const operatorFile = join(appRoot, "operator.json");
const configFile = join(appRoot, "application.json");
for (const path of [operatorFile, configFile]) if (!existsSync(path)) fail(`MISSING:${path}`);

const operator = JSON.parse(readFileSync(operatorFile, "utf8"));
const config = JSON.parse(readFileSync(configFile, "utf8"));
if (!Array.isArray(operator.providers) || !Array.isArray(config.providers)) fail("INVALID_STATE");

const store = createStore({ path: join(appRoot, "core.sqlite") });
let identity;
try {
  identity = store.get("application", "identity");
} finally {
  store.close();
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const timestamped = (path) => {
  const target = `${path}.bak-${stamp}`;
  copyFileSync(path, target);
  return target;
};

const report = [];
let optionsChanged = 0;
let limitsChanged = 0;

for (const spec of operator.providers) {
  const runtime = spec.runtime;
  if (!runtime || !runtime.options) continue;
  const surface = config.providers.find((p) => p.providerId === spec.providerId);
  let createdPersistedFlag = false;
  let persisted = identity?.providers?.find((p) => p.providerId === spec.providerId);
  if (!surface) fail(`PROVIDER_SURFACE_MISSING:${spec.providerId}`);
  if (!persisted) {
    // A newly added provider (e.g. the demo attacker) is absent from the
    // persisted identity by construction: the app only writes that record on a
    // successful boot, and the missing entry is exactly what blocks that boot
    // (digestOf(previous) !== digestOf(identity) -> DATASET_RUNTIME_MISMATCH).
    // Only --rebind may create it; the guarded path still refuses.
    if (!rebind) fail(`PROVIDER_SURFACE_MISSING:${spec.providerId}`);
    persisted = { providerId: spec.providerId, profileIds: [], runtimeDigest: "" };
    identity.providers.push(persisted);
    identity.providers.sort((a, b) => a.providerId.localeCompare(b.providerId));
    createdPersistedFlag = true;
  }

  const liveDigest = digestOf(runtime);
  if (
    !rebind &&
    (liveDigest !== surface.runtimeDigest || liveDigest !== persisted.runtimeDigest)
  )
    fail(`PRE_STATE_DRIFT:${spec.providerId}`);

  const entry = {
    ...(createdPersistedFlag ? { createdPersisted: true } : {}),
    providerId: spec.providerId,
    optionsBefore: { ...runtime.options },
    limitsBefore: surface.limits?.maxOutputTokens ?? null,
    digestBefore: liveDigest,
  };

  for (const [key, value] of Object.entries(patch)) {
    if (key === "limits") {
      if (printOnly) {
        entry.limitsAfter = value.maxOutputTokens;
      } else {
        surface.limits = { ...surface.limits, maxOutputTokens: value.maxOutputTokens };
        entry.limitsAfter = surface.limits.maxOutputTokens;
      }
      if (entry.limitsBefore !== value.maxOutputTokens) limitsChanged += 1;
      continue;
    }
    const before = runtime.options[key];
    entry.optionsAfter = { ...(entry.optionsAfter ?? entry.optionsBefore) };
    if (!printOnly) runtime.options[key] = value;
    entry.optionsAfter[key] = value;
    if (before !== value) optionsChanged += 1;
  }

  for (const [key, value] of Object.entries(runtimePatch)) {
    const before = runtime[key];
    entry.runtimeAfter = { ...(entry.runtimeAfter ?? {}), [key]: value };
    if (!printOnly) runtime[key] = value;
    if (before !== value) optionsChanged += 1;
  }
  if (!printOnly) {
    surface.runtimeDigest = digestOf(runtime);
    persisted.runtimeDigest = surface.runtimeDigest;
    // profileIds is a SECOND identity surface: the catalog validator requires
    // profileIds[0] === digestOf(runtime.profile) (and this is exactly what the
    // fixture gate rewrites while it swaps in its synthetic profile). Rebind
    // must re-derive it from the manifest profile, or the next launch fails
    // closed with RUNTIME_PROFILE_CATALOG_MISMATCH.
    const profileDigest = digestOf(runtime.profile);
    surface.profileIds = [profileDigest];
    if (surface.aliases && typeof surface.aliases === "object")
      for (const key of Object.keys(surface.aliases)) surface.aliases[key] = profileDigest;
    persisted.profileIds = [profileDigest];
    // Fourth surface: the payment config binds profileIds too, and
    // composition/application-payments.mjs fails closed with
    // PAYMENT_PROFILE_MISMATCH when they disagree with the provider profile.
    if (spec.payment && spec.payment.config && Array.isArray(spec.payment.config.profileIds))
      spec.payment.config.profileIds = [profileDigest];
    entry.profileDigestAfter = profileDigest;
  }
  entry.digestAfter = printOnly ? liveDigest : digestOf(runtime);
  report.push(entry);
}

if (printOnly) {
  console.log(
    JSON.stringify(
      {
        status: "w6-set-provider-runtime-options",
        ok: true,
        mode: "print",
        optionsChanged,
        limitsChanged,
        providers: report,
      },
      null,
      1,
    ),
  );
  process.exit(0);
}

const backups = [
  timestamped(operatorFile),
  timestamped(configFile),
  timestamped(join(appRoot, "core.sqlite")),
];

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        status: "w6-set-provider-runtime-options",
        ok: true,
        mode: "dry-run",
        optionsChanged,
        limitsChanged,
        backups,
        providers: report,
      },
      null,
      1,
    ),
  );
  process.exit(0);
}

const writeAtomic = (path, value) => {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
};
writeAtomic(operatorFile, operator);
writeAtomic(configFile, config);

const writer = createStore({ path: join(appRoot, "core.sqlite") });
try {
  writer.set("application", "identity", identity);
} finally {
  writer.close();
}

console.log(
  JSON.stringify(
    {
      status: "w6-set-provider-runtime-options",
      ok: true,
      optionsChanged,
      limitsChanged,
      backups,
      providers: report,
    },
    null,
    1,
  ),
);
