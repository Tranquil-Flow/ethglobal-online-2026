import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import { createBoundedConsumer } from "../src/client.mjs";
import { PROTOCOL } from "../src/protocol.mjs";
import { amount, fail, readJson } from "../src/safety.mjs";
// No wallet/key/env lookup. Dry-run exits before loading an operator adapter.
try {
  const { values: v } = parseArgs({
    options: {
      network: { type: "string" },
      budget: { type: "string" },
      execute: { type: "boolean" },
      approved: { type: "boolean" },
      adapter: { type: "string" },
    },
  });
  if (v.network !== PROTOCOL.network) fail("EXPLICIT_TESTNET_REQUIRED");
  const cap = amount(v.budget);
  if (cap <= 0n) fail("POSITIVE_BUDGET_REQUIRED");
  if (!v.execute) {
    console.log(
      JSON.stringify({
        mode: "live-preflight-only",
        network: PROTOCOL.network,
        asset: PROTOCOL.asset,
        facilitator: PROTOCOL.facilitatorUrl,
        maxAmountBaseUnits: cap.toString(),
        broadcast: false,
        walletLoaded: false,
        liveQualified: false,
      }),
    );
  } else {
    if (v.approved !== true || !v.adapter || !isAbsolute(v.adapter))
      fail("EXTERNAL_APPROVAL_AND_ADAPTER_REQUIRED");
    const { connect } = await import(pathToFileURL(v.adapter));
    const stopping = new AbortController();
    const abort = () => stopping.abort();
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    // Setup has its own finite ceiling; payment consumption remains <=30s.
    const signal = AbortSignal.any([
      stopping.signal,
      AbortSignal.timeout(180000),
    ]);
    let connection;
    try {
      connection = await connect({
        network: v.network,
        maxAmountBaseUnits: v.budget,
        signal,
      });
      const { url, expected, request, capability, walletAuthorize } =
        connection;
      if (
        expected?.mode !== "live" ||
        expected.network !== v.network ||
        !request?.prompt?.startsWith("SYNTHETIC_LIVE_SMOKE:") ||
        request.publishConsent !== false
      )
        fail("SYNTHETIC_LIVE_REQUEST_REQUIRED");
      const base = new URL(url);
      if (
        base.protocol !== "https:" ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
      )
        fail("HTTPS_SERVICE_REQUIRED");
      const fetchImpl = connection.fetch ?? fetch;
      if (typeof fetchImpl !== "function") fail("INVALID_OPERATOR_TRANSPORT");
      const response = await fetchImpl(url + "/quote", {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + capability,
        },
        body: JSON.stringify({ request }),
      });
      if (response.status !== 201) fail("QUOTE_UNAVAILABLE");
      const quote = await readJson(response);
      const consumer = createBoundedConsumer({
        url: url + "/operation",
        expected,
        walletAuthorize,
        fetch: fetchImpl,
        maxAmountBaseUnits: v.budget,
        maxTotalAmountBaseUnits: v.budget,
        timeoutMs: 30000,
      });
      const result = await consumer.consume({
        request,
        quote,
        capability,
        idempotencyKey: "live-smoke-" + quote.quoteId,
        signal,
      });
      if (
        result.status !== 200 ||
        result.body?.payment?.status !== "settled" ||
        result.body?.mode !== "live" ||
        result.body?.execution !== "succeeded"
      )
        fail("LIVE_SMOKE_NOT_CONFIRMED");
      await connection.recordResult?.(result);
      console.log(
        JSON.stringify({
          mode: "live",
          status: result.status,
          payment: result.body.payment.status,
          transactionRef: result.body.payment.transactionRef,
          operation: result.body.operation,
          inference: result.body.inference === true,
          inferenceVerified: false,
        }),
      );
    } finally {
      try {
        await connection?.close?.();
      } finally {
        process.off("SIGINT", abort);
        process.off("SIGTERM", abort);
      }
    }
  }
} catch (e) {
  console.error(e.code ?? "LIVE_SMOKE_FAILED");
  process.exitCode = 1;
}
