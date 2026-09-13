import { loadLiveStatus, statusText } from "../status.mjs";

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === undefined || child === null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function explainerStep(title, plain, hood) {
  return el("details", { class: "how-step" }, [
    el("summary", {}, [el("strong", { text: title }), el("span", { text: plain })]),
    el("p", { text: hood }),
  ]);
}

function statusRow(row) {
  return el("li", { class: `live-row ${row.state}` }, [
    el("strong", { text: row.label }),
    el("span", { text: statusText(row) }),
    el("p", { text: row.reason }),
    el("small", { text: row.source }),
  ]);
}

// --- W6 demo-sponsor 5-step explainer --------------------------------------

const DEMO_FLOW = [
  {
    n: 1,
    title: "Discover the provider",
    short: "ENS lookup or direct offer",
    detail: "The SDK resolves service.ethonline-node-a.eth via ENSv2 on Sepolia (or reads a direct offer). The resolved record pins a providerId and profileId for the rest of the flow.",
    state: "ens-resolution",
  },
  {
    n: 2,
    title: "Create a quote",
    short: "1 tinybar Hedera payment · sponsor pays",
    detail: "POST /v1/quotes returns a short-lived quote: 1 tinybar on hedera:testnet, asset 0.0.0, receiver 0.0.10419316, amountBaseUnits \"1\". The OT1 demo sponsor key pays for the demo so judges do not need a funded wallet.",
    state: "quote-created",
  },
  {
    n: 3,
    title: "First /v1/jobs → 402 challenge",
    short: "Server asks for payment",
    detail: "Submitting the request without a payment-signature header returns HTTP 402. The challenge body and the payment-required header carry the binding the authorizer needs.",
    state: "payment-required",
  },
  {
    n: 4,
    title: "/v2/demo-sponsor/authorize",
    short: "OT1 sponsor signs the header on Hedera testnet",
    detail: "POST /v2/demo-sponsor/authorize sends the 402 context to the OT1 sponsor key. The response carries a real payment-signature (~1.1 KB) bound to the request nonce.",
    state: "demo-sponsor-signed",
  },
  {
    n: 5,
    title: "Second /v1/jobs → settled",
    short: "Inference runs · receipt signed",
    detail: "POST /v1/jobs with payment-signature returns 202. The server settles on Hedera testnet, runs the small model, and returns a signed receipt. txId looks like 0.0.xxxxx@1700000000.000.",
    state: "execution-completed",
  },
];

function demoStepCard(step) {
  return el("article", {
    class: "demo-flow-step",
    dataset: { step: `w6-${step.state}` },
  }, [
    el("div", { class: "demo-flow-step__head" }, [
      el("span", { class: "demo-flow-step__n", text: `Step ${step.n}` }),
      el("h3", { text: step.title }),
    ]),
    el("p", { class: "demo-flow-step__short", text: step.short }),
    el("p", { class: "demo-flow-step__detail", text: step.detail }),
    el("div", { class: "demo-flow-step__state" }, [
      el("span", { class: "demo-state-badge", dataset: { state: step.state }, text: step.state }),
    ]),
  ]);
}

function demoFlowDiagram() {
  // Honest state badge row (mirrors the badges in composition/live-viewer.mjs).
  const badges = [
    "ens-resolution",
    "quote-created",
    "payment-required",
    "demo-sponsor-signed",
    "execution-completed",
  ];
  const badgeRow = el(
    "div",
    { class: "demo-state-row" },
    badges.map((b) =>
      el("span", { class: "demo-state-badge", dataset: { state: b }, text: b }),
    ),
  );

  // ASCII-style flow diagram, kept inside a <pre> so it scrolls horizontally
  // on narrow screens without breaking layout.
  const flow =
    "  client / SDK                                    Mycelium gateway                 Hedera testnet\n" +
    "       │                                                  │                                  │\n" +
    "  1    │  GET providerId/profileId (ENSv2)                │                                  │\n" +
    "  ───▶ │ ───────────────────────────────────────────────▶ │                                  │\n" +
    "       │                                                  │                                  │\n" +
    "  2    │  POST /v1/quotes  (capability)                   │                                  │\n" +
    "  ───▶ │ ───────────────────────────────────────────────▶ │                                  │\n" +
    "       │ ◀── 200: 1 tinybar · asset 0.0.0 · 0.0.10419316 ─│                                  │\n" +
    "       │                                                  │                                  │\n" +
    "  3    │  POST /v1/jobs  (no payment-signature)           │                                  │\n" +
    "  ───▶ │ ───────────────────────────────────────────────▶ │                                  │\n" +
    "       │ ◀── 402 + payment-required header ───────────────│                                  │\n" +
    "       │                                                  │                                  │\n" +
    "  4    │  POST /v2/demo-sponsor/authorize (402 context)    │                                  │\n" +
    "  ───▶ │ ───────────────────────────────────────────────▶ │  OT1 demo-sponsor key signs       │\n" +
    "       │                                                  │ ──────────────────────────────▶   │\n" +
    "       │ ◀── 200: payment-signature (~1.1 KB) ────────────│ ◀── real Hedera signature ────── │\n" +
    "       │                                                  │                                  │\n" +
    "  5    │  POST /v1/jobs  (payment-signature)              │                                  │                                  │\n" +
    "  ───▶ │ ───────────────────────────────────────────────▶ │  settle on hedera:testnet →       │\n" +
    "       │ ◀── 202: jobId + paymentId + txRef ──────────────│  txId 0.0.xxxxx@ts.ts           │\n" +
    "       │   inference runs → signed receipt (Ed25519)      │                                  │";

  const diagram = el("pre", { class: "demo-flow-diagram", text: flow });
  return el("section", { class: "demo-flow-diagram-wrap" }, [
    el("h2", { text: "W6 demo flow (one picture)" }),
    diagram,
    badgeRow,
  ]);
}

function demoFlowSection() {
  return el("section", { class: "page-section w6-demo-flow" }, [
    el("p", { class: "eyebrow", text: "W6 demo sponsor" }),
    el("h1", { text: "The 5 steps the demo actually performs" }),
    el("p", { class: "lede", text: "Plain-language walkthrough of the running demo. Every step has a live state badge; the diagram below mirrors the same five states." }),
    el("div", { class: "demo-flow-steps" }, DEMO_FLOW.map(demoStepCard)),
    demoFlowDiagram(),
  ]);
}

// --- Original how page (preserved) -----------------------------------------

export async function renderHow(container) {
  container.replaceChildren(el("section", { class: "page-section" }, [
    el("p", { class: "eyebrow", text: "How it works" }),
    el("h1", { text: "Loading…" }),
    el("p", { text: "Loading live demo status…" }),
  ]));
  const live = await loadLiveStatus().catch(() => ({ rows: [] }));
  container.replaceChildren(
    // New demo-sponsor explainer first so judges see it above the fold.
    demoFlowSection(),
    el("section", { class: "page-section how-page" }, [
      el("p", { class: "eyebrow", text: "How it works" }),
      el("h1", { text: "Receipts instead of blind trust" }),
      el("p", { class: "lede", text: "AI models run on ordinary computers owned by different people. You pay per question. Every answer comes with a receipt, so providers build a public reputation you can check instead of asking you to trust one company." }),
      el("div", { class: "how-steps" }, [
        explainerStep("Find", "Providers have names like websites.", "The demo can use ENSv2 records on Sepolia or the current configured provider list."),
        explainerStep("Price", "The provider quotes a price that expires quickly.", "The browser binds a signed provider offer to a short-lived quote."),
        explainerStep("Pay", "Demo credit covers a tiny Hedera testnet payment here.", "The paid path uses x402 and Hedera testnet tokens with no real value."),
        explainerStep("Run", "The model may be split across several Macs.", "Mycelium routes the request through its runtime; this helps bigger models fit, not every answer become faster."),
        explainerStep("Receipt", "The provider signs what it did.", "Your browser checks the Ed25519 receipt signature before showing the signed row."),
        explainerStep("Track record", "A public fingerprint can be indexed for reputation.", "Sepolia events and The Graph turn receipts and spot-checks into provider history."),
      ]),
      el("section", { class: "split" }, [
        el("div", {}, [
          el("h2", { text: "What this proves" }),
          el("ul", {}, [
            el("li", { text: "Who answered the request." }),
            el("li", { text: "What was paid on testnet." }),
            el("li", { text: "Whether public history has seen the receipt." }),
          ]),
        ]),
        el("div", {}, [
          el("h2", { text: "What it does not prove" }),
          el("ul", {}, [
            el("li", { text: "That the answer is true." }),
            el("li", { text: "That every future answer from a provider is honest." }),
            el("li", { text: "That your prompt is hidden from the provider." }),
          ]),
        ]),
      ]),
      el("section", {}, [
        el("h2", { text: "What's live right now" }),
        el("ul", { class: "live-status-list" }, live.rows.map(statusRow)),
      ]),
      el("section", { class: "faq" }, [
        el("h2", { text: "FAQ" }),
        explainerStep("Is this real money?", "No — this public demo uses testnet tokens with no real value.", "HashPack, when enabled, is still testnet-only for this demo."),
        explainerStep("Can the provider see my prompt?", "Yes. Don't send secrets.", "Receipts make behavior accountable; they do not encrypt the prompt from the provider."),
        explainerStep("Why is the answer short or slow?", "The demo uses small open models and a live experimental runtime.", "Provider availability and answer length are visible in Advanced mode."),
        explainerStep("Can I run a node?", "A Mac app is coming soon.", "The project is open source under AGPL-3.0-or-later."),
      ]),
    ]),
  );
}