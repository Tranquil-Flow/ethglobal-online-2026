import { test } from "node:test";
import { exerciseLocal } from "./local-scenario.mjs";
test(
  "actual ENSv2 hierarchy/resolver RPC, least privilege, revocation and changed selection",
  { timeout: 60000 },
  async () => {
    console.log(JSON.stringify(await exerciseLocal()));
  },
);
