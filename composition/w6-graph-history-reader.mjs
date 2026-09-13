// SPDX-License-Identifier: AGPL-3.0-or-later
//
// W12 / Phase 8 — Graph history reader for the audit-selection seam.
//
// Purpose
//   `composition/w12-verifications-endpoint.mjs` exposes
//   `setAuditSelectionHistory(source)`; `source` must satisfy:
//
//     {
//       receipts(providerId) -> number      // integer receipt count, 0 default
//       uptimeDays(providerId) -> number    // observed active days, 0 default
//       graphInputs() -> object|null        // weighted-draw inputs, null when unknown
//     }
//
//   The endpoint consumes those accessors **synchronously** while it builds
//   the candidate list for `selectAuditTarget` (w12-audit-selection.mjs):
//
//     receipts:  history?.receipts?.(row.providerId) ?? 0
//     uptimeDays: history?.uptimeDays?.(row.providerId) ?? 0
//     graph:     history?.graphInputs?.() ?? null
//
//   Therefore this reader is *refresh-then-read*: `refresh()` performs the
//   bounded public subgraph reads asynchronously and freezes a snapshot;
//   the seam accessors are pure synchronous reads of that snapshot. Before
//   the first successful refresh (or if every refresh failed) the accessors
//   answer the honest defaults — receipts 0, uptimeDays 0, graphInputs null —
//   which routes the endpoint to its `unweighted-local-v1` branch rather than
//   inventing trust numbers.
//
// Deployment
//   Resolved 2026-09-13 by live evidence (docs/handoffs/w6-graph-history-plan.md):
//   the only Studio deployment that exposes the `ProviderMetrics` /
//   `ProviderTrustDay` entities the stats path reads is
//
//     https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.2
//     deployment QmdGh7TSS3qkpx55aG9eNxF96d6V3jSgtGD9JxyEbUJZtp
//
//   `v0.3.0-verification-ledger` answers `{"message":"Not found"}` and
//   `v0.3.1-bytes32-reconcile` has no provider-metrics entities at all. The
//   reader therefore defaults its endpoint to the resolved deployment but
//   always accepts an explicit `endpoint` (and falls back to the same env
//   vars the supervisor sets: W6_GRAPH_HISTORY_SUBGRAPH_URL, then
//   W6_PROVIDER_STATS_SUBGRAPH_URL).
//
// Indexed shapes used (verified live on v0.3.2, 2026-09-13)
//   * ProviderMetrics.id = `{chainId}:{contractAddress}:{providerKey}`;
//     keyed by `providerKey` = 0x + sha256(JSON.stringify(providerId))
//     (confirmed vector: sha256("service.ethonline-node-b.eth") =
//     0x0e3784695993340af930772b748c5bb6e9d1a0eceaadf1788c962535555b3667,
//     which is the providerKey of the single live ProviderMetrics row).
//     NB: this is sha256 over the JSON-encoded string (digestOf(providerId)),
//     not over the raw bytes of the ENS name.
//   * Counts and timestamps arrive as decimal strings (Graph BigInt); this
//     module converts safely and never returns NaN/Infinity.
//   * ProviderTrustDay rows are `{ProviderMetrics.id}:day:{day}` — one row per
//     observed activity day per provider — and carry `latestTimestamp` (s).
//   * ReceiptClaim has no timestamp column; the per-day timestamped history
//     comes from ProviderTrustDay, and per-request provenance comes from
//     ReceiptClaim.objectDigest/transactionHash/blockNumber/blockHash.
//
// HONESTY RULES
//   * Only public subgraph data is read. No local store, no HCS, no key file.
//   * `graphObservationDigest` is a digest over the exact snapshot the draw
//     used, in the workbench digest language (`sha256:` over RFC-8785-style
//     canonical JSON wrapped in `{"value": ...}` — the same vocabulary as
//     `selectionSeed` in w12-audit-selection.mjs). A judge can recompute it
//     from the published inputs; the block hash pins the subgraph state.
//   * On failure the previous snapshot is retained (last-known-good) and
//     `status()` reports the error; a never-populated reader answers the
//     0 / 0 / null defaults. Nothing is ever fabricated.
//
// Import-safe: no side effects at import, no timers, no network until
// `refresh()` / the observation lookups are called. Node >= 20 ESM, no
// dependencies beyond `node:crypto` and global fetch.

import { createHash } from "node:crypto";

/** The resolved Studio deployment (see plan doc). Overridable via options/env. */
export const W6_GRAPH_HISTORY_DEFAULT_ENDPOINT =
  "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.2";

export const GRAPH_HISTORY_REASONS = Object.freeze({
  ok: "graph.reader.fetched",
  noProviders: "graph.reader.no_providers",
  invalidProvider: "graph.reader.invalid_provider",
  invalidResponse: "graph.reader.invalid_response",
  unavailable: "graph.reader.unavailable",
  providerMissing: "graph.reader.provider_missing",
  digestUnknown: "graph.reader.digest_unknown",
});

export const GRAPH_HISTORY_CONST = Object.freeze({
  DEFAULT_ENDPOINT: W6_GRAPH_HISTORY_DEFAULT_ENDPOINT,
  MAX_PROVIDERS: 32,
  MAX_TRUST_DAYS: 400,
  TIMEOUT_MS: 12_000,
  STALE_AFTER_MS: 10 * 60 * 1000,
});

const OUTCOMES = Object.freeze([
  "pending",
  "passed",
  "mismatch",
  "inconclusive",
  "unavailable",
]);

function failure(code, extra) {
  const error = new Error(code);
  error.code = code;
  if (extra !== undefined) error.detail = extra;
  return error;
}

function isHex64(value) {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
}

function isSafeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Parse a Graph BigInt-as-decimal-string (or a JSON number) into a safe
 * non-negative integer. Returns `null` when the value is unusable so callers
 * can decide between 0 (counts) and null (timestamps).
 */
export function parseGraphCount(value) {
  if (typeof value === "number") return isSafeCount(value) ? value : null;
  if (typeof value === "string" && /^\d{1,16}$/.test(value)) {
    const n = Number(value);
    return isSafeCount(n) ? n : null;
  }
  return null;
}

/**
 * The indexed provider key for a providerId: `0x` + sha256 of the JSON-encoded
 * providerId (the workbench's `digestOf(providerId)` vocabulary). Verified
 * against the live v0.3.2 row for `service.ethonline-node-b.eth`.
 */
export function providerKeyOf(providerId) {
  if (typeof providerId !== "string" || providerId.length === 0) return null;
  return (
    "0x" +
    createHash("sha256").update(JSON.stringify(providerId), "utf8").digest("hex")
  );
}

/** RFC-8785-style canonical JSON, mirroring `selectionSeed`'s canonicalizer. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

/** Workbench digest language: sha256 over `{"value":<canonical>}`. */
function digestOfCanonical(value) {
  return (
    "sha256:" +
    createHash("sha256").update(`{"value":${canonical(value)}}`).digest("hex")
  );
}

/**
 * The published observation digest for a snapshot. Inputs are exactly the
 * fields the draw uses (plus the indexed block); order-independent (providers
 * are sorted by providerId), so any party can recompute it from the same
 * public subgraph state.
 */
export function graphObservationDigest({ deployment, blockNumber, blockHash, providers }) {
  const rows = (Array.isArray(providers) ? providers : [])
    .map((p) => ({
      providerId: String(p?.providerId ?? ""),
      providerKey: p?.providerKey ?? null,
      receiptCount: parseGraphCount(p?.receiptCount) ?? 0,
      assessmentCount: parseGraphCount(p?.assessmentCount) ?? 0,
      mismatchCount: parseGraphCount(p?.mismatchCount) ?? 0,
      matchCount: parseGraphCount(p?.matchCount) ?? 0,
      trustScore: parseGraphCount(p?.trustScore) ?? 0,
      latestActivityTimestamp: parseGraphCount(p?.latestActivityTimestamp),
      activeReceiptDays7: parseGraphCount(p?.activeReceiptDays7) ?? 0,
      observedDays: parseGraphCount(p?.observedDays) ?? 0,
    }))
    .sort((a, b) => (a.providerId < b.providerId ? -1 : 1));
  return digestOfCanonical({
    deployment: typeof deployment === "string" ? deployment : null,
    blockNumber: isSafeCount(blockNumber) ? blockNumber : null,
    blockHash: isHex64(blockHash) ? blockHash : null,
    providers: rows,
  });
}

const META_QUERY = `query W6GraphReaderMeta { _meta { deployment hasIndexingErrors block { number hash timestamp } } }`;

const METRIC_FIELDS =
  "id providerKey receiptCount assessmentCount matchCount mismatchCount trustScore latestActivityTimestamp activeReceiptDays7 latestActivityDay formulaVersion";

const DAY_FIELDS = "id day receiptCount assessmentCount latestTimestamp";

function metricsQuery(count) {
  const params = [];
  const aliases = [];
  for (let i = 0; i < count; i++) {
    params.push(`$k${i}: Bytes!`);
    aliases.push(
      `m${i}: providerMetrics_collection(first: 1, where: { providerKey: $k${i} }) { ${METRIC_FIELDS} }`,
    );
  }
  return `query W6GraphReaderMetrics(${params.join(", ")}) { ${aliases.join(" ")} }`;
}

function trustDaysQuery(count) {
  const params = ["$limit: Int!"];
  const aliases = [];
  for (let i = 0; i < count; i++) {
    params.push(`$k${i}: Bytes!`);
    aliases.push(
      `d${i}: providerTrustDays(first: $limit, where: { providerKey: $k${i} }, orderBy: day, orderDirection: desc) { ${DAY_FIELDS} }`,
    );
  }
  return `query W6GraphReaderDays(${params.join(", ")}) { ${aliases.join(" ")} }`;
}

const OBSERVATION_QUERY = `query W6GraphProviderObservation($key: Bytes!, $limit: Int!) {
  receipts: receiptClaims(first: $limit, orderBy: blockNumber, orderDirection: desc, where: { providerKey: $key }) {
    id objectDigest providerKey mode chainId contractAddress publisher transactionHash blockNumber blockHash logIndex
  }
  trustDays: providerTrustDays(first: $limit, where: { providerKey: $key }, orderBy: day, orderDirection: desc) {
    id day receiptCount assessmentCount latestTimestamp
  }
}`;

const RECEIPT_QUERY = `query W6GraphReceiptObservation($digest: Bytes!, $limit: Int!) {
  receipt: receiptClaims(first: 1, where: { objectDigest: $digest }) {
    id objectDigest providerKey mode chainId contractAddress publisher transactionHash blockNumber blockHash logIndex
  }
  assessments: assessmentClaims(first: $limit, where: { receiptDigest: $digest }) {
    id objectDigest receiptDigest outcome mode valid verifierKey methodKey transactionHash blockNumber blockHash logIndex
  }
  openAssessments: openAssessmentClaims(first: $limit, where: { receiptDigest: $digest }) {
    id statementDigest objectDigest receiptDigest outcome mode valid linked verifierKey methodKey transactionHash blockNumber blockHash logIndex
  }
}`;

function normaliseProviderIds(input, maxProviders) {
  const raw = Array.isArray(input) ? input : [];
  const out = [];
  for (const id of raw) {
    if (typeof id !== "string" || id.length === 0 || id.length > 256) continue;
    if (!out.includes(id)) out.push(id);
    if (out.length >= maxProviders) break;
  }
  return out;
}

function mapReceiptRow(row) {
  if (!row || typeof row !== "object") return null;
  const blockNumber = parseGraphCount(row.blockNumber);
  const logIndex = parseGraphCount(row.logIndex);
  if (!isHex64(row.objectDigest) || !isHex64(row.transactionHash) || !isHex64(row.blockHash)) {
    return null;
  }
  if (blockNumber === null || logIndex === null) return null;
  return Object.freeze({
    objectDigest: row.objectDigest.toLowerCase(),
    providerKey: typeof row.providerKey === "string" ? row.providerKey.toLowerCase() : null,
    mode: parseGraphCount(row.mode ?? 0) ?? 0,
    chainId: typeof row.chainId === "string" ? row.chainId : null,
    contractAddress:
      typeof row.contractAddress === "string" ? row.contractAddress.toLowerCase() : null,
    publisher: typeof row.publisher === "string" ? row.publisher.toLowerCase() : null,
    transactionHash: row.transactionHash,
    blockNumber,
    blockHash: row.blockHash,
    logIndex,
  });
}

function mapDayRow(row) {
  if (!row || typeof row !== "object") return null;
  const day = parseGraphCount(row.day);
  const seconds = parseGraphCount(row.latestTimestamp);
  if (day === null) return null;
  return Object.freeze({
    day,
    receiptCount: parseGraphCount(row.receiptCount) ?? 0,
    assessmentCount: parseGraphCount(row.assessmentCount) ?? 0,
    latestTimestamp: seconds,
    latestAt: seconds === null ? null : new Date(seconds * 1000).toISOString(),
  });
}

function mapAssessmentRow(row) {
  if (!row || typeof row !== "object") return null;
  const outcomeIndex = parseGraphCount(row.outcome ?? -1);
  return Object.freeze({
    objectDigest: typeof row.objectDigest === "string" ? row.objectDigest : null,
    statementDigest: typeof row.statementDigest === "string" ? row.statementDigest : null,
    receiptDigest: typeof row.receiptDigest === "string" ? row.receiptDigest : null,
    outcome: outcomeIndex === null ? null : OUTCOMES[outcomeIndex] ?? null,
    outcomeIndex,
    valid: row.valid === true,
    linked: row.linked === undefined ? null : row.linked === true,
    verifierKey: typeof row.verifierKey === "string" ? row.verifierKey : null,
    methodKey: typeof row.methodKey === "string" ? row.methodKey : null,
    transactionHash: typeof row.transactionHash === "string" ? row.transactionHash : null,
    blockNumber: parseGraphCount(row.blockNumber),
    blockHash: typeof row.blockHash === "string" ? row.blockHash : null,
    logIndex: parseGraphCount(row.logIndex),
  });
}

/** sha256:<hex> (workbench digest) or 0x<64 hex> (on-chain bytes32) -> 0x form. */
function toBytes32Digest(value) {
  if (isHex64(value)) return value.toLowerCase();
  if (typeof value === "string" && /^sha256:[0-9a-f]{64}$/i.test(value)) {
    return "0x" + value.slice(7).toLowerCase();
  }
  return null;
}

/**
 * Build the Graph history reader.
 *
 * @param {object} [options]
 * @param {string} [options.endpoint]  Studio query URL. Default: env
 *        W6_GRAPH_HISTORY_SUBGRAPH_URL ?? W6_PROVIDER_STATS_SUBGRAPH_URL ??
 *        W6_GRAPH_HISTORY_DEFAULT_ENDPOINT.
 * @param {Function} [options.fetch]   transport (default globalThis.fetch).
 * @param {Function} [options.now]     clock (default Date.now).
 * @param {number} [options.timeoutMs] per-request budget (default 12s).
 * @param {number} [options.maxProviders] bounded provider fan-out (default 32).
 * @param {number} [options.maxTrustDays] trust-day row cap per provider (default 400).
 * @param {Function} [options.hcsSequence] optional () => string|null supplying
 *        the previous HCS sequence hash for the seed inputs (the subgraph
 *        cannot know it).
 * @param {number|Function} [options.epoch] optional epoch for the seed inputs (default 0).
 * @returns {{
 *   endpoint: string,
 *   refresh: (args?: {providerIds?: string[]}) => Promise<object>,
 *   status: () => object,
 *   receipts: (providerId: string) => number,
 *   uptimeDays: (providerId: string) => number,
 *   graphInputs: () => object|null,
 *   providerObservation: (providerId: string, args?: {limit?: number}) => Promise<object>,
 *   receiptObservation: (digest: string, args?: {limit?: number}) => Promise<object>,
 * }}
 */
export function createGraphHistoryReader(options = {}) {
  const envEndpoint =
    typeof process !== "undefined" && process?.env
      ? process.env.W6_GRAPH_HISTORY_SUBGRAPH_URL ?? process.env.W6_PROVIDER_STATS_SUBGRAPH_URL
      : undefined;
  const endpoint =
    options.endpoint ?? envEndpoint ?? W6_GRAPH_HISTORY_DEFAULT_ENDPOINT;
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw failure("INVALID_ENDPOINT");
  }
  try {
    // eslint-disable-next-line no-new
    new URL(endpoint);
  } catch {
    throw failure("INVALID_ENDPOINT");
  }
  const transport = options.fetch === undefined ? globalThis.fetch : options.fetch;
  if (typeof transport !== "function") throw failure("INVALID_TRANSPORT");
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const timeoutMs =
    Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : GRAPH_HISTORY_CONST.TIMEOUT_MS;
  const maxProviders =
    Number.isSafeInteger(options.maxProviders) && options.maxProviders > 0
      ? Math.min(options.maxProviders, GRAPH_HISTORY_CONST.MAX_PROVIDERS)
      : GRAPH_HISTORY_CONST.MAX_PROVIDERS;
  const maxTrustDays =
    Number.isSafeInteger(options.maxTrustDays) && options.maxTrustDays > 0
      ? options.maxTrustDays
      : GRAPH_HISTORY_CONST.MAX_TRUST_DAYS;
  const staleAfterMs =
    Number.isSafeInteger(options.staleAfterMs) && options.staleAfterMs >= 0
      ? options.staleAfterMs
      : GRAPH_HISTORY_CONST.STALE_AFTER_MS;
  const hcsSequence = typeof options.hcsSequence === "function" ? options.hcsSequence : null;
  const epochOption = options.epoch;

  let snapshot = null; // frozen last-known-good snapshot
  let requestedIds = [];
  let lastError = null; // { code, message, atMs }

  async function post(query, variables) {
    let response;
    try {
      response = await transport(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw failure("GRAPH_UNAVAILABLE", error?.message);
    }
    if (!response || typeof response.status !== "number") {
      throw failure("GRAPH_UNAVAILABLE", "no response");
    }
    if (response.status !== 200) {
      throw failure("GRAPH_UNAVAILABLE", `HTTP ${response.status}`);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw failure("GRAPH_INVALID_RESPONSE", "body is not JSON");
    }
    if (body?.errors?.length) {
      const first = body.errors[0]?.message ?? "graphql error";
      throw failure("GRAPH_QUERY_ERROR", String(first).slice(0, 200));
    }
    if (!body || typeof body.data !== "object" || body.data === null) {
      throw failure("GRAPH_INVALID_RESPONSE", "no data");
    }
    return body.data;
  }

  function parseMeta(data) {
    const meta = data?._meta;
    if (
      !meta ||
      meta.hasIndexingErrors !== false ||
      typeof meta.deployment !== "string" ||
      meta.deployment.length === 0 ||
      !isSafeCount(meta.block?.number) ||
      !isHex64(meta.block?.hash) ||
      !isSafeCount(meta.block?.timestamp)
    ) {
      throw failure("GRAPH_INVALID_META");
    }
    return {
      deployment: meta.deployment,
      blockNumber: meta.block.number,
      blockHash: meta.block.hash.toLowerCase(),
      blockTimestamp: meta.block.timestamp,
    };
  }

  /**
   * Fetch and freeze a new snapshot. Never throws: failures are recorded on
   * `status().lastError` and the previous snapshot (if any) is retained.
   */
  async function refresh({ providerIds } = {}) {
    const ids = normaliseProviderIds(providerIds ?? requestedIds, maxProviders);
    if (ids.length === 0) {
      lastError = {
        code: GRAPH_HISTORY_REASONS.noProviders,
        message: "refresh requires 1..maxProviders providerIds",
        atMs: now(),
      };
      return { ...status(), ok: false, reason: GRAPH_HISTORY_REASONS.noProviders };
    }
    try {
      const meta = parseMeta(await post(META_QUERY, {}));
      const keys = ids.map((id) => providerKeyOf(id));
      const metricsVars = {};
      keys.forEach((key, i) => {
        metricsVars[`k${i}`] = key;
      });
      const metricsData = await post(metricsQuery(ids.length), metricsVars);
      const daysVars = { limit: maxTrustDays, ...metricsVars };
      const daysData = await post(trustDaysQuery(ids.length), daysVars);

      const providers = new Map();
      for (let i = 0; i < ids.length; i++) {
        const providerId = ids[i];
        const providerKey = keys[i];
        const metricsRow = (metricsData?.[`m${i}`] ?? [])[0] ?? null;
        const dayRows = Array.isArray(daysData?.[`d${i}`]) ? daysData[`d${i}`] : [];
        const trustDays = dayRows.map(mapDayRow).filter(Boolean);
        const observedDays = trustDays.length;
        const trustDaysTruncated = dayRows.length >= maxTrustDays;

        let row;
        if (metricsRow && typeof metricsRow === "object") {
          const receiptCount = parseGraphCount(metricsRow.receiptCount) ?? 0;
          const assessmentCount = parseGraphCount(metricsRow.assessmentCount) ?? 0;
          // Observed active days: trust-day rows are the per-day activity
          // history. When none are indexed yet but on-chain claims exist, the
          // provider was active on at least one day (floor, never an invention).
          const uptimeDays =
            observedDays > 0 ? observedDays : receiptCount > 0 || assessmentCount > 0 ? 1 : 0;
          row = {
            providerId,
            providerKey,
            found: true,
            metricsId: typeof metricsRow.id === "string" ? metricsRow.id : null,
            receiptCount,
            assessmentCount,
            matchCount: parseGraphCount(metricsRow.matchCount) ?? 0,
            mismatchCount: parseGraphCount(metricsRow.mismatchCount) ?? 0,
            trustScore: parseGraphCount(metricsRow.trustScore) ?? 0,
            latestActivityTimestamp: parseGraphCount(metricsRow.latestActivityTimestamp),
            activeReceiptDays7: parseGraphCount(metricsRow.activeReceiptDays7) ?? 0,
            latestActivityDay: parseGraphCount(metricsRow.latestActivityDay),
            formulaVersion:
              typeof metricsRow.formulaVersion === "string" ? metricsRow.formulaVersion : null,
            observedDays,
            trustDaysTruncated,
            uptimeDays,
          };
        } else {
          row = {
            providerId,
            providerKey,
            found: false,
            metricsId: null,
            receiptCount: 0,
            assessmentCount: 0,
            matchCount: 0,
            mismatchCount: 0,
            trustScore: 0,
            latestActivityTimestamp: null,
            activeReceiptDays7: 0,
            latestActivityDay: null,
            formulaVersion: null,
            observedDays: 0,
            trustDaysTruncated: false,
            uptimeDays: 0,
          };
        }
        providers.set(providerId, Object.freeze(row));
      }

      const digest = graphObservationDigest({
        deployment: meta.deployment,
        blockNumber: meta.blockNumber,
        blockHash: meta.blockHash,
        providers: [...providers.values()],
      });
      snapshot = Object.freeze({
        deployment: meta.deployment,
        blockNumber: meta.blockNumber,
        blockHash: meta.blockHash,
        blockTimestamp: meta.blockTimestamp,
        fetchedAtMs: now(),
        providers,
        digest,
      });
      requestedIds = ids;
      lastError = null;
      return { ...status(), ok: true, reason: GRAPH_HISTORY_REASONS.ok };
    } catch (error) {
      lastError = {
        code: typeof error?.code === "string" ? error.code : "GRAPH_READER_ERROR",
        message: typeof error?.message === "string" ? error.message : String(error),
        atMs: now(),
      };
      return { ...status(), ok: false, reason: lastError.code };
    }
  }

  function status() {
    const ageMs = snapshot ? Math.max(0, now() - snapshot.fetchedAtMs) : null;
    return {
      ok: snapshot !== null,
      endpoint,
      deployment: snapshot?.deployment ?? null,
      blockNumber: snapshot?.blockNumber ?? null,
      blockHash: snapshot?.blockHash ?? null,
      blockTimestamp: snapshot?.blockTimestamp ?? null,
      refreshedAtMs: snapshot?.fetchedAtMs ?? null,
      ageMs,
      stale: snapshot ? ageMs > staleAfterMs : false,
      providers: snapshot?.providers.size ?? 0,
      digest: snapshot?.digest ?? null,
      lastError,
    };
  }

  function rowFor(providerId) {
    if (!snapshot || typeof providerId !== "string") return null;
    return snapshot.providers.get(providerId) ?? null;
  }

  /** Seam accessor: integer receipt count from the last snapshot (0 default). */
  function receipts(providerId) {
    const row = rowFor(providerId);
    return row ? row.receiptCount : 0;
  }

  /** Seam accessor: observed active days from the last snapshot (0 default). */
  function uptimeDays(providerId) {
    const row = rowFor(providerId);
    return row ? row.uptimeDays : 0;
  }

  /**
   * Seam accessor: weighted-draw inputs. Exactly the keys
   * `selectAuditTarget` reads; null until a snapshot exists (which keeps the
   * endpoint on its honest unweighted branch).
   */
  function graphInputs() {
    if (!snapshot) return null;
    let previousHcsSequenceHash = null;
    if (hcsSequence) {
      try {
        previousHcsSequenceHash = hcsSequence() ?? null;
      } catch {
        previousHcsSequenceHash = null;
      }
    }
    const epoch =
      typeof epochOption === "function"
        ? parseGraphCount(epochOption()) ?? 0
        : parseGraphCount(epochOption) ?? 0;
    return {
      previousHcsSequenceHash,
      graphObservationDigest: snapshot.digest,
      blockHash: snapshot.blockHash,
      epoch,
    };
  }

  /**
   * Per-provider observation for the Requests ledger: recent receipt claims
   * (immutable, no timestamp column) plus the timestamped per-day history.
   * Live read on demand; never throws.
   */
  async function providerObservation(providerId, { limit = 10 } = {}) {
    const providerKey = providerKeyOf(providerId);
    const bound = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 10;
    if (!providerKey) {
      return {
        ok: false,
        reason: GRAPH_HISTORY_REASONS.invalidProvider,
        providerId: providerId ?? null,
        providerKey: null,
        receipts: [],
        trustDays: [],
      };
    }
    try {
      const data = await post(OBSERVATION_QUERY, { key: providerKey, limit: bound });
      const receiptRows = Array.isArray(data?.receipts) ? data.receipts : [];
      const dayRows = Array.isArray(data?.trustDays) ? data.trustDays : [];
      const receiptList = receiptRows.map(mapReceiptRow).filter(Boolean);
      return {
        ok: true,
        reason: GRAPH_HISTORY_REASONS.ok,
        endpoint,
        providerId,
        providerKey,
        receipts: receiptList,
        trustDays: dayRows.map(mapDayRow).filter(Boolean),
        truncated: receiptRows.length >= bound || dayRows.length >= bound,
      };
    } catch (error) {
      return {
        ok: false,
        reason: typeof error?.code === "string" ? error.code : GRAPH_HISTORY_REASONS.unavailable,
        detail: typeof error?.message === "string" ? error.message : null,
        providerId,
        providerKey,
        receipts: [],
        trustDays: [],
      };
    }
  }

  /**
   * Per-request observation for the ledger ("the Graph observation for that
   * job"): the receipt claim for a digest plus its linked assessments.
   * Accepts `sha256:<hex>` (workbench vocabulary) or `0x<bytes32>`.
   * Live read on demand; never throws.
   */
  async function receiptObservation(receiptDigest, { limit = 10 } = {}) {
    const digest = toBytes32Digest(receiptDigest);
    const bound = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 10;
    if (!digest) {
      return {
        ok: false,
        reason: GRAPH_HISTORY_REASONS.invalidProvider,
        receiptDigest: receiptDigest ?? null,
        receipt: null,
        assessments: [],
        openAssessments: [],
      };
    }
    try {
      const data = await post(RECEIPT_QUERY, { digest, limit: bound });
      const receipt = mapReceiptRow((data?.receipt ?? [])[0] ?? null);
      const assessments = (Array.isArray(data?.assessments) ? data.assessments : [])
        .map(mapAssessmentRow)
        .filter(Boolean);
      const openAssessments = (Array.isArray(data?.openAssessments) ? data.openAssessments : [])
        .map(mapAssessmentRow)
        .filter(Boolean);
      return {
        ok: receipt !== null,
        reason: receipt ? GRAPH_HISTORY_REASONS.ok : GRAPH_HISTORY_REASONS.providerMissing,
        endpoint,
        receiptDigest: digest,
        receipt,
        assessments,
        openAssessments,
      };
    } catch (error) {
      return {
        ok: false,
        reason: typeof error?.code === "string" ? error.code : GRAPH_HISTORY_REASONS.unavailable,
        detail: typeof error?.message === "string" ? error.message : null,
        receiptDigest: digest,
        receipt: null,
        assessments: [],
        openAssessments: [],
      };
    }
  }

  return Object.freeze({
    endpoint,
    refresh,
    status,
    receipts,
    uptimeDays,
    graphInputs,
    providerObservation,
    receiptObservation,
  });
}
