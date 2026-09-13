import { homedir } from "node:os";
import { join } from "node:path";

export const W6_RUNTIME_ROOT =
  process.env.W6_RUNTIME_ROOT ||
  join(homedir(), "mycelium-physical-run", "w6-ethonline-20260912T090309Z");

export function w6RuntimePath(...segments) {
  return join(W6_RUNTIME_ROOT, ...segments);
}

export function ethonlineTestnetPath(...segments) {
  return join(homedir(), ".ethonline-testnet", ...segments);
}
