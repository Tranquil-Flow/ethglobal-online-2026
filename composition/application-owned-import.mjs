import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  initializeApplication,
  managedPath,
  loadManagedApplication,
} from "./application-operator.mjs";
import {
  makeOwnedNativeConfiguration,
  inspectOwnedNativeRuntime,
} from "./application-owned-native.mjs";
import {
  readPrivateFile,
  writePrivateExclusive,
  assertPrivateDirectory,
} from "../operations/src/private-files.mjs";
const fail = (c) => {
  throw Error(c);
};
const json = (p) => {
  const { data } = readPrivateFile(p, {
    maxBytes: 1048576,
    code: "PRIVATE_OWNED_NATIVE_PLAN_REQUIRED",
  });
  try {
    return JSON.parse(data.toString());
  } finally {
    data.fill(0);
  }
};
/** Build private operator state, but never issue a permit or start a model. */
export async function initializeOwnedNativeApplication({
  configFile,
  dataDir,
  dryRun = false,
}) {
  const planRoot = dirname(resolve(configFile));
  assertPrivateDirectory(planRoot);
  const plan = json(configFile);
  const required = ["engine", "providerId", "python", "port"];
  if (
    !plan ||
    Array.isArray(plan) ||
    required.some((k) => !Object.hasOwn(plan, k)) ||
    Object.keys(plan).some(
      (k) =>
        ![...required, "modelManifestFile", "publicOrigin", "core"].includes(k),
    ) ||
    !["fixture", "mlx-vlm"].includes(plan.engine) ||
    typeof plan.providerId !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(plan.providerId) ||
    !Number.isInteger(plan.port) ||
    plan.port < 0 ||
    plan.port > 65535
  )
    fail("INVALID_OWNED_NATIVE_PLAN");
  let assets = null,
    versions = null;
  if (plan.engine === "mlx-vlm") {
    if (!plan.modelManifestFile) fail("APP_NATIVE_MODEL_MANIFEST_REQUIRED");
    assets = json(managedPath(planRoot, plan.modelManifestFile));
    // Metadata only: no model, processor, GPU or user-code import occurs here.
    const script =
      "import json,platform,importlib.metadata as m;print(json.dumps({'python':platform.python_version(),'mlx':m.version('mlx'),'mlx-vlm':m.version('mlx-vlm'),'transformers':m.version('transformers')}))";
    try {
      versions = JSON.parse(
        execFileSync(plan.python, ["-I", "-B", "-c", script], {
          encoding: "utf8",
          timeout: 15000,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            PYTHONDONTWRITEBYTECODE: "1",
          },
        }),
      );
    } catch {
      fail("APP_NATIVE_ENVIRONMENT_REQUIRED");
    }
  }
  const configuration = makeOwnedNativeConfiguration({
    engine: plan.engine,
    python: plan.python,
    modelDirectory: assets?.modelDirectory ?? null,
    modelAssets: assets,
    runtimeVersions: versions,
  });
  const root = resolve(dataDir);
  let created = false;
  if (dryRun)
    return {
      status: "planned-not-authorized",
      engine: plan.engine,
      mode: configuration.mode,
      profile: configuration.profile,
      profileId: configuration.profileId,
      sourceDigest: configuration.sourceDigest,
      modelLoaded: false,
      permitIssued: false,
    };
  try {
    await initializeApplication({
      dataDir: root,
      providerIds: [plan.providerId],
      port: plan.port,
    });
    created = true;
    mkdirSync(join(root, "native"), { mode: 0o700 });
    writePrivateExclusive(
      join(root, "native/runtime.json"),
      JSON.stringify(configuration, null, 2) + "\n",
    );
    const runtime = {
      kind: "application-native",
      configurationFile: "native/runtime.json",
      permitFile: "native/permit.json",
    };
    const descriptor = inspectOwnedNativeRuntime({
      root,
      spec: runtime,
      mode: configuration.mode,
      providerId: plan.providerId,
    });
    const config = json(join(root, "application.json"));
    const operator = json(join(root, "operator.json"));
    config.mode = configuration.mode;
    config.providers[0].profileIds = [configuration.profileId];
    config.providers[0].runtimeDigest = descriptor.bindingDigest;
    config.providers[0].aliases = {
      [plan.engine === "fixture" ? "fixture" : "native"]:
        configuration.profileId,
    };
    config.core = {
      ...config.core,
      concurrency: 1,
      maxQueue: 2,
      jobDeadlineMs: 65000,
      portTimeoutMs: 15000,
      ...(plan.core ?? {}),
    };
    if (plan.publicOrigin !== undefined)
      config.publicOrigin = plan.publicOrigin;
    operator.providers[0].runtime = runtime;
    writeFileSync(
      join(root, "application.json"),
      JSON.stringify(config, null, 2) + "\n",
      { mode: 0o600 },
    );
    writeFileSync(
      join(root, "operator.json"),
      JSON.stringify(operator, null, 2) + "\n",
      { mode: 0o600 },
    );
    loadManagedApplication({ configFile: join(root, "application.json") });
    return {
      status: "initialized-no-permit",
      engine: plan.engine,
      mode: configuration.mode,
      providerId: plan.providerId,
      profileId: configuration.profileId,
      runtimeDigest: descriptor.bindingDigest,
      sourceDigest: configuration.sourceDigest,
      modelLoaded: false,
      permitIssued: false,
      requiredPermitFile: join(root, "native/permit.json"),
    };
  } catch (error) {
    if (created) rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
