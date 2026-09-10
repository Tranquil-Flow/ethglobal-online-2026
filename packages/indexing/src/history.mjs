import { digestOf, validate } from "../../contracts/index.mjs";
import {
  validateEvent,
  digest,
  failure,
  deadline,
  bounded,
  checkAbort,
  modes,
  outcomes,
} from "./common.mjs";
import { validateDeployment } from "./config.mjs";

const META = `query IndexHead { _meta { deployment hasIndexingErrors block { number hash timestamp } } }`;
const STABLE_META = `query StableHead($block: Bytes!) { _meta(block: {hash: $block}) { deployment hasIndexingErrors block { number hash timestamp } } }`;
export const PROVIDER_QUERY = `query ProviderHistory($provider: Bytes!, $block: Bytes!, $limit: Int!) {
 _meta(block: {hash: $block}) { deployment hasIndexingErrors block { number hash timestamp } }
 assessmentClaims(first: $limit, orderBy: blockNumber, orderDirection: desc, where: {providerKey: $provider}, block: {hash: $block}) {
  id objectDigest receiptDigest providerKey verifierKey methodKey outcome mode publicMetadata valid
  chainId contractAddress transactionHash blockNumber blockHash logIndex publisher
 }
 openAssessmentClaims(first: $limit, orderBy: blockNumber, orderDirection: desc, where: {providerKey: $provider}, block: {hash: $block}) {
  id statementDigest objectDigest receiptDigest providerKey verifierKey methodKey outcome mode publicMetadata valid linked
  chainId contractAddress transactionHash blockNumber blockHash logIndex author relayer
 }
}`;
export const RECEIPT_QUERY = `query ReceiptHistory($receipt: Bytes!, $block: Bytes!) {
 receiptClaims(first: 1, where: {objectDigest: $receipt}, block: {hash: $block}) {
  id objectDigest providerKey mode chainId contractAddress transactionHash blockNumber blockHash logIndex publisher
 }
 assessmentClaims(first: 100, where: {receiptDigest: $receipt}, block: {hash: $block}) {
  id objectDigest receiptDigest verifierKey methodKey outcome mode valid publicMetadata transactionHash blockNumber blockHash logIndex
 }
 openAssessmentClaims(first: 100, where: {receiptDigest: $receipt}, block: {hash: $block}) {
  id statementDigest objectDigest receiptDigest providerKey verifierKey methodKey outcome mode valid linked publicMetadata transactionHash blockNumber blockHash logIndex author relayer chainId contractAddress
 }
}`;

export function createGraphClient({
  endpoint,
  token,
  fetch: fetchImpl = globalThis.fetch,
  allowLocal = false,
  maxBytes = 2 * 1024 * 1024,
}) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw failure("INVALID_GRAPH_CONFIG");
  }
  const local = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (allowLocal && local && url.protocol === "http:")
    ) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1024 ||
    maxBytes > 4 * 1024 * 1024 ||
    (token && (!/^[\x21-\x7e]+$/.test(token) || token.length > 4096))
  )
    throw failure("INVALID_GRAPH_CONFIG");
  return {
    async query({ query, variables = {}, signal }) {
      const sig = deadline(signal, 5000);
      try {
        const response = await bounded(
          fetchImpl(url, {
            method: "POST",
            redirect: "error",
            signal: sig,
            headers: {
              "content-type": "application/json",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ query, variables }),
          }),
          sig,
        );
        if (!response.ok || !response.body)
          throw failure("GRAPH_UNAVAILABLE", true);
        const reader = response.body.getReader();
        let bytes = 0;
        const chunks = [];
        try {
          for (;;) {
            const { done, value } = await bounded(reader.read(), sig);
            if (done) break;
            bytes += value.length;
            if (bytes > maxBytes) throw failure("GRAPH_BOUNDS");
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (body.errors?.length || !body.data)
          throw failure("GRAPH_UNAVAILABLE", true);
        return body.data;
      } catch (e) {
        if (e?.retryable !== undefined) throw e;
        throw failure("GRAPH_UNAVAILABLE", true);
      }
    },
  };
}
export function historyReasons(history, { trustedVerifiers = [] } = {}) {
  if (history.freshness === "unavailable") return ["HISTORY_UNAVAILABLE"];
  if (history.freshness === "stale") return ["HISTORY_STALE"];
  if (!history.observations.length) return ["HISTORY_UNKNOWN"];
  const reasons = [];
  if (
    history.observations.some((a) => !trustedVerifiers.includes(a.verifierId))
  )
    reasons.push("UNKNOWN_VERIFIER");
  if (history.observations.some((a) => a.outcome === "mismatch"))
    reasons.push("ASSESSMENT_MISMATCH");
  if (
    history.observations.some((a) =>
      ["unavailable", "inconclusive", "pending"].includes(a.outcome),
    )
  )
    reasons.push("ASSESSMENT_UNAVAILABLE");
  return reasons.length ? reasons : ["HISTORY_OBSERVED"];
}
function historyConfig(config) {
  if (
    !modes.includes(config.mode) ||
    !/^\d{1,16}$/.test(String(config.chainId))
  )
    throw failure("INVALID_HISTORY_CONFIG");
  const maxAgeMs = config.maxAgeMs ?? 300000,
    limit = config.limit ?? 100,
    timeoutMs = config.timeoutMs ?? 5000;
  if (
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs < 1 ||
    maxAgeMs > 86400000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 10 ||
    timeoutMs > 30000
  )
    throw failure("INVALID_HISTORY_CONFIG");
  const c = { ...config, maxAgeMs, limit, timeoutMs };
  if (config.deployment) {
    c.deployment = validateDeployment(config.deployment);
    if (
      String(c.deployment.chainId) !== String(c.chainId) ||
      c.deployment.mode !== c.mode ||
      typeof c.deploymentId !== "string" ||
      !c.deploymentId.length ||
      c.deploymentId.length > 256
    )
      throw failure("INVALID_HISTORY_CONFIG");
  }
  return c;
}
export function createHistory({ config, client, provider } = {}) {
  const c = historyConfig(config || { mode: "development", chainId: "31337" });
  return {
    async getHistory({ providerId, signal }) {
      return (
        await queryProviderHistory({
          config: c,
          client,
          provider,
          providerId,
          signal,
        })
      ).history;
    },
  };
}
function sameHash(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    a.toLowerCase() === b.toLowerCase()
  );
}
function canonicalBlock(block, number) {
  if (
    !block ||
    block.number !== number ||
    !/^0x[0-9a-f]{64}$/i.test(block.hash) ||
    !Number.isSafeInteger(block.timestamp)
  )
    throw failure("INVALID_INDEX");
  return block;
}
function assertCommon(row, c, meta, providerKey) {
  if (
    typeof row.blockNumber !== "string" ||
    !/^\d{1,16}$/.test(row.blockNumber) ||
    typeof row.logIndex !== "string" ||
    !/^\d{1,16}$/.test(row.logIndex) ||
    !Number.isInteger(row.mode) ||
    !Number.isInteger(row.outcome) ||
    row.valid !== true ||
    String(row.chainId) !== String(c.chainId) ||
    row.providerKey?.toLowerCase() !== providerKey ||
    !/^0x[0-9a-f]{64}$/i.test(row.transactionHash) ||
    !/^0x[0-9a-f]{64}$/i.test(row.blockHash) ||
    !Number.isSafeInteger(Number(row.blockNumber)) ||
    Number(row.blockNumber) < c.deployment.startBlock ||
    Number(row.blockNumber) > meta.block.number ||
    !Number.isSafeInteger(Number(row.logIndex)) ||
    Number(row.logIndex) < 0 ||
    typeof row.publicMetadata !== "string" ||
    Buffer.byteLength(row.publicMetadata) > 8192 ||
    !/^0x[0-9a-f]{64}$/i.test(row.objectDigest) ||
    !/^0x[0-9a-f]{64}$/i.test(row.receiptDigest) ||
    !/^0x[0-9a-f]{64}$/i.test(row.verifierKey) ||
    !/^0x[0-9a-f]{64}$/i.test(row.methodKey)
  )
    throw failure("INVALID_OBSERVATION");
}
function parseObservation(row, c, meta, providerKey) {
  assertCommon(row, c, meta, providerKey);
  const a = JSON.parse(row.publicMetadata);
  validateEvent({
    version: "1",
    kind: "assessment",
    objectDigest: digest(row.objectDigest),
    receiptDigest: digest(row.receiptDigest),
    providerKey: digest(row.providerKey),
    verifierKey: digest(row.verifierKey),
    methodKey: digest(row.methodKey),
    outcome: outcomes[row.outcome],
    mode: modes[row.mode],
    assessment: a,
  });
  if (a.mode !== c.mode) throw failure("MODE_MISMATCH");
  return a;
}
function legacyObservation(row, c, meta, providerKey) {
  if (
    row.contractAddress?.toLowerCase() !== c.deployment.address.toLowerCase() ||
    row.publisher?.toLowerCase() !== c.deployment.publisher.toLowerCase()
  )
    throw failure("INVALID_OBSERVATION");
  return {
    assessment: parseObservation(row, c, meta, providerKey),
    key: row.objectDigest.toLowerCase(),
    provenance: {
      objectDigest: digest(row.objectDigest),
      transactionHash: row.transactionHash,
      blockNumber: Number(row.blockNumber),
      blockHash: row.blockHash,
      logIndex: Number(row.logIndex),
      publisher: row.publisher,
      contractAddress: row.contractAddress,
      chainId: String(row.chainId),
    },
  };
}
function openObservation(row, c, meta, providerKey) {
  const openAddress = (
    c.deployment.openRegistryAddress || c.deployment.address
  ).toLowerCase();
  if (
    row.contractAddress?.toLowerCase() !== openAddress ||
    row.linked !== false ||
    !/^0x[0-9a-f]{64}$/i.test(row.statementDigest) ||
    !/^0x[0-9a-f]{40}$/i.test(row.author) ||
    !/^0x[0-9a-f]{40}$/i.test(row.relayer)
  )
    throw failure("INVALID_OBSERVATION");
  return {
    assessment: parseObservation(row, c, meta, providerKey),
    key: row.statementDigest.toLowerCase(),
    provenance: {
      statementDigest: digest(row.statementDigest),
      objectDigest: digest(row.objectDigest),
      transactionHash: row.transactionHash,
      blockNumber: Number(row.blockNumber),
      blockHash: row.blockHash,
      logIndex: Number(row.logIndex),
      author: row.author,
      relayer: row.relayer,
      contractAddress: row.contractAddress,
      chainId: String(row.chainId),
    },
  };
}
export async function queryProviderHistory({
  config,
  client,
  provider,
  providerId,
  signal,
}) {
  const c = historyConfig(config);
  checkAbort(signal);
  if (
    typeof providerId !== "string" ||
    providerId.length < 1 ||
    providerId.length > 256
  )
    throw failure("INVALID_PROVIDER");
  const now = Date.now(),
    history = {
      version: "1",
      providerId,
      observations: [],
      freshness: "unavailable",
      chainId: String(c.chainId),
      observedAt: new Date(now).toISOString(),
      mode: c.mode,
    };
  const report = {
    history,
    reasons: [],
    counts: {},
    provenance: [],
    truncated: false,
  };
  if (client && c.deployment) {
    const sig = deadline(signal, c.timeoutMs);
    try {
      if (provider) {
        if (
          typeof provider.send !== "function" ||
          typeof provider.getBlock !== "function"
        )
          throw failure("INVALID_INDEX");
        const chainId = await bounded(provider.send("eth_chainId", []), sig);
        let actual;
        try {
          actual = BigInt(chainId).toString();
        } catch {
          throw failure("INVALID_INDEX");
        }
        if (actual !== String(c.chainId)) throw failure("CHAIN_MISMATCH");
      }
      let meta = (
        await bounded(client.query({ query: META, signal: sig }), sig)
      )._meta;
      if (
        !meta ||
        meta.hasIndexingErrors !== false ||
        meta.deployment !== c.deploymentId ||
        !Number.isSafeInteger(meta.block?.number) ||
        meta.block.number < c.deployment.startBlock ||
        !/^0x[0-9a-f]{64}$/i.test(meta.block.hash) ||
        !Number.isSafeInteger(meta.block.timestamp) ||
        meta.block.timestamp * 1000 > now + 30000
      )
        throw failure("INVALID_INDEX");
      if (provider) {
        const head = canonicalBlock(
          await bounded(provider.getBlock(meta.block.number), sig),
          meta.block.number,
        );
        if (
          !sameHash(head.hash, meta.block.hash) ||
          head.timestamp !== meta.block.timestamp
        )
          throw failure("INVALID_INDEX");
      }
      if (c.deployment.confirmations > 1) {
        const number = meta.block.number - c.deployment.confirmations + 1;
        if (number < c.deployment.startBlock)
          throw failure("INDEX_CONFIRMATIONS_PENDING");
        let stable;
        if (provider) {
          const block = canonicalBlock(
            await bounded(provider.getBlock(number), sig),
            number,
          );
          stable = (
            await bounded(
              client.query({
                query: STABLE_META,
                variables: { block: block.hash },
                signal: sig,
              }),
              sig,
            )
          )._meta;
          if (
            !stable?.block ||
            !sameHash(stable.block.hash, block.hash) ||
            stable.block.timestamp !== block.timestamp
          )
            throw failure("INVALID_INDEX");
        } else
          stable = (
            await bounded(
              client.query({
                query:
                  "query StableHead($number: Int!) { _meta(block: {number: $number}) { deployment hasIndexingErrors block { number hash timestamp } } }",
                variables: { number },
                signal: sig,
              }),
              sig,
            )
          )._meta;
        if (
          stable?.deployment !== meta.deployment ||
          stable.hasIndexingErrors !== false ||
          stable.block?.number !== number ||
          !/^0x[0-9a-f]{64}$/i.test(stable.block.hash) ||
          !Number.isSafeInteger(stable.block.timestamp) ||
          stable.block.timestamp > meta.block.timestamp
        )
          throw failure("INVALID_INDEX");
        meta = stable;
      }
      const providerKey = "0x" + digestOf(providerId).slice(7);
      const data = await bounded(
        client.query({
          query: PROVIDER_QUERY,
          variables: {
            provider: providerKey,
            block: meta.block.hash,
            limit: c.limit,
          },
          signal: sig,
        }),
        sig,
      );
      const legacyRows = data.assessmentClaims || [];
      const openRows = data.openAssessmentClaims || [];
      if (
        data._meta?.deployment !== meta.deployment ||
        data._meta.hasIndexingErrors !== false ||
        data._meta.block.hash !== meta.block.hash ||
        data._meta.block.number !== meta.block.number ||
        data._meta.block.timestamp !== meta.block.timestamp ||
        !Array.isArray(legacyRows) ||
        !Array.isArray(openRows) ||
        legacyRows.length > c.limit ||
        openRows.length > c.limit
      )
        throw failure("INVALID_INDEX");
      const rows = [
        ...legacyRows.map((row) => ({ type: "legacy", row })),
        ...openRows.map((row) => ({ type: "open", row })),
      ].sort((a, b) => {
        const bn = Number(b.row.blockNumber) - Number(a.row.blockNumber);
        return bn || Number(b.row.logIndex) - Number(a.row.logIndex);
      });
      if (
        rows.length > c.limit ||
        legacyRows.length === c.limit ||
        openRows.length === c.limit
      )
        report.truncated = true;
      const observations = [],
        provenance = [],
        counts = {},
        seen = new Set();
      for (const item of rows.slice(0, c.limit)) {
        const parsed =
          item.type === "legacy"
            ? legacyObservation(item.row, c, meta, providerKey)
            : openObservation(item.row, c, meta, providerKey);
        if (seen.has(parsed.key)) continue;
        seen.add(parsed.key);
        observations.push(parsed.assessment);
        provenance.push(parsed.provenance);
        const key = JSON.stringify([
          parsed.assessment.verifierId,
          parsed.assessment.outcome,
        ]);
        counts[key] = (counts[key] || 0) + 1;
      }
      history.observations = observations;
      history.indexedBlock = meta.block.number;
      history.indexedBlockHash = meta.block.hash;
      history.freshness =
        now - meta.block.timestamp * 1000 > c.maxAgeMs ? "stale" : "fresh";
      report.provenance = provenance;
      report.counts = counts;
    } catch (e) {
      if (signal?.aborted) throw failure("ABORTED", true);
      report.failureCode =
        e?.code === "ABORTED" ? "HISTORY_TIMEOUT" : "HISTORY_UNAVAILABLE";
    }
  }
  validate("History", history);
  report.reasons = historyReasons(history, c);
  if (report.truncated) report.reasons.push("HISTORY_WINDOW_LIMIT");
  return report;
}
