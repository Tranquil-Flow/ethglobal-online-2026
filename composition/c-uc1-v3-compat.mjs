#!/usr/bin/env node
// Bounded, local-conformance-only compatibility consumer; never a model/fleet runner.
import {digestOf} from "../packages/contracts/index.mjs";
import {simulatorProfile} from "./runtime.mjs";
import {createGatewayV3Transport} from "./mycelium-gateway-v3.mjs";
import {createGatewayV3SessionFactory} from "./mycelium-bridge-v3.mjs";
import {createV3NativeExecutionAdapter} from "./mycelium-native-v3.mjs";
try {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
    if (Buffer.byteLength(data) > 131072) throw Error("INPUT_LIMIT");
  }
  const config = JSON.parse(data), url = new URL(config.baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)) throw Error("LOCAL_CONFORMANCE_ONLY");
  const transport = createGatewayV3Transport({baseUrl: config.baseUrl, bearerToken: config.bearerToken, timeoutMs: config.timeoutMs ?? 5000});
  const q = await transport.qualification();
  const runtimeProfile = config.runtimeProfile ?? (config.localConformance === true ? q.native_contract?.profile : undefined);
  if (runtimeProfile?.runtime.execution_kind !== "conformance") throw Error("LOCAL_CONFORMANCE_ONLY");
  const workbenchProfile = config.workbenchProfile ?? structuredClone(simulatorProfile);
  const qualification = config.qualification ?? (config.localConformance === true ? q.binding : undefined);
  const request = config.request ?? {version: "1", nonce: config.nonce, providerId: "synthetic.local.eth",
    profileId: digestOf(workbenchProfile), prompt: config.prompt, maxOutputTokens: config.maxOutputTokens,
    seed: 0, sampling: "greedy", publishConsent: false};
  const now = config.localConformance === true && Number.isSafeInteger(config.nowUnixMs) ? () => config.nowUnixMs : Date.now;
  const openSession = createGatewayV3SessionFactory({transport, workbenchProfileId: digestOf(workbenchProfile), runtimeProfile, qualification, now});
  const adapter = createV3NativeExecutionAdapter({workbenchProfile, runtimeProfile, openSession,
    timeoutMs: config.timeoutMs ?? 5000, validateRequest(value) {
      if (value.seed !== 0 || value.sampling !== "greedy" || value.publishConsent !== false) throw Error("CONFORMANCE_REQUEST_REQUIRED");
    }});
  let count = 0, completed;
  for await (const event of adapter.execute({jobId: config.jobId ?? "local-c-uc1-compat", request, profile: workbenchProfile})) {
    count++;
    if (event.type === "completed") completed = event;
  }
  if (!completed) throw Error("MISSING_NATIVE_COMPLETION");
  console.log(JSON.stringify({status: "compatible", evidenceClass: "conformance-not-physical", physicalExecution: false,
    workbenchProfileId: digestOf(workbenchProfile), runtimeProfileId: digestOf(runtimeProfile),
    eventCount: count, tokenCount: completed.output.tokenIds.length, finishReason: completed.output.finishReason,
    outputDigest: digestOf(completed.output), evidenceDigest: completed.evidenceDigest}));
} catch (error) {
  // Never serialize request/credential-bearing exceptions or injected peer messages.
  const known = /^(INVALID_|MISSING_|NATIVE_|UPSTREAM_|GATEWAY_|UNSUPPORTED_|STALE_|QUALIFICATION_|RUNTIME_|POLICY_|LOCAL_|CONFORMANCE_|EVENT_|TOKEN_|SSE_|RESPONSE_|INPUT_|ABORTED$|EXECUTION_)/;
  const message = typeof error?.message === "string" && /^[A-Z0-9_]{1,80}$/.test(error.message) && known.test(error.message) ? error.message : "COMPATIBILITY_FAILED";
  console.error(JSON.stringify({status: "failed", code: message}));
  process.exitCode = 1;
}
