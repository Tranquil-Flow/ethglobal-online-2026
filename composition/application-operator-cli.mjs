import {
  initializeApplication,
  getApplicationPublicPins,
  doctorApplication,
  startManagedApplication,
} from "./application-operator.mjs";
import {
  backupManagedApplication,
  restoreManagedApplication,
} from "./application-backup.mjs";
import {
  readPrivateFile,
  writePrivateExclusive,
} from "../operations/src/private-files.mjs";
import { initializeNativeApplication } from "./application-native-import.mjs";
import { initializeOwnedNativeApplication } from "./application-owned-import.mjs";
import { initializeStdioApplication } from "./application-stdio-import.mjs";
import { planApplicationDeployment } from "./application-deployment.mjs";
const fields = {
  "--tls-config": "tlsConfigFile",
  "--native-hosts-file": "nativeHostsFile",
  "--data-dir": "dataDir",
  "--config": "configFile",
  "--artifact": "artifactPath",
  "--inventory": "inventoryFile",
  "--passphrase-file": "passphraseFile",
};
const fail = () => {
  throw Error("INVALID_OPERATOR_OPTIONS");
};
const requireOptions = (options, wanted) => {
  if (Object.keys(options).sort().join(",") !== [...wanted].sort().join(","))
    fail();
};
const privateJson = (path) => {
  const b = readPrivateFile(path, {
    maxBytes: 262144,
    code: "PRIVATE_CONFIG_REQUIRED",
  }).data;
  try {
    return JSON.parse(b.toString("utf8"));
  } finally {
    b.fill(0);
  }
};
let app;
try {
  const [action, ...args] = process.argv.slice(2),
    options = {},
    providerIds = [];
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i],
      v = args[i + 1];
    if (!v) fail();
    if (k === "--provider") providerIds.push(v);
    else {
      const f = fields[k];
      if (!f || options[f]) fail();
      options[f] = v;
    }
  }
  let nativeHostBindings;
  if (options.nativeHostsFile) {
    if (
      !["doctor", "start", "backup", "restore", "public-pins"].includes(action)
    )
      fail();
    nativeHostBindings = privateJson(options.nativeHostsFile);
    delete options.nativeHostsFile;
  }
  if (action === "init") {
    requireOptions(options, ["dataDir"]);
    console.log(
      JSON.stringify(
        await initializeApplication({
          ...options,
          ...(providerIds.length ? { providerIds } : {}),
        }),
      ),
    );
  } else if (action === "public-pins") {
    requireOptions(options, ["configFile"]);
    if (providerIds.length !== 1) fail();
    console.log(
      JSON.stringify(
        await getApplicationPublicPins({
          ...options,
          nativeHostBindings,
          providerId: providerIds[0],
        }),
      ),
    );
  } else {
    if (providerIds.length) fail();
    if (action === "plan-owned-native" || action === "init-owned-native") {
      requireOptions(options, ["configFile", "dataDir"]);
      console.log(
        JSON.stringify(
          await initializeOwnedNativeApplication({
            ...options,
            dryRun: action === "plan-owned-native",
          }),
        ),
      );
    } else if (action === "plan-native" || action === "init-native") {
      requireOptions(options, ["configFile", "dataDir"]);
      console.log(
        JSON.stringify(
          await initializeNativeApplication({
            ...options,
            dryRun: action === "plan-native",
          }),
        ),
      );
    } else if (action === "init-stdio") {
      requireOptions(options, ["configFile", "dataDir"]);
      console.log(JSON.stringify(await initializeStdioApplication(options)));
    } else if (action === "plan-deployment") {
      requireOptions(options, ["configFile", "tlsConfigFile"]);
      console.log(JSON.stringify(await planApplicationDeployment(options)));
    } else if (action === "runtime-status") {
      requireOptions(options, ["configFile"]);
      const config = privateJson(options.configFile);
      if (
        !Number.isInteger(config.port) ||
        config.port < 1 ||
        config.port > 65535
      )
        throw Error("FIXED_PORT_REQUIRED_FOR_STATUS");
      const response = await fetch(
        "http://127.0.0.1:" + config.port + "/v2/runtime-status",
        { signal: AbortSignal.timeout(5000) },
      );
      if (!response.ok) throw Error("APPLICATION_STATUS_UNAVAILABLE");
      const report = await response.json();
      if (
        report.version !== "1" ||
        !Array.isArray(report.providers) ||
        report.providers.length !== config.providers.length ||
        report.providers.some(
          (p) =>
            !config.providers.some((c) => c.providerId === p.providerId) ||
            p.mode !== config.mode ||
            ![
              "not_started",
              "loading",
              "ready",
              "stopping",
              "stopped",
              "expired",
              "failed",
              "unknown",
            ].includes(p.state),
        )
      )
        throw Error("APPLICATION_STATUS_UNAVAILABLE");
      console.log(
        JSON.stringify({
          version: "1",
          providers: report.providers.map((p) => ({
            providerId: p.providerId,
            mode: p.mode,
            state: p.state,
            modelLoaded: p.modelLoaded === true,
            inferenceVerified: false,
            financialProtection: false,
          })),
        }),
      );
    } else if (action === "doctor" || action === "start") {
      requireOptions(options, ["configFile"]);
      if (action === "doctor")
        console.log(
          JSON.stringify(
            await doctorApplication({ ...options, nativeHostBindings }),
          ),
        );
      else {
        app = await startManagedApplication({ ...options, nativeHostBindings });
        console.log(
          JSON.stringify({
            status: "listening",
            url: app.url,
            providerIds: app.providerIds,
            mode: app.mode,
            payment:
              app.accessPolicy === "non-economic"
                ? "non-monetary-no-settlement"
                : "ordinary-x402-not-financial-protection",
            checking: "separate-observations-not-proof",
          }),
        );
        for (const sig of ["SIGINT", "SIGTERM"])
          process.once(sig, () =>
            app.close().then(
              () => process.exit(0),
              () => process.exit(1),
            ),
          );
      }
    } else if (action === "backup" || action === "restore") {
      requireOptions(options, [
        action === "backup" ? "configFile" : "dataDir",
        "artifactPath",
        "inventoryFile",
        "passphraseFile",
      ]);
      const secret = privateJson(options.passphraseFile);
      if (
        !secret ||
        Object.keys(secret).join(",") !== "passphrase" ||
        typeof secret.passphrase !== "string"
      )
        throw Error("INVALID_PASSPHRASE_FILE");
      if (action === "backup") {
        const { inventory, ...report } = await backupManagedApplication({
          ...options,
          nativeHostBindings,
          passphrase: secret.passphrase,
        });
        writePrivateExclusive(
          options.inventoryFile,
          JSON.stringify(inventory, null, 2) + "\n",
        );
        console.log(JSON.stringify({ status: "backed-up", ...report }));
      } else {
        const report = await restoreManagedApplication({
          ...options,
          nativeHostBindings,
          targetDataDir: options.dataDir,
          passphrase: secret.passphrase,
          expectedInventory: privateJson(options.inventoryFile),
        });
        console.log(
          JSON.stringify({ status: "restored-not-started", ...report }),
        );
      }
    } else throw Error("USAGE_INIT_DOCTOR_START_BACKUP_RESTORE_STDIO");
  }
} catch (e) {
  await app?.close();
  const reason = /^[A-Z][A-Z0-9_]{0,100}$/.test(e.message)
    ? e.message
    : "OPERATOR_FAILED";
  console.error(
    JSON.stringify({
      status: "error",
      reason,
      message: reason.replaceAll("_", " ").toLowerCase(),
    }),
  );
  process.exitCode = 1;
}
