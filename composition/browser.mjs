import { setPaymentAuthorizer } from "/viewer.js";
const config = await fetch("/config.json").then((r) => r.json());
if (config.development !== true) throw Error("DEVELOPMENT_REQUIRED");
document.getElementById("provider").value = config.providerId;
document.getElementById("profile").value = config.profileId;
const banner = document.createElement("p");
banner.textContent =
  "SYNTHETIC LOCAL APPLICATION — offline payment simulation, synthetic ENS records and Graph-shaped responses. No funds, live inference or execution verification. Publication disabled.";
banner.setAttribute("role", "note");
document.body.prepend(banner);
setPaymentAuthorizer(async ({ body, quote }) => {
  if (quote.mode !== "development") throw Error("DEVELOPMENT_ONLY");
  const r = await fetch("/development/authorize", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ethonline-development": "synthetic-only",
    },
    body: JSON.stringify({ body, quote }),
  });
  if (!r.ok) throw Error("SYNTHETIC_AUTHORIZATION_UNAVAILABLE");
  return r.json();
});
