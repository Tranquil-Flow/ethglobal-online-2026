import { readFile } from "node:fs/promises";
import { ethers } from "./deps.mjs";
import { bytes32 } from "./eip712.mjs";

const REQUIRED_VERDICT_FIELDS = [
  "verdictId",
  "hederaRef",
  "subjectId",
  "providerKey",
  "profile",
  "epoch",
  "outcome",
  "evidenceDigest",
  "policyVersion",
  "nonce",
  "expiry",
];

export function parseVerdictJsonlLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const record = JSON.parse(trimmed);
  const raw = record.verdict ?? record;
  if (record.type && record.type !== "Verdict" && raw.type !== "Verdict") return null;
  for (const field of REQUIRED_VERDICT_FIELDS) {
    if (raw[field] === undefined || raw[field] === null || raw[field] === "") {
      throw new Error(`INVALID_VERDICT_MISSING_${field}`);
    }
  }
  return normalizeVerdict(raw);
}

export async function consumeVerdictJsonl({ logPath, outbox, seenVerdictIds = new Set(), offset = 0 } = {}) {
  if (!logPath) throw new Error("MISSING_VERDICT_LOG_PATH");
  if (!outbox) throw new Error("MISSING_OUTBOX");
  const text = await readFile(logPath, "utf8");
  const chunk = text.slice(offset);
  const lines = chunk.split(/\r?\n/);
  let parsed = 0;
  let enqueued = 0;
  const verdicts = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const verdict = parseVerdictJsonlLine(line);
    if (!verdict) continue;
    parsed += 1;
    if (seenVerdictIds.has(verdict.verdictId)) continue;
    seenVerdictIds.add(verdict.verdictId);
    verdicts.push(verdict);
    const before = outbox.countRows({ type: "settle" });
    outbox.append("settle", {
      verdictId: verdict.verdictId,
      hederaRef: verdict.hederaRef,
      action: verdict.action,
      verdict,
      mirror: { minConfirmations: 12 },
    });
    outbox.append("ledgerEvent", {
      verdictId: verdict.verdictId,
      hederaRef: verdict.hederaRef,
      eventType: verdict.ledgerEvent?.eventType ?? "AuditRecorded",
      payload: verdict.ledgerEvent?.payload ?? defaultLedgerPayload(verdict),
    });
    if (outbox.countRows({ type: "settle" }) > before) enqueued += 1;
  }
  return { parsed, enqueued, verdicts, nextOffset: text.length, seenVerdictIds };
}

export function normalizeVerdict(raw) {
  const verdict = {
    verdictId: String(raw.verdictId),
    action: raw.action ?? raw.kind ?? "settle",
    hederaRef: String(raw.hederaRef),
    subjectId: bytes32(raw.subjectId, "subjectId"),
    providerKey: ethers.getAddress(raw.providerKey),
    profile: bytes32(raw.profile, "profile"),
    epoch: Number(raw.epoch),
    outcome: Number(raw.outcome),
    evidenceDigest: bytes32(raw.evidenceDigest, "evidenceDigest"),
    policyVersion: bytes32(raw.policyVersion, "policyVersion"),
    nonce: BigInt(raw.nonce).toString(),
    expiry: BigInt(raw.expiry).toString(),
  };
  if (!["settle", "slash"].includes(verdict.action)) throw new Error(`INVALID_VERDICT_ACTION:${verdict.action}`);
  if (!Number.isSafeInteger(verdict.epoch) || verdict.epoch < 0) throw new Error("INVALID_VERDICT_EPOCH");
  if (!Number.isInteger(verdict.outcome) || verdict.outcome < 0 || verdict.outcome > 255) {
    throw new Error("INVALID_VERDICT_OUTCOME");
  }
  if (raw.ledgerEvent) verdict.ledgerEvent = raw.ledgerEvent;
  if (raw.slashId) verdict.slashId = bytes32(raw.slashId, "slashId");
  return verdict;
}

function defaultLedgerPayload(verdict) {
  return {
    auditId: verdict.subjectId,
    providerKey: verdict.providerKey,
    profile: verdict.profile,
    epoch: verdict.epoch,
    reason: 2,
    outcome: verdict.outcome,
    evidenceDigest: verdict.evidenceDigest,
    hederaRef: hederaRefToBytes32(verdict.hederaRef),
  };
}

export function hederaRefToBytes32(ref) {
  if (typeof ref === "string" && /^0x[0-9a-fA-F]{64}$/.test(ref)) return ref;
  return ethers.keccak256(ethers.toUtf8Bytes(String(ref)));
}
