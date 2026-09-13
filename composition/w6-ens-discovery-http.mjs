// W6 v3 — ENSv2 frontend provenance surface.
//
// Provides a read-only HTTP endpoint that returns ENSv2 Sepolia reads
// independently of the signed-offer gate (which throws OFFER_RECORD_MISMATCH
// when the ENS endpoint text record has not yet been repointed to match the
// live signed offer). This is the "compatible application-owned read-only
// surface" called out by the P1-ENS-CENTRAL pitfalls.
//
// Why a separate surface (not /v1/providers):
//   packages/core/ is owner-only and off-limits in this brief. The existing
//   /v1/providers handler in core/src/index.mjs validates the closed Provider
//   DTO and runs the gate's listOnce through the application's signed-offer
//   matcher, which fails closed when the ENS endpoint text record diverges
//   from the supervisor's runtime origin.
//
//   This module:
//     1. Loads W6_ENS_DISCOVERY_* from the supervisor env file
//     2. Wraps packages/discovery createEnsV2Discovery with a 30s cache
//     3. Exposes GET /v2/ens-discovery returning per-provider ENS reads as
//        a provenance-only payload (NOT a closed Provider DTO)
//     4. Surfaces cache state (fresh / valid / unavailable / stale /
//        expired / conflicting) and the on-chain source evidence
//
// The endpoint is intentionally additive: it never replaces the signed-offer
// gate. Provider selection in flow.mjs still validates association +
// equality of load-bearing fields against the signed offer, exactly as
// required by P1-ENS-CENTRAL pitfall #1.

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  loadProvidersFromEns,
  DEFAULT_TTL_MS,
  DEFAULT_TIMEOUT_MS,
} from "./w6-ens-discovery-loader.mjs";
import {
  normalizeName,
  RECORD_KEYS,
} from "../packages/discovery/src/index.mjs";

const SUPERVISOR_ENV =
  process.env.W6_SUPERVISOR_ENV_FILE ??
  `${process.env.HOME}/.config/mycelium/w6-supervisors.env`;

const DEFAULT_PORT = 4371;

function readSupervisorEnv() {
  if (!existsSync(SUPERVISOR_ENV)) {
    return {
      enabled: false,
      reason: `supervisor env file not found at ${SUPERVISOR_ENV}`,
    };
  }
  let raw;
  try {
    raw = readFileSync(SUPERVISOR_ENV, "utf8");
  } catch (error) {
    return {
      enabled: false,
      reason: `supervisor env file unreadable: ${error.message}`,
    };
  }
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    env[m[1]] = m[2];
  }
  if (env.W6_USE_ENS_DISCOVERY !== "1") {
    return {
      enabled: false,
      reason: "W6_USE_ENS_DISCOVERY is not \"1\" in supervisor env",
    };
  }
  if (!env.W6_ENS_DISCOVERY_RPC_URL) {
    return {
      enabled: false,
      reason: "W6_ENS_DISCOVERY_RPC_URL is required when discovery is on",
    };
  }
  const rawNames = env.W6_ENS_DISCOVERY_NAMES;
  const names =
    typeof rawNames === "string" && rawNames.length > 0
      ? rawNames.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : [];
  return {
    enabled: true,
    rpcUrl: env.W6_ENS_DISCOVERY_RPC_URL,
    names,
    ttlMs: Number(env.W6_ENS_DISCOVERY_TTL_MS ?? DEFAULT_TTL_MS),
    timeoutMs: Number(env.W6_ENS_DISCOVERY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    universal: env.W6_ENS_DISCOVERY_UNIVERSAL,
    root: env.W6_ENS_DISCOVERY_ROOT,
  };
}

function classifyCache(at, ttl, now, hasError) {
  if (hasError) return "unavailable";
  if (!at) return "expired";
  const age = now - at;
  if (age < 0) return "expired";
  if (age < ttl / 2) return "fresh";
  if (age < ttl) return "valid";
  return "stale";
}

export function createEnsDiscoveryHttp({
  port = Number(process.env.W6_ENS_DISCOVERY_HTTP_PORT ?? DEFAULT_PORT),
  host = process.env.W6_ENS_DISCOVERY_HTTP_HOST ?? "127.0.0.1",
  env = readSupervisorEnv(),
  loader = env.enabled
    ? loadProvidersFromEns({
        names: env.names.length ? env.names : ["service.ethonline-node-a.eth"],
        rpcUrl: env.rpcUrl,
        ttlMs: env.ttlMs,
        timeoutMs: env.timeoutMs,
        mode: "live",
        universal: env.universal,
        root: env.root,
      })
    : null,
  clock = () => Date.now(),
} = {}) {
  // Provenance snapshot per name — tracks the most recent successful read
  // and the most recent failure so the frontend can render
  // fresh/valid/unavailable/stale/expired/conflicting honestly.
  const provenance = new Map();

  async function listEns(names, signal) {
    if (!env.enabled || !loader) {
      return {
        ok: false,
        code: "DISCOVERY_DISABLED",
        message: env.reason,
        names,
      };
    }
    try {
      const result = await loader.list({ names, signal });
      const now = clock();
      for (const p of result.providers ?? []) {
        provenance.set(p.name, {
          provider: p,
          at: now,
          ttlMs: env.ttlMs,
          error: null,
        });
      }
      for (const e of result.errors ?? []) {
        const prior = provenance.get(e.name);
        provenance.set(e.name, {
          provider: prior?.provider ?? null,
          at: prior?.at ?? 0,
          ttlMs: env.ttlMs,
          error: { code: e.code, message: e.message },
        });
      }
      return { ok: true, ...result };
    } catch (error) {
      const now = clock();
      for (const n of names) {
        const prior = provenance.get(n);
        provenance.set(n, {
          provider: prior?.provider ?? null,
          at: prior?.at ?? 0,
          ttlMs: env.ttlMs,
          error: {
            code: error?.code ?? "ENS_RPC_UNAVAILABLE",
            message: error?.message ?? String(error),
          },
        });
      }
      return {
        ok: false,
        code: error?.code ?? "ENS_RPC_UNAVAILABLE",
        message: error?.message ?? String(error),
        names,
      };
    }
  }

  function summarize(name) {
    const entry = provenance.get(name);
    const now = clock();
    if (!entry) {
      return {
        name,
        state: "expired",
        hasProvider: false,
        hasError: true,
        error: { code: "NEVER_RESOLVED", message: "ENS not yet read" },
        ageMs: null,
        ttlMs: env.ttlMs,
      };
    }
    const ageMs = entry.at ? now - entry.at : null;
    const withinTtl = entry.at && ageMs !== null && ageMs < entry.ttlMs;
    let state;
    if (entry.error && !entry.provider) state = "unavailable";
    else if (entry.error && entry.provider) state = "conflicting";
    else if (!withinTtl) state = "expired";
    else state = classifyCache(entry.at, entry.ttlMs, now, false);
    return {
      name,
      state,
      hasProvider: Boolean(entry.provider),
      hasError: Boolean(entry.error),
      provider: entry.provider
        ? {
            providerId: entry.provider.providerId,
            endpoint: entry.provider.endpoint,
            profileIds: entry.provider.profileIds,
            paymentNetwork: entry.provider.paymentNetwork,
            paymentAsset: entry.provider.paymentAsset,
            paymentReceiver: entry.provider.paymentReceiver,
            historyEndpoint: entry.provider.historyEndpoint,
            source: entry.provider.source,
          }
        : null,
      error: entry.error,
      ageMs,
      ttlMs: entry.ttlMs,
    };
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? host}`);
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "METHOD_NOT_ALLOWED" } }));
        return;
      }
      if (url.pathname === "/v2/ens-discovery/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            mode: "live",
            enabled: env.enabled,
            reason: env.reason ?? null,
            ttlMs: env.ttlMs,
            timeoutMs: env.timeoutMs,
            rpcHost: env.rpcUrl ? new URL(env.rpcUrl).host : null,
            configuredNames: env.names ?? [],
            route: "ensv2-sepolia-onchain",
          }),
        );
        return;
      }
      if (url.pathname === "/v2/ens-discovery") {
        const names = url.searchParams.getAll("name").filter(Boolean);
        if (names.length === 0) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: { code: "INVALID_INPUT", message: "name query required" },
            }),
          );
          return;
        }
        if (names.length > 32) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                code: "INVALID_INPUT",
                message: "too many names (max 32)",
              },
            }),
          );
          return;
        }
        let normalized;
        try {
          normalized = names.map(normalizeName);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: { code: "INVALID_NAME", message: "name normalization failed" },
            }),
          );
          return;
        }
        const startedAt = clock();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), env.timeoutMs + 2000);
        const result = await listEns(normalized, controller.signal);
        clearTimeout(timer);
        const providers = [];
        const errors = [];
        const summaries = [];
        for (const n of normalized) {
          const summary = summarize(n);
          summaries.push(summary);
          if (summary.hasProvider) providers.push(summary.provider);
          else if (summary.error)
            errors.push({ name: n, code: summary.error.code });
        }
        const elapsedMs = clock() - startedAt;
        const payload = {
          version: "w6.ens-discovery.v1",
          ok: result.ok,
          enabled: env.enabled,
          reason: env.reason ?? null,
          route: env.enabled ? "ensv2-sepolia-onchain" : null,
          rpcHost: env.rpcUrl ? new URL(env.rpcUrl).host : null,
          ttlMs: env.ttlMs,
          timeoutMs: env.timeoutMs,
          recordKeys: [...RECORD_KEYS],
          elapsedMs,
          observedAt: new Date(clock()).toISOString(),
          names: normalized,
          providers,
          errors,
          provenance: summaries,
        };
        res.writeHead(result.ok ? 200 : 503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: error?.code ?? "INTERNAL",
            message: error?.message ?? String(error),
          },
        }),
      );
    }
  });

  server.listen(port, host, () => {
    console.log(
      JSON.stringify({
        status: "ens-discovery-http-ready",
        port,
        host,
        enabled: env.enabled,
        reason: env.reason ?? null,
        rpcHost: env.rpcUrl ? new URL(env.rpcUrl).host : null,
      }),
    );
  });

  return {
    server,
    listEns,
    summarize,
    provenance,
    config: env,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createEnsDiscoveryHttp();
  for (const sig of ["SIGINT", "SIGTERM"])
    process.once(sig, () => process.exit(0));
}