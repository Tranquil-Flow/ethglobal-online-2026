import { dirname, delimiter } from "node:path";
export const NODE_VERSION = "22.22.2";
export function assertRuntime() {
  if (process.versions.node !== NODE_VERSION)
    throw Error(
      `Use Node ${NODE_VERSION} for install AND execution; run npm run setup after changing ABI. Current: ${process.version}`,
    );
  // Child npm scripts must inherit this interpreter, not a different login-shell Node.
  process.env.PATH =
    dirname(process.execPath) + delimiter + (process.env.PATH || "");
}
