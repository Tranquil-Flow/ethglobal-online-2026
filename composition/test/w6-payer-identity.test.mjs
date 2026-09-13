import test from "node:test";
import assert from "node:assert/strict";
import { assertPayerIdentity } from "../../scripts/w6-single-payment-guard.mjs";
const evm = "0x" + "a".repeat(40),
  pub = "02" + "b".repeat(64);
function fixture() {
  return {
    config: { address: evm },
    accountId: "0.0.10419268",
    derivedPublicKey: pub,
    mirror: {
      account: "0.0.10419268",
      evm_address: evm,
      key: { _type: "ECDSA_SECP256K1", key: pub },
    },
  };
}
test("ECDSA EVM alias is verified against mirror account and derived public key", () =>
  assert.doesNotThrow(() => assertPayerIdentity(fixture())));
test("wrong alias, numeric account, mirror account, or signing key fails closed", () => {
  for (const mutate of [
    (v) => (v.config.address = "0x" + "f".repeat(40)),
    (v) => (v.config.accountId = "0.0.999"),
    (v) => (v.mirror.account = "0.0.999"),
    (v) => (v.derivedPublicKey = "02" + "c".repeat(64)),
    (v) => (v.mirror.key = null),
  ]) {
    const v = fixture();
    mutate(v);
    assert.throws(() => assertPayerIdentity(v), /PAYER_MISMATCH/);
  }
});
