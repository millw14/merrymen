# Owner runbook — moving the class route to a vault with one ceiling per quote

This is the second class-vault runbook, and it assumes you have read the first.
`docs/owner-runbook-class.md` opens with five reasons not to turn the class route
on at all, and every one of them still holds. Nothing here makes that route
safer; it makes a ceiling mean what you were told it means.

Everything the software can do is committed. This file is the part only you can
do — a deploy, a signature, and a decision.

## Why there is a second vault at all

**v1 holds one number and charges every buy against it.** `DEFAULT_SPEND_CAP` is
`250_000_000` raw units, which is 250 USDG at six decimals. The vault compares
that number against `quoteIn` — the amount of whatever asset funded the call.

**The chain never restricted which asset that is.** `_checkCurve` accepts any
ERC-20 equal to the curve's own `pairToken()`. The only thing pinning class buys
to USDG is a constraint in the permission wall, off chain.

So the day a second quote asset is approved, a five-dollar entry in an
eighteen-decimal share hands the vault about `2.8e16` against a ceiling of
`2.5e8`. It is refused by eight orders of magnitude, in the one place no
off-chain code can correct — the bytecode is frozen at a deployed address.

**A ceiling therefore has to be keyed by the asset it is denominated in.** It
cannot be made commensurable by scaling, because the only inputs that could
scale it are a price and a share multiplier, and the vault is forbidden to read
either at execution time. That prohibition is not incidental: an attacker who
chose the curve could choose those too.

`PonsClassVaultV2` holds one cap per quote asset, and **the cap is the
allowlist** — zero means refused, and it says so by name (`QuoteNotApproved`)
rather than by arithmetic, because "re-seal this" and "wait for the window" are
different instructions and a worker that confuses them retries the unfixable one
forever.

## What this does NOT unlock

Read this twice. Deploying the v2 factory changes exactly one layer.

**Your agents still cannot enter a non-USDG position.** The vault would *accept*
one. Nothing else would. The wall still pins the buy's quote word to USDG, the
candidate producer still filters to USDG, and the ledger still books `quoteIn`
as USDG at six decimals. Three independent refusals remain in place.

That ordering is deliberate rather than cautious. The contract is the only layer
that cannot be corrected after the fact, so it moves first and it moves alone.
Multi-quote *research* — the Brain ranking and reasoning about non-USDG
candidates, and saying plainly when the best opportunity is currently
unexecutable — is a separate change and is shadow-only.

**Native-ETH-quoted curves stay refused by name.** Every wall permission carries
`valueLimit: 0`, so the account cannot send native value at all. That is 53.6% of
launches and it is unchanged.

**The chain still does not vouch for any class token.** Provenance lives entirely
in the worker's factory-filtered launch feed. For this permission the chain is
looser than the off-chain mirror, which is the reverse of how everything else
here works.

## What the seed caps are, and what they are not

The v2 factory carries a **seed quote set** fixed at its own construction and
hands it to every vault it creates.

That seed is a **fleet-wide birth floor**, not your risk allowance. It exists for
one mechanical reason: a vault is created inside the same UserOperation as its
first buy, and that batch reverts whole — measured on chain 4663 at block
64670932 by `scripts/probe-kernel-batch-atomicity.mts`, with a control run that
proves the measurement. So there is no second transaction in which to seal caps
before the first buy needs them. A vault that was born empty and had to be
configured afterwards would fail its own first buy, every time.

### Right now the seed is the LAST word, not the first

The contract has `setQuoteCaps`, it is owner-only, and it never moves the vault's
address. **But nothing off chain can call it.** There is no `merrymen vault
set-caps`, and no other code path anywhere in this repo builds that operation —
`grep -rn setQuoteCaps` outside the contract and its tests returns nothing. The
caller has to be the smart account itself, via a sudo UserOperation, and that
operation has never been written.

So until that tooling exists, **whatever quotes the factory is seeded with are
the only quotes any vault from it will ever have.** Treat the seed as permanent.

Two things follow, and they point in opposite directions:

- **Seed every asset you intend to reach.** The planned canary picks NVDA *or*
  SPY by measured liquidity at test time. If only one is seeded, that choice is
  already made, and making it the other way needs code that does not exist.
- **Seed nothing you do not intend to reach.** A cap is a ceiling somebody has to
  be willing to defend, and you cannot lower it.

The asymmetry inside a chosen asset still favours small. **A birth default that
is too low costs you a refusal you can fix by deploying a new factory. One that
is too high is a ceiling nobody agreed to and cannot take back.**

### Seeding a quote is not enabling it

A seeded NVDA cap means the *vault* would accept an NVDA-funded buy. Nothing else
would. The wall still pins the class buy's quote word to USDG alone, the producer
still refuses any candidate quoted in anything else, and the ledger now refuses to
book a non-USDG fill rather than converting it. A seeded quote with no other layer
behind it is **inert**, not live — which is exactly why it is safe to seed the
canary's candidates now and decide between them later.

### Why the address does not move when a cap changes

Caps live in storage rather than in the CREATE2 init code. That is the
load-bearing decision in the whole design: a raw cap is derived from a dollar
allowance and a live price, so it differs at almost every signing — and if the
address moved with it, a routine re-sign would pin a fresh empty vault and leave
the open position behind in the old one.

The **seed** is a different matter, and it is in the init code: it is a
constructor argument, so two factories with different seeds produce different
vault addresses for the same owner. Re-deploying the factory to change the seed
therefore moves every vault. That is the real cost of getting it wrong, and it is
why this section is longer than it looks like it needs to be.


## Step 0 — flatten the v1 vault first

Do this before anything else, and confirm it landed.

**Sell the open position, then sweep the residue.** The v2 vault is a different
address. It is not an upgrade and there is no migration: nothing moves from one
to the other by itself.

Leaving a balance behind is recoverable — `merrymen recover` derives a vault from
a factory and your owner key alone, with no grant needed, and the v1 factory
stays pinned in `packages/core/src/protocols.ts` for exactly this reason. But
recovering is a manual errand with your owner key in a shell, and it is cheaper
to avoid than to perform.

## Step 1 — deploy the v2 factory

**There is no testnet rehearsal.** The script's quote table holds mainnet
addresses and only mainnet addresses, so on 46630 every token reads as a
non-contract. It now refuses that chain by name rather than dying at the first
`decimals()` read. The keyless dry run below is the rehearsal.

### Seed USDG only

```
MERRYMEN_V2_SEED="USDG:250"
```

`250` is not merely a small number: `250_000_000` raw is **exactly v1's
`DEFAULT_SPEND_CAP`**, so the cutover changes the vault and nothing else. At the
canary's five-dollar entry size that is about fifty entries of daily headroom — a
floor, not an allowance.

**Do not seed NVDA and SPY yet**, even though the vault would accept them and no
other layer would. Three reasons, in order of weight:

1. **The seed is the only refusal that can never be narrowed.** A non-USDG entry
   is refused in four places today; three of them are a code push away from
   changing and one is frozen bytecode. Spending the immutable refusal now buys a
   convenience that is needed once, later.
2. **A stock seed is sized off a live price, so it inherits the market-hours
   constraint.** A USDG cap reads no feed, no multiplier and no pause switch — it
   short-circuits to a price of exactly 1.0 — so a USDG-only deploy can be run at
   any hour, including a weekend, with nothing to go stale.
3. **Step 4 wants one variable.** Proving the USDG route on a factory seeded
   identically to v1's ceiling tests the vault, not a new number.

**The honest cost:** adding NVDA or SPY later needs an owner-key `setQuoteCaps`
operation, and that script does not exist yet (see the section above). It is
off-chain work that can be written. The factory is the thing that cannot be
rewritten, so the trade goes in this direction.


The seed is written in **dollars** and sealed in **raw units**. The script does
that conversion once, from each quote's own Chainlink feed and its own
`uiMultiplier()`, read live, and prints every number with its arithmetic so you
can see the ceiling you are actually sealing. A USDG cap skips all of that: a
dollar is a dollar, so it short-circuits to a price of exactly 1.0.

### Rehearse it first — no key, no gas

```bash
MERRYMEN_V2_DRY_RUN=1 MERRYMEN_V2_SEED="USDG:250" npm run --prefix contracts deploy:classfactoryv2:mainnet
```

Same code path, same reads, same refusals. It prints the raw caps it *would* seal
and stops before deploying. **Read the printed line character by character.** It
must say exactly:

```
    USDG   $   250  →  250000000 raw (6dp, a dollar by definition)
```

`250000000` is the number to check. Three extra zeros is the likeliest typo there
is, and above $10,000 the script refuses outright — but inside the band, the only
thing standing between a slipped decimal and an immutable ceiling is you reading
that line.

What the rehearsal cannot tell you is whether `deploy()` would succeed. That gate
needs the factory to exist, so it only runs for real.

### Then, for real

PowerShell has no inline environment prefix, so set each as its own statement:

```bash
$env:MERRYMEN_DEPLOYER_PRIVATE_KEY = "0x..."
$env:MERRYMEN_V2_SEED = "USDG:250"
npm run --prefix contracts deploy:classfactoryv2:mainnet
```

Use the npm script, never `npx hardhat run`. The bare CLI hands the script to
Node's ESM loader, which has no TypeScript handler, and it dies with
`ERR_UNKNOWN_FILE_EXTENSION` before touching the network. The loader rides in the
script entry itself.

**Market hours only matter for a STOCK seed.** Chainlink's equity feeds run 24/5
and the script refuses one older than two hours, because a cap derived from a
price nobody can trade at is a cap nobody agreed to — and unlike a bad trade,
nothing downstream can notice. The contract compares raw to raw and has no way to
know. Note the gate is a *staleness* gate, not a *session* gate: forty minutes
after the close it still passes, on a price the market has stopped making. That
gap is the operator's to close, which is the whole reason this paragraph exists.

A USDG-only seed has no such constraint and can be deployed at any hour.


It also refuses: an unknown chain, an unfunded deployer, a token whose
`decimals()` disagrees with the registry, a reverting `uiMultiplier()`, a paused
token, a cap that rounds to zero, and a cap too large for the vault's `uint96`
slot.

Then it checks three things and aborts on any of them:

1. `FACTORY_VERSION` answers 2.
2. `vaultFor` answers a real address.
3. The init code hash the factory will CREATE2 with equals the hash of the
   artifact compiled from this working tree.

The third is the one that matters. `FACTORY_VERSION` is a number any contract can
return. A factory built from a different commit would mint vaults whose bytecode
nobody here has read, at addresses the wall had already sealed.

The deployer key comes from the shell, is never logged, and should be unset
afterwards.

## Step 2 — pin the address

### Verify it from outside the process that deployed it

```bash
npx tsx scripts/verify-classfactoryv2.mts 0x<the-new-factory>
```

Read-only and keyless — run it from a shell that never held the deployer key.
The deploy script's own four gates are claims by the process under test; this
re-establishes the same facts from different sources, and adds three the deploy
script cannot make:

- the deployed bytecode is compared to the compiled artifact, not merely checked
  for being non-empty
- the seed is decoded back into **dollars**, so you read the ceiling as money
- `deploy()` is simulated for **Shogun**, the account that will actually use it,
  and the CREATE2 address is recomputed locally rather than taken from the
  factory's own view

It exits non-zero on any failure and prints the Shogun vault address, which is
the number the grant must seal in Step 3.

**If it says FAIL, do not pin the address and do not re-sign.** The factory is
immutable; the only remedy is a different deploy.


Put the deployed address in `PONS_CLASS_VAULT_FACTORY_V2` in
`packages/core/src/protocols.ts`, and **leave the v1 constant exactly as it is.**

Commit `contracts/deployments.json`. The repo has a test in both directions: a
constant naming an address nobody deployed fails, and a deployment that no
constant carries fails. The second half exists because `PonsSelfTrade` once spent
a release deployed-by-nobody and unreachable, and the only evidence was the
absence of trades.

## Step 3 — re-sign

Paste the deployed address into **Class vault factory contract** in /settings,
then re-sign at /grant.

The vault address is a CREATE2 function of the factory, so a v2 factory means a
different vault address, which means a new signature. Nothing about an existing
v1 grant changes or expires on its own — which is why Step 0 comes first.

**The signer checks the address before it seals anything.** It reads
`FACTORY_VERSION` and tells you which family you are about to commit to.

That check is not a formality. `vaultFor`, `deploy`, `buy`, `sell` and `sweep`
have identical signatures in both versions, so the permission wall built from a
v1 address is byte-identical to the one built from a v2 address. A v1 address
pasted here answers plausibly, returns a real deployed vault, pins a real target
and reports a successful re-sign — while the chain quietly enforces v1's single
global ceiling. Nothing downstream can tell.

A revert from `FACTORY_VERSION` means version 1, not an error. v1 declares no
such function and has no fallback.

The signer also refuses a v2 factory whose seed carries no USDG cap, or a USDG
cap of zero. A vault is created inside the same operation as its first buy, so a
bad seed has no second transaction to be fixed in: every buy the wall permits
would revert after the USDG approve leg had already landed, every tick, forever.

**Then check the agent can be put into service.** `classEnableBlockers` compares
the vault your signature sealed against the one the factory derives, and refuses
if they differ — that is a wall pinning a vault the executor never uses. It
derives from the factory the grant itself sealed, so a correctly signed v2 grant
produces no blockers. If it does produce one, the two sides really do disagree,
and the answer is not to override it.


## Step 4 — prove USDG still works, before anything else

The first thing a v2 vault must do is the thing a v1 vault already did.

A complete USDG round trip — buy, then sell, with the accounting reconciled —
against the new vault, with no non-USDG asset involved anywhere. If that does not
work, nothing downstream is worth attempting, and the failure is cheap to
diagnose because only one variable changed.

## Step 5 — the canary, and what it has to prove

**Prerequisite, because the factory is seeded USDG-only:** the vault must be
given an NVDA or SPY cap first, with an owner-key `setQuoteCaps` operation.
**That script does not exist yet.** It is a sudo UserOperation from the smart
account — the pattern is already in the recovery path — and it has to be written
before this step can begin. Nothing about it touches the wall, the producer or
the ledger, all of which still refuse a non-USDG entry; it only opens the vault's
own ceiling, which is one of four refusals.

Write it, size the cap from a live feed the same way the deploy script does, and
read the cap back with `quoteCap` before trusting it.


One agent, one non-USDG quote, chosen by **measured liquidity at the time of the
test** rather than by preference. NVDA or SPY.

The run has to demonstrate, end to end:

- USDG converted to the approved quote asset
- the vault BUY
- **a worker restart while the position is open** — the position must survive a
  process that does not remember it
- the vault SELL
- the quote asset converted back to USDG
- exact accounting across the whole trip

Both directions must be **simulated before entry**, not just the buy. An entry
you can open and cannot close is the failure this whole contract family exists to
prevent.

The entire batch must revert if any inner leg fails, and that behaviour is not
assumed. It was measured on chain 4663 at block 64670932, with three scenarios:
a batch where both inner calls succeed, a batch where the second reverts, and a
`TRY_EXEC` control where the second reverts and the batch does not. The third is
what makes the second a proof rather than a coincidence.

## If something goes wrong

`merrymen recover` takes your owner key and reaches a vault with no grant. It
probes **both** factories and reports what each holds, separately and labelled by
version, because a v1 vault may hold a position while new grants point at v2. A
factory that will not answer is named rather than collapsed into a single "class
vault" failure — one blinking read must not hide the other vault.

It sweeps **one operation per vault**. The batch is atomic, so two vaults sharing
one operation would let a dead one take the live one down with it, and the report
could not say which failed.

The browser recovery panel discloses every vault, and its confirmation says what
that press will *not* move: one approval covers one vault, so a balance in the
other needs a second run and the screen says so before you press.

`sweep` is owner-only, consults no cap and no approved set, and neither does
`sell`. Un-approving a quote must never strand a position entered in it — that is
written into the contract and tested, not left as a convention. A sweep now
reports what **arrived** rather than what it asked for, so a token that returns
success and moves nothing is refused by name instead of booking a withdrawal that
never happened.
