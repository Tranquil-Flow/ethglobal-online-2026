import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createFixtureServer, fixtureProfile } from "../src/fixture.mjs";

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.mjs", ...args], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, ...env },
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("CLI exposes complete operations over real HTTP with private 0600 session storage", async (t) => {
  const fixture = createFixtureServer();
  const { url } = await fixture.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => fixture.close());
  const home = await mkdtemp(join(tmpdir(), "access-cli-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home };
  const common = ["--base-url", url];
  assert.equal((await run([...common, "connect"], env)).code, 0);
  const capPath = join(home, ".ethonline-access", "session.json");
  assert.equal((await stat(capPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(capPath, "utf8"), /prompt|payment/i);

  const providers = await run([...common, "providers", "safe.eth"], env);
  assert.equal(
    JSON.parse(providers.stdout).providers[0].name,
    "<img src=x onerror=alert(1)>",
  );
  const profile = await run(
    [...common, "profile", fixtureProfile.profileId],
    env,
  );
  assert.equal(JSON.parse(profile.stdout).model, "fixture/model");
  const quote = await run(
    [
      ...common,
      "quote",
      "--provider",
      "safe.eth",
      "--profile",
      fixtureProfile.profileId,
      "--prompt",
      "synthetic",
    ],
    env,
  );
  const quoteBody = JSON.parse(quote.stdout);
  assert.equal(quoteBody.quote.amountBaseUnits, "5");
  const submit = await run(
    [
      ...common,
      "submit",
      "--request-file",
      quoteBody.requestFile,
      "--quote-id",
      quoteBody.quote.quoteId,
      "--idempotency-key",
      "cli-job",
      "--max-amount",
      "10",
      "--development-payment",
    ],
    env,
  );
  const job = JSON.parse(submit.stdout).job;
  assert.equal(job.executionStatus, "running");
  assert.equal((await run([...common, "stream", job.jobId], env)).code, 0);
  assert.equal(
    JSON.parse((await run([...common, "inspect", job.jobId], env)).stdout)
      .jobId,
    job.jobId,
  );
  assert.equal(
    JSON.parse((await run([...common, "cancel", job.jobId], env)).stdout)
      .executionStatus,
    "succeeded",
  );
  assert.equal((await run([...common, "history", "safe.eth"], env)).code, 0);
  assert.equal(
    (
      await run(
        [
          ...common,
          "select",
          "--providers-file",
          quoteBody.providersFile,
          "--quotes-file",
          quoteBody.quotesFile,
          "--profile",
          fixtureProfile.profileId,
          "--max-amount",
          "10",
          "--network",
          "eip155:84532",
          "--asset",
          "USDC",
        ],
        env,
      )
    ).code,
    0,
  );

  const completedQuote = JSON.parse(
    (
      await run(
        [
          ...common,
          "quote",
          "--provider",
          "safe.eth",
          "--profile",
          fixtureProfile.profileId,
          "--prompt",
          "receipt",
        ],
        env,
      )
    ).stdout,
  );
  const completed = JSON.parse(
    (
      await run(
        [
          ...common,
          "submit",
          "--request-file",
          completedQuote.requestFile,
          "--quote-id",
          completedQuote.quote.quoteId,
          "--idempotency-key",
          "cli-receipt",
          "--max-amount",
          "10",
          "--payment-authorizer",
          "test/authorizer.mjs",
          "--complete",
        ],
        env,
      )
    ).stdout,
  ).job;
  const receipt = await run(
    [
      ...common,
      "receipt",
      completed.jobId,
      "--check-integrity",
      "--trust-development-key",
    ],
    env,
  );
  assert.equal(JSON.parse(receipt.stdout).integrity, true);
  assert.match(receipt.stderr, /does not verify execution/i);
  assert.equal(
    (
      await run(
        [
          ...common,
          "assess",
          completed.jobId,
          "--method",
          "fixture-relation",
          "--idempotency-key",
          "cli-assess",
        ],
        env,
      )
    ).code,
    0,
  );
  const pinsFile = join(home, "pins.json");
  await writeFile(
    pinsFile,
    JSON.stringify({
      providerId: "safe.eth",
      keyId: "fixture-key",
      publicKeyJwk: fixture.publicKeyJwk,
    }),
    { mode: 0o600 },
  );
  assert.equal(
    (await run([...common, "export", completed.jobId], env)).code,
    1,
  );
  assert.equal(
    (
      await run(
        [...common, "export", completed.jobId, "--pins-file", pinsFile],
        env,
      )
    ).code,
    0,
  );
  assert.equal((await run([...common, "revoke"], env)).code, 0);
});

test("CLI refuses payment without explicit bounded authorization", async (t) => {
  const fixture = createFixtureServer();
  const { url } = await fixture.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => fixture.close());
  const home = await mkdtemp(join(tmpdir(), "access-cli-deny-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await run(["--base-url", url, "connect"], { HOME: home });
  const q = JSON.parse(
    (
      await run(
        [
          "--base-url",
          url,
          "quote",
          "--provider",
          "safe.eth",
          "--profile",
          fixtureProfile.profileId,
          "--prompt",
          "deny",
        ],
        { HOME: home },
      )
    ).stdout,
  );
  const result = await run(
    [
      "--base-url",
      url,
      "submit",
      "--request-file",
      q.requestFile,
      "--quote-id",
      q.quote.quoteId,
      "--idempotency-key",
      "deny",
    ],
    { HOME: home },
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /explicit.*max-amount.*payment/i);
});

test("explicit revoke forgets expired local capability and permits explicit reconnect", async (t) => {
  const f = createFixtureServer();
  const { url } = await f.listen();
  t.after(() => f.close());
  const home = await mkdtemp(join(tmpdir(), "access-expired-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home },
    common = ["--base-url", url];
  assert.equal((await run([...common, "connect"], env)).code, 0);
  f.expireSessions();
  const revoked = await run([...common, "revoke"], env);
  assert.equal(revoked.code, 0, revoked.stderr);
  assert.equal(JSON.parse(revoked.stdout).localForgotten, true);
  assert.equal(JSON.parse(revoked.stdout).revoked, false);
  await assert.rejects(stat(join(home, ".ethonline-access", "session.json")), {
    code: "ENOENT",
  });
  assert.equal((await run([...common, "connect"], env)).code, 0);
});
