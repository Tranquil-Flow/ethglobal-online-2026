// SPDX-License-Identifier: AGPL-3.0-or-later
//
// W6 Phase 5 — HCS go-live: operator client factory + one-shot topic creator.
//
// Import-safe: exports buildHcsOperator() and createDemoTopic() for the paid-app
// supervisor (composition/w6-supervisors/resume-retained-app.mjs); when executed
// directly it runs the one-shot topic create for the demo run.
//
//   node composition/w6-hcs-go-live.mjs [--probe] [--memo <memo>]
//
// Secrets policy: the operator key is read from the configured key file and is
// NEVER printed or logged. Only the account id, topic id and transaction id are
// surfaced (all public on HashScan by design).
//
// Operator resolution (env, from the supervisor env file or process.env):
//   W6_HCS_OPERATOR_ACCOUNT  account id override (default: W6_DEMO_SPONSOR_ACCOUNT)
//   W6_HCS_SIGNER_KEY_FILE   key file override (default: W6_DEMO_SPONSOR_KEY_FILE)
//
// The key file may be either a JSON object {accountId, privateKey, ...} (the
// demo sponsor layout) or a bare hex string (DER or raw, 0x optional).

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const DEFAULT_ENV_FILE = `${process.env.HOME}/.config/mycelium/w6-supervisors.env`;
const DEFAULT_MEMO = "mycelium-ethonline-audit-v1";
const DEFAULT_RUN_ROOT =
  "/Users/evinova-self/mycelium-physical-run/w6-ethonline-20260912T090309Z";

const SDK_URL = new URL(
  "../packages/payments/node_modules/@hiero-ledger/sdk/lib/index.js",
  import.meta.url,
);

export function parseEnvFile(raw) {
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    env[m[1]] = m[2];
  }
  return env;
}

export function readEnv(envFile = process.env.W6_SUPERVISOR_ENV_FILE ?? DEFAULT_ENV_FILE) {
  if (!existsSync(envFile)) return { envFound: false, envFile, env: {} };
  return { envFound: true, envFile, env: parseEnvFile(readFileSync(envFile, "utf8")) };
}

function readKeyMaterial(keyFile) {
  if (!existsSync(keyFile)) {
    throw Object.assign(new Error("HCS_KEY_FILE_MISSING"), { code: "HCS_KEY_FILE_MISSING" });
  }
  const mode = statSync(keyFile).mode & 0o777;
  if (mode !== 0o600 && mode !== 0o400) {
    throw Object.assign(new Error("HCS_KEY_FILE_PERMISSIONS"), { code: "HCS_KEY_FILE_PERMISSIONS" });
  }
  const raw = readFileSync(keyFile, "utf8").trim();
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      const privateKey =
        typeof parsed.privateKey === "string" ? parsed.privateKey.trim() : "";
      const accountId =
        typeof parsed.accountId === "string" ? parsed.accountId.trim() : "";
      if (!privateKey) {
        throw Object.assign(new Error("HCS_KEY_JSON_NO_PRIVATE_KEY"), {
          code: "HCS_KEY_JSON_NO_PRIVATE_KEY",
        });
      }
      return { privateKey, accountId };
    } catch (error) {
      if (error?.code) throw error;
      throw Object.assign(new Error("HCS_KEY_FILE_UNPARSEABLE"), { code: "HCS_KEY_FILE_UNPARSEABLE" });
    }
  }
  return { privateKey: raw, accountId: "" };
}

/**
 * Build the HCS operator: { accountId, signer, client } where `signer` matches
 * the submitHcs adapter contract (deps.signer.client(sdk) -> client).
 */
export async function buildHcsOperator(env = process.env) {
  const accountId = String(
    env.W6_HCS_OPERATOR_ACCOUNT ?? env.W6_DEMO_SPONSOR_ACCOUNT ?? "",
  ).trim();
  const keyFile = String(
    env.W6_HCS_SIGNER_KEY_FILE ?? env.W6_DEMO_SPONSOR_KEY_FILE ?? "",
  ).trim();
  if (!accountId) {
    throw Object.assign(new Error("HCS_OPERATOR_ACCOUNT_MISSING"), {
      code: "HCS_OPERATOR_ACCOUNT_MISSING",
    });
  }
  if (!keyFile) {
    throw Object.assign(new Error("HCS_SIGNER_KEY_FILE_MISSING"), {
      code: "HCS_SIGNER_KEY_FILE_MISSING",
    });
  }
  const material = readKeyMaterial(resolve(keyFile));
  const effectiveAccount = material.accountId || accountId;

  const sdk = await import(SDK_URL.href);
  const hex = material.privateKey.replace(/^0x/, "");
  let privateKey = null;
  try {
    privateKey = sdk.PrivateKey.fromString(hex);
  } catch {
    try {
      privateKey = sdk.PrivateKey.fromStringECDSA(hex);
    } catch {
      throw Object.assign(new Error("HCS_KEY_PARSE_FAILED"), { code: "HCS_KEY_PARSE_FAILED" });
    }
  }

  const client = sdk.Client.forTestnet();
  client.setOperator(sdk.AccountId.fromString(effectiveAccount), privateKey);

  return {
    accountId: effectiveAccount,
    sdk,
    client,
    signer: Object.freeze({
      accountId: effectiveAccount,
      publicKey: privateKey.publicKey,
      client: () => client,
    }),
    close: () => client.close?.() ?? Promise.resolve(),
  };
}

/**
 * Create ONE fresh HCS topic through the real adapter. Digest-only messages
 * will be submitted to this topic by the paid app when W6_HCS_BROADCAST=1.
 */
export async function createDemoTopic({ memo = DEFAULT_MEMO, operator, logger } = {}) {
  const { createHcsTopic } = await import("./w6-hcs-audit.mjs");
  const { submitHcs } = await import("../packages/payments/scripts/hcs-adapter.mjs");
  const bound = (input, extra = {}) =>
    submitHcs(input, {
      signer: operator.signer,
      logger: logger ?? { info: () => {} },
      ...extra,
    });
  return createHcsTopic(
    { memo, operatorAccountId: operator.accountId },
    { submitHcs: bound, maxAmountBaseUnits: "60000000", logger },
  );
}

function isMainModule() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  const probe = args.includes("--probe");
  const memoIndex = args.indexOf("--memo");
  const memo = memoIndex !== -1 && args[memoIndex + 1] ? args[memoIndex + 1] : DEFAULT_MEMO;

  const { envFound, envFile, env } = readEnv();
  if (!envFound) {
    console.error(JSON.stringify({ error: "HCS_SUPERVISOR_ENV_MISSING", envFile }));
    process.exit(2);
  }
  const operator = await buildHcsOperator(env);
  console.log(JSON.stringify({ status: "hcs-operator-ready", accountId: operator.accountId }));

  if (probe) {
    console.log(JSON.stringify({ status: "probe-complete", note: "no topic created" }));
    await operator.close();
    process.exit(0);
  }

  const result = await createDemoTopic({
    memo,
    operator,
    logger: { info: (o) => console.log(JSON.stringify(o)) },
  });
  console.log(
    JSON.stringify({
      status: "hcs-topic-created",
      topicId: result.topicId,
      transactionId: result.transactionId,
      memo: result.memo,
      operatorAccountId: result.operatorAccountId,
      dryRun: result.dryRun,
    }),
  );

  if (!result.dryRun && result.topicId) {
    const runRoot = env.W6_RUNTIME_ROOT ?? DEFAULT_RUN_ROOT;
    const record = {
      createdBy: "w6-hcs-go-live",
      topicId: result.topicId,
      transactionId: result.transactionId,
      memo: result.memo,
      operatorAccountId: result.operatorAccountId,
      network: "hedera:testnet",
      createdAt: new Date().toISOString(),
    };
    const path = join(runRoot, "hcs-topic.json");
    writeFileSync(`${path}.${process.pid}.tmp`, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ status: "hcs-topic-recorded", path }));
  }
  await operator.close();
}
