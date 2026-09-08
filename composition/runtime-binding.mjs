import {
  simulatorProfile,
  createSimulator,
  createReplayAssessor,
} from "./runtime.mjs";
export function createSimulatorBinding(c) {
  if (
    !Array.isArray(c?.providers) ||
    !c.providers.length ||
    c.providers.length > 8
  )
    throw Error("INVALID_PROVIDER_CATALOG");
  const executors = new Map(
    c.providers.map((p) => [
      p.providerId,
      createSimulator({
        delayMs: c.delayMs ?? 0,
        fault: c.faults?.[p.providerId] ?? "none",
      }),
    ]),
  );
  return {
    mode: "development",
    simulator: true,
    profile: simulatorProfile,
    create({ store, providerPins }) {
      const loadEvidence = async (ref) => {
        if (typeof ref !== "string" || !ref.startsWith("core-local:"))
          throw Error("EVIDENCE_UNAVAILABLE");
        const id = ref.slice("core-local:".length),
          row = store.get("jobs", id),
          bundle = store.get("private", id),
          receipt = store.get("receipts", id)?.receipt;
        if (
          !bundle?.request ||
          !bundle.profile ||
          !bundle.output ||
          !receipt ||
          !row ||
          row.evidenceExpiresAt <= Date.now()
        )
          throw Error("EVIDENCE_UNAVAILABLE");
        return {
          version: "1",
          mode: "development",
          ...bundle,
          receipt,
          assessments: store.get("assessments", id)?.items ?? [],
        };
      };
      const assessors = new Map(
        c.providers.map((p) => [
          p.providerId,
          createReplayAssessor({
            loadEvidence,
            pins: providerPins[p.providerId],
            reexecutor: createSimulator(),
          }),
        ]),
      );
      const primary = assessors.values().next().value;
      return {
        executor: {
          mode: "development",
          execute(x) {
            const e = executors.get(x.request.providerId);
            if (!e) throw Error("PROVIDER_UNAVAILABLE");
            return e.execute(x);
          },
        },
        assessor: {
          method: primary.method,
          verifierId: primary.verifierId,
          assess(x) {
            const a = assessors.get(x.receipt.payload.providerId);
            if (!a) throw Error("PROVIDER_UNAVAILABLE");
            return a.assess(x);
          },
        },
      };
    },
  };
}
