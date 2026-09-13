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

function short(value) {
  const text = String(value ?? "");
  return text.length > 28 ? `${text.slice(0, 14)}…${text.slice(-8)}` : text;
}

function jsonBlock(label, value) {
  if (value === undefined || value === null) return null;
  return el("details", { class: "json-details" }, [
    el("summary", { text: label }),
    el("pre", { text: JSON.stringify(value, null, 2) }),
  ]);
}

function timelineItem(label, body) {
  return el("li", {}, [el("strong", { text: label }), el("span", { text: body })]);
}

export function renderDetailsDrawer(container, state, { open = false, onClose } = {}) {
  container.replaceChildren();
  const provider = state?.provider ?? {};
  const source = provider.source ?? {};
  const quote = state?.quote;
  const job = state?.job;
  const receipt = state?.receipt;
  const publication = state?.publication;
  const rows = [
    timelineItem("Provider name", provider.providerId ?? "Auto-selected"),
    timelineItem(
      "Resolution",
      source.chainId ? `${source.chainId}${source.blockNumber ? ` at block ${source.blockNumber}` : ""}` : "Direct provider record",
    ),
    timelineItem("Placement", provider.capabilities?.placement ?? state?.providerConfig?.capabilities?.placement ?? "Shown by the provider when available"),
    timelineItem("Quote", quote ? `${quote.amountBaseUnits} ${quote.asset} on ${quote.network}; expires ${quote.expiresAt}` : "Quote not requested yet"),
    timelineItem("Hedera transaction", job?.payment?.transactionRef ?? "Waiting for payment record"),
    timelineItem("Stream", job?.executionStatus ? `Job ${job.executionStatus}; ${state?.answer?.length ?? 0} characters streamed` : "Not started"),
    timelineItem("Receipt", receipt ? `${receipt.keyId}; ${state?.receiptStatus?.signed ? "signature checked" : "signature pending"}` : "Not returned yet"),
    timelineItem("Public history", publication ? "Publication status refreshed" : "Waiting for public history"),
    timelineItem("Selection", state?.comparison?.decision?.selected?.providerId ? `Selected ${state.comparison.decision.selected.providerId}` : "Auto-pick uses available provider data"),
  ];
  const drawer = el("aside", { class: "details-drawer", hidden: !open, "aria-label": "Technical details" }, [
    el("div", { class: "drawer-header" }, [
      el("div", {}, [
        el("p", { class: "eyebrow", text: "Technical details" }),
        el("h2", { text: "Journey timeline" }),
      ]),
      el("button", { type: "button", class: "text-button", onclick: onClose, text: "Close" }),
    ]),
    el("ol", { class: "timeline" }, rows),
    el("section", { class: "details-section" }, [
      el("h3", { text: "Independent states" }),
      el("ul", { class: "state-list" }, [
        el("li", { text: `Execution: ${job?.executionStatus ?? "not started"}` }),
        el("li", { text: `Output: ${state?.answer ? "streamed" : "not available yet"}` }),
        el("li", { text: `Receipt integrity: ${state?.receiptStatus?.signed ? "checked" : "not checked"}` }),
        el("li", { text: `Payment: ${job?.payment?.status ?? "not started"}` }),
        el("li", { text: `Publication: ${publication?.status ?? (state?.request?.publishConsent === false ? "off" : "pending")}` }),
      ]),
    ]),
    el("section", { class: "details-section" }, [
      el("h3", { text: "IDs and hashes" }),
      el("dl", { class: "kv" }, [
        el("dt", { text: "Profile" }),
        el("dd", { class: "mono", text: short(state?.profileId) }),
        el("dt", { text: "Runtime" }),
        el("dd", { class: "mono", text: short(provider.runtimeDigest ?? state?.providerConfig?.runtimeDigest ?? "—") }),
        el("dt", { text: "Receipt" }),
        el("dd", { class: "mono", text: short(job?.receiptDigest ?? "—") }),
      ]),
    ]),
    el("section", { class: "details-section" }, [
      el("h3", { text: "Tools" }),
      el("p", { text: "Export, recovery and offline checks use the same request data shown below. Imported recovery files are inspect-only." }),
    ]),
    el("section", { class: "details-section raw-json" }, [
      el("h3", { text: "Raw JSON" }),
      jsonBlock("Quote", quote),
      jsonBlock("Job", job),
      jsonBlock("Receipt", receipt),
      jsonBlock("Publication", publication),
      el("p", { class: "muted", text: "— means the provider didn't send this fact; we never guess it." }),
    ].filter(Boolean)),
  ]);
  container.append(drawer);
}
