export const ISOLATED_FREE_ORIGIN = "http://127.0.0.1:4350";

export function resolveViewerConfig(config, origin) {
  return {
    ...config,
    ...(origin === ISOLATED_FREE_ORIGIN && config.isolatedFree === true
      ? { apiUrl: origin }
      : {}),
  };
}

function showBadge(target, config) {
  if (config.apiUrl !== ISOLATED_FREE_ORIGIN) return;
  if (target.document.querySelector("[data-isolated-free-path]")) return;
  const badge = target.document.createElement("span");
  badge.dataset.isolatedFreePath = "true";
  badge.setAttribute("role", "note");
  badge.textContent = "Isolated Free Path — loopback only";
  Object.assign(badge.style, {
    display: "inline-block",
    margin: "0.5rem 0",
    padding: "0.25rem 0.55rem",
    border: "1px solid currentColor",
    borderRadius: "999px",
    fontSize: "0.8rem",
    fontWeight: "700",
  });
  target.document.querySelector("header")?.prepend(badge);
}

export function installIsolatedFreeViewer(target = window) {
  // Self-heal stale service workers: an older bundle registered one, and an
  // active SW serves the whole site from cache — hard refreshes cannot reach
  // the new bundle until it is unregistered. Do this before anything else
  // renders so the very first new-bundle load clears the trap.
  if (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator
  ) {
    try {
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => {
          for (const registration of registrations) registration.unregister();
        })
        .catch(() => {});
    } catch {
      // Never let SW hygiene break the page.
    }
  }
  if (target.fetch.__myceliumIsolatedFree) return;
  const fetchFromOrigin = target.fetch.bind(target);
  const wrappedFetch = async (input, init) => {
    const response = await fetchFromOrigin(input, init);
    const requestUrl = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
      target.location.href,
    );
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    if (
      method !== "GET" ||
      requestUrl.origin !== target.location.origin ||
      requestUrl.pathname !== "/config.json" ||
      !response.ok
    )
      return response;
    const config = resolveViewerConfig(
      await response.clone().json(),
      target.location.origin,
    );
    if (config.apiUrl !== ISOLATED_FREE_ORIGIN) return response;
    if (!Object.hasOwn(target, "__MYCELIUM_VIEWER_CONFIG__"))
      Object.defineProperty(target, "__MYCELIUM_VIEWER_CONFIG__", {
        value: Object.freeze({ ...config }),
        enumerable: false,
      });
    showBadge(target, config);
    return new response.constructor(JSON.stringify(config), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  Object.defineProperty(wrappedFetch, "__myceliumIsolatedFree", { value: true });
  target.fetch = wrappedFetch;
}
