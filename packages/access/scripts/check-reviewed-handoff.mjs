// Execute the immutable review validator in memory, never copy/edit shared files.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const show = (path) =>
  execFileSync("git", ["show", `handoff-review-v1:${path}`], {
    cwd: root,
    encoding: "utf8",
  });
const source = show("scripts/validate-handoff.mjs");
const { validateHandoff } = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64")
);
const config = JSON.parse(show("docs/lanes.json")).access;
const report = JSON.parse(
  readFileSync(
    new URL("../../../docs/handoffs/access.json", import.meta.url),
    "utf8",
  ),
);
validateHandoff(report, config, root);
console.log(
  `Reviewed handoff passed: ${config.acceptanceIds.length} required acceptance IDs, ${config.externalGateIds.length} required external gates; shared files unchanged.`,
);
