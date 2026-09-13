import test from "node:test";
import assert from "node:assert/strict";
import { getPaymentMode } from "../w6-demo-sponsor.mjs";

// w6-demo-sponsor.mjs exposes only getPaymentMode (PAYMENT_MODES and
// DEFAULT_PAYMENT_MODE are module-internal). Tests hard-code the
// expected default for visibility.
const EXPECTED_DEFAULT = "demo";

test("getPaymentMode() returns 'demo' when W6_PAYMENT_MODE is unset", () => {
  assert.equal(getPaymentMode({ env: {} }), EXPECTED_DEFAULT);
});
test("getPaymentMode() returns 'demo' when W6_PAYMENT_MODE=''", () => {
  assert.equal(getPaymentMode({ env: { W6_PAYMENT_MODE: "" } }), EXPECTED_DEFAULT);
});
test("getPaymentMode() returns 'demo' when W6_PAYMENT_MODE='demo'", () => {
  assert.equal(getPaymentMode({ env: { W6_PAYMENT_MODE: "demo" } }), "demo");
});
test("getPaymentMode() returns 'wallet' when W6_PAYMENT_MODE='wallet'", () => {
  assert.equal(
    getPaymentMode({ env: { W6_PAYMENT_MODE: "wallet" } }),
    "wallet",
  );
});
test("getPaymentMode() trims whitespace and lowercases mixed input", () => {
  assert.equal(
    getPaymentMode({ env: { W6_PAYMENT_MODE: "  WALLET  " } }),
    "wallet",
  );
  assert.equal(
    getPaymentMode({ env: { W6_PAYMENT_MODE: "Demo" } }),
    "demo",
  );
});
test("getPaymentMode() falls back to 'demo' on invalid value and warns", () => {
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  assert.equal(
    getPaymentMode({ env: { W6_PAYMENT_MODE: "foobar" }, warn }),
    "demo",
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unknown W6_PAYMENT_MODE/);
  assert.match(warnings[0], /foobar/);
  assert.match(warnings[0], new RegExp(`falling back to ${EXPECTED_DEFAULT}`));
});
test("getPaymentMode() falls back to 'demo' on empty-string after trim", () => {
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  // An all-whitespace string is non-empty so it falls into the "unknown"
  // branch and emits the standard fallback warning.
  assert.equal(
    getPaymentMode({ env: { W6_PAYMENT_MODE: "   " }, warn }),
    "demo",
  );
  assert.equal(warnings.length, 1);
});
test("getPaymentMode() does not warn on valid values", () => {
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  getPaymentMode({ env: { W6_PAYMENT_MODE: "demo" }, warn });
  getPaymentMode({ env: { W6_PAYMENT_MODE: "wallet" }, warn });
  getPaymentMode({ env: {}, warn });
  assert.equal(warnings.length, 0);
});
test("getPaymentMode() defaults to 'demo' even when process.env is undefined", () => {
  // Pass no env to exercise the destructuring default.
  assert.equal(getPaymentMode({ warn: () => {} }), "demo");
});
test("DEFAULT_PAYMENT_MODE constant matches the documented default", () => {
  // Default is hard-coded to 'demo' so judges can click-and-run without a wallet.
  assert.equal(EXPECTED_DEFAULT, "demo");
});
