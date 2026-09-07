#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createDiscovery } from "./index.mjs";
import { createEnsV2Resolver } from "./ensv2.mjs";
import { previewOperation } from "./operator.mjs";
import { createProviderReader } from "./consumer.mjs";
import { DiscoveryError, fail } from "./errors.mjs";
async function jsonFile(path) {
  const b = await readFile(path);
  if (b.length > 131072) fail("LIMIT");
  try {
    return JSON.parse(b);
  } catch {
    fail("INVALID_JSON");
  }
}
export async function runCli(args) {
  const [command, path, ...names] = args;
  if (command === "--help" || !command)
    return {
      usage:
        "cli list|verify|preview|select|read config.json [provider.subname.eth ...]",
      notes:
        "Explicit mode/config required. preview uses operation + public address/record fields in config; no signing or broadcast. select uses selection field (server-authoritative quotes only). read is explicit credential-free GET for exactly one resolved provider.",
    };
  if (
    !["list", "verify", "preview", "select", "read"].includes(command) ||
    !path
  )
    fail("INVALID_COMMAND");
  const config = await jsonFile(path);
  if (command === "preview") return previewOperation(config);
  const resolver = createEnsV2Resolver(config),
    discovery = createDiscovery({
      config: {
        mode: config.mode,
        allowLoopback:
          config.mode === "development" && config.allowLoopback === true,
      },
      resolver,
    });
  if (command === "select") {
    const input = config.selection;
    if (!input) fail("INVALID_SELECTION");
    const authoritative = await discovery.list({
      names: input.providers.map((p) => p.name),
    });
    if (authoritative.errors.length) fail("PROVIDER_UNAVAILABLE");
    return discovery.select({ ...input, providers: authoritative.providers });
  }
  const result = await discovery.list({ names });
  if (command === "read") {
    if (names.length !== 1 || result.providers.length !== 1)
      fail("PROVIDER_UNAVAILABLE");
    const data = await createProviderReader({
      discovery,
      config: {
        mode: config.mode,
        allowLoopback: config.allowLoopback === true,
      },
    }).get({ provider: result.providers[0] });
    return {
      mode: config.mode,
      bytes: data.length,
      body: data.toString("utf8"),
    };
  }
  return result;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const result = await runCli(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (result.errors?.length) process.exitCode = 1;
  } catch (e) {
    console.error(
      JSON.stringify({
        error: {
          code: e instanceof DiscoveryError ? e.code : "UNAVAILABLE",
          message:
            "Discovery command failed; inspect public configuration and documented requirements.",
          retryable: e instanceof DiscoveryError ? e.retryable : false,
        },
      }),
    );
    process.exitCode = 1;
  }
}
