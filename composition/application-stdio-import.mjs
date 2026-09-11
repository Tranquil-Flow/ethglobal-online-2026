import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import {
  readPrivateFile,
  writePrivateExclusive,
  assertPrivateDirectory,
  assertSafeParent,
} from "../operations/src/private-files.mjs";
import {
  initializeApplication,
  managedPath,
  doctorApplication,
} from "./application-operator.mjs";
import { validateApplicationConfig } from "./application-workbench.mjs";
import { digest, loadNativeBinding } from "./vendor/a-native-executor-v1.mjs";
const fail = (c) => {
  throw Error(c);
};
const json = (p) => {
  const { data } = readPrivateFile(p, {
    maxBytes: 262144,
    code: "PRIVATE_IMPORT_REQUIRED",
  });
  try {
    return JSON.parse(data.toString("utf8"));
  } finally {
    data.fill(0);
  }
};
export async function initializeStdioApplication({ configFile, dataDir }) {
  const planRoot = dirname(resolve(configFile));
  assertPrivateDirectory(planRoot);
  const plan = json(configFile),
    required = [
      "providerId",
      "bindingFile",
      "bindingSha256",
      "credentialFile",
      "approveRuntimeAccess",
      "port",
    ];
  if (
    !plan ||
    required.some((k) => !Object.hasOwn(plan, k)) ||
    Object.keys(plan).some(
      (k) => ![...required, "publicOrigin", "core"].includes(k),
    ) ||
    plan.approveRuntimeAccess !== true ||
    !/^[a-f0-9]{64}$/.test(plan.bindingSha256)
  )
    fail("INVALID_STDIO_IMPORT");
  const bindingFile = managedPath(planRoot, plan.bindingFile),
    credentialFile = managedPath(planRoot, plan.credentialFile);
  const { data: bindingBytes } = readPrivateFile(bindingFile, {
    maxBytes: 262144,
    code: "PRIVATE_IMPORT_REQUIRED",
  });
  if (
    createHash("sha256").update(bindingBytes).digest("hex") !==
    plan.bindingSha256
  )
    fail("NATIVE_BINDING_CHANGED");
  const b = loadNativeBinding(bindingFile);
  if (
    b.mode !== "live" ||
    b.verification_claim !== false ||
    !Number.isFinite(b.expiresAtUnix) ||
    b.expiresAtUnix * 1000 <= Date.now()
  )
    fail("NATIVE_ACCESS_INVALID");
  const { data: credential } = readPrivateFile(credentialFile, {
    maxBytes: 4096,
    code: "PRIVATE_NATIVE_CREDENTIAL_REQUIRED",
  });
  const root = resolve(dataDir);
  assertSafeParent(root);
  if (existsSync(root)) fail("DESTINATION_EXISTS");
  const stage = mkdtempSync(join(dirname(root), ".stdio-import-")),
    child = join(stage, "app");
  try {
    await initializeApplication({
      dataDir: child,
      providerIds: [plan.providerId],
      port: plan.port,
    });
    const config = json(join(child, "application.json")),
      manifest = json(join(child, "operator.json"));
    config.mode = "live";
    config.providers[0].profileIds = [b.profileId];
    config.providers[0].runtimeDigest = digest(b);
    config.providers[0].aliases = { "qwen38-27b": b.profileId };
    config.core = {
      ...config.core,
      concurrency: 1,
      maxQueue: 4,
      jobDeadlineMs: 90000,
      portTimeoutMs: 10000,
      ...plan.core,
    };
    if (plan.publicOrigin !== undefined)
      config.publicOrigin = plan.publicOrigin;
    validateApplicationConfig({ ...config, dataDir: child });
    manifest.providers[0].runtime = {
      kind: "native-stdio",
      bindingFile: "native/binding.json",
      bindingSha256: plan.bindingSha256,
      credentialFile: "native/credential.txt",
      accessFile: "native/access.json",
    };
    mkdirSync(join(child, "native"), { mode: 0o700 });
    writePrivateExclusive(join(child, "native/binding.json"), bindingBytes);
    writePrivateExclusive(join(child, "native/credential.txt"), credential);
    writePrivateExclusive(
      join(child, "native/access.json"),
      JSON.stringify(
        {
          schema: "mycelium.application-native-access/v1",
          providerId: plan.providerId,
          bindingDigest: digest(b),
          expiresAt: new Date(b.expiresAtUnix * 1000).toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    // Only files in this newly created staging directory are replaced.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(child, "application.json"),
      JSON.stringify(config, null, 2) + "\n",
      { mode: 0o600 },
    );
    writeFileSync(
      join(child, "operator.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o600 },
    );
    await doctorApplication({ configFile: join(child, "application.json") });
    mkdirSync(root, { mode: 0o700 });
    try {
      for (const name of readdirSync(child))
        renameSync(join(child, name), join(root, name));
    } catch (e) {
      rmSync(root, { recursive: true, force: true });
      throw e;
    }
    return {
      status: "initialized",
      runtime: "native-stdio",
      mode: "live",
      providerId: plan.providerId,
      profileId: b.profileId,
      modelLoaded: false,
      networkContacted: false,
      checking: "unavailable",
      nativePermitMinted: false,
      applicationAccessExpiresAt: new Date(
        b.expiresAtUnix * 1000,
      ).toISOString(),
    };
  } finally {
    credential.fill(0);
    bindingBytes.fill(0);
    rmSync(stage, { recursive: true, force: true });
  }
}
