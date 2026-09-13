import { createRequire } from "node:module";

const paymentsRequire = createRequire(
  new URL("../../../packages/payments/package.json", import.meta.url),
);

export const BetterSqlite3 = paymentsRequire("better-sqlite3");
export const ethers = paymentsRequire("ethers");

export function loadOptionalHederaSdk() {
  try {
    return paymentsRequire("@hashgraph/sdk");
  } catch {
    try {
      return paymentsRequire("@hiero-ledger/sdk");
    } catch {
      return null;
    }
  }
}
