import { setup } from "./application.mjs";
// Explicit generated-key synthetic test binding; never a live runtime.
export async function createApplicationBindings({ config }) {
  return setup(config.dataDir).bindings;
}
