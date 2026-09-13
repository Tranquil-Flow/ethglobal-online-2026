// W6 — ENSv2 discovery lookups for the Try page.
//
// Read-only provenance surface backed by /v2/ens-discovery on the public
// edge (composition/w6-ens-discovery-http.mjs; GET ?name=<ens>.eth). The
// demo providers are pre-configured, so this lookup is informational only:
// it never changes the selected provider, and it never feeds the signed-
// offer equality gate in flow.mjs.
//
// Bounding rules (binding):
//   * 10s AbortController timeout per request; every error is caught and
//     returned as data — lookupEnsRecord() never rejects.
//   * A tiny session cache (30s TTL, matching the edge's own 30s ENS cache)
//     plus in-flight de-duplication keeps repeated re-renders from
//     re-querying the endpoint (the edge rate-limits /v2/ens-discovery).
//   * When the lookup fails the UI says so ("ENS lookup unavailable") —
//     resolved names / profile ids are never invented.

const DISCOVERY_PATH = "/v2/ens-discovery";
const LOOKUP_TIMEOUT_MS = 10_000;
const LOOKUP_CACHE_TTL_MS = 30_000;

/** Sepolia registry address the W6 ENSv2 records resolve through. */
export const ETHERSCAN_ADDRESS_URL =
  "https://sepolia.etherscan.io/address/0x4a1817d13e9cf196f471725176355c1234b63c70";

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "checked") node.checked = Boolean(value);
    else if (key === "value") node.value = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === undefined || child === null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** first 16 chars + "…" — the compact profile-id form used across the UI. */
export function shortProfileId(profileId, keep = 16) {
  if (typeof profileId !== "string" || profileId.length === 0) return null;
  return profileId.length > keep ? `${profileId.slice(0, keep)}…` : profileId;
}

// name (lowercased) -> { at, pending, value }. `pending` de-duplicates
// concurrent lookups for the same name; `value` caches the settled result.
const lookupCache = new Map();

async function requestEnsRecord(name, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(DISCOVERY_PATH, globalThis.location?.origin ?? "");
    url.searchParams.set("name", name);
    const response = await fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!body) {
      return {
        ok: false,
        name,
        error: {
          code: `HTTP_${response.status}`,
          message: `ENS discovery answered HTTP ${response.status}`,
        },
      };
    }
    if (body.enabled === false) {
      return {
        ok: false,
        name,
        error: {
          code: "DISCOVERY_DISABLED",
          message: body.reason ?? "ENS discovery is disabled on this deployment.",
        },
      };
    }
    if (!response.ok) {
      const firstError = body?.error ?? (body?.errors ?? [])[0] ?? (body?.provenance ?? [])[0]?.error ?? null;
      return {
        ok: false,
        name,
        error: {
          code: firstError?.code ?? `HTTP_${response.status}`,
          message: firstError?.message ?? `ENS discovery answered HTTP ${response.status}`,
        },
      };
    }
    const record = (body.providers ?? [])[0] ?? null;
    const provenance = (body.provenance ?? [])[0] ?? null;
    if (!record) {
      const firstError = provenance?.error ?? (body.errors ?? [])[0] ?? null;
      return {
        ok: false,
        name,
        error: {
          code: firstError?.code ?? "NO_RECORD",
          message: firstError?.message ?? "No ENSv2 record resolved for this name.",
        },
      };
    }
    return {
      ok: true,
      name: record.providerId ?? name,
      providerId: record.providerId ?? null,
      profileIds: Array.isArray(record.profileIds) ? record.profileIds : [],
      endpoint: record.endpoint ?? null,
      paymentNetwork: record.paymentNetwork ?? null,
      paymentAsset: record.paymentAsset ?? null,
      paymentReceiver: record.paymentReceiver ?? null,
      historyEndpoint: record.historyEndpoint ?? null,
      state: provenance?.state ?? null,
      blockNumber: record.source?.blockNumber ?? null,
      blockHash: record.source?.blockHash ?? null,
      resolvedAt: record.source?.resolvedAt ?? null,
      route: body.route ?? null,
    };
  } catch (error) {
    const aborted = error?.name === "AbortError";
    return {
      ok: false,
      name,
      error: {
        code: aborted ? "TIMEOUT" : "FETCH_FAILED",
        message: aborted
          ? `ENS lookup timed out after ${timeoutMs} ms`
          : error?.message ?? String(error),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bounded, cached, never-rejecting ENSv2 lookup for a single name.
 *
 * Returns a promise resolving to one of:
 *   { ok: true,  name, providerId, profileIds, endpoint, state, blockNumber, route }
 *   { ok: false, name, error: { code, message } }
 */
export function lookupEnsRecord(rawName, { timeoutMs = LOOKUP_TIMEOUT_MS, force = false } = {}) {
  const name = String(rawName ?? "").trim();
  if (!name) {
    return Promise.resolve({
      ok: false,
      name: "",
      error: { code: "EMPTY_NAME", message: "Enter an ENS name to resolve." },
    });
  }
  const key = name.toLowerCase();
  const now = Date.now();
  const hit = lookupCache.get(key);
  if (!force && hit) {
    if (hit.pending) return hit.pending;
    if (hit.value && now - hit.at < LOOKUP_CACHE_TTL_MS) return Promise.resolve(hit.value);
  }
  const entry = { at: now, pending: null, value: null };
  entry.pending = requestEnsRecord(name, timeoutMs)
    // Belt-and-braces: requestEnsRecord already catches everything, but a
    // stray rejection must not poison the cache entry forever.
    .catch((error) => ({
      ok: false,
      name,
      error: { code: "LOOKUP_FAILED", message: error?.message ?? String(error) },
    }))
    .then((value) => {
      entry.pending = null;
      entry.value = value;
      entry.at = Date.now();
      lookupCache.set(key, entry);
      return value;
    });
  lookupCache.set(key, entry);
  return entry.pending;
}

// --- render helpers --------------------------------------------------------

function resolvedChip(blockNumber) {
  return el("span", {
    class: "ledger-chip",
    title: `ENSv2 registry read on Sepolia via ${DISCOVERY_PATH}${blockNumber ? ` · block #${blockNumber}` : ""}`,
    text: "Resolved via ENSv2 · Sepolia",
  });
}

function profileNode(profileIds) {
  const first = Array.isArray(profileIds) ? profileIds[0] : null;
  const short = shortProfileId(first);
  if (!short) return el("span", { class: "muted", text: "no profile id" });
  return el("span", { class: "mono", title: profileIds.join(", "), text: short });
}

function renderResolvedLine(result) {
  return [
    resolvedChip(result.blockNumber),
    el("span", { class: "mono", text: result.name ?? result.providerId ?? "—" }),
    profileNode(result.profileIds),
    el("a", {
      href: ETHERSCAN_ADDRESS_URL,
      target: "_blank",
      rel: "noopener",
      text: "Sepolia Etherscan",
    }),
  ];
}

function renderUnavailableLine(result) {
  const code = result?.error?.code ?? "UNAVAILABLE";
  const message = result?.error?.message ?? "ENS lookup failed.";
  return [el("span", { class: "ens-error", title: `${code}: ${message}`, text: "ENS lookup unavailable" })];
}

/**
 * Mount the compact Try-page provenance line. Call after the node is in the
 * document; the async completion is a no-op when a newer render already
 * replaced the node (stale-render guard).
 */
export function mountEnsLine(node, rawName) {
  if (!node) return;
  lookupEnsRecord(rawName).then((result) => {
    if (!node.isConnected) return;
    node.replaceChildren(...(result.ok ? renderResolvedLine(result) : renderUnavailableLine(result)));
  });
}

/**
 * Mount the Advanced-mode lookup result for a user-typed ENS name. The
 * result is informational only: the selected provider is never changed.
 */
export function mountEnsResult(node, rawName) {
  if (!node) return;
  lookupEnsRecord(rawName).then((result) => {
    if (!node.isConnected) return;
    if (result.ok) {
      const rows = [
        ["Provider", result.providerId ?? "—"],
        ["Profiles", (result.profileIds ?? []).join(", ") || "—"],
        ["Endpoint", result.endpoint ?? "—"],
        ["Payment", [result.paymentNetwork, result.paymentAsset, result.paymentReceiver].filter(Boolean).join(" · ") || "—"],
        ["History", result.historyEndpoint ?? "—"],
        [
          "Provenance",
          [
            result.blockNumber ? `block #${result.blockNumber}` : null,
            result.blockHash ? `0x${String(result.blockHash).slice(0, 10)}…` : null,
            result.resolvedAt ? `resolved ${whenAgo(result.resolvedAt)}` : null,
          ].filter(Boolean).join(" · ") || "—",
        ],
      ];
      node.replaceChildren(
        el("div", { class: "ens-result" }, [
          resolvedChip(result.blockNumber),
          el("dl", { class: "ens-record" }, rows.map(([dt, dd]) => [
            el("dt", { text: dt }),
            el("dd", { class: "mono", title: dd, text: dd }),
          ]).flat()),
          el("a", {
            href: ETHERSCAN_ADDRESS_URL,
            target: "_blank",
            rel: "noopener",
            text: "Sepolia Etherscan",
          }),
        ]),
      );
    } else {
      const code = result?.error?.code ?? "UNAVAILABLE";
      const message = result?.error?.message ?? "ENS lookup failed.";
      node.replaceChildren(
        el("span", { class: "ens-error", title: message, text: `ENS lookup failed — ${code}` }),
      );
    }
  });
}

function whenAgo(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "recently";
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}
