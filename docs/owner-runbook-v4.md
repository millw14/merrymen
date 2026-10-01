# Owner runbook — memecoins and new pairs via the v4 adapter

This runbook covers the owner-controlled deployment and signing steps for a
v4 adapter. Use your own existing account, current settings, and chosen risk
limits throughout. A saved adapter address is not proof that the contract is
safe to authorize.

## Already done for you (no action)

- `V4SelfSwap` contract and tests are in this repository. Its intended output
  recipient is the calling smart account.
- Wall permission, grant marker, worker mirror, execution path, discovery
  PoolKey capture, and routing over discovered pools are implemented.
- The renew button on `/grant` is now trustworthy: it fetches settings at
  click time and signs on the chain the page shows.

## Step 1 — Bitquery API key

Discovery is how merrymen SEES new pairs (they launch through hooks on v4;
the hook address can only be learned from the Initialize event, and Bitquery
indexes those). Without a key, discovery stays silently off.

- Get a key at bitquery.io (free tier is fine to start).
- Paste it into `/settings` → `bitqueryApiKey`. Confirm that
  `discoveryEnabled` is on for your account.

## Step 2 — Deploy the adapter (twice)

Deployment spends real gas from a real key, so it is yours to run. The key is
read from the environment and is not printed by the script; the script does
print public addresses and the deployer's ETH balance.

In PowerShell, from `contracts/`:

```powershell
$env:MERRYMEN_DEPLOYER_PRIVATE_KEY = "0x…"   # a funded EOA; close this shell after
npx hardhat run scripts/deploy-v4selfswap.ts --network robinhoodTestnet
npx hardhat run scripts/deploy-v4selfswap.ts --network robinhood
```

- Testnet gas: free at https://faucet.testnet.chain.robinhood.com
- Mainnet gas: a small amount of ETH on chain 4663.
- The two runs may print different addresses. Check each address against its
  actual chain; never use a testnet address in a mainnet grant.
- The script refuses unknown chains, missing keys, and an address with no
  PoolManager code. After deployment, it checks that the adapter has code and
  that `poolManager()` returns the pinned PoolManager address. These checks do
  not, by themselves, prove the deployed adapter's code identity.
- Before saving or signing, independently verify that the deployed address is
  **this repository's `V4SelfSwap` runtime**, built from the reviewed source
  with the expected constructor argument, and that its immutable
  `poolManager()` equals the **canonical PoolManager for that chain**. Cross-check
  the PoolManager in `contracts/scripts/deploy-v4selfswap.ts` against
  `packages/core/src/protocols.ts` and independently confirm the chain's
  intended deployment. Compare deployed runtime bytecode with the
  corresponding build after immutable substitution, or verify reproducible
  source and constructor arguments on a trusted explorer. Merely finding
  non-empty code or a matching `poolManager()` return value is insufficient.
- Paste only the verified MAINNET adapter address into `/settings` → "v4 adapter
  contract". Use the verified testnet address only for a testnet grant.

## Step 3 — Name your memecoins

A token must be in your settings AT SIGNING TIME to be tradeable — the
sell-approve permission is sealed into the signature (the no-exit rule).

- `/settings` → "your own tokens": symbol, contract address, and **exact**
  decimals for each token you want to trade now. Wrong decimals mis-value the
  holding by orders of magnitude.
- Tick the same symbols into the basket list, in the same save. In
  `customTokens` = watched and sellable; in `basketSymbols` = actually traded.

## Step 4 — Re-sign on mainnet

- Open `/grant` → **restore a funded wallet** tab for the owner of the
  **existing account you intend to renew**.
- Click the **mainnet · 4663** pill and tick the acknowledgement.
- Restore your backed-up owner key and use **check this wallet**. Compare the
  displayed owner address and derived smart-account address with **your own
  existing account records**. Stop if either differs. No address in this
  runbook is a substitute for that comparison.
- Review the proposed token scope, per-trade and daily caps, expiry, and
  other limits against your current strategy and intended exposure. Do not
  increase a limit merely to clear a rejection.
- Confirm that `/settings` contains the independently verified mainnet
  `V4SelfSwap` address and canonical PoolManager binding from step 2 **before
  signing**. An arbitrary contract address, even one with code, must not be
  sealed into the grant.
- Sign. Then verify `~/.merrymen/grant.json` contains:
  - `"chainId": 4663`
  - `"grantTokens": [...]` listing only the token addresses you authorized
  - `"v4-adapter"` in `grantFeatures`, and `"v4AdapterAddress"` = the mainnet
    adapter whose code identity and PoolManager binding you verified.

If any of those is missing, the settings save and the signature crossed —
hard-reload `/grant` and sign again.

## Step 5 — Fund the smart account

Send only to the smart-account address you matched to your existing account in
step 4:

1. **ETH first** — the account self-pays gas, and the first operation also
   pays to deploy the account.
2. **USDG** — your chosen trading capital. Check your account's current
   `idleFloorUsdg`, daily cap, and sweep behavior before funding; this
   runbook provides no universal deposit amount.
3. Any scout budget is money you have decided you can lose: quarantined
   positions are carried at cost and the drawdown breaker cannot protect
   them. Keep the budget within your own risk limits.

## Step 6 — Prove it

```bash
merrymen preflight
```
Expect **0 blockers**. Then:

```bash
merrymen selftest
```
It must print **PASSED** — it now exits non-zero for anything less, and green
means the grant, the wall, the bundler and the ledger all work.

Memecoin pools trade 24/7, so no market-hours window applies to them (the
stock leg still needs US market hours).

## From then on — each new token

1. Discovery announces the launch in your feed/Telegram (with the pool's
   liquidity and FDV, and — for hooked pools — the key that makes it
   routable).
2. `/settings`: add it (symbol, address, decimals) and tick it into the
   basket.
3. `/grant`: click **renew the key (free)**. One click; it now reads your
   fresh settings and signs on the chain the page shows.

That re-sign-per-token loop is structural, not an inconvenience to engineer
away: the wall cannot widen itself, which is the product's core promise. Two
minutes per token is what "the chain enforces the wall" costs.

## What the wall now guarantees on v4

- Output of every adapter swap lands in YOUR account — not a policy
  condition, a fact of the bytecode.
- Both legs of every adapter swap must be assets you named at signing.
- No Permit2, no UniversalRouter, no standing approvals: each trade approves
  exactly its own input amount, consumed by the swap.
- A hooked pool that won't quote the exit is never entered; an empty fill
  reverts rather than reporting success; a mis-settle reverts by name.
