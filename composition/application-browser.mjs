import "/viewer.js";
const c = await fetch("/config.json").then((r) => r.json());
if (c.applicationVersion !== "2" || c.fixture !== false)
  throw Error("APPLICATION_VIEWER_REQUIRED");
const provider = document.getElementById("provider"),
  profile = document.getElementById("profile"),
  choice = document.getElementById("provider-choice"),
  models = document.getElementById("profile-choice");
const option = (value, label) => {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
};
for (const p of c.providers) choice.append(option(p.providerId, p.providerId));
const selectProvider = () => {
  const p = c.providers.find((p) => p.providerId === choice.value);
  if (!p) return;
  provider.value = p.providerId;
  models.replaceChildren();
  for (const id of p.profileIds)
    models.append(
      option(
        id,
        Object.entries(p.aliases)
          .filter(([, v]) => v === id)
          .map(([name]) => name)
          .join(" / ") || id,
      ),
    );
  profile.value = models.value;
  document.getElementById("tokens").max = String(p.limits.maxOutputTokens);
  document.getElementById("prompt").maxLength = p.limits.maxPromptCharacters;
  provider.dispatchEvent(new Event("input", { bubbles: true }));
};
choice.addEventListener("change", selectProvider);
models.addEventListener("change", () => {
  profile.value = models.value;
  profile.dispatchEvent(new Event("input", { bubbles: true }));
});
selectProvider();
document.getElementById("configured-choice").hidden = false;
document.getElementById("budget").value = "0";
const note = document.createElement("p");
note.setAttribute("role", "note");
note.textContent =
  (c.development
    ? "SYNTHETIC APPLICATION — not model inference. "
    : "LIVE RUNTIME CONFIGURED — not independently qualified. ") +
  (c.accessPolicy === "non-economic"
    ? "Non-economic access: no charge or settlement. "
    : "Ordinary x402 payment requires explicit authorization. ") +
  "No verification-contingent financial protection. Direct signed offers are not ENS records or computation proofs.";
document.querySelector("header").append(note);
