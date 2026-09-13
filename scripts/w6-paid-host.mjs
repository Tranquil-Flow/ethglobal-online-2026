// Retired: this entrypoint previously held an unguarded payment signer.
// Keep imports inert; the maintained payment boundary is named in the refusal.
import { pathToFileURL } from "node:url";

export const RETIRED_PAYMENT_ENTRYPOINT_MESSAGE =
  "RETIRED_PAYMENT_ENTRYPOINT: scripts/w6-paid-host.mjs is disabled because it was an unguarded payment signer. Use scripts/w6-single-payment-guard.mjs through the maintained owner-approved guarded payment flow; this entrypoint will not read credentials, sign, or connect to a network.";

export function refuseLegacyPaymentEntrypoint({ stderr = process.stderr } = {}) {
  stderr.write(RETIRED_PAYMENT_ENTRYPOINT_MESSAGE + "\n");
  return 1;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = refuseLegacyPaymentEntrypoint();
}
