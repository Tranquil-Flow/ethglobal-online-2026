import { startDevelopment } from "./index.mjs";
import { startRehearsalInfrastructure } from "./local-rehearsal.mjs";

export function validateWorkbenchConfig(input) {
  const allowed = [
    "version",
    "mode",
    "dataDir",
    "port",
    "providers",
    "faults",
    "delayMs",
  ];
  if (
    !input ||
    Object.keys(input).some((k) => !allowed.includes(k)) ||
    input.version !== "1" ||
    !["simulation", "conformance", "mycelium-v3-conformance"].includes(input.mode) ||
    typeof input.dataDir !== "string" ||
    !input.dataDir ||
    !Number.isInteger(input.port) ||
    input.port < 0 ||
    input.port > 65535
  )
    throw Error("INVALID_WORKBENCH_CONFIG");
  if (
    !Array.isArray(input.providers) ||
    !input.providers.length ||
    input.providers.length > 8 ||
    new Set(input.providers.map((p) => p?.providerId)).size !==
      input.providers.length ||
    input.providers.some(
      (p) =>
        !p ||
        Object.keys(p).some(
          (k) => !["providerId", "amountBaseUnits"].includes(k),
        ) ||
        !/^[a-z0-9-]+\.example\.eth$/.test(p.providerId) ||
        !/^([1-9][0-9]{0,3}|10000)$/.test(p.amountBaseUnits),
    )
  )
    throw Error("INVALID_PROVIDER_CATALOG");
  if (
    input.faults !== undefined &&
    (!input.faults ||
      Array.isArray(input.faults) ||
      typeof input.faults !== "object" ||
      Object.entries(input.faults).some(
        ([id, v]) =>
          !input.providers.some((p) => p.providerId === id) ||
          typeof v !== "string",
      ))
  )
    throw Error("INVALID_SIMULATOR_FAULTS");
  if (
    input.delayMs !== undefined &&
    (!Number.isInteger(input.delayMs) ||
      input.delayMs < 0 ||
      input.delayMs > 1000)
  )
    throw Error("INVALID_SIMULATOR_DELAY");
  if (input.mode === "mycelium-v3-conformance" && (input.faults !== undefined || input.delayMs !== undefined)) throw Error("V3_GATEWAY_OWNS_RUNTIME_INPUTS");
  return structuredClone(input);
}

// Simulation is an explicit complete local topology, never a fallback for live startup.
export async function startWorkbench({
  config,
  runtime,
  receiptSigner,
  publicationSigner,
} = {}) {
  if (config?.mode === "live") {
    if (!runtime) throw Error("LIVE_RUNTIME_REQUIRED");
    const { startLiveWorkbench } = await import("./live-workbench.mjs");
    return startLiveWorkbench({
      config,
      runtime,
      receiptSigner,
      publicationSigner,
    });
  }
  const v3 = config?.mode === "mycelium-v3-conformance";
  if (v3 && (!runtime || runtime.kind !== "mycelium-v3-conformance" || runtime.protocol !== "mycelium.request_gateway.v3" || runtime.mode !== "development" || runtime.conformance !== true || receiptSigner || publicationSigner)) throw Error("V3_CONFORMANCE_RUNTIME_REQUIRED");
  if (!v3 && (runtime || receiptSigner || publicationSigner))
    throw Error("LIVE_BINDINGS_FORBIDDEN_IN_SIMULATION");
  const c = validateWorkbenchConfig(config);
  const { createSimulatorBinding } = await import("./runtime-binding.mjs");
  const runtimeDefinition =
    v3 ? runtime : c.mode === "conformance"
      ? await (
          await import("./conformance-binding.mjs")
        ).createConformanceBinding(c)
      : createSimulatorBinding(c);
  let infrastructure;
  try {
    infrastructure = await startRehearsalInfrastructure();
  } catch (error) {
    await runtimeDefinition.close?.();
    throw error;
  }
  let app,
    heartbeat,
    pending = Promise.resolve(),
    closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    const errors = [];
    for (const f of [
      () => pending,
      () => app?.close(),
      () => infrastructure.close(),
      () => runtimeDefinition.close?.(),
    ])
      try {
        await f();
      } catch (e) {
        errors.push(e);
      }
    if (errors.length)
      throw new AggregateError(errors, "WORKBENCH_CLOSE_FAILED");
  }
  try {
    app = await startDevelopment({
      development: true,
      dataDir: c.dataDir,
      port: c.port,
      providerCatalog: c.providers,
      localInfrastructure: infrastructure.descriptor,
      runtimeDefinition,
    });
    // Keep the local canonical chain advancing for confirmation and freshness checks.
    heartbeat = setInterval(() => {
      pending = pending
        .then(() =>
          closed
            ? undefined
            : Promise.all([
                infrastructure.ens.client.request({
                  method: "evm_mine",
                  params: [],
                }),
                infrastructure.graph.evm.provider.send("evm_mine", []),
              ]),
        )
        .catch(() => {});
    }, 1000);
    heartbeat.unref();
    // Local chain/index services are disposable; reconstruct only previously consented
    // immutable outbox events. Never reauthorize payment or rerun retained jobs.
    for (
      let offset = 0, count = app.diagnostics().outbox.length;
      offset < count;
      offset += 64
    )
      await app.reconcilePublications({ offset, limit: 64 });
    return { ...app, mode: c.mode, infrastructure, close };
  } catch (e) {
    await close();
    throw e;
  }
}
