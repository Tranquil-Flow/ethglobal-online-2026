# External qualification — provisioning attempt

## Authority

Owner authorized Hedera testnet, Sepolia and needed Graph deployments, then dedicated
testnet account setup, a free Graph project and faucet sourcing. Mainnet funds,
paid hosting, source publication and excluded runtime operation remain unauthorized.
Local verified candidate remains 9373db92f24cbd34d13c151314f04c3b716b38e1.

## Actual provisioning

Dedicated EVM keypairs were generated using installed ethers Wallet.createRandom.
Files are outside the repository in ~/.ethonline-testnet, directory mode 0700 and
files mode 0600. Keys were not printed, exported to browser pages or committed.
These are locally generated keys, not proof of activated/funded chain accounts.

| Purpose | Public address |
|---|---|
| Hedera payer | 0x3059a3a2BE58717380A3662eECF68bbd1143359B |
| Hedera receiver | 0x1516b556592b05f694Fb5E303611BD1A14446336 |
| Sepolia deployer | 0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE |

## Observed external prerequisites

- https://api.testnet.blocky402.com/supported returned HTTP 200 and advertised
  hedera:testnet, exact x402 v2, fee payer 0.0.7162784.
- Hedera testnet mirror network-nodes request returned HTTP 200 and one node.
- https://portal.hedera.com/faucet accepted the payer address and displayed a
  10-test-HBAR confirmation. Confirm remained disabled; reCAPTCHA frames were present.
  No successful disbursement or transaction receipt was observed.
- https://faucet.quicknode.com/ethereum/sepolia rejected the new deployer address:
  "Invalid ETH mainnet balance." This contradicts the page FAQ's no-minimum-balance
  statement. No mainnet funds were supplied.
- https://sepolia-faucet.pk910.de/ displayed "Loading captcha..." before Start Mining.
  No mining workload or CAPTCHA bypass was started.
- https://faucet.zalalena.com/sepolia explicitly requires CAPTCHA before delivery.
- https://thegraph.com/studio/ displayed a disconnected-wallet login modal offering
  Coinbase Wallet, WalletConnect and Safe. No connected signing session exists for
  the dedicated wallet. No project or deployment was created.

Browser-use CLI had an environment import error; the repository's existing Playwright
installation successfully exercised the public forms instead. A first local keygen
command had a homedir typo and failed before generating files; the corrected command
succeeded with permission verification.

## Qualification disposition

BLOCKED on faucet human verification and a supported Graph wallet login/signing session.
No faucet receipt, settlement, chain deployment or hosted Graph query is claimed.
No CAPTCHA evasion, existing-wallet secret discovery, mainnet spending or paid service
was attempted. Local completion evidence is preserved; external qualification is open.

## Funding and first deployment follow-up

Owner completed faucet verification and funded Sepolia. Live checks observed payer
0.0.10419268 with 1000000000 tinybars and Sepolia deployer with
210000000000000000 wei on chain 11155111. These observations supersede funding blockers.

`testnet-deployments.json` records the confirmed Sepolia registry deployment and
successful Hedera receiver creation (0.0.10419316). Registry runtime code was fetched
and hashed after two confirmations. The initial 0.001-test-ETH fee ceiling rejected
the estimate before broadcast; observed estimate justified a bounded 0.003-test-ETH
ceiling, using testnet funds only.

Hedera alias account construction failed before execute with an SDK key-type error.
Mirror checks found no transaction/account. The preserved no-alias account creation
succeeded using the intended public key, with 0.1 test HBAR initial balance and a
1-test-HBAR fee ceiling. The receiver is identified by its numeric account ID, not
the originally generated EVM address. Failed attempts remain in artifacts/closeout.

All pinned ENSv2 addresses have code on Sepolia; UniversalResolver ROOT_REGISTRY
returns the expected pinned root. This does not establish owned-name provisioning.
Graph wallet connection/project creation, real x402 settlement/consumption and ENS
name provisioning remain open. No assessment claims have been published.
