// Managed, application-owned Ollama binding. Offline inspection never contacts
// a server or loads a model. It installs no assessor and has no money authority.
import { readFileSync } from "node:fs";
import { validate, digestOf } from "../packages/contracts/index.mjs";
import { createOllamaAdapter } from "./mycelium-adapter-ollama.mjs";
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const sourceDigest = digestOf(
  readFileSync(
    new URL("./mycelium-adapter-ollama.mjs", import.meta.url),
    "utf8",
  ),
);
export function inspectOllamaRuntime({ spec: input, mode, providerId }) {
  if (mode !== "live") fail("RUNTIME_MODE_MISMATCH");
  if (
    !input ||
    Array.isArray(input) ||
    Object.keys(input).sort().join() !==
      ["kind", "endpoint", "profile", "options"].sort().join() ||
    input.kind !== "ollama"
  )
    fail("INVALID_OLLAMA_BINDING");
  const spec = structuredClone(input),
    profile = spec.profile;
  try {
    validate("Profile", profile);
  } catch {
    fail("INVALID_OLLAMA_BINDING");
  }
  const artifact = (role) => {
    const matches = profile.artifacts.filter((x) => x.role === role);
    if (matches.length !== 1) fail("OLLAMA_PROFILE_MISMATCH");
    return matches[0];
  };
  if (
    !spec.options ||
    Object.keys(spec.options).sort().join() !==
      [
        "maxPromptTokens",
        "maxOutputTokens",
        "contextTokens",
        "timeoutMs",
        "maxOutputBytes",
      ]
        .sort()
        .join() ||
    artifact("ollama-policy").digest !== digestOf(spec.options) ||
    artifact("ollama-adapter").digest !== sourceDigest ||
    artifact("ollama-model-gguf").digest !== profile.tokenizerDigest ||
    profile.templateDigest !== digestOf({ raw: true })
  )
    fail("OLLAMA_PROFILE_MISMATCH");
  artifact("ollama-manifest");
  const profileId = digestOf(profile);
  const config = {
    endpoint: spec.endpoint,
    model: profile.model,
    providerId,
    profileId,
    profileDigest: profileId,
    options: spec.options,
  };
  createOllamaAdapter(config); // config-only validation; no construction-time I/O
  const authorize = () => {
    if (process.env.WAVE5_OLLAMA_LIVE_APPROVED !== "1")
      fail("OLLAMA_LOCAL_MODEL_APPROVAL_REQUIRED");
  };
  return {
    kind: "ollama",
    mode: "live",
    bindingDigest: digestOf(spec),
    profiles: [profile],
    authorize,
    create() {
      authorize();
      return { executor: createOllamaAdapter(config) };
    },
  };
}
