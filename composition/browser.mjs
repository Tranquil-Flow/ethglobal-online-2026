import { setPaymentAuthorizer } from "/viewer.js";
const config = await fetch("/config.json").then((r) => r.json());
if (config.development !== true) throw Error("DEVELOPMENT_REQUIRED");
document.getElementById("provider").value = config.providerId;
document.getElementById("profile").value = config.profileId;
const choices = document.createElement("datalist");
choices.id = "configured-providers";
for (const p of config.providers ?? []) {
  const option = document.createElement("option");
  option.value = p.providerId;
  choices.append(option);
}
document.body.append(choices);
document.getElementById("provider").setAttribute("list", choices.id);
const banner = document.createElement("p");
banner.textContent = `SYNTHETIC LOCAL APPLICATION — ${config.payment}; ${config.discovery}; ${config.history}. Execution: ${config.execution}. Assessment: ${config.assessment}. No real funds or inference verification. Publication: ${config.publication}.`;
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
