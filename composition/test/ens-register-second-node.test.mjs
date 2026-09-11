import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEnsRecords,
  boundedFee,
  validateRegistrationPlan,
} from "../ens-register-second-node.mjs";
const id = "sha256:" + "a".repeat(64);
const record = {
  providerId: "service.ethonline-node-a.eth",
  profileId: id,
  endpoint: "https://m4pro.tail53d0d3.ts.net",
  historyUrl: "https://graph.example/query/public",
};
test("registration records use existing fields and honest non-economic terms", () => {
  assert.deepEqual(buildEnsRecords(record), {
    "ethonline.endpoint": record.endpoint,
    "ethonline.profiles": JSON.stringify([id]),
    "ethonline.payment.network": "non-economic",
    "ethonline.payment.asset": "none",
    "ethonline.payment.receiver": record.providerId,
    "ethonline.history": record.historyUrl,
  });
  assert.throws(
    () => buildEnsRecords({ ...record, endpoint: "http://100.84.252.4:4370" }),
    /INVALID_ENS_ENDPOINT/,
  );
  assert.throws(
    () => buildEnsRecords({ ...record, profileId: "guessed" }),
    /INVALID_PROFILE/,
  );
});
test("plan admits only the named Sepolia scope and bounded fees", () => {
  const plan = {
    chainId: 11155111,
    owner: "0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE",
    providers: [
      record,
      { ...record, providerId: "service.ethonline-node-b.eth" },
    ],
    perTransactionLimitWei: "5000000000000000",
    totalLimitWei: "30000000000000000",
  };
  assert.equal(validateRegistrationPlan(plan).providers.length, 2);
  assert.throws(
    () => validateRegistrationPlan({ ...plan, chainId: 1 }),
    /SEPOLIA_ONLY/,
  );
  assert.throws(
    () => validateRegistrationPlan({ ...plan, providers: [record, record] }),
    /EXACT_WAVE5_NAMES_REQUIRED/,
  );
  assert.equal(
    boundedFee({
      gas: 100n,
      gasPrice: 2n,
      used: 0n,
      perTransaction: 250n,
      total: 500n,
    }),
    200n,
  );
  assert.throws(
    () =>
      boundedFee({
        gas: 100n,
        gasPrice: 3n,
        used: 0n,
        perTransaction: 250n,
        total: 500n,
      }),
    /TRANSACTION_BUDGET/,
  );
  assert.throws(
    () =>
      boundedFee({
        gas: 100n,
        gasPrice: 2n,
        used: 400n,
        perTransaction: 250n,
        total: 500n,
      }),
    /PHASE_BUDGET/,
  );
});
