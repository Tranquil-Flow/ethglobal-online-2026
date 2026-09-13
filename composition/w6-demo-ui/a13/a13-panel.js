// A13 panel client logic — Lane A13-UI-Wiring-Stub.
// Fetches /api/a13/status, renders one of: not-installed / disabled /
// ready / running / complete. Submits /api/a13/swarm when state==ready
// and polls /api/a13/receipt/<runId> for the (eventually TEE-verified)
// receipt.
//
// This file does NOT touch any other file in composition/w6-demo-ui/.
// Mount via <script type="module" src="/a13/a13-panel.js"></script> after
// the panel HTML is in the DOM.

const A13 = (() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    card: $("a13-status-card"),
    badge: $("a13-status-badge"),
    message: $("a13-status-message"),
    meta: $("a13-status-meta"),
    metaPath: $("a13-meta-path"),
    metaVersion: $("a13-meta-version"),
    metaLastRun: $("a13-meta-lastrun"),
    metaState: $("a13-meta-state"),
    form: $("a13-swarm-form"),
    submit: $("a13-swarm-submit"),
    refresh: $("a13-swarm-refresh"),
    nodeCount: $("a13-input-nodecount"),
    prompt: $("a13-input-prompt"),
    maxTokens: $("a13-input-maxtokens"),
    output: $("a13-output"),
    outRunId: $("a13-out-runid"),
    outStarted: $("a13-out-started"),
    outState: $("a13-out-state"),
    outReceipt: $("a13-out-receipt"),
    outReceiptJson: $("a13-out-receipt-json"),
    integrationNote: $("a13-integration-note"),
  };

  // XSS-safe text setter.
  const setText = (el, s) => { if (el) el.textContent = String(s ?? "—"); };

  const ALLOWED_STATES = new Set([
    "not-installed", "disabled", "ready", "running", "complete", "error", "loading",
  ]);

  function renderStatus(status) {
    const state = ALLOWED_STATES.has(status?.state) ? status.state : "error";
    els.card.dataset.state = state;
    setText(els.badge, state);
    setText(els.message, status?.message ?? "Unknown A13 state");
    els.meta.hidden = false;

    setText(els.metaPath, status?.worktree ?? "—");
    setText(els.metaVersion, status?.version ?? "—");
    setText(els.metaLastRun, status?.lastRunAt ?? "—");
    setText(els.metaState, state);

    // Enable Run only in `ready` state. Disable in `running` to avoid double-submit.
    if (state === "ready") {
      els.submit.disabled = false;
      els.submit.textContent = "Run swarm";
    } else if (state === "running") {
      els.submit.disabled = true;
      els.submit.textContent = "Running…";
    } else if (state === "complete") {
      els.submit.disabled = false;
      els.submit.textContent = "Run again";
    } else {
      els.submit.disabled = true;
      els.submit.textContent =
        state === "not-installed" ? "A13 not installed" :
        state === "disabled" ? "A13 disabled (quota fix pending)" :
        state === "loading" ? "Loading…" :
        "Run swarm";
    }
  }

  async function refreshStatus() {
    try {
      const r = await fetch("/api/a13/status", { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      renderStatus(body);
      return body;
    } catch (e) {
      renderStatus({ state: "error", message: `Could not reach /api/a13/status: ${e?.message ?? e}` });
      return null;
    }
  }

  async function submitSwarm(ev) {
    ev.preventDefault();
    const payload = {
      nodeCount: Number(els.nodeCount.value) || 2,
      prompt: String(els.prompt.value ?? "").slice(0, 512),
      maxNewTokens: Number(els.maxTokens.value) || 1,
    };
    els.submit.disabled = true;
    els.submit.textContent = "Submitting…";
    try {
      const r = await fetch("/api/a13/swarm", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) {
        els.output.hidden = false;
        setText(els.outRunId, "—");
        setText(els.outStarted, new Date().toISOString());
        setText(els.outState, body.state ?? "error");
        setText(els.outReceipt, body.message ?? `HTTP ${r.status}`);
        return;
      }
      els.output.hidden = false;
      setText(els.outRunId, body.runId ?? "—");
      setText(els.outStarted, body.startedAt ?? new Date().toISOString());
      setText(els.outState, body.state ?? "running");
      setText(els.outReceipt, "Polling for receipt…");
      // Poll receipt until complete or 30s.
      await pollReceipt(body.runId, 30);
    } catch (e) {
      els.output.hidden = false;
      setText(els.outRunId, "—");
      setText(els.outStarted, new Date().toISOString());
      setText(els.outState, "error");
      setText(els.outReceipt, `Submit failed: ${e?.message ?? e}`);
    } finally {
      // Re-enable in line with current state (likely now running or complete).
      refreshStatus();
    }
  }

  async function pollReceipt(runId, maxSeconds) {
    const started = Date.now();
    while ((Date.now() - started) / 1000 < maxSeconds) {
      try {
        const r = await fetch(`/api/a13/receipt/${encodeURIComponent(runId)}`, {
          headers: { accept: "application/json" },
        });
        if (r.ok) {
          const body = await r.json();
          setText(els.outState, body.state ?? "complete");
          setText(els.outReceipt, body.verified === true ? "TEE-verified receipt (stub)" : "Receipt (placeholder)");
          els.outReceiptJson.hidden = false;
          els.outReceiptJson.textContent = JSON.stringify(body, null, 2);
          return;
        }
        if (r.status !== 404) {
          // Non-404 failure — surface it.
          setText(els.outReceipt, `Receipt poll HTTP ${r.status}`);
          return;
        }
      } catch (e) {
        setText(els.outReceipt, `Receipt poll error: ${e?.message ?? e}`);
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
    setText(els.outReceipt, "Receipt not ready (timeout)");
  }

  function init() {
    if (!els.card) return; // panel not mounted
    els.form?.addEventListener("submit", submitSwarm);
    els.refresh?.addEventListener("click", refreshStatus);
    refreshStatus();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return { refresh: refreshStatus };
})();

export default A13;