import { renderReceiptCard } from "./receipt.mjs";
import { mountEnsLine, mountEnsResult } from "./ens-lookup.mjs";

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "checked") node.checked = Boolean(value);
    else if (key === "value") node.value = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === undefined || child === null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const steps = [
  ["finding", "Finding provider"],
  ["pricing", "Getting price"],
  ["paying", "Paying"],
  ["generating", "Generating…"],
  ["verifying", "Verifying · TEE"],
  ["signing", "Receipt & publication"],
];

/** The demo providers advertise one shared output-token cap; the payment
 *  sponsor guard enforces the same bound. The input clamps to it so a user
 *  cannot configure a request the demo route will refuse. */
function maxOutputTokenBound(config) {
  const bound = Number(config?.limits?.maxOutputTokens);
  return Number.isFinite(bound) && bound > 0 ? Math.min(bound, 128) : 128;
}

/** Segmented Simple/Advanced switch. Sits directly above the advanced panel
 *  so toggling it never scrolls the panel out of view. */
function modeSwitch(mode, onMode) {
  const button = (value, label) =>
    el("button", {
      type: "button",
      class: `mode-switch-btn ${mode === value ? "is-active" : ""}`,
      "aria-pressed": mode === value ? "true" : "false",
      onclick: () => onMode(value),
      text: label,
    });
  return el("div", { class: "mode-switch", role: "group", "aria-label": "Form complexity" }, [
    button("simple", "Simple"),
    button("advanced", "Advanced"),
  ]);
}

function phaseIndex(phase) {
  if (phase === "done") return steps.length;
  if (phase === "error") return -1;
  return steps.findIndex(([id]) => id === phase);
}

function trustLine(providerStats, providerId) {
  const providers = providerStats?.providers ?? providerStats?.rows ?? [];
  const row = providers.find((item) => item.providerId === providerId || item.ensName === providerId) ?? providerStats?.provider;
  const trust = row?.trust ?? row?.rank?.trust ?? row?.metrics ?? null;
  const score = trust?.score ?? row?.trustScore;
  const reason = row?.rank?.reasons?.[0] ?? row?.sentence ?? null;
  if (score === undefined || score === null) return { text: "New provider", reason: reason ?? "Picked from currently available providers" };
  return { text: `Trust ${score}/1000`, reason: reason ?? "Picked for public track record" };
}

function modelCard(model, form, onChange) {
  const selected = form.modelKey === model.key;
  // An unavailable model is rendered disabled with its reason, never hidden and
  // never silently selectable.
  if (model.unavailable)
    return el("label", { class: "model-card is-unavailable", title: "Not available" }, [
      el("input", { type: "radio", name: "modelKey", value: model.key, disabled: true }),
      el("span", { class: "model-name", text: model.label }),
      el("span", { class: "model-meta", text: "No providers" }),
    ]);
  return el("label", { class: `model-card ${selected ? "selected" : ""}` }, [
    el("input", {
      type: "radio",
      name: "modelKey",
      value: model.key,
      checked: selected,
      onchange: () => onChange({ modelKey: model.key }),
    }),
    el("span", { class: "model-name", text: model.label }),
    el("span", { class: "model-meta", text: model.providers?.length > 1 ? `${model.providers.length} providers` : "Demo route" }),
  ]);
}

function stepper(phase) {
  const idx = phaseIndex(phase);
  return el("ol", { class: "stepper", "aria-live": "polite", "data-testid": "stepper" },
    steps.map(([id, label], i) => el("li", {
      class: i < idx ? "done" : i === idx ? "active" : "todo",
      text: i < idx ? `${label} ✓` : label,
      dataset: { step: id },
    })),
  );
}

function paymentRows(form, paymentState, onChange, hashpackAvailable) {
  const walletState = paymentState?.wallet;
  const walletConnected = walletState?.status === "connected";
  const rows = [
    el("label", { class: "payment-choice is-wallet" }, [
      el("input", { type: "radio", name: "paymentMethod", value: "hashpack", checked: form.paymentMethod === "hashpack", onchange: () => onChange({ paymentMethod: "hashpack" }) }),
      el("span", { text: "Pay with my Hedera wallet" }),
      el("small", { text: walletConnected
        ? `HashPack connected · ${walletState.accountId}`
        : hashpackAvailable
          ? "HashPack · connect to pay with your own wallet"
          : "HashPack not detected — install or unlock it" }),
    ]),
    el("label", { class: "payment-choice is-demo" }, [
      el("input", { type: "radio", name: "paymentMethod", value: "demo", checked: form.paymentMethod !== "hashpack", onchange: () => onChange({ paymentMethod: "demo" }) }),
      el("span", { text: "Free demo credit" }),
      el("small", { text: "Demo-only fallback · sponsored on Hedera testnet" }),
    ]),
  ];
  return rows;
}

function advancedControls({ form, config, models, flowState, onChange, onCompare, onStep }) {
  const providers = config?.providers ?? [];
  return el("section", { class: "advanced-panel", "data-testid": "advanced-panel" }, [
    el("h3", { text: "Advanced controls" }),
    el("div", { class: "advanced-grid" }, [
      el("label", {}, [
        el("span", { text: "Provider" }),
        el("select", { id: "provider-select", value: form.providerId ?? "auto", onchange: (e) => onChange({ providerId: e.target.value === "auto" ? null : e.target.value }) }, [
          el("option", { value: "auto", text: "Auto-pick by track record" }),
          ...providers.map((p) => el("option", { value: p.providerId, selected: form.providerId === p.providerId, text: p.providerId })),
        ]),
      ]),
      // W6 — optional ENSv2 name lookup. Resolves through /v2/ens-discovery
      // (read-only provenance); it never changes the provider selected above.
      el("label", {}, [
        el("span", { text: "ENS name · optional" }),
        el("input", {
          id: "ens-name",
          type: "text",
          value: form.ensName ?? "",
          placeholder: "service.ethonline-node-a.eth",
          autocapitalize: "off",
          spellcheck: "false",
          onchange: (e) => onChange({ ensName: e.target.value }),
          onkeydown: (e) => { if (e.key === "Enter") e.target.blur(); },
        }),
        el("small", { class: "field-hint", text: "Read-only ENSv2 provenance read. The selection above is not changed." }),
      ]),
      el("label", {}, [
        el("span", { text: "Model" }),
        el("select", { id: "model-select", value: form.modelKey, onchange: (e) => onChange({ modelKey: e.target.value }) },
          models.map((m) => el("option", { value: m.key, selected: form.modelKey === m.key, text: `${m.label} · ${m.profileId ?? "auto"}` })),
        ),
      ]),
      el("label", {}, [
        el("span", { text: "Answer length · max output tokens" }),
        el("input", { id: "tokens", type: "number", min: "2", max: String(maxOutputTokenBound(config)), value: form.maxOutputTokens, oninput: (e) => onChange({ maxOutputTokens: Math.min(Number(e.target.value), maxOutputTokenBound(config)) }) }),
        el("small", { class: "field-hint", text: `Demo providers serve up to ${maxOutputTokenBound(config)} tokens.` }),
      ]),
      el("label", {}, [
        el("span", { text: "Budget ceiling" }),
        el("input", { id: "budget", type: "text", value: form.budget, oninput: (e) => onChange({ budget: e.target.value }) }),
        el("small", { class: "field-hint", text: "The most your payment method may authorize for one quote. You pay the quote amount, never more than this ceiling." }),
      ]),
      el("div", { class: "checks-row" }, [
        el("label", { class: "check-row" }, [
          el("input", { type: "checkbox", checked: form.publishConsent !== false, onchange: (e) => onChange({ publishConsent: e.target.checked }) }),
          el("span", { text: "Record a receipt fingerprint publicly" }),
        ]),
      ]),
    ]),
    // Result slot for the optional ENS name above (populated after mount).
    el("p", { class: "ens-result", "data-testid": "ens-result" }, [
      String(form.ensName ?? "").trim()
        ? el("span", { class: "muted", text: "Resolving ENSv2…" })
        : el("span", { class: "muted", text: "Optional: resolve an ENSv2 name to inspect its on-chain record (read-only; the selection above is not changed)." }),
    ]),
    el("div", { class: "advanced-actions" }, [
      el("button", { type: "button", class: "secondary", onclick: onCompare, text: "Compare quotes from every provider" }),
      el("button", { type: "button", class: "secondary", onclick: onStep, text: "Run next step" }),
      el("button", { type: "button", class: "secondary", disabled: true, text: "Download encrypted recovery" }),
      el("button", { type: "button", class: "secondary", disabled: !flowState?.job, text: "Export receipt" }),
    ]),
    flowState?.quote ? el("details", { class: "quote-review" }, [
      el("summary", { text: "Quote review" }),
      el("p", { text: `${flowState.quote.amountBaseUnits} ${flowState.quote.asset} on ${flowState.quote.network}` }),
      el("p", { text: `Recipient ${flowState.quote.receiver}; expires ${flowState.quote.expiresAt}` }),
      el("pre", { text: JSON.stringify(flowState.quote, null, 2) }),
    ]) : null,
  ]);
}

export function renderTry(container, context) {
  const {
    form,
    mode,
    config,
    models,
    flowState,
    providerStats,
    paymentState,
    hashpackAvailable,
    error,
    onChange,
    onMode,
    onAsk,
    onStop,
    onChangeProvider,
    onDetails,
    onDownload,
    onAgain,
    onCompare,
    onStep,
  } = context;
  container.replaceChildren();
  const providerId = flowState?.provider?.providerId ?? form.providerId ?? config?.providers?.[0]?.providerId ?? "provider";
  const trust = trustLine(providerStats, providerId);
  // W6 — ENSv2 provenance. The lookup target is the name the currently-shown
  // provider advertises; it is informational only and never influences
  // selection (the demo providers are pre-configured and the signed-offer
  // equality gate is unchanged). When no provider is known yet the line is
  // omitted entirely rather than guessed at.
  const ensTarget = flowState?.provider?.providerId ?? form.providerId ?? config?.providers?.[0]?.providerId ?? null;
  const ensCustomName = mode === "advanced" ? String(form.ensName ?? "").trim() : "";
  const ensLine = el("p", { class: "ens-line", "data-testid": "ens-line" }, [
    el("span", { class: "muted", text: "Resolving ENSv2…" }),
  ]);
  const maxPrompt = flowState?.provider?.limits?.maxPromptCharacters ?? config?.limits?.maxPromptCharacters ?? 1000;
  const promptLength = form.prompt.length;
  const running = ["finding", "pricing", "paying", "generating", "verifying"].includes(flowState?.phase);
  const generating = flowState?.phase === "generating";
  const askDisabled = running || promptLength === 0 || promptLength > maxPrompt;
  const primary = form.paymentMethod === "hashpack" ? "Review & pay" : "Ask";
  const shell = el("section", { class: "try-shell" }, [
    el("div", { class: "hero" }, [
      el("h1", { text: "Request verifiable inference from open source models hosted on distributed networks." }),
      el("p", { text: "Every answer comes with a signed receipt, a payment record, contributes to the public track record for the provider and is verified by our TEE. What you ask for is what you get." }),
    ]),
    el("div", { "data-test-mode": mode }, [
      el("article", { class: "try-card", "data-testid": "try-card" }, [
      el("div", { class: "card-title-row" }, [
        el("div", {}, [el("p", { class: "eyebrow", text: "Try it" }), el("h2", { text: "Ask a question" })]),
      ]),
      el("div", { class: "model-grid", role: "radiogroup", "aria-label": "Model" }, models.map((model) => modelCard(model, form, onChange))),
      el("p", { class: "provider-line" }, [
        "Served by ",
        el("strong", { text: providerId }),
        ` · ${trust.text} · `,
        el("button", { type: "button", class: "link-button", onclick: onChangeProvider, text: "Change" }),
        el("span", { class: "provider-reason", text: ` ${trust.reason}` }),
      ]),
      // ENSv2 provenance line sits directly under the provider line.
      ensTarget ? ensLine : null,
      el("label", { class: "prompt-label" }, [
        el("span", { text: "Prompt" }),
        el("textarea", { id: "prompt", rows: "6", maxlength: maxPrompt, value: form.prompt, placeholder: "Ask a practical question…", oninput: (e) => {
          onChange({ prompt: e.target.value }, { render: false });
          const card = e.target.closest(".try-card");
          const count = card?.querySelector(".prompt-tools > span");
          if (count) {
            count.textContent = `${e.target.value.length}/${maxPrompt}`;
            count.className = e.target.value.length > maxPrompt ? "over" : "";
          }
          const button = card?.querySelector("#ask-button");
          if (button) button.disabled = e.target.value.trim().length === 0 || e.target.value.length > maxPrompt;
        } }),
      ]),
      el("div", { class: "prompt-tools" }, [
        el("span", { class: promptLength > maxPrompt ? "over" : "", text: `${promptLength}/${maxPrompt}` }),
      ]),
      el("div", { class: "payment-row", role: "radiogroup", "aria-label": "Payment method" }, paymentRows(form, paymentState, onChange, hashpackAvailable)),
      el("p", { class: "price-line", text: flowState?.quote
        ? (flowState.quote.network === "non-economic" || flowState.quote.asset === "none"
          ? "Cost: covered for this demo"
          : `Cost: ${flowState.quote.amountBaseUnits} ${flowState.quote.asset} · ${flowState.quote.network}`)
        : "Cost: shown before payment; demo credit uses Hedera testnet" }),
      stepper(flowState?.phase ?? "idle"),
      el("p", { class: "verifier-note", text: "Verification runs inside the TEE: the verifier holds the ensemble statistical tests and runs the classifier that checks every answer. Three consecutive mismatches trigger an automatic audit." }),
      error
        ? el("div", { class: `friendly-error ${error.tone}`, role: "alert" }, [
            el("p", { class: "friendly-error-message", text: error.message }),
            // Always surface the real code: without it a failed request is
            // indistinguishable from any other failure while testing the flow.
            error.code && error.code !== "UNKNOWN"
              ? el("p", { class: "friendly-error-code", text: `Error code: ${error.code}` })
              : null,
          ].filter(Boolean))
        : null,
      flowState?.answer ? el("div", { class: "answer-bubble", "data-testid": "answer", text: flowState.answer }) : null,
      el("div", { class: "primary-actions" }, [
        el("button", { id: "ask-button", type: "button", class: "primary", disabled: askDisabled, onclick: onAsk, text: primary }),
        generating ? el("button", { id: "stop-button", type: "button", class: "secondary", onclick: onStop, text: "Stop" }) : null,
      ]),
      // The mode switch sits directly above the advanced panel so toggling
      // Advanced never leaves the panel outside the viewport.
      modeSwitch(mode, onMode),
      mode === "advanced" ? advancedControls({ form, config, models, flowState, onChange, onCompare, onStep }) : null,
      el("div", { id: "receipt-slot" }),
      // Technical details renders directly below this card; the trigger
      // therefore lives at the card's foot, just above the panel it opens.
      el("div", { class: "details-row" }, [
        el("button", { type: "button", class: "text-button", onclick: onDetails, text: "Technical details" }),
      ]),
    ].filter(Boolean)),
    ]),
  ]);
  container.append(shell);
  // ENSv2 lookups are kicked off after mount: bounded (10s), cached (30s),
  // and informational only — never a provider-selection input. Completions
  // are no-ops if a newer render already replaced these nodes.
  if (ensTarget) mountEnsLine(container.querySelector('[data-testid="ens-line"]'), ensTarget);
  if (ensCustomName) mountEnsResult(container.querySelector('[data-testid="ens-result"]'), ensCustomName);
  if (flowState?.phase === "done" || flowState?.receipt || flowState?.job?.receiptDigest) {
    renderReceiptCard(
      container.querySelector("#receipt-slot"),
      {
        ...flowState,
        paymentMethod: form.paymentMethod,
        // A7 — let the receipt read the wallet's [demo-only] flag so the
        // badge can render "mock-wallet [demo-only]" instead of "wallet".
        wallet: paymentState?.wallet ?? flowState?.wallet ?? null,
      },
      { providerStats, onDetails, onDownload, onAgain },
    );
  }
}
