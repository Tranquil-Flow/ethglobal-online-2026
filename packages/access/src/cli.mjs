#!/usr/bin/env node
import {
  readFile,
  writeFile,
  mkdir,
  lstat,
  rename,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  createClient,
  createRequest,
  selectOfferedProfile,
  developmentAuthorizer,
  verifyReceiptIntegrity,
  checkBuyerEvidenceJson,
  safeBaseUrl,
  AccessError,
} from "./index.mjs";
const random = () => randomBytes(12).toString("hex");
export async function privateWrite(path, value) {
  const temp = path + "." + random();
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  try {
    await rename(temp, path);
  } catch (e) {
    await unlink(temp);
    throw e;
  }
  return path;
}
export async function privateRead(path) {
  const s = await lstat(path);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.mode & 0o077 ||
    s.uid !== process.getuid()
  )
    throw new AccessError("PRIVATE_FILE_PERMISSIONS");
  if (s.size > 2097152) throw new AccessError("FILE_TOO_LARGE");
  return JSON.parse(await readFile(path, "utf8"));
}
export async function readPrivatePassphrase(path) {
  if (!path) throw new AccessError("RECOVERY_PASSPHRASE_FILE_REQUIRED");
  const value = await privateRead(path);
  if (
    !value ||
    Object.keys(value).length !== 1 ||
    typeof value.passphrase !== "string" ||
    value.passphrase.length < 12 ||
    value.passphrase.length > 256
  )
    throw new AccessError("INVALID_RECOVERY_PASSPHRASE_FILE");
  return value.passphrase;
}
export async function runCli(argv) {
  const options = {},
    pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      options[key] = [
        "development-payment",
        "complete",
        "check-integrity",
        "trust-development-key",
      ].includes(key)
        ? true
        : argv[++i];
    } else pos.push(a);
  }
  const [command, arg] = pos;
  if (command === "evidence-check") {
    if (
      !options["evidence-file"] ||
      !options["pins-file"] ||
      !options["expectation-file"]
    )
      throw new AccessError("EVIDENCE_PINS_AND_EXPECTATION_REQUIRED");
    const b = await privateRead(options["evidence-file"]);
    return checkBuyerEvidenceJson(
      JSON.stringify(b),
      await privateRead(options["pins-file"]),
      await privateRead(options["expectation-file"]),
    );
  }
  if (command === "signature-check") {
    if (!options["key-file"] || !options["receipt-file"])
      throw new AccessError("KEY_AND_RECEIPT_FILES_REQUIRED");
    const receipt = await privateRead(options["receipt-file"]),
      key = await privateRead(options["key-file"]);
    const result = await verifyReceiptIntegrity(
      receipt,
      key.publicKeyJwk || key,
    );
    console.error(
      "Receipt integrity only; does not verify execution. Key trust is caller-pinned.",
    );
    if (!result.integrity) throw new AccessError("INVALID_SIGNATURE");
    return result;
  }
  const base = safeBaseUrl(options["base-url"] || "http://127.0.0.1:4350");
  const dir = join(homedir(), ".ethonline-access");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const ds = await lstat(dir);
  if (
    !ds.isDirectory() ||
    ds.isSymbolicLink() ||
    ds.mode & 0o077 ||
    ds.uid !== process.getuid()
  )
    throw new AccessError("PRIVATE_DIRECTORY_PERMISSIONS");
  const sessionFile = join(dir, "session.json");
  let session;
  try {
    session = await privateRead(sessionFile);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (session && session.baseUrl !== base)
    throw new AccessError("SESSION_ORIGIN_MISMATCH");
  if (options["development-payment"] && options["payment-authorizer"])
    throw new AccessError("SELECT_ONE_AUTHORIZER");
  const paymentAuthorizer = options["payment-authorizer"]
    ? (await import(pathToFileURL(resolve(options["payment-authorizer"])).href))
        .default
    : options["development-payment"]
      ? developmentAuthorizer
      : undefined;
  if (
    paymentAuthorizer !== undefined &&
    typeof paymentAuthorizer !== "function"
  )
    throw new AccessError("INVALID_AUTHORIZER_MODULE");
  const client = createClient({
    baseUrl: base,
    capability: session?.capability,
    paymentAuthorizer,
    pins: options["pins-file"]
      ? await privateRead(options["pins-file"])
      : undefined,
  });
  const save = (name, value) =>
    privateWrite(join(dir, name + "-" + random() + ".json"), value);
  if (command === "recovery-export") {
    if (!options["request-file"] || !options["pins-file"])
      throw new AccessError("RECOVERY_REQUEST_AND_PINS_FILES_REQUIRED");
    const { request, quote } = await privateRead(options["request-file"]);
    const passphrase = await readPrivatePassphrase(options["passphrase-file"]);
    const archive = await client.exportRecovery({
      request,
      quote,
      idempotencyKey: options["idempotency-key"],
      passphrase,
    });
    return {
      recoveryFile: await save("encrypted-recovery", archive),
      encrypted: true,
      reusableCapabilityExported: false,
    };
  }
  if (command === "recovery-import") {
    if (!options["recovery-file"])
      throw new AccessError("RECOVERY_FILE_REQUIRED");
    const recovered = await client.importRecovery(
      await privateRead(options["recovery-file"]),
      await readPrivatePassphrase(options["passphrase-file"]),
    );
    if (recovered.status === "unresolved")
      return { status: "unresolved", readOnly: true };
    return {
      status: "accepted",
      readOnly: true,
      job: recovered.job,
      buyerExpectationFile: await save(
        "recovered-buyer-expectation",
        recovered.client.getBuyerExpectation(recovered.job.jobId),
      ),
    };
  }
  if (command === "recovery-revoke") {
    if (!options["recovery-file"])
      throw new AccessError("RECOVERY_FILE_REQUIRED");
    return client.revokeRecovery(
      await privateRead(options["recovery-file"]),
      await readPrivatePassphrase(options["passphrase-file"]),
    );
  }
  if (command === "connect") {
    if (session) throw new AccessError("REVOKE_EXISTING_SESSION_FIRST");
    const s = await client.connect();
    await privateWrite(sessionFile, { ...s, baseUrl: base });
    return { connected: true, expiresAt: s.expiresAt };
  }
  if (command === "revoke") {
    let revoked = true;
    try {
      await client.revoke();
    } catch (e) {
      if (!(e instanceof AccessError) || e.status !== 401) throw e;
      revoked = false; // Server did not confirm revocation; discard expired local credential only.
    }
    await unlink(sessionFile);
    return { revoked, localForgotten: true };
  }
  if (command === "offers") return client.listOffers();
  if (command === "providers") return client.listProviders(pos.slice(1));
  if (command === "profile") return client.getProfile(arg);
  if (command === "history") return client.getHistory(arg);
  if (command === "quote") {
    if (options.profile && options["profile-index"] !== undefined)
      throw new AccessError("SELECT_ONE_PROFILE");
    const profileId =
      options.profile ??
      (await selectOfferedProfile(
        client,
        options.provider,
        options["profile-index"] === undefined
          ? undefined
          : Number(options["profile-index"]),
      ));
    const prompt = options["prompt-file"]
      ? await readFile(options["prompt-file"], "utf8")
      : options.prompt;
    const request = await createRequest({
      providerId: options.provider,
      profileId,
      prompt,
      maxOutputTokens: Number(options["max-output"] || 8),
      seed: Number(options.seed || 0),
    });
    const quote = await client.createQuote(request);
    const providers = (await client.listProviders([request.providerId]))
      .providers;
    const requestFile = await save("request", { request, quote });
    const providersFile = await save("providers", providers),
      quotesFile = await save("quotes", [quote]);
    return { quote, requestFile, providersFile, quotesFile };
  }
  if (command === "select")
    return client.selectProviders({
      providers: await privateRead(options["providers-file"]),
      quotes: await privateRead(options["quotes-file"]),
      profileId: options.profile,
      maxAmountBaseUnits: options["max-amount"],
      network: options.network,
      asset: options.asset,
    });
  if (command === "submit") {
    if (!options["max-amount"])
      throw new AccessError(
        "Require explicit --max-amount and --development-payment or --payment-authorizer",
      );
    const { request, quote } = await privateRead(options["request-file"]);
    client.rememberQuote(quote);
    let result = await client.submitJob({
      request,
      quoteId: options["quote-id"],
      idempotencyKey: options["idempotency-key"],
      authorization: {
        maxAmountBaseUnits: options["max-amount"],
        asset: quote.asset,
        network: quote.network,
      },
    });
    if (options.complete) {
      for await (const event of client.streamJob(result.job.jobId)) {
      }
      result = { ...result, job: await client.getJob(result.job.jobId) };
    }
    // The session already authorizes the job; never emit child bearer to stdout.
    const expected = client.getBuyerExpectation(result.job.jobId);
    if (result.job.output) expected.output = result.job.output;
    return {
      job: result.job,
      expectationFile: await save("buyer-expectation", expected),
    };
  }
  if (command === "stream") {
    let count = 0;
    for await (const event of client.streamJob(arg)) {
      console.log(JSON.stringify(event));
      count++;
    }
    return { events: count };
  }
  if (command === "inspect") return client.getJob(arg);
  if (command === "publication") return client.getPublication(arg);
  if (command === "assessments") return client.listAssessments(arg);
  if (command === "delete-evidence") {
    if (options.confirm !== "delete-private-evidence")
      throw new AccessError("EXPLICIT_DELETION_REQUIRED");
    await client.deleteEvidence(arg);
    return { privateEvidenceDeleted: true, publicCommitmentsErased: false };
  }
  if (command === "cancel") return client.cancelJob(arg);
  if (command === "receipt") {
    const receipt = await client.getReceipt(arg);
    if (!options["check-integrity"])
      return { receiptFile: await save("receipt", receipt) };
    let key;
    if (options["key-file"]) {
      key = await privateRead(options["key-file"]);
      key = key.publicKeyJwk || key;
    } else if (
      options["trust-development-key"] &&
      receipt.payload.mode === "development" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)
    )
      key = (await client.getKey(receipt.keyId)).publicKeyJwk;
    else throw new AccessError("KEY_PIN_REQUIRED");
    const result = await verifyReceiptIntegrity(receipt, key);
    console.error(
      "Receipt integrity only; does not verify execution. Development retrieval is not provider identity trust.",
    );
    if (!result.integrity) throw new AccessError("INVALID_SIGNATURE");
    return result;
  }
  if (command === "assess")
    return client.createAssessment(
      arg,
      options.method,
      options["idempotency-key"],
    );
  if (command === "export")
    return {
      privateEvidenceFile: await save(
        "evidence",
        await client.getEvidence(arg, {
          expected: options["expectation-file"]
            ? await privateRead(options["expectation-file"])
            : undefined,
        }),
      ),
      claim: "hashes and receipt integrity, not trusted execution",
    };
  throw new AccessError(
    "Commands: connect revoke offers providers profile select quote recovery-export recovery-import recovery-revoke submit stream inspect cancel receipt signature-check assess export history",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(JSON.stringify(await runCli(process.argv.slice(2))));
  } catch (e) {
    console.error(
      e instanceof AccessError ? e.message : "LOCAL_OPERATION_FAILED",
    );
    process.exitCode = 1;
  }
}
