# Live trading consent — what it is, and how to roll it out

## The defect this closes

An owner created an agent, picked **Paper trading** in the wizard, and said in
as many words that he had not given permission to trade real money. The product
disagreed with him.

`canTradeForReal` asked seven questions — armed, executor, chain, cash, gas,
policy, wall — and none of them was *"did the owner ask for this"*.
`paperTradingEnabled` could not answer it either: `execModeOf` consults it only
**after** `canTradeForReal` has already failed, so it grants permission to
*simulate* and a healthy rail never reaches it. `exec-mode.ts` said so itself:
*"paper is PERMISSION TO SIMULATE, not a request to, and it never moves a
working agent."*

Measured by executing the real functions, with gas sponsorship on as production
has it (`MERRYMEN_SPONSOR_GAS=true` plus a bundler key, both set on the
orchestrator):

```
mainnet + owner wants paper + funded 500 USDG  ->  {"mode":"live"}
```

Funding was the promotion. So was moving a grant to mainnet. So was the house
switching sponsorship on — one deploy variable that moved owners onto the live
rail without any of them doing anything.

## The four things, kept apart

| | what it decides | where it lives |
|---|---|---|
| **Network** | which chain the grant is for | the signature |
| **Funding** | whether there is money | the chain |
| **`paperTradingEnabled`** | when real execution is off, simulate or do nothing | Settings |
| **`liveTradingEnabled`** | **may real orders reach the chain** | Settings — **new** |

`liveTradingEnabled` is a **required term** of `canTradeForReal`, not a fallback
behind it. A fallback is routed around whenever the world improves; a term
cannot be. It defaults **false**, and it deliberately has **no environment
override** — `MERRYMEN_LIVE_TRADING=true` on the orchestrator would be the house
consenting to spend real money on behalf of every owner in the fleet at once.

It is **not** `!paperTradingEnabled`. They answer different questions, and
collapsing them would make *"stop showing me pretend fills"* mean *"start
spending my money"*.

### The matrix, as executed

| case | `canTradeForReal` | mode | the owner sees |
|---|---|---|---|
| mainnet + PAPER + funded | false | `paper/live-not-enabled` | PAPER · *Start live trading* |
| mainnet + LIVE + funded | true | `live` | LIVE |
| mainnet + PAPER + unfunded | false | `paper/live-not-enabled` | PAPER · *Start live trading* |
| testnet + LIVE + funded | false | `paper/wrong-chain` | BLOCKED · *Re-sign on Robinhood Chain* |
| testnet + PAPER | false | `paper/live-not-enabled` | PAPER · *Start live trading* |

`live-not-enabled` is a `RefuseRule` but is deliberately **absent from
`OWNER_ACTION`**, so practising renders PAPER rather than a red BLOCKED pill
with a signature attached. Nothing is wrong, so nothing asks to be fixed.

A paper verdict also carries **`wouldBlockLive`** — what *would* stop live,
measured with consent forced on so the answer is about the machinery rather
than circularly about the consent we already know is missing. The feed event
says it out loud, so an owner on a testnet grant learns that before they flip
the switch instead of after.

---

## Rollout — three deploys, in this order

> **The order is not optional.** `liveTradingEnabled` defaults false and
> `worker/src/settings.ts` resolves an *absent* field to the default. No tenant
> alive today has ever written this field. Deploying enforcement first would
> move every agent in the fleet to paper on its next tick — including the ones
> whose owners are watching them trade real funds, with no notice and nothing on
> screen to explain it. That is not a consent fix; it is a fleet outage wearing
> one.

> **On an already-migrated deployment, skip step 0 and never set it again.**
> Standing down has nobody left to protect once consent is recorded, and
> everybody to expose.

### 0. Stand down — ONLY on a deployment that has never run this migration

```
MERRYMEN_LIVE_INTENT_STAND_DOWN=1
```

This switches enforcement off so the fleet behaves exactly as it did before the
gate existed, for the length of the migration. It is a **separate variable from
the backfill on purpose.** It used to be implied by `=report`, which was correct
exactly once — while the field was absent fleet-wide. After the migration that
coupling inverts into a hazard: re-running the report to check a detail would
un-gate every tenant whose consent is now recorded, for the length of a
read-only question. **A dry run must not change behaviour.**

Remove it in the same session as step 3. It is the one variable here that can
put real money at risk, because while it is set, funding implies consent again
— which is the original defect.

### 1. Report

Deploy with:

```
MERRYMEN_BACKFILL_LIVE_INTENT=report
```

The orchestrator runs the plan on its first cohort pass, writes **nothing**, and
logs the exact list with a reason per tenant:

```
[live-intent] N tenant(s) would be granted live trading:
  GRANT 0x… — has-traded-for-real
  GRANT 0x… — explicitly-not-paper
[live-intent] M left on Paper (no evidence they ever asked for live)
[live-intent] K already carry the field, untouched
```

**Read this list.** It is the only chance to notice the migration is wrong
before it writes settings on other people's agents. Check in particular that
every agent you know to be trading real money appears under `GRANT`.

### 2. Apply

Redeploy with:

```
MERRYMEN_BACKFILL_LIVE_INTENT=apply
```

Same plan, then the writes. Confirm the log line:

```
[live-intent] APPLIED — N granted, K skipped
```

### 3. Remove the variables

Unset `MERRYMEN_BACKFILL_LIVE_INTENT` (and `MERRYMEN_LIVE_INTENT_STAND_DOWN` if
you set it) and redeploy. The backfill is idempotent — re-running it produces an
empty plan — but leaving a migration armed is how it fires again later against a
fleet it was not written for.

---

## What this migration counts as a real order — and what it does not

`TradeRow.status` (`worker/src/store.ts`) is five wide, and the line between the
middle two is drawn by `index.ts` as `status: onChain ? "reverted" : "rejected"`:

| status | meaning | consent? |
|---|---|---|
| `landed` | submitted, mined, succeeded | **yes** |
| `submitted` | in flight, not yet settled | **yes** |
| `reverted` | reached the chain and failed there — gas was spent | **yes** |
| `rejected` | never left the box; a pre-flight refusal | no |
| `paper` | the simulator | no |

`reverted` was **missed by the first apply** on 2026-09-13, which asked for
`('landed', 'submitted')` only. That reads an owner whose orders all reverted as
one who never traded — and an agent whose swaps keep reverting is precisely the
one whose owner is watching real gas burn for nothing. A failing live trader is
still a live trader. `backfill-live-intent.test.ts` now carries a drift guard
that fails if a sixth status is ever added to the ledger without being
classified here.

---

## What the backfill counts as consent already given

Two signals, both things the **owner did**:

1. **A real order reached the chain.** `trades.status` is written by the
   execution fork itself — the paper arm writes the literal `"paper"`, the live
   arm writes `"submitted"` then `"landed"`. A non-paper row is a transaction
   this account actually made, and an owner who watched that happen and carried
   on has consented in the only way that matters.
2. **The owner explicitly switched the simulator off.** `paperTradingEnabled:
   false` is what the old `go-live` wrote. It never gated anything, but it was
   an ask, and this is the first chance to honour it.

### What deliberately does **not** count

- **Having money.** Funding implying consent is the bug; reading a balance in
  the migration would rebuild it inside its own fix. The backfill's test suite
  fails if the query ever touches a balance.
- **Holding a mainnet grant.** Signing a permission is not asking to use it.
- **`paperTradingEnabled` merely being *absent*.** It defaults **true**, so
  absence is the state of every tenant who never touched it. Reading absence as
  a live request would grant the whole fleet consent nobody gave.

It **only ever grants** — nothing writes `false`. A tenant who already set the
field is left as they set it, and the apply re-reads each tenant immediately
before writing, so an owner who decided for themselves between the report and
the write is not overruled. An unreadable record is skipped and named rather
than counted as either answer, and one tenant's write failure does not abandon
the rest.

---

## Terminology

Three words, three meanings, no overlap. The product previously used
*"practice"* for both the 46630 network and simulated trading — the wallet
screen offered *"Move this key to practice (testnet 46630)"* while the wizard
offered *"Paper trading — practise with simulated funds"* — so an owner who
wanted the second could pick the first and end up with a key that can never
trade.

| word | means | never means |
|---|---|---|
| **Testnet** | chain 46630 | simulated trading |
| **Paper** | simulated fills at live prices, any chain | a network |
| **Live** | real orders, real money | a network |

Chain cards name networks (`Testnet (46630)`, `Robinhood Chain (4663)`). The
mode is a setting, and it lives in Settings.

---

## The re-sign loop, and why the banner now says CHECKING

`wrong-chain`'s button reads *"Re-sign on Robinhood Chain"* and called
`onScreen({kind:"grant"})`. `pathForScreen` flattens that to the string
`/grant`, and `screenForPath` re-hydrates it from `usePathname()` — which
carries no query — so no field on the descriptor could survive, and nothing went
red when one was dropped. The destination then pins its chain selector to the
grant being replaced, by design, so the prominent control read *"re-sign this
key (free)"* and sealed **another testnet grant**. An owner reported this as
*"I'm resigning but this banner keeps appearing."*

The intent now travels as `?chain=4663`, read at **both** of `Wallet.tsx`'s
mount arms — the localStorage one and the server-grant one that serves every
hosted Privy owner signed in from a browser that did not mint the agent. It only
pre-selects: the move stays an explicit tick, the mainnet acknowledgement stays
required, and an unrecognised value in the URL is ignored.

Separately, a corrected grant takes four hops to reach a screen — the
orchestrator's 15s ferry, the child's 240s tick, the 15s mirror, the browser's
60s poll: about **5.5 minutes**. For all of it the page asserted the old
blocker. `autonomyOf` now compares `grant.grantedAt` against `workerAliveAt`
(both unix seconds, both from the same `/api/grants` response) and renders
**CHECKING** when the blocker predates the signature.

That is not a suppression. It never says the agent is fine — only that we have
not heard since. One beat ends it, whatever the beat says, including *"still
wrong-chain"* for someone who re-signed onto the sandbox twice.
