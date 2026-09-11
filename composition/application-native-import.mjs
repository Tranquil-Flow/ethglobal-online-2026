import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  readPrivateFile,
  writePrivateExclusive,
  assertPrivateDirectory,
  assertSafeParent,
} from "../operations/src/private-files.mjs";
import { digestOf } from "../packages/contracts/index.mjs";
import { validateOperatorInputs } from "./mycelium-operator.mjs";
import { createMyceliumProfile } from "./mycelium-profile.mjs";
import { validateApplicationConfig } from "./application-workbench.mjs";
import {
  initializeApplication,
  managedPath,
  doctorApplication,
} from "./application-operator.mjs";
const fail = (code) => {
  throw Error(code);
};
function exact(x, required, optional = []) {
  if (
    !x ||
    typeof x !== "object" ||
    Array.isArray(x) ||
    required.some((k) => !Object.hasOwn(x, k)) ||
    Object.keys(x).some((k) => ![...required, ...optional].includes(k))
  )
    fail("INVALID_NATIVE_IMPORT");
}
function privateJson(path) {
  const bytes = readPrivateFile(path, {
    maxBytes: 262144,
    code: "UNSAFE_OPERATOR_INPUTS",
  }).data;
  try {
    return { value: JSON.parse(bytes.toString("utf8")), bytes };
  } catch {
    bytes.fill(0);
    fail("INVALID_NATIVE_IMPORT");
  }
}
/** Import only explicit native operator inputs; never translate research profiles or mint a grant. */
export async function initializeNativeApplication({
  configFile,
  dataDir,
  dryRun = false,
}) {
  if (
    typeof configFile !== "string" ||
    typeof dataDir !== "string" ||
    typeof dryRun !== "boolean"
  )
    fail("INVALID_NATIVE_IMPORT");
  const root = resolve(dataDir),
    sourceRoot = dirname(resolve(configFile));
  assertPrivateDirectory(sourceRoot);
  assertSafeParent(root);
  try {
    lstatSync(root);
    fail("NATIVE_IMPORT_TARGET_EXISTS");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const buffers = [];
  let temporary;
  try {
    const planFile = privateJson(configFile);
    buffers.push(planFile.bytes);
    const plan = planFile.value;
    exact(plan, ["schema", "providers"], ["port", "core", "publicOrigin"]);
    if (
      plan.schema !== "mycelium.application.native-import.v1" ||
      !Array.isArray(plan.providers) ||
      plan.providers.length < 1 ||
      plan.providers.length > 8
    )
      fail("INVALID_NATIVE_IMPORT");
    const entries = plan.providers.map((spec) => {
      exact(spec, ["inputFile"], ["aliases"]);
      const file = privateJson(managedPath(sourceRoot, spec.inputFile));
      buffers.push(file.bytes);
      const input = file.value;
      const pins = validateOperatorInputs(input);
      if (input.providers.length !== 1) fail("ONE_NATIVE_PROVIDER_PER_INPUT");
      const aliases = spec.aliases ?? ["model"];
      if (
        !Array.isArray(aliases) ||
        !aliases.length ||
        aliases.length > 8 ||
        new Set(aliases).size !== aliases.length
      )
        fail("INVALID_MODEL_ALIAS");
      const providerId = input.providers[0].providerId,
        profile = createMyceliumProfile(input.metadata).profile;
      const prefix = "native/" + digestOf(providerId).slice(7);
      const refs = [
        ...input.providers,
        ...(input.replayGateway ? [input.replayGateway] : []),
      ].map((x) => x.credentialRef);
      return {
        input,
        bytes: file.bytes,
        provider: {
          providerId,
          keyId: "receipt-" + digestOf(providerId).slice(7, 23),
          profileIds: [pins.profileId],
          runtimeDigest: pins.inputDigest,
          limits: {
            ...input.metadata.limits,
            maxOutputTokens: Math.min(
              input.metadata.limits.maxOutputTokens,
              input.access.maxOutputTokens,
            ),
          },
          aliases: Object.fromEntries(
            aliases.map((alias) => [alias, digestOf(profile)]),
          ),
        },
        runtime: {
          kind: "mycelium",
          inputFile: prefix + "/input.json",
          grantFile: prefix + "/grant.json",
          credentialFiles: Object.fromEntries(
            [...new Set(refs)].map((ref) => [
              ref,
              prefix + "/credentials/" + ref,
            ]),
          ),
        },
      };
    });
    const config = validateApplicationConfig({
      version: "2",
      mode: "live",
      accessPolicy: "non-economic",
      dataDir: ".",
      port: plan.port ?? 0,
      providers: entries.map((x) => x.provider),
      ...(plan.core !== undefined ? { core: plan.core } : {}),
      ...(plan.publicOrigin !== undefined
        ? { publicOrigin: plan.publicOrigin }
        : {}),
    });
    const report = {
      status: dryRun
        ? "native-import-plan"
        : "native-imported-awaiting-authority",
      providerCount: entries.length,
      mode: "live-configured-not-qualified",
      networkContacted: false,
      modelLoaded: false,
      grantCreated: false,
      credentialCopied: false,
      requiredNext:
        "OWNER_ACCEPTED_BINDING_AND_FRESH_GRANTS_AND_PRIVATE_CREDENTIALS",
    };
    if (dryRun) return report;
    temporary = mkdtempSync(join(dirname(root), ".native-import-"));
    const stage = join(temporary, "state");
    // Reuse private identity generation only; no executor is constructed by initialization.
    await initializeApplication({
      dataDir: stage,
      providerIds: entries.map((x) => x.provider.providerId),
      port: config.port,
    });
    const manifest = {
      version: "2",
      providers: entries.map((e) => ({
        providerId: e.provider.providerId,
        keyFile: "identities/" + e.provider.keyId + ".pem",
        runtime: e.runtime,
      })),
    };
    for (const e of entries) {
      mkdirSync(join(stage, dirname(e.runtime.inputFile), "credentials"), {
        recursive: true,
        mode: 0o700,
      });
      writePrivateExclusive(join(stage, e.runtime.inputFile), e.bytes);
    }
    // These are our newly generated, unpublished staging files, never an existing deployment.
    rmSync(join(stage, "application.json"));
    rmSync(join(stage, "operator.json"));
    writePrivateExclusive(
      join(stage, "application.json"),
      JSON.stringify(config, null, 2) + "\n",
    );
    writePrivateExclusive(
      join(stage, "operator.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    await doctorApplication({ configFile: join(stage, "application.json") });
    mkdirSync(root, { mode: 0o700 });
    try {
      for (const name of readdirSync(stage))
        renameSync(join(stage, name), join(root, name));
    } catch (e) {
      rmSync(root, { recursive: true, force: true });
      throw e;
    }
    return report;
  } finally {
    for (const b of buffers) b.fill(0);
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
