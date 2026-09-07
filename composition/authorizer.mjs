import { safeBaseUrl } from "../packages/access/src/index.mjs";
// Explicit CLI/SDK callback for the composed OFFLINE simulator only. Not a wallet.
export default async function authorizeDevelopment({
  baseUrl,
  body,
  quote,
  signal,
}) {
  const url = new URL(safeBaseUrl(baseUrl));
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    quote?.mode !== "development"
  )
    throw Error("DEVELOPMENT_ONLY");
  const r = await fetch(url.origin + "/development/authorize", {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      "content-type": "application/json",
      "x-ethonline-development": "synthetic-only",
    },
    body: JSON.stringify({ body, quote }),
  });
  if (!r.ok) throw Error("SYNTHETIC_AUTHORIZATION_UNAVAILABLE");
  return r.json();
}
