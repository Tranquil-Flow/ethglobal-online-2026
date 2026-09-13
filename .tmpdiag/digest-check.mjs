
import { digestOf } from "../packages/contracts/index.mjs";
import { readFileSync } from "node:fs";
const APP = "/Users/evinova-self/mycelium-physical-run/w6-ethonline-20260912T090309Z/application-live-paid-01";
const op = JSON.parse(readFileSync(APP + "/operator.json", "utf8"));
const profile = op.providers[0].runtime.profile;
console.log("profileDigest     =", digestOf(profile));
const app = JSON.parse(readFileSync(APP + "/application.json", "utf8"));
console.log("profileIds[0]     =", app.providers[0].profileIds[0]);
console.log("runtimeDigest     =", app.providers[0].runtimeDigest);
console.log("runtimeDigest2    =", digestOf(op.providers[0].runtime));
console.log("runtime keys      =", Object.keys(op.providers[0].runtime));
