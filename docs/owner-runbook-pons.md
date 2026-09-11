# Owner runbook — trading Pons bonding curves

Everything the software can do is done and committed. This file is the part
only you can do. Unlike the v4 runbook, it opens with the reasons you might
decide NOT to do it, because they are real and they are not obvious from the
code.

## Read this before you deploy anything

**A round trip costs 199 bps in curve fees alone.** 100 bps per side, measured
exactly — 0.980100 to six decimal places, across three curves and four sizes
spanning three orders of magnitude. That is before gas, and before the
USDG→quote-asset leg you need to reach most curves. merrymen's whole existing
cost floor is about 47 bps, so one Pons round trip costs more than four times
what the rest of the system budgets for an entire trade. A strategy has to beat
2% before it breaks even.

**This adapter reaches 27.2% of launches, not all of them.** Native-ETH-quoted
curves are 53.6% and it refuses them all. `buy()` is payable, and every
permission in the wall carries `valueLimit: 0` — the account may not send native
value at all. Bridging that means the adapter pulls WETH, unwraps it, and
forwards the ETH itself, which costs four of the guarantees the contract
otherwise inherits from `V4SelfSwap`: a `receive()`, a live ETH balance
mid-transaction, a trust dependency on WETH (an upgradeable proxy on this chain,
not canonical WETH9, which gets full gas on the withdraw payout while the
adapter is holding ETH), and a WETH approve permission. That is a different
contract with a different threat model, and it belongs behind its own selector
so you can grant one without granting the other.

**Of the 27.2%, only the USDG-quoted 2.8% are one hop from your cash.** A
stock-token-quoted curve — 42.8% of launches, and the bulk of what this reaches
— needs USDG→NVDA first. "ERC-20 is simpler" is a claim about the contract, not
about reach.

**The wall cannot vouch for the curve.** A buy goes to a per-token address,
about 475 new ones an hour, so there is nothing to pin. A curve self-reports its
`factory()`, which a hostile contract can too, and the Pons factory publishes no
registry view (sixteen candidate selectors probed; none present in its
bytecode). So a compromised session key can name an attacker's contract as the
curve and lose up to the standing allowance of an allowlisted asset. That is the
same exposure the wall already carries for the v4 adapter's caller-chosen pool
key and for SwapRouter02 today — not new, and not zero. What bounds it: both
asset legs are pinned to your own asset list, the pull is capped at the trade
size, and the adapter enforces the output floor against your account's own
balance rather than taking the curve's word for it.

If those four paragraphs do not change your mind, the rest is the procedure.

## Already done for you (no action)

- `PonsSelfTrade` written, tested (17 contract tests), attacked with a hostile
  curve that takes the money and pays 1%, and verified against mainnet by
  simulation before a line was written.
- Wall permission, grant marker, both signers, worker mirror, arm-time liveness
  check, settings plumbing, execution path and deploy script — all committed
  with tests.
- The adapter is non-payable and has exactly one function. No owner, no pause,
  no upgrade, no rescue. If there is a bug in it, nobody can stop it — including
  us. That is the same deliberate trade `V4SelfSwap` makes.

## Step 1 — deploy the adapter

Testnet first. The two runs produce two different addresses.

```bash
cd contracts && NODE_OPTIONS="--import tsx" npx hardhat run scripts/deploy-ponsselftrade.ts --network robinhoodTestnet
```

`NODE_OPTIONS="--import tsx"` IS REQUIRED, and leaving it off is not a subtle
failure — `hardhat run` hands the script to Node's ESM loader, which has no TS
handler, so the command in this runbook used to die with
`ERR_UNKNOWN_FILE_EXTENSION` before touching the network. Hardhat compiles its
own `hardhat.config.ts` and nothing else. In PowerShell, set it separately
first: `$env:NODE_OPTIONS = "--import tsx"`.

The deployer key comes from `MERRYMEN_DEPLOYER_PRIVATE_KEY` in the shell that
runs it, is never logged or written, and should be unset afterwards. The script
refuses any chain that is not 46630 or 4663, refuses to run with no balance, and
post-verifies that the deployed ABI is the one the wall pins — one non-payable
function called `tradeExactIn`. A payable entry point would mean the
permission's `valueLimit: 0` was guarding a door that had moved.

## Step 2 — settings

Paste the address into `/settings` as `ponsAdapterAddress`, on the machine that
signs grants for that chain.

This is a HINT, not the authority. The worker calls whatever address the grant
was sealed against, and warns you if the two have drifted. A setting that could
redirect trades at a contract your signature never covered would be the mirror
going looser than the chain, which is the one direction that is never safe.

## Step 3 — add the token, then re-sign

Both, in that order, for every token you want traded.

The adapter can only move assets your signature already covers, so a Pons token
has to be added in `/settings` as a custom token and then the grant re-signed at
`/grant`. The re-sign is what seals the adapter address and mints the
`pons-adapter` marker; the setting alone changes nothing, and a marker without
the sealed address is a claim the worker correctly ignores.

**This also means you cannot buy a token you have not already approved of.**
That is the wall working, not a limitation to route around: discovery tells you
a curve exists, and you decide. The sequence stays owner → wall → agent.

## Step 4 — verify before funding

On testnet, with the grant re-signed:

- `/grant` should show the Pons adapter address on the grant, not just in
  settings.
- The worker logs `pons adapter … has no code on chain …` if you got the address
  wrong or deployed to the other chain. It says so at arm time rather than
  letting a UserOp revert later.
- Discovery should already be naming curves (`🚀 pons: N of M launches worth a
  look`). That path needs no adapter and has been running since Phase 1.

## What is still not true after all four steps

- **Native-quoted curves stay unreachable.** 53.6% of the launchpad. Adding them
  is a separate contract and a separate decision.
- **The agent has never landed a live trade of any kind.** The plan's own
  sequencing says to land one ordinary trade on the existing v3 path first, as
  the cheapest possible proof the execution path works at all. That has not
  happened, and a bonding curve is a poor place to discover that something
  upstream is broken.
- **Trencher's own gates still refuse every curve.** `minLiquidityUsd` is
  $25,000 against a structural ceiling of about $10,249, and `minFdvUsd` is
  $50,000 against a ceiling of $50,218 reached only at the instant a curve stops
  existing. Curve candidates need their own configuration or the path can never
  fire — and the refusal will read as a judgement about the token rather than
  about the venue.
