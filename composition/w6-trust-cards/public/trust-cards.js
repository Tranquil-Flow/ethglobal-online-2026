(() => {
  const CARD_IDS = ["graph-stats", "ens-info", "provider-trust"];

  const text = (tag, value, className) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value == null || value === "" ? "—" : String(value);
    return node;
  };

  const clear = (node) => {
    while (node.firstChild) node.removeChild(node.firstChild);
  };

  const badge = (value, kind = "neutral") => {
    const node = text("span", value, `badge ${kind}`);
    return node;
  };

  const badgeRow = (...badges) => {
    const row = document.createElement("div");
    row.className = "badge-row";
    for (const item of badges) row.append(item);
    return row;
  };

  const metric = (label, value) => {
    const item = document.createElement("dl");
    item.className = "metric";
    item.append(text("dt", label), text("dd", value));
    return item;
  };

  const entityRows = (items) => {
    const row = document.createElement("div");
    row.className = "entity-row";
    const list = document.createElement("dl");
    for (const [label, value] of items) list.append(text("dt", label), text("dd", value));
    row.append(list);
    return row;
  };

  const sourceLine = (payload) => {
    const source = payload && payload.source ? payload.source : null;
    const updated = payload && payload.lastUpdated ? payload.lastUpdated : null;
    return text("small", `source: ${source || "local static data"}${updated ? ` · updated: ${updated}` : ""}`, "source-line");
  };

  const getCard = (id) => document.querySelector(`[data-card-id="${id}"]`);

  async function fetchJson(path) {
    const response = await fetch(path, { cache: "no-store" });
    let body;
    try { body = await response.json(); } catch { body = { available: false, error: "Invalid JSON response" }; }
    if (!response.ok && !body.error) body.error = `HTTP ${response.status}`;
    return body;
  }

  function renderUnavailable(container, payload, fallback) {
    container.append(
      badgeRow(badge("unavailable", "error")),
      text("p", payload && payload.error ? payload.error : fallback, "notice"),
      payload && payload.detail ? text("small", payload.detail, "source-line") : document.createTextNode(""),
      sourceLine(payload || {}),
    );
  }

  function renderGraphStats(payload) {
    const container = getCard("graph-stats");
    if (!container) return;
    clear(container);
    if (!payload || payload.available === false) {
      renderUnavailable(container, payload, "Graph Studio unavailable");
      return;
    }
    const grid = document.createElement("div");
    grid.className = "metric-grid";
    grid.append(
      metric("Indexed block", payload.blockNumber),
      metric("Chain lag", payload.lag == null ? "unknown" : `${payload.lag} blocks`),
      metric("Confirmations", payload.confirmations == null ? "unknown" : `${payload.confirmations} blocks`),
      metric("Providers", payload.providerCount),
      metric("Audits", payload.auditCount),
      metric("Indexing errors", payload.hasIndexingErrors === false ? "false" : payload.hasIndexingErrors),
    );
    container.append(
      badgeRow(
        badge("live Studio endpoint", "ok"),
        badge(payload.confirmations == null ? "confirmations unknown" : `${payload.confirmations} confirmations`, payload.confirmations >= 12 ? "ok" : "warn"),
      ),
      grid,
      entityRows([
        ["Deployment", payload.deployment],
        ["Block hash", payload.blockHash],
        ["Block time", payload.blockTimestamp],
        ["Chain head RPC", payload.chainHeadRpc],
      ]),
      sourceLine(payload),
    );
  }

  function renderEnsEntity(label, entity) {
    const resolver = entity && entity.resolver ? entity.resolver : "TBD: parent-gated broadcast pending";
    return entityRows([
      ["Name", entity && entity.name],
      ["Role", label],
      ["Parent ENS", entity && entity.parent],
      ["Content hash", entity && entity.contentHash],
      ["Resolver address", resolver],
      ["Endpoint", entity && entity.endpoint],
    ]);
  }

  function renderEnsInfo(payload) {
    const container = getCard("ens-info");
    if (!container) return;
    clear(container);
    if (!payload || payload.available === false) {
      renderUnavailable(container, payload, "ENS info unavailable");
      return;
    }
    container.append(
      badgeRow(
        badge("parent gate required", "warn"),
        badge("no ENS broadcast performed", "warn"),
        badge(payload.network || "sepolia", "neutral"),
      ),
      renderEnsEntity("apex public viewer", payload.apex),
      renderEnsEntity("TEE verifier", payload.verifier),
      renderEnsEntity("gateway", payload.gateway),
      text("p", payload.notes, "notice"),
      sourceLine(payload),
    );
  }

  function renderEmptyProviderState(container, payload) {
    container.append(
      badgeRow(badge("empty Graph provider set", "warn"), badge("fixtures pending", "warn")),
      text("p", payload.message || "no providers registered yet — demo data fixtures pending.", "empty-state"),
      entityRows([
        ["Swarm", payload.swarm],
        ["Provider count", payload.providerCount],
        ["Audit count", payload.auditCount],
        ["Required stake rows", payload.requiredStakeCount],
        ["Graph block", payload.blockNumber],
      ]),
      sourceLine(payload),
    );
  }

  function providerCard(provider) {
    const section = document.createElement("section");
    section.className = "provider-card";
    section.append(text("h4", provider.id));
    const statusKind = provider.status === "eligible" ? "ok" : provider.status === "under-staked" ? "warn" : provider.status === "slashed" ? "error" : "neutral";
    section.append(badgeRow(badge(provider.status || "unknown", statusKind)));
    const list = document.createElement("dl");
    const pairs = [
      ["Stake", provider.stake],
      ["Required stake", provider.requiredStake],
      ["Audit count", provider.auditCount],
      ["Audit outcomes", JSON.stringify(provider.auditCounts || {})],
      ["Last audit", provider.lastAudit ? `${provider.lastAudit.outcome || "unknown"} @ ${provider.lastAudit.timestamp || "unknown"}` : "none"],
      ["Slash count", provider.slashCount],
      ["Profile", provider.profileId],
      ["Operator", provider.operator],
    ];
    for (const [label, value] of pairs) list.append(text("dt", label), text("dd", value));
    section.append(list);
    return section;
  }

  function renderProviderTrust(payload) {
    const container = getCard("provider-trust");
    if (!container) return;
    clear(container);
    if (!payload || payload.available === false) {
      renderUnavailable(container, payload, "Provider trust unavailable");
      return;
    }
    if (payload.empty || !Array.isArray(payload.providers) || payload.providers.length === 0) {
      renderEmptyProviderState(container, payload);
      return;
    }
    container.append(
      badgeRow(badge(`${payload.providerCount} provider(s)`, "ok"), badge(`${payload.auditCount} audit(s)`, "neutral")),
      entityRows([
        ["Swarm", payload.swarm],
        ["Graph block", payload.blockNumber],
        ["Required stake rows", payload.requiredStakeCount],
      ]),
    );
    for (const provider of payload.providers) container.append(providerCard(provider));
    container.append(sourceLine(payload));
  }

  async function hydrate() {
    for (const id of CARD_IDS) {
      const card = getCard(id);
      if (card) card.setAttribute("data-loading", "true");
    }
    const [graph, ens, providers] = await Promise.all([
      fetchJson("/api/graph-stats"),
      fetchJson("/api/ens-info"),
      fetchJson("/api/provider-trust"),
    ]);
    renderGraphStats(graph);
    renderEnsInfo(ens);
    renderProviderTrust(providers);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hydrate, { once: true });
  else hydrate();
})();
