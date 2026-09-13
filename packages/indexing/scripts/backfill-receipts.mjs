#!/usr/bin/env node
// L-PUBLISH backfill script.
//
// Backfills real historical receipts / assessments onto the development Registry.
//
// Usage:
//   node packages/indexing/scripts/backfill-receipts.mjs --input <file.json> \
//        [--execute] [--tx-cap N] [--journal-dir <dir>] [--rpc <url>] [--signer <file>]
//
// Defaults: --dry-run is on; nothing is broadcast, no signer is required, and the
// script only prints the planned publish plan. Use `--execute` to actually open an
// EventSink and submit. Each run writes a JSON journal under
// `--journal-dir/run-<UTC-ISO>.json` (default `./artifacts/backfill-runs/`).
//
// No real Sepolia broadcasts. No key reads unless `--signer <file>` is supplied and
// `--execute` is set; in that case the file must be a JSON `{address, privateKey}`
// bound to the deployment's `publisher`.

import { createRequire } from 'node:module';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  planBackfill,
  recordDigest,
  createReceiptPublisher,
} from '../../../composition/w6-receipt-publisher.mjs';
import { validateDeployment } from '../src/config.mjs';
import { createPublicationStore } from '../src/index.mjs';

const require = createRequire(
  new URL('../../package.json', import.meta.url),
);
const { JsonRpcProvider, Wallet } = require('ethers');

function parseArgs(argv) {
  const out = { dryRun: true, txCap: 10 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--input':
        out.input = argv[++i];
        break;
      case '--execute':
        out.dryRun = false;
        break;
      case '--tx-cap':
        out.txCap = Number(argv[++i]);
        break;
      case '--journal-dir':
        out.journalDir = argv[++i];
        break;
      case '--rpc':
        out.rpc = argv[++i];
        break;
      case '--signer':
        out.signerFile = argv[++i];
        break;
      case '--deployment':
        out.deploymentFile = argv[++i];
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        throw new Error(`UNKNOWN_ARG:${a}`);
    }
  }
  return out;
}

function help() {
  console.log(`backfill-receipts.mjs — dry-run default; --execute broadcasts via local anvil.

Required:
  --input <file.json>           JSON array of receipt/assessment records.
  --deployment <file.json>      JSON deployment descriptor (must satisfy validateDeployment).

Optional:
  --tx-cap N                    Max publishes per run (default 10, max 10000).
  --journal-dir <dir>           Per-run journal directory (default ./artifacts/backfill-runs/).
  --rpc <url>                   JSON-RPC URL (default http://127.0.0.1:8545/).
  --signer <file>               JSON {address,privateKey}; required for --execute.
  --execute                     Actually publish; default is dry-run.

Dry-run prints the plan and exits 0 without contacting the chain.`);
}

async function readJson(path) {
  const fs = await import('node:fs/promises');
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

async function loadSigner(file) {
  const json = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8'));
  if (typeof json.address !== 'string' || typeof json.privateKey !== 'string') {
    throw new Error('INVALID_SIGNER_FILE');
  }
  return json;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    help();
    return;
  }
  if (!args.input) throw new Error('MISSING_INPUT');
  if (!args.deploymentFile) throw new Error('MISSING_DEPLOYMENT');
  if (!args.dryRun && !args.signerFile) throw new Error('MISSING_SIGNER');

  const records = await readJson(args.input);
  const deployment = validateDeployment(await readJson(args.deploymentFile));
  const plan = planBackfill(records, { txCap: args.txCap, mode: deployment.mode });

  const journalDir = resolve(
    args.journalDir ?? join(process.cwd(), 'artifacts', 'backfill-runs'),
  );
  await mkdir(journalDir, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const journalPath = join(journalDir, `run-${runId}.json`);

  const report = {
    runId,
    dryRun: args.dryRun,
    txCap: args.txCap,
    deployment: {
      mode: deployment.mode,
      chainId: String(deployment.chainId),
      address: deployment.address,
      publisher: deployment.publisher,
      codeHash: deployment.codeHash,
    },
    planned: plan.length,
    startedAt: new Date().toISOString(),
  };

  if (args.dryRun) {
    report.status = 'planned';
    report.plan = plan;
    await writeFile(journalPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // --execute path: bind signer + provider + store, run plan with bounded txCap.
  const signerJson = await loadSigner(args.signerFile);
  if (signerJson.address.toLowerCase() !== deployment.publisher.toLowerCase()) {
    throw new Error('SIGNER_NOT_BOUND_TO_PUBLISHER');
  }
  const rpc = args.rpc ?? 'http://127.0.0.1:8545/';
  const provider = new JsonRpcProvider(rpc);
  const signer = new Wallet(signerJson.privateKey, provider);
  const storeDir = await mkdtemp(join(tmpdir(), 'backfill-receipts-'));
  const store = createPublicationStore({ directory: storeDir });
  const publisher = createReceiptPublisher({
    signer,
    store,
    deployment,
    maxGasPriceWei: '100000000000',
  });

  const results = [];
  let broadcast = 0;
  for (const entry of plan) {
    const record = records.find(
      (r) => recordDigest(r) === entry.objectDigest || r.objectDigest === entry.objectDigest,
    );
    if (!record) continue;
    try {
      const out =
        entry.kind === 'receipt'
          ? await publisher.publishReceipt({
              objectDigest: record.objectDigest,
              providerKey: record.providerKey,
              mode: deployment.mode,
            })
          : await publisher.publishAssessment(record);
      results.push({
        objectDigest: entry.objectDigest,
        status: out.status,
        transactionRef: out.transactionRef,
      });
      broadcast += 1;
    } catch (error) {
      results.push({
        objectDigest: entry.objectDigest,
        status: 'failed',
        code: error?.code,
        message: error?.message,
      });
    }
  }

  await publisher.close();
  await rm(storeDir, { recursive: true, force: true });

  report.status = 'completed';
  report.broadcast = broadcast;
  report.results = results;
  report.finishedAt = new Date().toISOString();
  await writeFile(journalPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      status: 'failed',
      code: error?.code ?? 'BACKFILL_FAILED',
      message: error?.message,
    }),
  );
  process.exit(1);
});