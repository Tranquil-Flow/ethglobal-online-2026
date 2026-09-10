import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, statSync } from "node:fs";
import { startWorkbench } from "./workbench.mjs";
import { startDevelopment } from "./index.mjs";
import { loadOperatorInputs, createOperatorRuntimeBinding } from "./mycelium-operator.mjs";
const args = process.argv.slice(2),
  options = {};
let useLocalServices = false,
  operatorInputsPath,
  configPath,
  bindingsPath;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--config") configPath = args[++i];
  else if (args[i] === "--operator-inputs") operatorInputsPath = args[++i];
  else if (args[i] === "--bindings") bindingsPath = args[++i];
  else if (args[i] === "--local-services") useLocalServices = true;
  else if (args[i] === "--development") options.development = true;
  else if (args[i] === "--data-dir") options.dataDir = args[++i];
  else if (args[i] === "--port") options.port = Number(args[++i]);
  else if (args[i] === "--delay-ms") options.delayMs = Number(args[++i]);
  else throw Error("UNKNOWN_OPTION");
}
let app, rehearsal;
async function close() {
  try {
    await app?.close();
  } finally {
    await rehearsal?.close();
  }
}
try {
  if (configPath) {
    if (
      useLocalServices ||
      Object.keys(options).length ||
      statSync(configPath).size > 65536
    )
      throw Error("INVALID_WORKBENCH_CONFIG");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (operatorInputsPath && (config.mode !== "live" || !bindingsPath))
      throw Error("INVALID_OPERATOR_INPUTS");
    const operatorInputs = operatorInputsPath ? loadOperatorInputs(operatorInputsPath) : undefined;
    let bindings = {};
    if (bindingsPath) {
      if (!["live", "mycelium-v3-conformance"].includes(config.mode))
        throw Error("LIVE_BINDINGS_FORBIDDEN_IN_SIMULATION");
      const module = await import(pathToFileURL(resolve(bindingsPath)).href);
      if (typeof module.createBindings !== "function")
        throw Error("LIVE_RUNTIME_REQUIRED");
      bindings = await module.createBindings({ config });
      if (
        !bindings ||
        Object.keys(bindings).some(
          (k) => !["runtime", "receiptSigner", "publicationSigner", ...(operatorInputs ? ["authorizeRuntimeAccess", "credentialFor"] : [])].includes(k),
        )
      )
        throw Error("LIVE_RUNTIME_REQUIRED");
    }
    if (operatorInputs) {
      if (bindings.runtime) throw Error("AMBIGUOUS_OPERATOR_RUNTIME");
      const runtime = await createOperatorRuntimeBinding(operatorInputs, bindings);
      bindings = {runtime, receiptSigner:bindings.receiptSigner, publicationSigner:bindings.publicationSigner};
    }
    app = await startWorkbench({ config, ...bindings });
  } else {
    if (bindingsPath || operatorInputsPath) throw Error("INVALID_WORKBENCH_CONFIG");
    if (useLocalServices) {
      if (options.development !== true) throw Error("DEVELOPMENT_REQUIRED");
      const { startRehearsalInfrastructure } = await import(
        "./local-rehearsal.mjs"
      );
      rehearsal = await startRehearsalInfrastructure();
      options.localInfrastructure = rehearsal.descriptor;
      options.providerId = "worker.example.eth";
    }
    app = await startDevelopment(options);
  }
  console.log(
    JSON.stringify({
      url: app.url,
      providerId: app.providerId,
      profileId: app.profileId,
      pins: app.pins,
      mode: app.mode ?? "development",
      execution:
        app.mode === "live"
          ? "declared-live-runtime-not-qualified"
          : ["conformance", "mycelium-v3-conformance"].includes(app.mode)
            ? "native-gateway-conformance-not-inference"
            : configPath
              ? "staged-simulator-not-inference"
              : "synthetic-not-inference",
      assessment: app.replayMethod ?? "unavailable",
      payment:
        app.mode === "live"
          ? "configured-Blocky402-testnet"
          : "offline-synthetic-no-funds",
      history:
        app.mode === "live"
          ? "configured-pinned-Graph-not-qualified"
          : useLocalServices || configPath
            ? "local-Graph-Node-not-public-provider"
            : "synthetic-Graph-shaped-not-deployed",
      discovery:
        app.mode === "live"
          ? "configured-canonical-ENSv2-not-qualified"
          : useLocalServices || configPath
            ? "local-ENSv2-contracts"
            : "synthetic-records-not-ENS",
    }),
  );
  for (const sig of ["SIGINT", "SIGTERM"])
    process.once(sig, () =>
      close().then(
        () => process.exit(0),
        () => process.exit(1),
      ),
    );
} catch (e) {
  await close();
  console.error(
    [
      "LIVE_RUNTIME_REQUIRED",
      "INVALID_OPERATOR_INPUTS",
      "UNSAFE_OPERATOR_INPUTS",
      "RUNTIME_ACCESS_GRANT_REQUIRED",
      "INVALID_ACCESS_SCOPE",
      "OPERATOR_PROFILE_MISMATCH",
      "OPERATOR_QUALIFICATION_MISMATCH",
      "AMBIGUOUS_OPERATOR_RUNTIME",
      "INVALID_WORKBENCH_CONFIG",
      "INVALID_PROVIDER_CATALOG",
      "DEVELOPMENT_REQUIRED",
      "PRIVATE_DIRECTORY_REQUIRED",
      "INVALID_LOCAL_CONFIG",
    ].includes(e.message)
      ? e.message
      : "LOCAL_START_FAILED; use supported Node and a private data directory, check occupied ports",
  );
  process.exitCode = 1;
}
