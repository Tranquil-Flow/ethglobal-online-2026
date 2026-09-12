// Read-only qualification replay. Never loads signing keys or broadcasts.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createEnsV2Discovery } from '../packages/discovery/src/index.mjs';
import { createGraphClient, createHistory, queryProviderHistory } from '../packages/indexing/src/index.mjs';
const require = createRequire(new URL('../packages/indexing/package.json', import.meta.url));
const { JsonRpcProvider, Contract, keccak256 } = require('ethers');
const load = name => JSON.parse(fs.readFileSync(new URL('../docs/handoffs/' + name, import.meta.url)));
if (process.argv.length > 2) {
  // A Step 6 successor readback never overwrites the retained Step 5 receipt.
  const { parseArgs } = await import('node:util');
  const { values } = parseArgs({options:{'hedera-evidence':{type:'string'},output:{type:'string'}}});
  if(!values['hedera-evidence'] || !values.output) throw Error('HEDERA_EVIDENCE_AND_OUTPUT_REQUIRED');
  const { revalidateHederaEvidence } = await import('../composition/hedera-revalidation.mjs');
  const evidence=JSON.parse(fs.readFileSync(values['hedera-evidence'],'utf8'));
  const observed=await revalidateHederaEvidence(evidence);
  fs.writeFileSync(values.output,JSON.stringify(observed,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({status:observed.status,transactionId:observed.transactionId,amountTinybars:observed.amountTinybars,broadcast:false,inferenceVerified:false}));
} else {
const hedera = load('hedera-qualification.json'), graph = load('graph-studio-deployment.json'), ens = load('ens-qualification.json');
const provider = new JsonRpcProvider('https://ethereum-sepolia-rpc.publicnode.com');
const result = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).trim(), scope: 'read-only-testnet-qualification', inferenceVerified: false, transactions: [], hedera: [] };
try {
  assert.equal(BigInt(await provider.send('eth_chainId', [])), 11155111n);
  assert.equal(keccak256(await provider.getCode(graph.deployment.address)), graph.deployment.codeHash);
  const registry = new Contract(graph.deployment.address, ['function publisher() view returns(address)', 'function deploymentMode() view returns(uint8)'], provider);
  assert.equal((await registry.publisher()).toLowerCase(), graph.deployment.publisher.toLowerCase());
  assert.equal(await registry.deploymentMode(), 1n);
  const hashes = [...new Set([graph.receiptPublication.transactionRef, ...Object.values(ens.transactions).map(t => t.hash)])];
  for (const hash of hashes) {
    const receipt = await provider.getTransactionReceipt(hash);
    assert.ok(receipt); assert.equal(receipt.status, 1); assert.equal(receipt.from.toLowerCase(), ens.owner.toLowerCase());
    const block = await provider.getBlock(receipt.blockNumber); assert.equal(block.hash, receipt.blockHash);
    result.transactions.push({ hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, status: receipt.status, feeWei: String(receipt.fee) });
  }
  for (const run of hedera.runs) {
    const [account, timestamp] = run.transactionId.split('@');
    const id = account + '-' + timestamp.replace('.', '-');
    const response = await fetch('https://testnet.mirrornode.hedera.com/api/v1/transactions/' + id, { signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200);
    const body = await response.json();
    const tx = body.transactions.find(t => t.transaction_id === id && t.nonce === 0);
    assert.ok(tx); assert.equal(tx.result, 'SUCCESS');
    const net = accountId => tx.transfers.filter(t => t.account === accountId).reduce((sum, t) => sum + BigInt(t.amount), 0n);
    assert.equal(net(hedera.payer), -BigInt(run.amountTinybars)); assert.equal(net(hedera.receiver), BigInt(run.amountTinybars));
    result.hedera.push({ transactionId: run.transactionId, result: tx.result, consensusTimestamp: tx.consensus_timestamp, amountTinybars: run.amountTinybars });
  }
  assert.ok(hedera.runs.reduce((sum, r) => sum + BigInt(r.amountTinybars), 0n) <= BigInt(hedera.totalLimitTinybars));
  const client = createGraphClient({ endpoint: graph.queryUrl });
  const config = { mode: 'live', chainId: '11155111', deployment: graph.deployment, deploymentId: graph.deploymentId, timeoutMs: 20000 };
  const history = createHistory({ config, client, provider });
  result.history = await queryProviderHistory({ config, client, provider, providerId: 'qualification.operator.eth' });
  assert.equal(result.history.history.freshness, 'fresh'); assert.deepEqual(result.history.reasons, ['HISTORY_UNKNOWN']);
  const data = await client.query({ query: 'query Receipt($receipt: Bytes!, $block: Bytes!) { receiptClaims(first: 2, where: {objectDigest: $receipt}, block: {hash: $block}) { objectDigest providerKey transactionHash blockNumber mode } }', variables: { receipt: '0x' + graph.receiptPublication.event.receiptDigest.slice(7), block: result.history.history.indexedBlockHash } });
  assert.equal(data.receiptClaims.length, 1);
  const claim = data.receiptClaims[0];
  assert.equal(claim.transactionHash, graph.receiptPublication.transactionRef); assert.equal(claim.mode, 1);
  assert.equal(claim.providerKey, '0x' + graph.receiptPublication.event.providerKey.slice(7)); result.indexedReceipt = claim;
  const discovery = createEnsV2Discovery({ inputs: { mode: 'live', rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com', names: [ens.name], timeoutMs: 30000 }, history });
  result.discovery = await discovery.list({ names: [ens.name] });
  assert.equal(result.discovery.errors.length, 0); assert.equal(result.discovery.providers.length, 1);
  const found = result.discovery.providers[0]; assert.equal(found.name, ens.name); assert.equal(found.paymentReceiver, hedera.receiver); assert.equal(found.historyEndpoint, graph.queryUrl);
  const { artifact } = await import('../packages/discovery/src/artifacts.mjs');
  const { packetToBytes } = createRequire(new URL('../packages/discovery/package.json', import.meta.url))('viem/ens');
  const universal = artifact('UniversalResolverV2');
  const owner = await new Contract(universal.address, universal.abi, provider).findOwner('0x' + Buffer.from(packetToBytes(ens.name)).toString('hex'));
  assert.equal(owner.toLowerCase(), ens.owner.toLowerCase()); result.ensOwner = owner;
  // Exercise the selection decision with a real application quote and the live
  // ENS/Graph ports. This temporary loopback host cannot authorize a payment.
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { generateKeyPairSync } = await import('node:crypto');
  const { createSigner } = await import('../packages/core/src/index.mjs');
  const { createRequest } = await import('../packages/access/src/index.mjs');
  const { startTestnetPaymentQualification } = await import('../composition/qualification-payment.mjs');
  const temporary = await mkdtemp(tmpdir() + '/ethonline-decision-');
  let app;
  try {
    const keyId = 'read-only-decision';
    app = await startTestnetPaymentQualification({ approval: 'hedera-testnet-live-settlement', dataDir: temporary, resourceUrl: found.endpoint + '/v1/jobs', signer: createSigner({ privateKey: generateKeyPairSync('ed25519').privateKey, keyId }), receiptKeyId: keyId, paymentAuthorizer: async () => { throw Error('READ_ONLY_QUALIFICATION'); }, paymentConfig: { mode: 'live', network: 'hedera:testnet', asset: '0.0.0', receiver: hedera.receiver, feePayer: hedera.feePayer, providerId: found.providerId, baseAmountBaseUnits: '1', perOutputTokenBaseUnits: '0', maxAmountBaseUnits: '1', maxTotalAmountBaseUnits: '1', facilitatorUrl: 'https://api.testnet.blocky402.com/', mirrorUrl: 'https://testnet.mirrornode.hedera.com/' } });
    await app.client.connect();
    const request = await createRequest({ providerId: found.providerId, profileId: app.profileId, prompt: 'Test-only quote qualification; no job submitted', maxOutputTokens: 8, seed: 0 });
    const quote = await app.client.createQuote(request);
    result.decision = await discovery.select({ providers: result.discovery.providers, quotes: [quote], profileId: app.profileId, network: 'hedera:testnet', asset: '0.0.0', maxAmountBaseUnits: '1' });
    assert.equal(result.decision.selected?.providerId, found.providerId);
    assert.ok(result.decision.reasons[0].codes.includes('HISTORY_UNKNOWN'));
    assert.ok(!result.decision.reasons[0].codes.includes('OBSERVED_PASS_NOT_PROOF'));
  } finally { await app?.close(); await rm(temporary, { recursive: true, force: true }); }
  result.totalSepoliaFeesWei = String(result.transactions.reduce((sum, t) => sum + BigInt(t.feeWei), 0n));
  result.status = 'passed'; result.completedAt = new Date().toISOString();
  fs.mkdirSync(new URL('../artifacts/closeout/', import.meta.url), { recursive: true });
  fs.writeFileSync(new URL('../artifacts/closeout/external-revalidation.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { provider.destroy(); }
}
