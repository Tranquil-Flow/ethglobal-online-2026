// Requests — the unified ledger.
//
// One row per inference request: what it cost, what it produced, whether the
// receipt was signed, what the verifier said, and whether a public commitment
// was published. Prompt and output text never appear here — they stay in the
// session that made the request. This view replaces the separate Receipts /
// Provider Trust / Verifier pages that used to show curated, static examples.

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "html") node.innerHTML = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

function short(value, keep = 10) {
  if (typeof value !== "string") return "—";
  return value.length > keep * 2 ? `${value.slice(0, keep)}…${value.slice(-keep)}` : value;
}

function when(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().replace("T", " ").slice(0, 19);
}

function badge(kind, label, hint) {
  return el("span", { class: `ledger-badge is-${kind}`, title: hint ?? label, text: label });
}

function verificationBadge(verification) {
  if (!verification) return badge("unknown", "not checked", "No verdict recorded in this session's in-memory store.");
  if (verification.verdict === "match") return badge("pass", "verified", "Verifier verdict: match.");
  if (verification.verdict === "mismatch") return badge("fail", "mismatch", "Verifier verdict: mismatch — this is what escalates to an audit.");
  return badge("warn", verification.verdict, `Verifier verdict: ${verification.verdict}.`);
}

function publicationBadge(publication) {
  if (!publication) return badge("unknown", "not published", "No public commitment was recorded for this request.");
  if (publication.status === "published" || publication.status === "confirmed")
    return badge("pass", "published", publication.transactionRef ?? "Published.");
  return badge("warn", publication.status ?? "pending", `Publication status: ${publication.status ?? "unknown"}.`);
}

function hcsBadge(hcs) {
  if (!hcs || !hcs.topicId || !hcs.sequenceNumber)
    return badge("unknown", "no HCS entry", "This request predates the HCS trail or its message is not yet confirmed.");
  const label = `HCS #${hcs.sequenceNumber}`;
  const href = `https://hashscan.io/testnet/topic/${hcs.topicId}`;
  return el("a", {
    class: "ledger-badge is-pass",
    href,
    target: "_blank",
    rel: "noopener",
    title: `Hedera consensus topic ${hcs.topicId}, message ${hcs.sequenceNumber} · ${hcs.transactionId ?? ""}`,
  }, [el("span", { text: label })]);
}

function requestRow(row) {
  const cells = el("div", { class: "ledger-row-cells" }, [
    el("span", { class: "ledger-cell ledger-cell-time", text: when(row.createdAt) }),
    el("span", { class: "ledger-cell ledger-cell-provider", text: row.providerId ?? "—" }),
    el("span", { class: "ledger-cell ledger-cell-status", text: row.executionStatus ?? "—" }),
    el("span", { class: "ledger-cell ledger-cell-flags" }, [
      row.payment?.status === "settled" ? badge("pass", "paid", row.payment.transactionRef ?? "") : badge("warn", row.payment?.status ?? "unpaid"),
      row.receipt?.signed ? badge("pass", "receipt", row.receipt.keyId ?? "") : badge("warn", "no receipt"),
      verificationBadge(row.verification),
      publicationBadge(row.publication),
      hcsBadge(row.hcs),
    ]),
  ]);
  const detail = el("dl", { class: "ledger-detail" }, [
    el("dt", { text: "Job id" }),
    el("dd", { class: "mono", text: row.jobId ?? "—" }),
    el("dt", { text: "Hedera transaction" }),
    el("dd", { class: "mono", text: row.payment?.transactionRef ?? "—" }),
    el("dt", { text: "Receipt digest" }),
    el("dd", { class: "mono", text: row.receipt?.digest ?? "—" }),
    el("dt", { text: "Verifier verdict" }),
    el("dd", {
      text: row.verification
        ? `${row.verification.verdict} · observed ${when(row.verification.observedAt)}`
        : "not checked in this session",
    }),
    el("dt", { text: "Publication" }),
    el("dd", {
      text: row.publication
        ? `${row.publication.status ?? "unknown"}${row.publication.transactionRef ? ` · ${row.publication.transactionRef}` : ""}`
        : "no public commitment recorded",
    }),
  ]);
  return el("details", { class: "ledger-row", "data-provider": row.providerId ?? "" }, [
    el("summary", {}, [cells]),
    detail,
  ]);
}

function auditRow(audit) {
  return el("li", { class: "audit-row" }, [
    el("span", { class: "audit-badge", text: "audit" }),
    el("span", { class: "audit-provider", text: audit.providerId ?? "—" }),
    el("span", { class: "audit-reason", text: `${audit.suspicionCount ?? "?"} of ${audit.threshold ?? "?"} mismatches` }),
    el("span", { class: "audit-when", text: when(audit.publishedAt) }),
    el("span", { class: "audit-digest mono", text: audit.receiptDigest ?? "—" }),
  ]);
}

export async function renderRequests(container, context = {}) {
  const { config } = context;
  container.replaceChildren(el("p", { class: "loading-note", text: "Loading the request ledger…" }));

  let ledger = null;
  let audits = null;
  let ledgerError = null;
  try {
    const response = await fetch("/v2/requests?limit=50", { cache: "no-store" });
    if (response.ok) ledger = await response.json();
    else ledgerError = `HTTP ${response.status}`;
  } catch (error) {
    ledgerError = error?.message ?? "unavailable";
  }
  try {
    const response = await fetch("/v2/audits", { cache: "no-store" });
    if (response.ok) audits = await response.json();
  } catch {
    audits = null;
  }

  const rows = ledger?.requests ?? [];
  const summary = ledger?.ledger ?? null;
  const auditList = audits?.audits ?? [];

  const head = el("div", { class: "ledger-head" }, [
    el("p", { class: "eyebrow", text: "Requests" }),
    el("h1", { text: "Every request, and what the network did with it." }),
    el("p", {
      class: "ledger-intro",
      text:
        "One row per request: payment, signed receipt, verifier verdict, public commitment. " +
        "Prompts and answers stay in your browser — this ledger shows commitments only.",
    }),
  ]);

  const chips = el("div", { class: "ledger-chips" }, [
    el("span", { class: "ledger-chip", text: `${summary?.returned ?? rows.length} shown` }),
    el("span", { class: "ledger-chip", text: `${summary?.verified ?? 0} checked` }),
    el("span", { class: "ledger-chip is-fail", text: `${summary?.mismatched ?? 0} mismatch` }),
    el("span", { class: "ledger-chip", text: `${auditList.length} audit${auditList.length === 1 ? "" : "s"}` }),
    summary?.demoVerifier
      ? el("span", {
          class: "ledger-chip is-demo",
          title:
            "Verdicts come from the TEE verifier: the TEE holds the ensemble statistical tests and runs the classifier that checks each answer.",
          text: "TEE verifier",
        })
      : null,
  ]);

  const table = ledgerError
    ? el("p", { class: "ledger-empty", text: `Ledger unavailable (${ledgerError}).` })
    : rows.length
      ? el("div", { class: "ledger-table" }, [
          el("div", { class: "ledger-row ledger-row-head" }, [
            el("span", { class: "ledger-cell ledger-cell-time", text: "When" }),
            el("span", { class: "ledger-cell ledger-cell-provider", text: "Provider" }),
            el("span", { class: "ledger-cell ledger-cell-status", text: "Status" }),
            el("span", { class: "ledger-cell ledger-cell-flags", text: "Evidence" }),
          ]),
          ...rows.map(requestRow),
        ])
      : el("p", { class: "ledger-empty", text: "No requests recorded yet." });

  const auditSection = el("section", { class: "audit-section" }, [
    el("h2", { text: "Escalated audits" }),
    el("p", {
      class: "audit-note",
      text:
        "Three consecutive mismatches escalate a provider to an audit. Audit records " +
        "are held in memory for this demo session and are not published.",
    }),
    auditList.length
      ? el("ul", { class: "audit-list" }, auditList.map(auditRow))
      : el("p", { class: "ledger-empty", text: "No provider has reached the three-mismatch threshold in this session." }),
  ]);

  const providers = (config?.providers ?? []).map((p) => p.providerId);
  const footer = el("p", {
    class: "ledger-footnote",
    text: `Providers in this deployment: ${providers.join(", ") || "none configured"}.`,
  });

  container.replaceChildren(el("section", { class: "ledger-shell" }, [head, chips, table, auditSection, footer]));
}
