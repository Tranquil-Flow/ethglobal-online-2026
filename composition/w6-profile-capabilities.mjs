import { readFile } from "node:fs/promises";

const APP_DIGEST = /^sha256:[0-9a-f]{64}$/;
const RAW_DIGEST = /^[0-9a-f]{64}$/;
const CAPABILITIES = new Set([
  "tee-attested",
  "local",
  "unavailable",
  "not-applicable",
]);

export class ProfileCapabilityError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProfileCapabilityError";
    this.code = code;
  }
}

function fail(code) {
  throw new ProfileCapabilityError(code);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateProfile(row) {
  const fields = [
    "id",
    "appProfileDigest",
    "verifierProfileSha256",
    "pinReason",
    "contract",
    "audits",
  ];
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).sort().join("\0") !== fields.sort().join("\0") ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(row.id) ||
    !(row.appProfileDigest === null || APP_DIGEST.test(row.appProfileDigest)) ||
    !(
      row.verifierProfileSha256 === null ||
      RAW_DIGEST.test(row.verifierProfileSha256)
    ) ||
    typeof row.pinReason !== "string" ||
    !row.pinReason ||
    !row.contract ||
    typeof row.contract !== "object" ||
    Array.isArray(row.contract) ||
    !row.audits ||
    typeof row.audits !== "object" ||
    Object.keys(row.audits).sort().join("\0") !==
      ["ensembleScorer", "referenceSamples"].sort().join("\0") ||
    typeof row.audits.referenceSamples !== "boolean" ||
    typeof row.audits.ensembleScorer !== "boolean"
  ) {
    fail("INVALID_VERIFIER_PROFILE_MAP");
  }
  return deepFreeze(structuredClone(row));
}

export function validateProfileCapabilities(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !==
      ["profiles", "version"].sort().join("\0") ||
    value.version !== 1 ||
    !Array.isArray(value.profiles) ||
    value.profiles.length === 0
  ) {
    fail("INVALID_VERIFIER_PROFILE_MAP");
  }
  const profiles = value.profiles.map(validateProfile);
  const ids = new Set();
  const appDigests = new Set();
  const verifierDigests = new Set();
  for (const row of profiles) {
    if (ids.has(row.id)) fail("DUPLICATE_VERIFIER_PROFILE_ID");
    ids.add(row.id);
    if (row.appProfileDigest) {
      if (appDigests.has(row.appProfileDigest))
        fail("DUPLICATE_APP_PROFILE_DIGEST");
      appDigests.add(row.appProfileDigest);
    }
    if (row.verifierProfileSha256) {
      if (verifierDigests.has(row.verifierProfileSha256))
        fail("DUPLICATE_VERIFIER_PROFILE_DIGEST");
      verifierDigests.add(row.verifierProfileSha256);
    }
  }
  return Object.freeze({ version: 1, profiles: Object.freeze(profiles) });
}

export async function loadProfileCapabilities(path) {
  let value;
  try {
    const bytes = await readFile(path);
    if (bytes.length > 1024 * 1024) fail("INVALID_VERIFIER_PROFILE_MAP");
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof ProfileCapabilityError) throw error;
    fail("INVALID_VERIFIER_PROFILE_MAP");
  }
  return validateProfileCapabilities(value);
}

function unavailable(reason, row) {
  return Object.freeze({
    profileId: row?.id ?? null,
    appProfileDigest: row?.appProfileDigest ?? null,
    verifierProfileSha256: row?.verifierProfileSha256 ?? null,
    audit: "unavailable",
    referenceSamples:
      row?.audits.referenceSamples === false ? "not-applicable" : "unavailable",
    ensembleScorer:
      row?.audits.ensembleScorer === false ? "not-applicable" : "unavailable",
    reasons: Object.freeze([reason]),
  });
}

export function getProfileCapability(
  appProfileDigest,
  profileMap,
  { verifierMode = "unavailable" } = {},
) {
  if (!CAPABILITIES.has(verifierMode) || verifierMode === "not-applicable")
    fail("INVALID_VERIFIER_MODE");
  const map = validateProfileCapabilities(profileMap);
  if (!APP_DIGEST.test(appProfileDigest ?? ""))
    return unavailable(
      "Profile digest is not a valid application SHA-256 identity.",
    );
  const row = map.profiles.find(
    (candidate) => candidate.appProfileDigest === appProfileDigest,
  );
  if (!row)
    return unavailable(
      "Profile is not present in the operator-pinned allowlist.",
    );
  if (!row.verifierProfileSha256) return unavailable(row.pinReason, row);
  if (!row.audits.referenceSamples && !row.audits.ensembleScorer) {
    return Object.freeze({
      profileId: row.id,
      appProfileDigest: row.appProfileDigest,
      verifierProfileSha256: row.verifierProfileSha256,
      audit: "not-applicable",
      referenceSamples: "not-applicable",
      ensembleScorer: "not-applicable",
      reasons: Object.freeze(["This profile has no configured audit methods."]),
    });
  }
  if (verifierMode === "unavailable")
    return unavailable("The verifier transport is unavailable.", row);
  return Object.freeze({
    profileId: row.id,
    appProfileDigest: row.appProfileDigest,
    verifierProfileSha256: row.verifierProfileSha256,
    audit: verifierMode,
    referenceSamples: row.audits.referenceSamples
      ? verifierMode
      : "not-applicable",
    ensembleScorer: row.audits.ensembleScorer ? verifierMode : "not-applicable",
    reasons: Object.freeze([
      verifierMode === "tee-attested"
        ? "Reference-sample audits run in the configured attested verifier."
        : "Reference-sample audits run in the local verifier (not TEE).",
      row.audits.ensembleScorer
        ? "The ordinary-response ensemble scorer is configured."
        : "The ensemble scorer is not applicable to this profile; random reference-sample selection remains independent.",
    ]),
  });
}

export function assertProfileAvailableBeforeQuote(
  appProfileDigest,
  profileMap,
) {
  const map = validateProfileCapabilities(profileMap);
  const row = map.profiles.find(
    (candidate) => candidate.appProfileDigest === appProfileDigest,
  );
  if (
    !APP_DIGEST.test(appProfileDigest ?? "") ||
    !row ||
    !row.verifierProfileSha256
  ) {
    fail("VERIFIER_PROFILE_UNAVAILABLE");
  }
  return structuredClone(row);
}
