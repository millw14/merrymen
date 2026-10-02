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

## Step 2 — Verify a shared adapter, or deploy once per chain

One `V4SelfSwap` contract can serve every Merrymen account on the same chain:
its payer and recipient are always the caller. Hosted users do not need a
separate deployment. The platform operator should provide a verified address;
a user then saves it and signs their own permission. Re-signing while the
address is missing cannot add v4 permission.

Check `contracts/deployments.json` first. A recorded address must still be
verified on its stated chain against the reviewed contract runtime. Never use
a mainnet address as proof of a testnet deployment, or vice versa.

From `contracts/`, prepare an unsigned mainnet deployment without any key:

```sh
npm run prepare:v4:mainnet
```

This compiles the contract, checks chain 4663 and the pinned PoolManager's
code, estimates gas, and writes a JSON review file. It sends no transaction.
The file contains constructor data, compiler/input hashes, and expected full
runtime after substituting the PoolManager immutable. The gas estimate can
change and may exclude chain-specific data fees. Independently confirm the
canonical PoolManager against [Uniswap's deployment table](https://developers.uniswap.org/docs/protocols/v4/deployments).

If there is no existing verified adapter, the **operator** signs one deployment
with their funded deployment wallet. Deployment spends ETH; a hosted user's
renewal only signs permission. An owner-operated shell can run:

```powershell
$env:MERRYMEN_DEPLOYER_PRIVATE_KEY = "0x…"   # never send this key to another person
npm run deploy:v4:mainnet
Remove-Item Env:MERRYMEN_DEPLOYER_PRIVATE_KEY
```

The script uses the TypeScript loader required by this repository, refuses
unknown chains or a missing PoolManager, prints the transaction hash, waits for
success, compares **all** deployed runtime bytes (including the immutable), and
checks `poolManager()`. Only then does it record the address, transaction,
block, runtime hash, and compiler provenance in `contracts/deployments.json`.
Before broadcasting, it creates an exclusive `deployments.v4-<chain>.attempt.json`
journal with the deployer, nonce, and expected contract address. It adds the
transaction hash as soon as available and retains the journal on any failure.
A retry refuses to broadcast while that journal exists, even if receipt waiting
or verification was interrupted. It also refuses to overwrite a recorded v4
deployment. Inspect the recorded transaction, or the deployer nonce and expected
address when the hash is absent, before any manual recovery. Do not remove an
uncertain attempt just to retry.

All shared manifest writers serialize their final read/merge/write through
`deployments.json.lock`. A process crash may leave that lock behind. Inspect
whether a writer is still running and preserve its attempt/transaction evidence
before manual recovery; the tools never steal an old lock automatically.

For testnet, use `prepare:v4:testnet` and `deploy:v4:testnet` and verify chain
46630 separately. Testnet gas is available from
https://faucet.testnet.chain.robinhood.com. The addresses may match or differ;
verify each against its actual chain.

Save the verified adapter in `/settings` → **v4 adapter contract** for the
account that will sign. Setting only `MERRYMEN_V4_ADAPTER_ADDRESS` on the worker
does not configure the hosted browser's signing settings or add permission to
an existing grant. Complete step 4 once the correct address is saved.

## Step 3 — Name your memecoins

A token must be in your settings AT SIGNING TIME to be tradeable — the
sell-approve permission is sealed into the signature (the no-exit rule).

- `/settings` → "your own tokens": symbol, contract address, and **exact**
  decimals for each token you want to trade now. Wrong decimals mis-value the
  holding by orders of magnitude.
- Tick the same symbols into the basket list, in the same save. In
  `customTokens` = watched and sellable; in `basketSymbols` = actually traded.

## Step 4 — Re-sign on mainnet

- Open the existing agent's **Wallet** panel and check its displayed owner and
  smart-account addresses against **your own existing account records**. Stop
  if either differs. No address in this runbook substitutes for that comparison.
- For a legacy owner-key account, use **re-sign this key (free)** while the
  original owner key is available in this browser. If the browser no longer
  holds it, restore your backed-up key into the **same existing account** and
  check both addresses before proceeding.
- For a Privy-owned account, stay signed in as its owner and use the same
  **re-sign this key (free)** control. The embedded wallet signs through the
  login; there is no owner key to paste or restore.
- Select **mainnet · 4663** and acknowledge the chain before signing. Confirm
  that the Wallet panel still shows the intended existing smart account.
- Review the proposed token scope, per-trade and daily caps, expiry, and
  other limits against your current strategy and intended exposure. Do not
  increase a limit merely to clear a rejection.
- Confirm that `/settings` contains the independently verified mainnet
  `V4SelfSwap` address and canonical PoolManager binding from step 2 **before
  signing**. An arbitrary contract address, even one with code, must not be
  sealed into the grant.
- Sign once and wait for the Wallet panel to report **Permission renewed**.
  For a hosted account, that message means the server accepted the renewal;
  completing a wallet signature alone is not enough.
- For a **hosted account**, reopen its Wallet status in the app. Check the
  displayed chain and caps, then check **Trading permissions → Uniswap v4**.
  It must say the adapter permission is sealed to the exact verified mainnet
  address from step 2. A saved address in Settings without that sealed
  permission is not a completed grant. The Wallet panel does not display the
  exact signed token list; if you need to audit it, inspect your authenticated
  `/api/grants` response rather than assuming Settings proves what was signed.
- For a **self-hosted installation only**, also inspect its local
  `~/.merrymen/grant.json` (or the `grant.json` under its configured
  `MERRYMEN_HOME`). Check `"chainId": 4663`, `"grantTokens"` for only the token
  addresses you authorized, `"v4-adapter"` in `grantFeatures`, and
  `"v4AdapterAddress"` for the verified mainnet adapter.

If the server refuses the renewal or any expected marker, address, chain, or
limit is missing or mismatched, **stop**. Recheck the saved settings, deployed
adapter code and PoolManager identity, selected chain, and intended grant
scope. Resolve the discrepancy before signing once more, then verify the new
server-accepted status. Do not keep re-signing the same configuration.

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

## What fits beside it

Every capability you turn on adds to the permission your first operation has to
install, and there is one ceiling for all of it (14M gas, `first-enable-gas.ts`).
Signatures made since `scoped-spenders` name each contract only on the tokens it
actually pulls, so the v4 adapter now fits beside the rest:

| Your permission | Custom tokens that fit |
|---|---|
| class vault + Autonomous Trencher + v4 adapter | up to 4 |
| class vault + Autonomous Trencher | up to 6 |

If you were told to choose between the Trencher, v4 and your tokens, renew at
`/grant` once: the same settings now seal a narrower permission set. If the
signer still refuses, it says how many tokens fit with what you have on.

The v4 adapter trades USDG against your own coins. Stocks always trade on
Uniswap v3, where every tradeable stock has depth.

## What the wall now guarantees on v4

- Output of every adapter swap lands in YOUR account — not a policy
  condition, a fact of the bytecode.
- Both legs of every adapter swap must be assets you named at signing — USDG
  and your own coins, never a stock, so no v4 pool can be handed your shares.
- No Permit2, no UniversalRouter, no standing approvals: each trade approves
  exactly its own input amount, consumed by the swap.
- A hooked pool that won't quote the exit is never entered; an empty fill
  reverts rather than reporting success; a mis-settle reverts by name.
