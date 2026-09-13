// SPDX-License-Identifier: AGPL-3.0-or-later
//
// W12 — Demo Verifications endpoints + observation hook.
//
// Two responsibilities:
//   (a) Wire the in-memory verifications store into the live viewer by
//       adding two non-proxied routes:
//           GET  /v2/providers/{ens}/verifications
//           GET  /v2/audits?limit=N
//           POST /v2/providers/{ens}/verifications  (demo-only; used by
//                                                   the 3-strike E2E
//                                                   driver to drive the
//                                                   suspicion counter
//                                                   without restarting
//                                                   the paid app)
//           GET  /v2/verifications/probe            (summary + provider
//                                                   list)
//       (the viewer normally proxies /v2/* to the core; these routes
//       are intercepted before the proxy so the store can serve them).
//   (b) Provide a small `enqueueObservation({ providerId, verdict,
//       receiptDigest, requestId })` function the verified-executor
//       pipeline can call when it has a verdict.
//
// HONEST BOUNDARY:
//   * The store is in-memory only. No persistence, no fan-out to The
//     Graph, no HCS message. Audits emitted here are demo-only and
//     surfaced with the [demo-only] badge in the public viewer.
//   * Verdict provenance is whatever the caller passes. The hook does
//     NOT re-run the prompt or contact the TEE verifier — it is a
//     side-channel that the verified-executor can call when it
//     already knows the verdict. The POST endpoint is intended only
//     for the demo E2E driver and is not exposed to the public.

import { recordObservation, getProviderVerifications, listAudits, listProviderIds, summary, VERIFICATIONS_CONST, listProviders } from "./w12-verifications-store.mjs";
import {
  selectAuditTarget,
  withinBudget,
} from "./w12-audit-selection.mjs";

const VERIFICATIONS_PATH = /^\/v2\/providers\/([^/]+)\/verifications$/;
const AUDITS_PATH = "/v2/audits";
const SELECTION_PATH = "/v2/audits/selection";
const PROBE_PATH = "/v2/verifications/probe";

function jsonResponse(res, status, body) {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

function decodeEns(encoded) {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > 4096) {
        reject(new Error("BODY_TOO_LARGE"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        resolve({ _raw: buf });
      }
    });
    req.on("error", reject);
  });
}

/**
 * Returns true if the request matched one of the W12 routes.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @returns {boolean}
 */
export function tryHandleVerificationsRoute(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const pathname = url.pathname;

  if (pathname === AUDITS_PATH) {
    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      jsonResponse(res, 405, { error: "METHOD_NOT_ALLOWED", demoOnly: true });
      return true;
    }
    const limit = Math.max(
      1,
      Math.min(32, Number(url.searchParams.get("limit")) || 10),
    );
    jsonResponse(res, 200, {
      demoOnly: true,
      persistedTo: "in-memory-only",
      audits: listAudits(limit),
      summary: summary(),
    });
    return true;
  }

  if (pathname === SELECTION_PATH) {
    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      return jsonResponse(res, 405, { ok: false, reason: "METHOD_NOT_ALLOWED" });
    }
    const nowMs = Date.now();
    const providers = listProviders();
    const history = auditSelectionHistory;
    const candidates = providers.map((row) => ({
      providerId: row.providerId,
      receipts: history?.receipts?.(row.providerId) ?? 0,
      mismatches: row.mismatchCount ?? 0,
      uptimeDays: history?.uptimeDays?.(row.providerId) ?? 0,
      lastAuditedAtMs: row.auditedAt ? Date.parse(row.auditedAt) : null,
    }));
    const selection = selectAuditTarget({
      providers: candidates,
      graph: history?.graphInputs?.() ?? null,
      nowMs,
    });
    const budget = withinBudget({
      auditTimestampsMs: listAudits()
        .map((a) => Date.parse(a.publishedAt))
        .filter((t) => Number.isFinite(t)),
      nowMs,
    });
    return jsonResponse(res, 200, {
      ok: true,
      demoOnly: true,
      historySource: history ? "injected" : "absent",
      budget,
      selection,
    });
  }

  if (pathname === PROBE_PATH) {
    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      jsonResponse(res, 405, { error: "METHOD_NOT_ALLOWED", demoOnly: true });
      return true;
    }
    jsonResponse(res, 200, {
      demoOnly: true,
      summary: summary(),
      providers: listProviderIds(),
    });
    return true;
  }

  const match = pathname.match(VERIFICATIONS_PATH);
  if (match) {
    const ens = decodeEns(match[1]);
    if (!ens) {
      jsonResponse(res, 400, {
        error: "INVALID_PROVIDER_ID",
        demoOnly: true,
      });
      return true;
    }
    if (req.method === "GET") {
      jsonResponse(res, 200, {
        demoOnly: true,
        persistedTo: "in-memory-only",
        verifications: getProviderVerifications(ens),
      });
      return true;
    }
    if (req.method === "POST") {
      readJsonBody(req)
        .then((body) => {
          const verdict = String(
            body?.verdict ?? "unavailable",
          ).toLowerCase();
          try {
            const result = recordObservation({
              providerId: ens,
              verdict,
              receiptDigest:
                typeof body?.receiptDigest === "string"
                  ? body.receiptDigest
                  : null,
              requestId:
                typeof body?.requestId === "string" ? body.requestId : null,
              verifierId:
                typeof body?.verifierId === "string" ? body.verifierId : null,
              method: typeof body?.method === "string" ? body.method : null,
            });
            jsonResponse(res, 200, {
              demoOnly: true,
              persistedTo: "in-memory-only",
              observation: result,
              verifications: getProviderVerifications(ens),
            });
          } catch (error) {
            jsonResponse(res, 400, {
              demoOnly: true,
              error: error?.code ?? "INVALID_INPUT",
              message: error?.message,
            });
          }
        })
        .catch(() => {
          jsonResponse(res, 400, { demoOnly: true, error: "BAD_BODY" });
        });
      return true;
    }
    res.setHeader("allow", "GET, POST");
    jsonResponse(res, 405, { error: "METHOD_NOT_ALLOWED", demoOnly: true });
    return true;
  }

  return false;
}

/**
 * Hook used by the verified-executor / observation bridge.
 *
 * @param {object} args
 * @param {string} args.providerId
 * @param {"match"|"mismatch"|"inconclusive"|"unavailable"} args.verdict
 * @param {string} [args.receiptDigest]
 * @param {string} [args.requestId]
 * @param {string} [args.verifierId]  Honest verifier label when known; a
 *                                    labelled row for a completed job becomes
 *                                    an on-chain assessment claim through the
 *                                    core outbox (see packages/core
 *                                    recordVerdictAssessment).
 * @param {string} [args.method]      Honest method label when known.
 */
// Phase 7/8 seam: the paid app may inject a reader that supplies the public
// history (receipt count, uptime) and the Graph inputs for a draw. Without it
// the route still answers — with historySource: "absent" and an unweighted,
// clearly-labelled draw — rather than inventing trust numbers.
let auditSelectionHistory = null;
export function setAuditSelectionHistory(source) {
  auditSelectionHistory = source ?? null;
}

export function enqueueObservation(args) {
  return recordObservation(args);
}

export {
  recordObservation,
  getProviderVerifications,
  listAudits,
  listProviderIds,
  summary,
  VERIFICATIONS_CONST,
};
