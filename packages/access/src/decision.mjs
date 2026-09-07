import { AccessError } from "./index.mjs";
// Advisory only: Graph-derived observations are untrusted data, not tool instructions.
export async function decideProvider(
  client,
  { names, quotes = [], profileId, maxAmountBaseUnits, network, asset },
) {
  const { providers, errors } = await client.listProviders(names);
  const selection = await client.selectProviders({
    providers,
    quotes,
    profileId,
    maxAmountBaseUnits,
    network,
    asset,
  });
  const histories = await Promise.all(
    providers.map((p) => client.getHistory(p.providerId)),
  );
  const eligible = selection.selected;
  const history = histories.find((h) => h.providerId === eligible?.providerId);
  const selected =
    eligible && history?.freshness === "fresh" && history.mode === eligible.mode
      ? eligible
      : null;
  return {
    selected,
    reasons: selection.reasons,
    errors,
    decision: {
      compatible: !!eligible,
      historyFreshness: history?.freshness || "unavailable",
      sampleStatus: history?.observations.length
        ? "observations-not-proof"
        : "unknown",
      historyPolicy:
        "fresh index required; missing samples unknown; no trust score",
      budgetChecked: !!eligible,
      paidWriteAuthorized: false,
    },
    histories,
  };
}
