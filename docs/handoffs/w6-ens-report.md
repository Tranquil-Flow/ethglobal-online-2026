# Wave 6 ENS re-point report

## Status

The target file currently contains:
```json
{"version":"ethonline.wave6.ens-target.v1","chainId":11155111,"owner":"0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE","providerNames":["service.ethonline-node-a.eth","service.ethonline-node-b.eth"],"endpoint":"https://ethonline-wave6.example.invalid","ownerConfirmed":false}
```
This is a reserved `.invalid` placeholder, not an owner-set public origin. The design is sound: it records both bidder/provider names, the request receiver endpoint key (`ethonline.endpoint`), owner/address checks, preview/simulation, per-name writes, 12-confirmation waits, and bidirectional before/after resolution through the canonical ENSv2 verification path.

## Operator command (do not run until target and ownerConfirmed are updated)

Run from the repository root with Node 20+, installed `viem`, an operator-selected Sepolia RPC, and a private key supplied directly by the operator (never commit either secret):
```sh
SEPOLIA_RPC_URL='https://OWNER_SELECTED_SEPOLIA_RPC' \
WAVE6_ENS_PRIVATE_KEY='0xOWNER_SUPPLIED_PRIVATE_KEY' \
node --input-type=module <<'NODE'
import fs from 'node:fs/promises';
import { createPublicClient, createWalletClient, http, namehash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
const p = JSON.parse(await fs.readFile('docs/handoffs/w6-ens-target-endpoint.json', 'utf8'));
const expectedNames = ['service.ethonline-node-a.eth','service.ethonline-node-b.eth'];
const u = new URL(p.endpoint);
if (p.chainId !== 11155111 || p.owner !== '0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE' || JSON.stringify(p.providerNames) !== JSON.stringify(expectedNames) || p.ownerConfirmed !== true || u.protocol !== 'https:' || u.hostname.endsWith('.invalid') || u.username || u.password || u.search || u.hash) throw new Error('closed owner-set public HTTPS target required');
const account = privateKeyToAccount(process.env.WAVE6_ENS_PRIVATE_KEY);
if (account.address.toLowerCase() !== p.owner.toLowerCase()) throw new Error('operator is not ENS owner');
const transport = http(process.env.SEPOLIA_RPC_URL);
const publicClient = createPublicClient({ chain: sepolia, transport });
const walletClient = createWalletClient({ account, chain: sepolia, transport });
const abi = [{ type:'function', name:'setText', stateMutability:'nonpayable', inputs:[{name:'node',type:'bytes32'},{name:'key',type:'string'},{name:'value',type:'string'}], outputs:[] }];
for (const name of p.providerNames) {
  const before = await publicClient.getEnsText({ name, key:'ethonline.endpoint' });
  if (before === p.endpoint) { console.log(JSON.stringify({ name, before, after:before, unchanged:true })); continue; }
  const resolver = await publicClient.getEnsResolver({ name });
  if (!resolver) throw new Error(`no resolver for ${name}`);
  const { request } = await publicClient.simulateContract({ account, address:resolver, abi, functionName:'setText', args:[namehash(name),'ethonline.endpoint',p.endpoint] });
  const hash = await walletClient.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash, confirmations:12 });
  const after = await publicClient.getEnsText({ name, key:'ethonline.endpoint' });
  if (after !== p.endpoint) throw new Error(`post-write mismatch for ${name}`);
  console.log(JSON.stringify({ name, before, after, tx:`https://sepolia.etherscan.io/tx/${hash}` }));
}
NODE
```

## Evidence and URLs

Before execution, resolve each name at one canonical Sepolia block and retain endpoint, block number/hash, resolver proxy/implementation, registry/expiry walk, and alias result. After 12 confirmations, repeat the identical production resolution, require the new endpoint and canonical block re-read, then retain the command output and transaction receipts.

Expected transaction links (one per changed name):
- `https://sepolia.etherscan.io/tx/<NODE_A_TX_HASH>`
- `https://sepolia.etherscan.io/tx/<NODE_B_TX_HASH>`

**Live re-point NOT executed — requires operator wallet location and owner-set public demo origin. Testnet ENS re-point remains owner territory.**
