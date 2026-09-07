import { validate, digestOf } from "../../contracts/index.mjs";
import { safeGet } from "./url-policy.mjs";
import { fail } from "./errors.mjs";
function records(provider) {
  const { source, ...rest } = provider;
  return rest;
}
// Explicit single-provider public GET only; no prompts, wallet headers or fan-out.
export function createProviderReader({ discovery, config }) {
  return {
    async get({ provider, signal }) {
      try {
        validate("Provider", provider);
      } catch {
        fail("INVALID_PROVIDER");
      }
      discovery.invalidate(provider.name);
      const { providers } = await discovery.list({
        names: [provider.name],
        signal,
      });
      const authoritative = providers[0];
      if (
        !authoritative ||
        digestOf(records(provider)) !== digestOf(records(authoritative))
      )
        fail("PROVIDER_CHANGED");
      return safeGet(authoritative.endpoint, { ...config, signal });
    },
  };
}
