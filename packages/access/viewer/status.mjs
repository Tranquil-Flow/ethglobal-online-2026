async function json(pathOrUrl, { timeoutMs = 6000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(pathOrUrl, { cache: "no-store", signal: controller.signal });
    if (!response.ok) return { ok: false, status: response.status, data: null };
    return { ok: true, status: response.status, data: await response.json() };
  } catch (error) {
    return { ok: false, status: 0, data: null, error };
  } finally {
    clearTimeout(timer);
  }
}

function runtimeReady(runtime) {
  const providers = Array.isArray(runtime?.providers) ? runtime.providers : [];
  if (!providers.length) return false;
  return providers.some((row) => {
    const state = String(row.state ?? row.status ?? "").toLowerCase();
    return ["ready", "online", "ok", "idle", "running"].includes(state) || row.modelLoaded === true;
  });
}

function graphConfig(config) {
  return config?.graph?.endpoint || config?.graphEndpoint || config?.subgraphUrl || null;
}

async function graphMeta(config) {
  const endpoint = graphConfig(config);
  if (!endpoint) return { ok: false, reason: "No public Graph endpoint in config." };
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query { _meta { deployment block { number hash } hasIndexingErrors } }" }),
    });
    if (!response.ok) return { ok: false, reason: `Graph HTTP ${response.status}` };
    const body = await response.json();
    return { ok: !body?.data?._meta?.hasIndexingErrors, data: body?.data?._meta ?? null, reason: body?.errors?.[0]?.message };
  } catch (error) {
    return { ok: false, reason: error?.message ?? "Graph unavailable" };
  }
}

export async function loadLiveStatus({ includeGraph = true } = {}) {
  const [health, config, runtime] = await Promise.all([
    json("/healthz"),
    json("/config.json"),
    json("/v2/runtime-status"),
  ]);
  // Provider stats needs the configured provider ids, so it cannot join the
  // parallel batch above: the route 400s without `providers=` and the row below
  // would then look "unavailable" when the real fault was our query shape.
  const providerIds = (config.data?.providers ?? [])
    .map((p) => p.providerId)
    .filter(Boolean);
  const stats = providerIds.length
    ? await json(
        `/v2/providers/stats?${new URLSearchParams({ providers: providerIds.join(","), window: "7d" })}`,
      )
    : { ok: false, status: 0, data: null };
  const graph = includeGraph && config.ok ? await graphMeta(config.data) : { ok: false };
  const networkOk = health.ok && health.data?.status === "ok";
  const runtimeOk = runtime.ok && runtimeReady(runtime.data);
  const paymentOk = config.ok
    ? config.data?.accessPolicy === "ordinary-paid-x402"
      ? config.data?.demoSponsor?.status === "available" || config.data?.demoSponsor?.status === undefined
      : true
    : false;
  const rows = [
    {
      id: "network",
      label: "Public gateway",
      state: networkOk ? "live" : "partial",
      reason: networkOk ? "Health check responded." : "The public gateway did not return a healthy response.",
      source: "/healthz",
      data: health.data,
    },
    {
      id: "runtime",
      label: "Model network",
      state: runtimeOk ? "live" : runtime.ok ? "partial" : "unavailable",
      reason: runtimeOk ? "At least one provider reports ready." : "No ready provider reported by runtime status.",
      source: "/v2/runtime-status",
      data: runtime.data,
    },
    {
      id: "payment",
      label: "Testnet payments",
      state: paymentOk ? "live" : config.ok ? "partial" : "unavailable",
      reason: paymentOk
        ? "DEMO credit or configured testnet payment path is advertised."
        : "Payment status is not advertised as available.",
      source: "/config.json",
      data: config.data?.demoSponsor ?? null,
    },
    {
      id: "graph",
      label: "Public history",
      state: graph.ok || stats.ok ? "live" : graph.data || stats.data ? "partial" : "unavailable",
      reason: graph.ok
        ? "The configured subgraph responded without indexing errors."
        : stats.ok
          ? "Provider stats API responded."
          : graph.reason ?? "Graph status is not available yet.",
      source: graphConfig(config.data) || "/v2/providers/stats",
      data: graph.data ?? stats.data ?? null,
    },
  ];
  const overall = networkOk && runtimeOk ? "live" : networkOk ? "partial" : "unavailable";
  return {
    overall,
    chipClass: overall === "live" ? "is-live" : overall === "partial" ? "is-partial" : "is-down",
    rows,
    config: config.data,
    health: health.data,
    runtime: runtime.data,
    stats: stats.data,
    graph: graph.data,
  };
}

export function statusText(row) {
  return row.state === "live" ? "Live" : row.state === "partial" ? "Partial" : "Unavailable";
}
