import { getAddress } from "ethers";
import { failure, modes } from "./common.mjs";
export function validateDeployment(config) {
  try {
    const c = structuredClone(config);
    if (
      !modes.includes(c.mode) ||
      !Number.isSafeInteger(c.chainId) ||
      c.chainId <= 0 ||
      !Number.isSafeInteger(c.startBlock) ||
      c.startBlock < 0 ||
      !Number.isSafeInteger(c.confirmations) ||
      c.confirmations < 1 ||
      c.confirmations > 256 ||
      !/^0x[0-9a-f]{64}$/.test(c.codeHash) ||
      typeof c.network !== "string" ||
      !/^[-a-z0-9]+$/.test(c.network)
    )
      throw 0;
    c.address = getAddress(c.address);
    c.publisher = getAddress(c.publisher);
    if (c.openRegistryAddress !== undefined)
      c.openRegistryAddress = getAddress(c.openRegistryAddress);
    if (
      /^0x0{40}$/i.test(c.address) ||
      /^0x0{40}$/i.test(c.publisher) ||
      (c.openRegistryAddress && /^0x0{40}$/i.test(c.openRegistryAddress))
    )
      throw 0;
    if (
      c.mode === "development" &&
      (c.chainId !== 31337 || c.network !== "localhost")
    )
      throw 0;
    if (
      c.mode === "live" &&
      (c.chainId !== 11155111 ||
        c.network !== "sepolia" ||
        c.confirmations < 12)
    )
      throw 0;
    return Object.freeze(c);
  } catch {
    throw failure("INVALID_DEPLOYMENT");
  }
}
