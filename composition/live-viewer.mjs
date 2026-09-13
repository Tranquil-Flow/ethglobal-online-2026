import { createServer, request as httpRequest } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { tryHandleVerificationsRoute } from "./w12-verifications-endpoint.mjs";

const debugFlag = (config, ...paths) => paths.some((path) => {
  let value = config;
  for (const key of path.split(".")) value = value?.[key];
  return value === true || value === "enabled" || value === "available" || value === "tee-attested";
});

/** A deliberately compressed, allowlisted matrix. It never serializes config. */
export function compressedCapabilityMatrix(config = {}) {
  const row = (id, label, enabled, reason) => Object.freeze({ id, label, enabled, reason });
  const inference = debugFlag(config, "inferenceEnabled", "runtime.inferenceEnabled");
  const audits = debugFlag(config, "auditsEnabled", "checking.enabled", "capabilities.audits");
  const graph = debugFlag(config, "graphStatsEnabled", "capabilities.graphStats");
  const escrow = debugFlag(config, "escrowEnabled", "capabilities.escrow");
  const staking = debugFlag(config, "stakingEnabled", "capabilities.staking");
  return Object.freeze([
    row("demo", "DEMO", debugFlag(config, "demoSponsorEnabled", "wallet.demo.enabled"), "Requires explicit sponsored-payment advertisement."),
    row("wallet", "Wallet", debugFlag(config, "hederaWalletEnabled", "wallet.enabled"), "Requires the live Hedera wallet gate."),
    row("0.5b", "0.5B distributed", inference, "Requires the advertised native route."),
    row("0.5b-audits", "0.5B audits", audits && debugFlag(config, "capabilities.audit05b"), "Requires a pinned, parity-qualified profile."),
    row("0.5b-ensemble", "0.5B ensemble", debugFlag(config, "capabilities.ensemble05b"), "Requires the current-int8 ensemble bundle."),
    row("27b", "27B hosted", debugFlag(config, "capabilities.hosted27b"), "Hidden until M2 passes."),
    row("27b-audits", "27B audits", audits && debugFlag(config, "capabilities.audit27b"), "Requires M2/PQ3 and verifier wiring."),
    row("tee", "TEE", debugFlag(config, "teeAttested", "checking.teeAttested", "capabilities.tee"), "Only on after verified attestation."),
    row("escrow", "Escrow", escrow, "Requires X3/G14."),
    row("staking", "Staking", staking && graph, "Requires fresh Graph ledger stats."),
    row("slashing", "Slashing", staking && debugFlag(config, "slashingEnabled", "capabilities.slashing"), "Only for parity-qualified profiles."),
    row("graph", "Graph stats", graph, "Requires G1/G2/G17."),
    row("owner-console", "Owner console", false, "Private loopback-only surface; the public viewer never probes or depends on it."),
    row("package", "Mac package", debugFlag(config, "judgePackageEnabled", "capabilities.judgePackage"), "Requires A8/J3."),
    row("judge-audits", "Judge audits", audits && debugFlag(config, "capabilities.judgeAudits"), "Requires J1/PQ2/G12."),
  ]);
}

const DEBUG_DRAWER_JS = `(()=>{if(new URL(location.href).searchParams.get("debug")!=="1")return;addEventListener("DOMContentLoaded",async()=>{const box=document.createElement("details");box.className="mycelium-debug-drawer";box.open=true;const title=document.createElement("summary");title.textContent="Debug details — capability matrix";box.append(title);const note=document.createElement("p");note.textContent="Public allowlisted flags only. No secrets or owner-console dependency.";box.append(note);const list=document.createElement("ul");box.append(list);document.body.append(box);try{const response=await fetch("/debug-capabilities.json",{cache:"no-store"});if(!response.ok)throw Error("unavailable");const body=await response.json();for(const row of body.capabilities){const item=document.createElement("li");const state=document.createElement("strong");state.textContent=row.enabled?"ON ":"OFF ";item.className=row.enabled?"is-on":"is-off";item.append(state,document.createTextNode(row.label+" — "+row.reason));list.append(item)}}catch{const item=document.createElement("li");item.textContent="Capability details unavailable.";list.append(item)}})})();`;
const DEBUG_DRAWER_CSS = `.mycelium-debug-drawer{position:fixed;z-index:9999;right:1rem;bottom:1rem;width:min(35rem,calc(100vw - 2rem));max-height:70vh;overflow:auto;padding:1rem;background:#07110f;color:#ecf8f2;border:1px solid #62e6ae;box-shadow:0 1rem 3rem #000a;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}.mycelium-debug-drawer summary{cursor:pointer;font-weight:700;color:#82d8f5}.mycelium-debug-drawer p{color:#91aaa0}.mycelium-debug-drawer ul{padding-left:1.25rem}.mycelium-debug-drawer li{margin:.35rem 0}.mycelium-debug-drawer .is-on strong{color:#62e6ae}.mycelium-debug-drawer .is-off strong{color:#ff8f87}`;

export const ISOLATED_FREE_ORIGIN = "http://127.0.0.1:4350";

const hasProxyHeaders = (headers) =>
  [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "cf-connecting-ip",
    "cf-ray",
  ].some((name) => headers[name] !== undefined);

/** Keep the isolated flag available only on a direct loopback request. */
export function viewerConfigForRequest({ config, viewerOrigin, headers = {} }) {
  const isolatedFree =
    viewerOrigin === ISOLATED_FREE_ORIGIN &&
    config.accessPolicy === "non-economic" &&
    !hasProxyHeaders(headers);
  return {
    ...config,
    apiUrl: config.apiUrl ?? viewerOrigin,
    ...(isolatedFree ? { isolatedFree: true } : {}),
  };
}

/** A loopback-only viewer boundary with a fixed core destination. No wallet or
 * development authorization endpoint is provided; the SDK uses a trusted wallet.
 */
export async function startLiveViewer({ coreUrl, port = 0, config, historyComparison }) {
  const files = new Map();
  // L-SPONSOR: tolerate missing v2 isolated-free assets by falling back to live-browser.
  const isolatedFreeLoader = new URL("./w6-isolated-free/application-loader.mjs", import.meta.url);
  const isolatedFreeAvailable = await stat(isolatedFreeLoader).then(() => true, () => false);
  const effectiveAppVersion =
    config.applicationVersion === "2" && isolatedFreeAvailable ? "2" : "1";
  for (const [path, file, type] of [
    ["/", "../packages/access/dist/index.html", "text/html"],
    ["/style.css", "../packages/access/dist/style.css", "text/css"],
    ["/viewer.js", "../packages/access/dist/app.js", "text/javascript"],
    ["/w6-wallet-ui.mjs", "./w6-wallet-ui.mjs", "text/javascript"],
    [
      "/w6-hashpack-adapter.mjs",
      "./w6-hashpack-adapter.mjs",
      "text/javascript",
    ],
    [
      "/app.js",
      effectiveAppVersion === "2"
        ? "./w6-isolated-free/application-loader.mjs"
        : "./live-browser.mjs",
      "text/javascript",
    ],
    ...(effectiveAppVersion === "2"
      ? [
          ["/application-browser.js", "./application-browser.mjs", "text/javascript"],
          ["/w6-isolated-free.js", "./w6-isolated-free/browser.mjs", "text/javascript"],
        ]
      : []),
  ]) {
    const original = await readFile(new URL(file, import.meta.url));
    files.set(path, {
      data: path === "/"
        ? Buffer.from(original.toString("utf8").replace("</head>", '<link rel="stylesheet" href="/debug-drawer.css"></head>').replace("</body>", '<script src="/debug-drawer.js" defer></script></body>'))
        : original,
      type,
    });
  }
  const configBytes = (req) =>
    JSON.stringify(
      viewerConfigForRequest({ config, viewerOrigin: url, headers: req.headers }),
    );
  const core = new URL(coreUrl);
  if (
    core.protocol !== "http:" ||
    core.hostname !== "127.0.0.1" ||
    core.origin !== coreUrl
  )
    throw Error("INVALID_VIEWER_UPSTREAM");
  let url;
  const json = (res, code, status) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ code }));
  };
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, url);
    const pathname = requestUrl.pathname;
    if (
      req.headers.host !== new URL(url).host ||
      (req.headers.origin && ![url, config.apiUrl].includes(req.headers.origin))
    )
      return json(res, "ORIGIN_DENIED", 403);
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    if (pathname === "/debug-capabilities.json" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ version: 1, capabilities: compressedCapabilityMatrix(config) }));
      return;
    }
    if (pathname === "/debug-drawer.js" && req.method === "GET") {
      res.setHeader("content-type", "text/javascript; charset=utf-8");
      res.end(DEBUG_DRAWER_JS);
      return;
    }
    if (pathname === "/debug-drawer.css" && req.method === "GET") {
      res.setHeader("content-type", "text/css; charset=utf-8");
      res.end(DEBUG_DRAWER_CSS);
      return;
    }
    if (pathname === "/v2/history-comparison" && req.method === "GET" && historyComparison) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      res.once("close", () => controller.abort());
      Promise.resolve(historyComparison(controller.signal)).then(result => {
        if (controller.signal.aborted) return;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
      }).catch(() => { if (!res.destroyed) json(res,"HISTORY_UNAVAILABLE",503); }).finally(() => clearTimeout(timer));
      return;
    }
    // W12: demo verifications (in-memory only — see
    // composition/w12-verifications-store.mjs and
    // composition/w12-verifications-endpoint.mjs). Intercepted before
    // the /v2/* proxy below so the store can serve these endpoints
    // without forwarding to the core. Marked demo-only; never persisted
    // to The Graph or HCS.
    if (tryHandleVerificationsRoute(req, res)) return;
    if (
      pathname.startsWith("/v1/") ||
      pathname.startsWith("/v2/") ||
      pathname === "/healthz"
    ) {
      const headers = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i].toLowerCase();
        if (k === "host") headers.push(req.rawHeaders[i], core.host);
        else if (k === "origin") headers.push(req.rawHeaders[i], coreUrl);
        else headers.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
      }
      const proxy = httpRequest(
        coreUrl + req.url,
        { method: req.method, headers },
        (up) => {
          res.writeHead(up.statusCode, up.headers);
          up.pipe(res);
        },
      );
      proxy.on("error", () => {
        if (!res.headersSent) json(res, "UPSTREAM_UNAVAILABLE", 503);
        else res.destroy();
      });
      req.on("aborted", () => proxy.destroy());
      res.on("close", () => proxy.destroy());
      req.pipe(proxy);
      return;
    }
    if (pathname === "/config.json" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(configBytes(req));
      return;
    }
    const file = files.get(pathname);
    if (!file) return json(res, "NOT_FOUND", 404);
    if (req.method !== "GET") return json(res, "METHOD_NOT_ALLOWED", 405);
    res.setHeader("content-type", file.type);
    res.end(file.data);
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.maxConnections = 128;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

export const advancedControlsCollapsed = true;

const escapeNarrativeHtml = (value) =>
  String(value ?? "Not supplied")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const safeNarrativeUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

/** Render the standalone judge-facing narrative without changing viewer startup. */
export function renderDemoNarrative({
  ensName,
  resolvedEndpoint,
  placement,
  quote,
  hederaTxId,
  streamedText,
  receiptDigest,
  graphObservation,
  selectionDecision,
  network = {},
  advancedControlsCollapsed: collapseAdvancedControls =
    advancedControlsCollapsed,
}) {
  const ethereumNetwork = network.ethereum ?? network.evm ?? "sepolia";
  const etherscanBase =
    network.etherscanBaseUrl ??
    (ethereumNetwork === "mainnet"
      ? "https://etherscan.io"
      : `https://${ethereumNetwork}.etherscan.io`);
  const hederaNetwork = network.hedera ?? "testnet";
  const hashscanBase =
    network.hashscanBaseUrl ?? `https://hashscan.org/${hederaNetwork}`;
  const resolverAddress = network.ensResolverAddress;
  const ensUrl = resolverAddress
    ? safeNarrativeUrl(
        `${etherscanBase}/address/${encodeURIComponent(resolverAddress)}`,
      )
    : null;
  const hederaUrl = hederaTxId
    ? safeNarrativeUrl(
        `${hashscanBase}/transaction/${encodeURIComponent(hederaTxId)}`,
      )
    : null;
  const studioUrl = safeNarrativeUrl(
    network.studioQueryUrl ?? network.historyEndpoint,
  );
  const observationSource =
    graphObservation && typeof graphObservation === "object"
      ? graphObservation.source
      : graphObservation;
  const observationFreshness =
    graphObservation && typeof graphObservation === "object"
      ? graphObservation.freshness
      : undefined;
  const externalLink = (url, label) =>
    url
      ? `<a href="${escapeNarrativeHtml(url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${label}</a>`
      : '<span class="demo-link-unavailable">Live link unavailable</span>';
  const advancedControls = `<div class="demo-narrative__advanced-controls" data-demo-advanced-controls>
      <span data-control="evidence-export">Evidence export</span>
      <span data-control="attempt-context-export">Attempt context export</span>
      <span data-control="offline-evidence-check">Offline evidence check</span>
    </div>`;
  const advanced = collapseAdvancedControls
    ? `<details class="demo-narrative__advanced">
    <summary>Advanced evidence &amp; export controls</summary>
    ${advancedControls}
  </details>`
    : `<section class="demo-narrative__advanced" aria-label="Advanced evidence and export controls">
    ${advancedControls}
  </section>`;

  return `<section class="demo-narrative" aria-label="Demo narrative">
  <section class="demo-narrative__beat" data-beat="ens-resolution">
    <h2>ENS name → resolved record</h2>
    <p><strong>${escapeNarrativeHtml(ensName)}</strong> resolves to <code>${escapeNarrativeHtml(resolvedEndpoint)}</code>.</p>
    ${externalLink(ensUrl, "View Sepolia ENS resolver on Etherscan")}
  </section>
  <section class="demo-narrative__beat" data-beat="placement">
    <h2>Node topology / placement</h2>
    <p>${escapeNarrativeHtml(placement)}</p>
  </section>
  <section class="demo-narrative__beat" data-beat="quote">
    <h2>Quote</h2>
    <p>${escapeNarrativeHtml(quote)}</p>
  </section>
  <section class="demo-narrative__beat" data-beat="hedera-transaction">
    <h2>Hedera tx</h2>
    <p><code>${escapeNarrativeHtml(hederaTxId)}</code></p>
    ${externalLink(hederaUrl, "View transaction on HashScan")}
  </section>
  <section class="demo-narrative__beat" data-beat="streamed-output">
    <h2>Streamed output</h2>
    <pre>${escapeNarrativeHtml(streamedText)}</pre>
  </section>
  <section class="demo-narrative__beat" data-beat="signed-receipt">
    <h2>Signed receipt</h2>
    <p>Digest: <code>${escapeNarrativeHtml(receiptDigest)}</code></p>
  </section>
  <section class="demo-narrative__beat" data-beat="graph-observation">
    <h2>Graph observation</h2>
    <p>Source: ${escapeNarrativeHtml(observationSource)}</p>
    <p>Freshness: ${escapeNarrativeHtml(observationFreshness)}</p>
    ${externalLink(studioUrl, "Open Studio query")}
  </section>
  <section class="demo-narrative__beat" data-beat="selection-decision">
    <h2>Selection decision</h2>
    <p>${escapeNarrativeHtml(selectionDecision)}</p>
  </section>
  <section class="demo-narrative__beat demo-narrative__states" data-beat="honest-state-badges">
    <h2>Honest state badges</h2>
    <span class="demo-state-badge" data-state="execution-completed">execution-completed</span>
    <span class="demo-state-badge" data-state="output-unchecked">output-unchecked</span>
    <span class="demo-state-badge" data-state="receipt-integrity-valid">receipt-integrity-valid</span>
    <span class="demo-state-badge" data-state="assessment-unavailable">assessment-unavailable</span>
  </section>
  ${advanced}
</section>`;
}
