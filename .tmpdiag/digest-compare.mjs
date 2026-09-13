
import { digestOf } from "../packages/contracts/index.mjs";
import { createHash } from "node:crypto";
const pid = "service.ethonline-node-a.eth";
console.log("digestOf:", digestOf(pid));
console.log("createHash:", "sha256:" + createHash("sha256").update(pid).digest("hex"));
console.log("slice(7) of digestOf:", digestOf(pid).slice(7));
