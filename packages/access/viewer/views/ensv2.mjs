// W6 v3 ENSv2 frontend provenance badge.
//
// Renders a compact "Resolved via ENSv2 · Sepolia" badge backed by a real
// /v2/ens-discovery read, plus an expandable detail view with:
//   - ENS name (provider ENS / .eth name)
//   - resolved endpoint (from chain, not from signed offer)
//   - model profile digests (from chain)
//   - payment details (network/asset/receiver from chain)
//   - Graph history pointer (from chain)
//   - resolution time, block number, block hash
//
// Cache state is shown honestly:
//   fresh  - read within first half of TTL
//   valid  - read within TTL
//   stale  - TTL exceeded
//   expired- never read OR outside TTL window
//   unavailable - ENS RPC failed
//   conflicting - provider+error (e.g. ENS read succeeded but later failed)
//
// The module is intentionally NOT a closed Provider DTO. It exposes the raw
// chain reads as a separate provenance surface so the browser can show
// provenance without breaking the application-owned /v1/providers contract.
//
// IMPORTANT: this module is read-only. It must NOT be used for provider
// selection or quote/inference binding. The selection gate is still
// /v1/providers (closed Provider DTO) and the signed-offer equality check
// in packages/access/viewer/flow.mjs::resolveCandidate is preserved.

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === undefined || child === null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function fmtTinybar(baseUnits) {
  const n = Number(baseUnits);
  if (!Number.isFinite(n) || n === 0) return null;
  const hbar = n / 100_000_000;
  return `${hbar} HBAR`;
}

function truncateMid(s, head = 8, tail = 6) {
  if (typeof s !== "string") return "—";
  if (s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function shortHash(h) {
  if (typeof h !== "string" || !h.startsWith("0x")) return "—";
  return `${h.slice(0, 10)}…${h.slice(-8)}`;
}

function shortDigest(d) {
  if (typeof d !== "string") return "—";
  return `${d.slice(0, 18)}…${d.slice(-6)}`;
}

const STATE_LABEL = {
  fresh: "Fresh",
  valid: "Valid",
  stale: "Stale",
  expired: "Expired",
  unavailable: "Unavailable",
  conflicting: "Conflicting",
  disabled: "Disabled",
};

const STATE_EXPLAIN = {
  fresh: "Read within the last 15s of the 30s TTL window.",
  valid: "Read within the 30s TTL window.",
  stale: "Read is older than the 30s TTL; refresh recommended.",
  expired: "No successful read within the TTL window.",
  unavailable: "ENS RPC failed or timed out; no usable read.",
  conflicting: "Read succeeded but the supervisor's gate also reported an error.",
  disabled: "ENS discovery is not enabled on the supervisor.",
};

// networkShape — used to label the binding rows in the detail view.
function networkLabel(network) {
  if (!network) return "—";
  if (network === "hedera:testnet") return "Hedera testnet";
  return network;
}

function row(label, value, opts = {}) {
  const cls = opts.mono ? "receipt-row-text mono" : "receipt-row-text";
  return el("div", { class: "receipt-row", dataset: { state: opts.state ?? "neutral" } }, [
    el("dt", { text: label }),
    el("dd", {}, [el("span", { class: cls, text: value ?? "—" })]),
  ]);
}

// fetchEnsDiscovery — issues the read-only request and returns the JSON
// payload. Honors an external AbortSignal so the badge can be cancelled
// when the host page unmounts.
export async function fetchEnsDiscovery({ names, signal } = {}) {
  const url = new URL("/v2/ens-discovery", globalThis.location?.origin ?? "");
  for (const name of names ?? []) url.searchParams.append("name", name);
  const response = await fetch(url, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) {
    return {
      ok: false,
      enabled: false,
      reason: body?.error?.message ?? `HTTP ${response.status}`,
      providers: [],
      errors: (names ?? []).map((n) => ({ name: n, code: `HTTP_${response.status}` })),
      provenance: (names ?? []).map((n) => ({
        name: n,
        state: "unavailable",
        hasProvider: false,
        hasError: true,
        error: { code: `HTTP_${response.status}` },
        ageMs: null,
        ttlMs: null,
      })),
      observedAt: new Date().toISOString(),
      route: null,
    };
  }
  return body;
}

// renderEnsBadge — compact inline badge.
//
//   state shape:
//     ok       - read succeeded
//     pending  - reading
//     error    - read failed (or disabled)
//
//   data shape (after fetch):
//     provenance[i] = { name, state, hasProvider, hasError, provider, error }
export function renderEnsBadge(data, { providerId, onRefresh, state = "ok" } = {}) {
  const wrapper = el("span", { class: "ensv2-badge-wrap", dataset: { providerId } });

  const provenance = (data?.provenance ?? []).find(
    (p) => p.name?.toLowerCase() === providerId?.toLowerCase(),
  );
  const ensState = provenance?.state ?? (data?.enabled ? "expired" : "disabled");
  const cls = `ensv2-badge ensv2-badge-${ensState}`;
  const label =
    ensState === "fresh" || ensState === "valid"
      ? "Resolved via ENSv2 · Sepolia"
      : ensState === "stale"
        ? "ENSv2 read stale"
        : ensState === "expired"
          ? "ENSv2 read expired"
          : ensState === "unavailable"
            ? "ENSv2 unavailable"
            : ensState === "conflicting"
              ? "ENSv2 conflicting"
              : ensState === "disabled"
                ? "ENSv2 disabled"
                : "ENSv2…";
  const badge = el(
    "button",
    {
      type: "button",
      class: cls,
      title: STATE_EXPLAIN[ensState] ?? "ENSv2 status",
      dataset: { state: ensState, source: "/v2/ens-discovery" },
      onclick: (event) => {
        event.stopPropagation();
        const open = wrapper.classList.toggle("is-open");
        if (open && onRefresh) onRefresh();
      },
      text: state === "pending" ? "Resolving ENSv2…" : label,
    },
  );
  wrapper.append(badge);

  const detail = renderEnsDetail(data, { providerId });
  wrapper.append(detail);
  return wrapper;
}

export function renderEnsDetail(data, { providerId } = {}) {
  const detail = el(
    "details",
    { class: "ensv2-detail", dataset: { providerId } },
    [
      el("summary", { class: "ensv2-detail-summary", text: "ENSv2 detail" }),
    ],
  );

  const inner = el("div", { class: "ensv2-detail-inner" });

  if (!data) {
    inner.append(
      el("p", { class: "muted", text: "ENSv2 read has not started yet." }),
    );
    detail.append(inner);
    return detail;
  }

  if (!data.enabled) {
    inner.append(
      el("p", { class: "receipt-row", dataset: { state: "off" } }, [
        el("dt", { text: "ENSv2 discovery" }),
        el("dd", {}, [
          el("span", { class: "receipt-row-text", text: "Disabled on the supervisor." }),
        ]),
      ]),
    );
    inner.append(
      el("p", { class: "muted", text: data.reason ?? "Set W6_USE_ENS_DISCOVERY=1 in the supervisor env to enable." }),
    );
    detail.append(inner);
    return detail;
  }

  const provenance = (data.provenance ?? []).find(
    (p) => p.name?.toLowerCase() === providerId?.toLowerCase(),
  );
  const state = provenance?.state ?? "expired";

  inner.append(
    row("ENS state", `${STATE_LABEL[state] ?? state} · ${STATE_EXPLAIN[state] ?? ""}`, {
      state: state === "fresh" || state === "valid" ? "ok" : state === "unavailable" || state === "expired" ? "off" : "pending",
    }),
    row("ENSv2 route", data.route ?? "—"),
    row("Sepolia RPC", data.rpcHost ?? "—"),
    row("Read at", data.observedAt ?? "—"),
    row("Elapsed", `${data.elapsedMs ?? "—"} ms`),
    row("Cache TTL", `${Math.round((data.ttlMs ?? 0) / 1000)} s`),
  );

  if (provenance?.provider) {
    const p = provenance.provider;
    const source = p.source ?? {};
    const receiverShort = p.paymentReceiver
      ? `${p.paymentReceiver.slice(0, 6)}…${p.paymentReceiver.slice(-4)}`
      : "—";
    inner.append(
      row("Resolved endpoint", p.endpoint ?? "—", { mono: true }),
      row("Model profiles", (p.profileIds ?? []).map((d) => shortDigest(d)).join(", ") || "—"),
      row("Payment network", networkLabel(p.paymentNetwork)),
      row("Payment asset", p.paymentAsset ?? "—"),
      row("Payment receiver", `${p.paymentReceiver ?? "—"} (${receiverShort})`, { mono: true }),
      row("Graph history", p.historyEndpoint ?? "—", { mono: true }),
      row("Chain block", `#${source.blockNumber ?? "—"}`),
      row("Block hash", source.blockHash ? shortHash(source.blockHash) : "—"),
      row("Resolved at (ISO)", source.resolvedAt ?? "—"),
      row("Expires at (ISO)", source.expiresAt ?? "—"),
    );
  } else if (provenance?.error) {
    inner.append(
      row(
        "Error",
        `${provenance.error.code ?? "ENS_ERROR"}: ${provenance.error.message ?? ""}`,
        { state: "off" },
      ),
    );
  } else {
    inner.append(
      el("p", { class: "muted", text: "ENSv2 read returned no provider records for this name." }),
    );
  }

  detail.append(inner);
  return detail;
}

// renderEnsProvenanceBar — a top-of-page banner that summarizes the ENSv2
// reads for all configured names. Lives above the providers table so
// reviewers see "ENSv2 is wired and reading Sepolia" before they pick a row.
export function renderEnsProvenanceBar(data, { onRefresh } = {}) {
  const banner = el("div", {
    class: `ensv2-bar ensv2-bar-${data?.enabled ? (data?.ok ? "ok" : "warn") : "off"}`,
    "data-testid": "ensv2-bar",
  });
  const provenance = data?.provenance ?? [];
  const validCount = provenance.filter((p) => p.state === "fresh" || p.state === "valid").length;
  const totalCount = provenance.length;
  const title = data?.enabled
    ? `Resolved via ENSv2 · Sepolia (${validCount}/${totalCount} fresh)`
    : "ENSv2 discovery disabled";
  banner.append(
    el("div", { class: "ensv2-bar-text" }, [
      el("strong", { text: title }),
      el("span", {
        class: "ensv2-bar-meta",
        text: data?.route && data?.rpcHost ? `${data.route} · ${data.rpcHost}` : (data?.reason ?? ""),
      }),
    ]),
  );
  if (typeof onRefresh === "function") {
    banner.append(
      el("button", {
        type: "button",
        class: "text-button",
        onclick: () => onRefresh(),
        text: "Refresh lookup",
      }),
    );
  }
  return banner;
}

// compat — the providers view imports `el` and the helpers through a
// single module surface; re-export `el` so the same conventions apply.
export { el };