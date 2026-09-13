import { readFileSync } from "node:fs";
import { w6RuntimePath } from "./w6-runtime-paths.mjs";

const paymentsPath = new URL("../composition/application-payments.mjs", import.meta.url).href;
const { inspectManagedPayments } = await import(paymentsPath);

const o = JSON.parse(readFileSync(w6RuntimePath("application-live-paid-01", "operator.json"), "utf8"));
const spec = o.providers.find(p => p.get && p.payment)?.payment || (() => { for (const p of o.providers) if (p.payment) return p.payment; })();
const providerId = "service.ethonline-node-a.eth";
const profileIds = ["sha256:f17c05c452151f99e6758908ee2849f1086b237972b9f3fe1ca6506d9714fcea"];
const mode = "live";
try {
  const result = inspectManagedPayments({ spec, mode, providerId, profileIds });
  console.log("OK:", JSON.stringify(result, null, 2).slice(0,500));
} catch (e) {
  console.error("ERR:", e.code || e.message);
  console.error(e.stack);
}