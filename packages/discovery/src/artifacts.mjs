import { readFileSync } from "node:fs";
export function artifact(name) {
  if (
    ![
      "PermissionedResolverImpl",
      "RootRegistry",
      "UniversalResolverV2",
      "VerifiableFactory",
      "LabelStore",
    ].includes(name)
  )
    throw new Error("Unknown artifact");
  return JSON.parse(
    readFileSync(new URL(`../vendor/${name}.json`, import.meta.url), "utf8"),
  );
}
export const sepolia = {
  chainId: 11155111,
  universal: artifact("UniversalResolverV2").address,
  root: artifact("RootRegistry").address,
  resolverImplementation: artifact("PermissionedResolverImpl").address,
  factory: artifact("VerifiableFactory").address,
};
