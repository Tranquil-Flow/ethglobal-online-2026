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

function hederaTx(ref) {
  return ref ? `https://hashscan.org/testnet/transaction/${encodeURIComponent(ref)}` : null;
}

function explorerTx(hash) {
  return hash ? `https://sepolia.etherscan.io/tx/${encodeURIComponent(hash)}` : null;
}

function findPublicationTx(publication) {
  if (!publication) return null;
  if (publication.transactionHash) return publication.transactionHash;
  if (publication.transactionRef) return publication.transactionRef;
  const events = Array.isArray(publication.events) ? publication.events : [];
  return events.find((event) => event.transactionHash)?.transactionHash ??
    events.find((event) => event.transactionRef)?.transactionRef ??
    null;
}

function indexed(publication) {
  if (!publication) return false;
  if (publication.indexed === true || publication.status === "indexed" || publication.status === "confirmed") return true;
  return (publication.events ?? []).some((event) => event.indexed === true || event.status === "indexed" || event.status === "confirmed");
}

function auditText(providerStats, providerId) {
  const rows = providerStats?.providers ?? providerStats?.rows ?? [];
  const row = rows.find((item) => item.providerId === providerId || item.ensName === providerId) ?? providerStats?.provider;
  const history = row?.history ?? row?.metrics ?? row;
  const matches = Number(history?.matchCount ?? history?.matches ?? 0);
  const total = Number(history?.assessmentCount ?? history?.assessments ?? 0);
  if (total > 0) return `${providerId} passed ${matches} of ${total} recent spot-checks`;
  return "Not spot-checked yet";
}

function row(label, state, body, action) {
  const marker = state === "ok" ? " ✓" : state === "pending" ? " …" : "";
  const node = el("div", { class: "receipt-row", dataset: { state } }, [
    el("dt", { text: `${label}${marker}` }),
    el("dd", {}, [el("span", { class: "receipt-row-text", text: body })]),
  ]);
  if (action) node.querySelector("dd").append(" ", action);
  return node;
}

export function renderReceiptCard(container, state, { providerStats, onDetails, onDownload, onAgain } = {}) {
  container.replaceChildren();
  const job = state?.job;
  const providerId = state?.provider?.providerId ?? job?.payment?.providerId ?? state?.request?.providerId ?? "provider";
  const tx = job?.payment?.transactionRef ?? job?.payment?.transactionHash ?? null;
  const amount = job?.payment?.amountBaseUnits ?? state?.quote?.amountBaseUnits ?? null;
  // A7 — detect whether the wallet path used the [demo-only] mock. The
  // mock-wallet path always carries `wallet.__demoOnly === true` and the
  // signed-tx adapter carries `__demoOnly: true` in its headers. If the
  // payment method is "hashpack" and either flag is set, surface the badge
  // so reviewers see the wallet flow did NOT use a real extension.
  const walletDemoOnly = Boolean(
    state?.wallet?.__demoOnly === true ||
    state?.payment?.__demoWallet === true ||
    (state?.paymentMethod === "hashpack" &&
      state?.paymentHeaders?.["x-demo-only"] === "1"),
  );
  const paidText = tx
    ? `Paid${amount ? ` ${amount}` : ""} on Hedera testnet${state?.paymentMethod === "hashpack" ? (walletDemoOnly ? " (mock-wallet [demo-only])" : " (wallet)") : " (demo sponsor)"}`
    : job?.payment?.status
      ? "Payment accepted; on-chain record is still arriving"
      : "Payment record is still arriving";
  const pubTx = findPublicationTx(state?.publication);
  const recordedText = state?.request?.publishConsent === false
    ? "Public recording was turned off"
    : pubTx
      ? `Recorded publicly on Sepolia${indexed(state?.publication) ? " · Indexed by The Graph" : " · Still indexing"}`
      : "Recording publicly on Sepolia…";
  const card = el("section", { class: "receipt-card", id: "receipt-card", tabindex: "-1", "data-testid": "receipt-card" }, [
    el("div", { class: "receipt-card-head" }, [
      el("div", {}, [
        el("p", { class: "eyebrow", text: "Receipt" }),
        el("h2", { text: "What this answer can prove" }),
      ]),
    ]),
    el("dl", { class: "receipt-grid" }, [
      row(
        "Signed",
        state?.receiptStatus?.signed ? "ok" : "pending",
        state?.receiptStatus?.signed
          ? `Signed by ${providerId} — checked in your browser`
          : "Checking the provider signature…",
      ),
      row(
        "Paid",
        tx ? "ok" : "pending",
        paidText,
        tx ? el("a", { href: hederaTx(tx), target: "_blank", rel: "noreferrer", text: "View on HashScan" }) : null,
      ),
      row(
        "Recorded",
        state?.request?.publishConsent === false ? "off" : pubTx ? "ok" : "pending",
        recordedText,
        pubTx ? el("a", { href: explorerTx(pubTx), target: "_blank", rel: "noreferrer", text: "View tx" }) : null,
      ),
      row("Audited", "neutral", auditText(providerStats, providerId)),
    ]),
    el("p", { class: "receipt-footnote" }, [
      "A receipt proves who answered and what was paid — not that the answer is correct. ",
      el("a", { href: "#/how", text: "How it works" }),
    ]),
    el("div", { class: "receipt-actions" }, [
      el("button", { type: "button", class: "primary secondary", onclick: onAgain, text: "Ask another" }),
      el("button", { type: "button", class: "text-button", onclick: onDownload, text: "Download receipt" }),
      el("button", { type: "button", class: "text-button", onclick: onDetails, text: "Technical details" }),
    ]),
  ]);
  container.append(card);
  queueMicrotask(() => card.focus({ preventScroll: true }));
}
