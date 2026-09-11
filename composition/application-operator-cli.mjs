import {
  initializeApplication,
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
const fields = {
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
  } else {
    if (providerIds.length) fail();
    if (action === "plan-native" || action === "init-native") {
      requireOptions(options, ["configFile", "dataDir"]);
      console.log(
        JSON.stringify(
          await initializeNativeApplication({
            ...options,
            dryRun: action === "plan-native",
          }),
        ),
      );
    } else if (action === "doctor" || action === "start") {
      requireOptions(options, ["configFile"]);
      if (action === "doctor")
        console.log(JSON.stringify(await doctorApplication(options)));
      else {
        app = await startManagedApplication(options);
        console.log(
          JSON.stringify({
            status: "listening",
            url: app.url,
            providerIds: app.providerIds,
            mode: app.mode,
            payment: "non-monetary-no-settlement",
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
          targetDataDir: options.dataDir,
          passphrase: secret.passphrase,
          expectedInventory: privateJson(options.inventoryFile),
        });
        console.log(
          JSON.stringify({ status: "restored-not-started", ...report }),
        );
      }
    } else throw Error("USAGE_INIT_DOCTOR_START_BACKUP_RESTORE");
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
