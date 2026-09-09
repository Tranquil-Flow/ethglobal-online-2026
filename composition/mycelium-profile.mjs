import { digestOf, validate } from "../packages/contracts/index.mjs";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SOURCE_COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MANIFEST_ROLE = "mycelium-profile-manifest-v1";
const MAX_PROMPT_CHARACTERS = 32768;
const MAX_PROMPT_UTF8_BYTES = 131072;
const MAX_OUTPUT_TOKENS = 4096;

const METADATA_FIELDS = [
  "version",
  "mode",
  "model",
  "artifacts",
  "runtime",
  "codec",
  "numerics",
  "selector",
  "limits",
  "requestPolicy",
  "qualification",
];
const MODEL_FIELDS = ["id", "revision", "representation"];
const ARTIFACT_FIELDS = ["role", "digest", "uri"];
const RUNTIME_FIELDS = ["revision", "sourceCommit"];
const CODEC_FIELDS = ["id", "tokenizerDigest", "templateDigest"];
const NUMERICS_FIELDS = [
  "dtype",
  "quantization",
  "backend",
  "hardwareClass",
  "determinism",
];
const SELECTOR_FIELDS = ["algorithm", "logitQuantum", "rounding", "tieBreak"];
const LIMIT_FIELDS = [
  "maxPromptCharacters",
  "maxPromptUtf8Bytes",
  "maxOutputTokens",
];
const REQUEST_POLICY_FIELDS = ["sampling", "seed"];
const QUALIFICATION_FIELDS = [
  "status",
  "deploymentId",
  "epoch",
  "pathId",
  "manifestDigest",
  "loadProofDigest",
  "qualificationDigest",
];
const REQUEST_FIELDS = [
  "version",
  "nonce",
  "providerId",
  "profileId",
  "prompt",
  "maxOutputTokens",
  "seed",
  "sampling",
  "publishConsent",
];

function failure(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function exactKeys(value, fields, code = "INVALID_METADATA_SHAPE") {
  if (!isPlainObject(value))
    throw failure(code, "Expected a plain closed-shape object");
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw failure(code, "Object fields do not match the closed shape");
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, seen = new Set(), code = "INVALID_METADATA_SHAPE") {
  if (typeof value === "string" && !value.isWellFormed())
    throw failure(code, "Expected well-formed Unicode");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw failure(code, "Only safe integer JSON numbers are supported");
    return value;
  }
  if (typeof value !== "object" || seen.has(value))
    throw failure(code, "Expected acyclic JSON data");
  if (!Array.isArray(value) && !isPlainObject(value))
    throw failure(code, "Expected plain JSON data");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key === "symbol"))
    throw failure(code, "Symbol keys are not supported");
  const dataDescriptors = Array.isArray(value)
    ? Object.entries(descriptors)
        .filter(([key]) => key !== "length")
        .map(([, descriptor]) => descriptor)
    : Object.values(descriptors);
  for (const descriptor of dataDescriptors) {
    if (!descriptor.enumerable || !("value" in descriptor))
      throw failure(code, "Expected enumerable JSON data properties");
  }
  seen.add(value);
  let clone;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length)
      throw failure(code, "Sparse or extended arrays are not supported");
    clone = value.map((entry) => cloneJson(entry, seen, code));
  } else {
    clone = {};
    for (const [key, descriptor] of Object.entries(descriptors))
      clone[key] = cloneJson(descriptor.value, seen, code);
  }
  seen.delete(value);
  return clone;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function boundedText(value, maximum = 256) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum
  );
}

function requireText(value, maximum = 256) {
  if (!boundedText(value, maximum))
    throw failure(
      "INVALID_METADATA_VALUE",
      "Metadata text pin is missing or out of bounds",
    );
}

function requireDigest(value) {
  if (!SHA256.test(value))
    throw failure("INVALID_DIGEST", "Metadata digest must be lowercase sha256");
}

function validateMetadata(metadata) {
  exactKeys(metadata, METADATA_FIELDS);
  exactKeys(metadata.model, MODEL_FIELDS);
  exactKeys(metadata.runtime, RUNTIME_FIELDS);
  exactKeys(metadata.codec, CODEC_FIELDS);
  exactKeys(metadata.numerics, NUMERICS_FIELDS);
  exactKeys(metadata.selector, SELECTOR_FIELDS);
  exactKeys(metadata.limits, LIMIT_FIELDS);
  exactKeys(metadata.requestPolicy, REQUEST_POLICY_FIELDS);
  exactKeys(metadata.qualification, QUALIFICATION_FIELDS);

  if (
    metadata.version !== "1" ||
    !["development", "live"].includes(metadata.mode)
  ) {
    throw failure(
      "INVALID_METADATA_VALUE",
      "Unsupported metadata version or mode",
    );
  }
  for (const value of Object.values(metadata.model)) requireText(value);
  requireText(metadata.runtime.revision);
  if (!SOURCE_COMMIT.test(metadata.runtime.sourceCommit))
    throw failure(
      "INVALID_METADATA_VALUE",
      "Runtime source commit must be an exact lowercase commit hash",
    );
  requireText(metadata.codec.id);
  requireDigest(metadata.codec.tokenizerDigest);
  requireDigest(metadata.codec.templateDigest);
  for (const value of Object.values(metadata.numerics))
    requireText(value, 2048);

  if (
    !Array.isArray(metadata.artifacts) ||
    metadata.artifacts.length < 1 ||
    metadata.artifacts.length > 127
  ) {
    throw failure(
      "UNSUPPORTED_LIMITS",
      "Metadata must contain 1..127 artifacts, leaving room for its manifest",
    );
  }
  const roles = new Set();
  for (const artifact of metadata.artifacts) {
    exactKeys(artifact, ARTIFACT_FIELDS);
    requireText(artifact.role);
    requireDigest(artifact.digest);
    requireText(artifact.uri, 2048);
    if (artifact.role === MANIFEST_ROLE)
      throw failure(
        "RESERVED_ARTIFACT_ROLE",
        "Manifest artifact role is reserved",
      );
    if (roles.has(artifact.role))
      throw failure("INVALID_METADATA_VALUE", "Artifact roles must be unique");
    roles.add(artifact.role);
  }

  if (
    metadata.selector.algorithm !== "quantized-greedy" ||
    metadata.selector.rounding !== "python-round-half-even" ||
    metadata.selector.tieBreak !== "lowest-token-id" ||
    !/^(?:0|[1-9][0-9]*)\.[0-9]*[1-9][0-9]*$/.test(
      metadata.selector.logitQuantum,
    )
  ) {
    throw failure(
      "UNSUPPORTED_SELECTOR",
      "Selector must explicitly pin quantized greedy, decimal quantum, rounding, and tie break",
    );
  }
  const limits = metadata.limits;
  if (
    ![
      limits.maxPromptCharacters,
      limits.maxPromptUtf8Bytes,
      limits.maxOutputTokens,
    ].every(Number.isSafeInteger) ||
    limits.maxPromptCharacters < 1 ||
    limits.maxPromptCharacters > MAX_PROMPT_CHARACTERS ||
    limits.maxPromptUtf8Bytes < limits.maxPromptCharacters ||
    limits.maxPromptUtf8Bytes > MAX_PROMPT_UTF8_BYTES ||
    limits.maxOutputTokens < 1 ||
    limits.maxOutputTokens > MAX_OUTPUT_TOKENS
  ) {
    throw failure(
      "UNSUPPORTED_LIMITS",
      "Limits exceed or contradict the request gateway bounds",
    );
  }
  if (
    metadata.requestPolicy.sampling !== "greedy" ||
    metadata.requestPolicy.seed !== 0
  ) {
    throw failure(
      "UNSUPPORTED_REQUEST_POLICY",
      "Only constructor-bound seed zero and greedy sampling are supported",
    );
  }
  const expectedStatus =
    metadata.mode === "development"
      ? "conformance-only"
      : "owner-declared-unqualified";
  if (metadata.qualification.status !== expectedStatus) {
    throw failure(
      "INVALID_QUALIFICATION_STATUS",
      "Qualification status does not match metadata mode",
    );
  }
  for (const field of ["deploymentId", "epoch", "pathId"])
    requireText(metadata.qualification[field]);
  for (const field of [
    "manifestDigest",
    "loadProofDigest",
    "qualificationDigest",
  ])
    requireDigest(metadata.qualification[field]);
}

function validatePinnedRequest(request, profileId, limits) {
  let copy;
  try {
    copy = cloneJson(request, new Set(), "INVALID_REQUEST_SHAPE");
    exactKeys(copy, REQUEST_FIELDS, "INVALID_REQUEST_SHAPE");
    validate("Request", copy);
  } catch (error) {
    if (error?.code === "INVALID_REQUEST_SHAPE") throw error;
    throw failure(
      "INVALID_REQUEST_SHAPE",
      "Request does not match the closed v1 schema",
    );
  }
  if (copy.profileId !== profileId)
    throw failure(
      "PROFILE_MISMATCH",
      "Request profile is not the pinned manifest profile",
    );
  if (copy.seed !== 0)
    throw failure(
      "UNSUPPORTED_SEED",
      "Only seed zero is implemented by the upstream constructor",
    );
  if (copy.sampling !== "greedy")
    throw failure("UNSUPPORTED_SAMPLING", "Only greedy sampling is supported");
  if (
    copy.maxOutputTokens > limits.maxOutputTokens ||
    copy.prompt.length > limits.maxPromptCharacters ||
    Buffer.byteLength(copy.prompt, "utf8") > limits.maxPromptUtf8Bytes
  ) {
    throw failure(
      "REQUEST_LIMIT_EXCEEDED",
      "Request exceeds the pinned profile limits",
    );
  }
  return true;
}

/**
 * Build an offline immutable workbench Profile binding from a closed sanitized
 * Mycelium metadata packet. This function performs no I/O and no qualification.
 */
export function createMyceliumProfile(input) {
  const metadata = cloneJson(input);
  validateMetadata(metadata);
  const manifestDigest = digestOf(metadata);
  const profile = {
    version: "1",
    model: metadata.model.id,
    artifacts: [
      ...metadata.artifacts,
      {
        role: MANIFEST_ROLE,
        digest: manifestDigest,
        uri: `urn:${manifestDigest}`,
      },
    ],
    runtimeRevision: metadata.runtime.revision,
    tokenizerDigest: metadata.codec.tokenizerDigest,
    templateDigest: metadata.codec.templateDigest,
    numerics: { ...metadata.numerics },
  };
  validate("Profile", profile);
  const profileId = digestOf(profile);
  const frozenMetadata = deepFreeze(metadata);
  const frozenProfile = deepFreeze(profile);
  const binding = {
    profile: frozenProfile,
    profileId,
    metadata: frozenMetadata,
    validateRequest(request) {
      return validatePinnedRequest(request, profileId, frozenMetadata.limits);
    },
  };
  return deepFreeze(binding);
}
