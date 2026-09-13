import { createTryFlow, modelOptionsFromConfig } from "./flow.mjs";
import { friendlyError, codeLine } from "./errors.mjs";
import {
  authorizeDemoPayment,
  configurePayments,
  getPaymentMethod,
  isHashPackAvailable,
  setPaymentAuthorizer,
  setPaymentMethod,
} from "./payments.mjs";
import { loadLiveStatus, statusText } from "./status.mjs";
import { renderTry } from "./views/try.mjs";
import { renderDetailsDrawer } from "./views/details.mjs";
import { renderProviders } from "./views/providers.mjs";
import { renderHow } from "./views/how.mjs";
import { renderDevelopers } from "./views/developers.mjs";

export { authorizeDemoPayment, setPaymentAuthorizer };
export function setAuditStatusProvider() {}

const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch {}
  },
};

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

const app = {
  root: null,
  main: null,
  detailsRoot: null,
  statusRoot: null,
  route: "try",
  config: null,
  models: [],
  providerStats: null,
  status: null,
  error: null,
  detailsOpen: false,
  paymentState: null,
  paymentHost: null,
  flow: null,
  flowState: { phase: "idle" },
  form: {
    modelKey: "auto",
    providerId: null,
    prompt: "",
    paymentMethod: "demo",
    maxOutputTokens: 64,
    budget: "1",
    publishConsent: true,
    pauseSteps: false,
  },
  stepCursor: 0,
};

function routeFromHash() {
  const raw = location.hash.replace(/^#\/?/, "") || "try";
  const [path, query] = raw.split("?");
  if (query?.includes("mode=advanced")) setMode("advanced", { render: false });
  return path.split("/")[0] || "try";
}

function setMode(mode, { render: shouldRender = true } = {}) {
  app.mode = mode === "advanced" ? "advanced" : "simple";
  store.set("mycelium.try.mode", app.mode);
  if (app.mode === "simple" && location.hash.includes("mode=advanced")) {
    history.replaceState(null, "", "#/try");
  }
  if (shouldRender) render();
}

function defaultMode() {
  if (location.hash.includes("mode=advanced")) return "advanced";
  return store.get("mycelium.try.mode") === "advanced" ? "advanced" : "simple";
}

function syncFormPatch(patch, options = {}) {
  Object.assign(app.form, patch);
  if (patch.paymentMethod) {
    try {
      setPaymentMethod(patch.paymentMethod);
    } catch (error) {
      app.error = friendlyError(error);
      app.form.paymentMethod = "demo";
      setPaymentMethod("demo");
    }
  }
  if (options.render !== false) render();
}

function currentTheme() {
  return document.documentElement.dataset.theme === "mushroom" ? "mushroom" : "cream";
}

function applyTheme(theme, { persist = true } = {}) {
  const next = theme === "mushroom" ? "mushroom" : "cream";
  document.documentElement.dataset.theme = next;
  document.body.dataset.theme = next;
  if (persist) {
    try { localStorage.setItem("mycelium.theme", next); } catch {}
  }
  // Reveal or hide the pre-baked mycelium strand layer.
  const layer = document.querySelector(".mycelium-strands");
  if (layer) layer.style.display = next === "mushroom" ? "block" : "none";
  // Update the toggle button label.
  const toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.dataset.theme = next;
    toggle.setAttribute("aria-pressed", next === "mushroom" ? "true" : "false");
    toggle.title = next === "mushroom" ? "Switch to cream theme" : "Switch to mushroom theme";
  }
}

function themeToggleButton() {
  const theme = currentTheme();
  return el("button", {
    type: "button",
    id: "theme-toggle",
    class: "theme-toggle",
    "aria-pressed": theme === "mushroom" ? "true" : "false",
    title: theme === "mushroom" ? "Switch to cream theme" : "Switch to mushroom theme",
    onclick: () => applyTheme(currentTheme() === "mushroom" ? "cream" : "mushroom"),
    text: theme === "mushroom" ? "☾ Mushroom" : "☀ Cream",
  });
}

function buildShell() {
  document.body.replaceChildren();
  // Honour the theme set by the pre-bundle bootstrap on <html>.
  document.body.dataset.theme = currentTheme();
  app.root = el("div", { class: "app-shell" }, [
    el("header", { class: "topbar" }, [
      el("a", { class: "brand", href: "#/try", text: "Mycelium" }),
      el("nav", { class: "tabs", "aria-label": "Main" }, [
        el("a", { href: "#/try", text: "Try it", dataset: { route: "try" } }),
        el("a", { href: "#/providers", text: "Providers", dataset: { route: "providers" } }),
        el("a", { href: "#/how", text: "How it works", dataset: { route: "how" } }),
        el("a", { href: "#/developers", text: "Developers", dataset: { route: "developers" } }),
      ]),
      themeToggleButton(),
      el("div", { id: "status-root", class: "status-root" }),
    ]),
    el("main", { id: "app-main", tabindex: "-1" }),
    el("div", { id: "details-root" }),
    el("footer", { class: "footer" }, [
      el("span", { text: "Testnet demo" }),
      el("span", { text: "Open source (AGPL)" }),
      el("a", { href: "#/how", text: "How it works" }),
      el("a", { href: "#/developers", text: "Developers" }),
    ]),
  ]);
  document.body.append(app.root);
  // Reveal the pre-baked strand layer if the active theme is dark.
  const layer = document.querySelector(".mycelium-strands");
  if (layer) layer.style.display = currentTheme() === "mushroom" ? "block" : "none";
  app.main = app.root.querySelector("#app-main");
  app.detailsRoot = app.root.querySelector("#details-root");
  app.statusRoot = app.root.querySelector("#status-root");
}

function renderStatus() {
  if (!app.statusRoot) return;
  const status = app.status;
  const popover = el("div", { class: "status-popover", hidden: true }, [
    el("p", { text: "Runs on Hedera testnet and Sepolia. Payments use test tokens with no real value. Answers come from small open models and can be wrong." }),
    status?.rows?.length ? el("ul", {}, status.rows.map((row) => el("li", {}, [el("strong", { text: row.label }), ` · ${statusText(row)}`]))) : null,
  ].filter(Boolean));
  const chip = el("button", {
    type: "button",
    id: "status-chip",
    class: `status-chip ${status?.chipClass ?? "is-partial"}`,
    onclick: () => { popover.hidden = !popover.hidden; },
    text: "● Testnet demo",
  });
  app.statusRoot.replaceChildren(chip, popover);
}

function updateActiveTabs() {
  document.querySelectorAll(".tabs a").forEach((a) => {
    a.toggleAttribute("aria-current", a.dataset.route === app.route);
  });
}

function downloadJson(name, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showReview(review) {
  return new Promise((resolve) => {
    const overlay = el("div", { class: "modal-backdrop", role: "presentation" }, [
      el("section", { class: "review-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "review-title" }, [
        el("h2", { id: "review-title", text: review?.title ?? "Review testnet payment" }),
        el("dl", { class: "kv" }, [
          el("dt", { text: "Amount" }), el("dd", { text: review?.amount ?? "Quote amount" }),
          el("dt", { text: "Recipient" }), el("dd", { class: "mono", text: review?.recipient ?? "Provider" }),
          el("dt", { text: "Expires" }), el("dd", { text: review?.expiresAt ?? "Soon" }),
        ]),
        el("p", { class: "muted", text: "This is Hedera testnet. Tokens have no real value." }),
        el("div", { class: "dialog-actions" }, [
          el("button", { type: "button", class: "secondary", onclick: () => close(false), text: "Cancel" }),
          el("button", { type: "button", class: "primary", onclick: () => close(true), text: "Approve in HashPack" }),
        ]),
      ]),
    ]);
    function close(answer) {
      overlay.remove();
      resolve(answer);
    }
    document.body.append(overlay);
    overlay.querySelector("button").focus();
  });
}

async function loadProviderStats() {
  if (app.config?.fixture) return;
  try {
    const response = await fetch("/v2/providers/stats", { cache: "no-store" });
    if (response.ok) app.providerStats = await response.json();
  } catch {}
}

async function refreshStatus() {
  if (app.config?.fixture) {
    app.status = {
      overall: "partial",
      chipClass: "is-partial",
      rows: [
        { id: "network", label: "Public gateway", state: "live", reason: "Development fixture responded.", source: "/healthz" },
        { id: "runtime", label: "Model network", state: "partial", reason: "Fixture path streams synthetic output for browser safety tests.", source: "/config.json" },
        { id: "payment", label: "Testnet payments", state: "partial", reason: "Development fixture uses a local payment adapter.", source: "/config.json" },
        { id: "graph", label: "Public history", state: "unavailable", reason: "Public history is not part of the local fixture.", source: "/config.json" },
      ],
    };
  } else {
    app.status = await loadLiveStatus().catch(() => ({ overall: "partial", chipClass: "is-partial", rows: [] }));
  }
  renderStatus();
}

function flowOptions() {
  return {
    prompt: app.form.prompt.trim(),
    modelKey: app.form.modelKey === "auto" ? undefined : app.form.modelKey,
    providerId: app.form.providerId || undefined,
    maxOutputTokens: Number(app.form.maxOutputTokens) || 64,
    budget: app.mode === "advanced" ? (app.form.budget || undefined) : undefined,
    publishConsent: app.form.publishConsent !== false,
  };
}

async function ask() {
  app.error = null;
  try {
    setPaymentMethod(app.form.paymentMethod);
    if (app.form.paymentMethod === "hashpack") await app.paymentHost?.connectWallet();
    render();
    await app.flow.submitAndStream(flowOptions());
  } catch (error) {
    app.error = friendlyError(error, { pendingSubmission: app.flow?.state()?.pendingSubmission });
    app.flowState = app.flow?.state() ?? app.flowState;
    render();
  }
}

async function stop() {
  try { await app.flow.cancel(); } catch (error) { app.error = friendlyError(error); }
  app.flowState = app.flow.state();
  render();
}

async function compare() {
  app.error = null;
  try {
    await app.flow.compareQuotes(flowOptions());
  } catch (error) {
    app.error = friendlyError(error);
  }
  app.flowState = app.flow.state();
  render();
}

async function step() {
  const sequence = ["find", "price", "ask"];
  const action = sequence[app.stepCursor % sequence.length];
  app.stepCursor++;
  try {
    if (action === "find") await app.flow.findProvider(flowOptions());
    else if (action === "price") await app.flow.price(flowOptions());
    else await ask();
  } catch (error) {
    app.error = friendlyError(error);
  }
  app.flowState = app.flow.state();
  render();
}

function renderDetails() {
  renderDetailsDrawer(app.detailsRoot, app.flowState, {
    open: app.detailsOpen,
    onClose: () => { app.detailsOpen = false; renderDetails(); },
  });
}

function renderTryRoute() {
  renderTry(app.main, {
    form: app.form,
    mode: app.mode,
    config: app.config ?? {},
    models: app.models,
    flowState: app.flowState,
    providerStats: app.providerStats,
    paymentState: app.paymentState,
    hashpackAvailable: isHashPackAvailable(app.config ?? {}),
    error: app.mode === "advanced" && app.error ? { ...app.error, message: `${app.error.message} ${codeLine(app.error)}`.trim() } : app.error,
    onChange: syncFormPatch,
    onMode: setMode,
    onAsk: ask,
    onStop: stop,
    onChangeProvider: () => { location.hash = "#/providers"; },
    onDetails: () => { app.detailsOpen = true; renderDetails(); },
    onDownload: () => downloadJson("mycelium-receipt.json", { state: app.flowState }),
    onAgain: () => { app.flow.resetForNext(); app.form.prompt = ""; app.error = null; app.flowState = app.flow.state(); render(); },
    onCompare: compare,
    onStep: step,
  });
  renderDetails();
}

function render() {
  if (!app.main) return;
  app.route = routeFromHash();
  updateActiveTabs();
  renderStatus();
  if (app.route === "providers") {
    app.detailsRoot.replaceChildren();
    renderProviders(app.main, { config: app.config, onSelectProvider: (providerId) => { app.form.providerId = providerId; location.hash = "#/try"; } });
  } else if (app.route === "how") {
    app.detailsRoot.replaceChildren();
    renderHow(app.main);
  } else if (app.route === "developers") {
    app.detailsRoot.replaceChildren();
    renderDevelopers(app.main);
  } else {
    renderTryRoute();
  }
}

async function init() {
  if (!document.body) return;
  app.mode = defaultMode();
  buildShell();
  app.flow = createTryFlow({
    onEvent(event) {
      app.flowState = event.state;
      if (event.type === "config") {
        app.config = event.config;
        app.models = event.models;
      }
      render();
    },
  });
  app.config = await app.flow.loadConfig().catch((error) => {
    app.error = friendlyError(error);
    return {};
  });
  app.models = modelOptionsFromConfig(app.config);
  app.form.modelKey = app.models[0]?.key ?? "auto";
  app.form.providerId = null;
  app.form.maxOutputTokens = app.config?.demoSponsor?.status === "available" ? 64 : 64;
  app.form.budget = app.config?.demoSponsor?.status === "available" ? "1" : "0";
  app.paymentHost = configurePayments({
    config: app.config,
    onReview: showReview,
    onStateChange(state) {
      app.paymentState = state;
      if (state.method) app.form.paymentMethod = state.method;
      render();
    },
  });
  await Promise.all([refreshStatus(), loadProviderStats()]);
  render();
  app.flow.findProvider({ modelKey: app.form.modelKey === "auto" ? undefined : app.form.modelKey }).catch((error) => {
    app.error = friendlyError(error);
    app.flowState = app.flow.state();
    render();
  });
}

addEventListener("hashchange", render);
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
else init();
