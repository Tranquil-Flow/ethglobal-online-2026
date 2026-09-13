// V2 wiring: wrap a native executor so an ordinary job's successful completion
// enqueues a NON-BLOCKING verifier observation. The user-visible response never
// waits on scoring; failures are swallowed (audits are optional evidence, never
// a payment/execution dependency). Raw text is passed transiently to the bridge
// (which persists only a MAC); this wrapper never persists it.
//
// Composition: wrap the executor returned by inspectMyceliumHttpRuntime's
// create() — see docs/handoffs/w6-demo-integration-plan.md §6 V2.
export function createVerifiedExecutor({ executor, bridge, providerId }) {
  if (!executor || typeof executor.execute !== "function")
    throw Object.assign(new Error("EXECUTOR_REQUIRED"), { code: "EXECUTOR_REQUIRED" });
  if (!bridge || typeof bridge.enqueueCompletedJob !== "function")
    throw Object.assign(new Error("BRIDGE_REQUIRED"), { code: "BRIDGE_REQUIRED" });
  if (typeof providerId !== "string" || !providerId)
    throw Object.assign(new Error("PROVIDER_ID_REQUIRED"), { code: "PROVIDER_ID_REQUIRED" });

  const execute = (args = {}) => {
    const upstream = executor.execute(args);
    let observed = false;
    const iterator = (async function* () {
      for await (const event of upstream) {
        if (event?.type === "completed" && !observed) {
          observed = true;
          try {
            const ticket = bridge.enqueueCompletedJob({
              requestId: args.jobId,
              providerId,
              profileId: event.profileId,
              requestKind: "ordinary",
              executionStatus: "succeeded",
              output: event.output,
            });
            // Non-blocking by contract: never await ticket.completion here.
            if (ticket?.completion?.catch) ticket.completion.catch(() => {});
          } catch {
            // Audit enqueue failure must never affect the served response.
          }
        }
        yield event;
      }
    })();
    return iterator;
  };

  return Object.freeze({
    ...executor,
    execute,
    verifiedExecutor: true,
    close: async () => {
      if (typeof executor.close === "function") await executor.close();
      if (typeof bridge.close === "function") await bridge.close();
    },
  });
}
