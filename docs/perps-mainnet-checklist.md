# Perpetuals: the mainnet checklist (Rollout, Phase 0)

There is no Lighter on Robinhood testnet 46630, so the first live deposit, key
registration, order and withdrawal happen on mainnet 4663 with real money
(docs/perps.md, "Honest limits"). This file is what must be proven there, with
a small amount, **before live perps are switched on for anyone** — the
operator's own self-hosted install included. It is the Phase 0 gate of
docs/perps.md's Rollout; Phase 2 (signers offer the opt-in, live for the
tenants in `MERRYMEN_PERPS_LIVE_TENANTS`) does not start while any item below is
open.

Every item says why it is here, the exact probe, what to record, what result
lets live go ahead, and what stays switched off if it does not. The code is
built to fail closed on each of them already — an item that fails leaves
something refused, never something unprotected — but "fails closed" is not
"works", and a venue whose behaviour was guessed is not one to hold other
people's leverage on.

Sources: the contract's Rollout list; the signer spike's "UNVERIFIED — needs a
mainnet dust test before live opens"; the review amendments
`venue-stop-semantics` and `venue-stop-expiry-and-price-band`. Nothing here is
run by CI.

## Setup

- **Account.** A fresh agent smart account on 4663 whose owner key the
  operator holds in a browser-key wallet (never a Privy login: the recover
  drill needs the owner key). Fund it with about 60 USDG and a little ETH for
  gas. Nothing in this list needs more.
- **Worker.** Self-hosted, from the commit under test, with
  `MERRYMEN_PERPS=live` (the self-hosted default), live trading on, the
  real-money consent given, and a grant re-signed with the perpetuals opt-in
  (`perp-lighter-v1`). Settings: `perpsMarkets ["BTC-PERP"]`,
  `perpsMaxLeverage 2`, `perpsPerTradeUsdg 25`, `perpsMaxOpenNotionalUsdg 50`,
  `perpsMaxCollateralUsdg 30`, `perpsStopLossPct 5`, `perpsStopSlipBps 200`,
  `perpsDriver manual` (owner orders only — no strategy opens anything during
  the probes).
- **Before anything.** `merrymen doctor` must print that both signer files
  match their pinned hashes and the known-answer test passes. If it does not,
  stop: nothing below can be signed.
- **Reads.** Public: `https://api.rh.lighter.xyz/api/v1/…` (`orderBookDetails`,
  `accountsByL1Address`, `account?by=index`, `tx?by=hash`, `withdrawalDelay`,
  `fundings`). Authenticated (the worker's auth token, never pasted anywhere):
  `accountActiveOrders`, `accountInactiveOrders`, `positionFunding`, `trades`.
  Chain: `eth_call` on the ZkLighter proxy `0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d`
  (`addressToAccountIndex`, `getPendingBalance`) and the explorer for receipts.
- **Recording.** Fill the Result line of each item with the date, who ran it,
  the tx hashes and the numbers asked for. A result without evidence is not a
  result.

---

## A · The signer where it will run

### A1 · WASM memory and latency in a hosted child

**Why.** The signer is a 13.96 MB Go WASM loaded in each child that holds a
live key. A child that runs out of memory, or signs too slowly for the
protective loop's 15 s clock, leaves positions without their exits.

**Probe.** On the production image (Railway, `node:22-slim`), in an
orchestrator child armed with a perps grant: record the child's RSS before and
after `instantiateSigner` and the known-answer test; time 20 signatures each of
CreateOrder, CreateGroupedOrders (OTO) and CancelAllOrders; repeat with four
armed children at once.

**Passes when.** The known-answer test passes in the image; RSS growth per
child and the slowest signature leave clear headroom under the child's memory
limit and far inside 15 s. Write the numbers into docs/hosted-deploy.md.

**If it fails.** Hosted live perps stay off (Phase 2 does not start). The
signer is lazy, so paper children are unaffected.

**Result.** _not run_

---

## B · Onboarding: deposit, account, key

### B1 · Deposit → account index → collateral credited

**Why.** The Lighter account is created by the first deposit and keyed on
`_to`. Everything after it — the account index, the key, every order — rests
on that one leg going through the session key's wall.

**Probe.** Let the worker's onboarding deposit 20 USDG: `USDG.approve(proxy, a)`
then `deposit(self, 3, 0, a)`, both through the session key (never the owner
key). Then poll `addressToAccountIndex(self)` and
`accountsByL1Address?l1_address=<self>` until non-zero, and
`account?by=index&value=<idx>` until the collateral shows.

**Record.** UserOp and tx hash; seconds from receipt to account index; seconds
to collateral credited; the `Deposit` log's topic and fields; how the
classifier booked the leg (it must be `venue-margin`, never capital).

**Passes when.** The deposit lands through the wall, the account index
appears, credited collateral equals the deposit to the micro, the `Deposit`
topic equals the one pinned in `LIGHTER_ROUTE_V1`, and equity does not move
across the leg.

**If it fails.** No live onboarding. A deposit the wall refused means the
wall's pins are wrong: do not relax them; re-derive them.

**Result.** _not run_

### B2 · Key registration, the 21126 ordering, time to usable

**Why.** `changePubKey` cannot run while the account's cross collateral is
zero (venue error 21126). The onboarding order — deposit, index, then key —
assumes that; the recover drill (H2) depends on it too.

**Probe.** (a) On a second fresh account, before any deposit, submit the
wall's `changePubKey(idx?, 16, 0x60, 40, w4, w5)` and record exactly what
happens: an L1 revert, an accepted priority request that the rollup rejects,
or nothing. (b) On the B1 account, after the collateral is credited, let
onboarding register the sealed key; poll the account's API keys until key
index 16 shows the sealed public key, then time the first authenticated read
and the first accepted nonce.

**Passes when.** A registration at zero collateral fails with no side effect
the worker cannot see and retry; after the deposit, index 16 holds exactly the
sealed key; time from the registration receipt to the first usable nonce is
recorded for the dashboard's onboarding copy.

**If it fails.** No live onboarding; if (a) leaves a pending priority request
that later lands, onboarding must wait for it before anything else and this
item is re-run.

**Result.** _not run_

---

## C · Orders

For every order: the `tx?by=hash` status sequence (1 → 2–5, or 0), the
client order indexes the worker persisted, and what `accountActiveOrders` /
`accountInactiveOrders` show afterwards.

### C1 · A minimum BTC open as OTO

**Why.** An open is one grouped transaction (tx 28): OTO `[IOC entry, SL
child]`. The spike saw position-tied orders on this instance but never a tx 28
itself.

**Probe.** First the leverage: `UpdateLeverage(1, 5000, isolated)` on the flat
market, then `account?by=index` must read BTC isolated at IMF 5000. Then an
owner open, long BTC-PERP, at the effective minimum
(`max(10 USDG, min_base × price)`, about 17 USDG on 2026-09-29).

**Record.** Leverage tx and read-back; the tx 28 hash and status; the entry
fill (base, price); the SL child's order index, base, trigger, price and
`OrderExpiry` as the venue reports them; the time from send to the child
showing active.

**Passes when.** tx 28 is accepted; the child exists, is reduce-only, and its
base equals the EXECUTED parent base; the dashboard shows the position as
protected only once the child is seen resting.

**If it fails.** No live opens. A tx 28 the venue refuses means a different
open shape, which is a contract change, not a setting.

**Result.** _not run_

### C2 · OTOCO, and the sibling when one child fires

**Probe.** Set `perpsTakeProfitPct` and repeat C1 as OTOCO `[entry, SL, TP]`.
Then close the position through one child: place the take close to the mark so
it fires.

**Record.** Both children as in C1; after the take fills, the stop's status.

**Passes when.** Both children are created reduce-only at the executed base,
and when one fires the other is cancelled by the venue (OCO), leaving nothing
resting.

**If it fails.** Owner and strategist take-profits stay off (`perp-trend`
never uses one); OTO only.

**Result.** _not run_

### C3 · The IOC parent fills nothing

**Probe.** An OTO whose entry's worst price is far from the book (a buy at
0.9 × mark), so the IOC cannot fill.

**Record.** Whether the SL child is never created, created and cancelled, or
left resting.

**Passes when.** No child is left resting against a position that does not
exist.

**If it fails.** Live opens wait until the reconciler's cleanup (CancelAllOrders
for the market when it reads flat) is shown to remove the orphan before
anything else is sent there.

**Result.** _not run_

### C4 · Minimums on IOC and trigger orders

**Why.** The effective minimum is computed from `min_base_amount` and
`min_quote_amount`; whether the venue applies them to IOC and trigger orders
too is not known.

**Probe.** (a) An IOC open at 9 USDG notional; (b) an IOC at the effective
minimum less one base tick; (c) C1's child at the minimum parent size.

**Record.** Accept or reject, with the venue code, for each.

**Passes when.** The venue refuses exactly what `perp-below-min` refuses, and
never refuses a stop child whose parent met the minimum.

**If it fails.** Raise the effective minimum in core to what the venue
enforces (never lower a cap to reach it), and re-run C1.

**Result.** _not run_

### C5 · A leftover stop when another reduce-only order closes the position

**Probe.** With C1's position and its SL child resting, close it with an owner
`/close` (a reduce-only IOC for the full venue size).

**Record.** The SL child's status straight after the close, and 60 s later.

**Passes when.** Either the venue cancels the child, or the worker's
zero-position CancelAllOrders for that market does — seen, not assumed — before
any new open there is signed.

**If it fails.** Live opens stay off until the cleanup is fixed: a stop left
resting on a flat market is an order nobody meant.

**Result.** _not run_

---

## D · The venue stop

### D1 · The fat-finger band: at placement or at trigger?

**Why.** The single most important unknown for rule 7. The venue refuses a
stop whose price is more than 5% through its trigger (21733/21735). If it also
measures the band against the book at placement, a stop more than about 4.5%
from the mark can never be placed, and every open with a wider stop is
refused.

**Probe.** On an open BTC long: (a) a standalone STOP_LOSS with trigger 8%
below mark and price 2% below the trigger; (b) one with price 6% below its
trigger.

**Record.** Accept or reject, with codes, for both.

**Passes when.** (a) is accepted and (b) is refused. Then the band is judged
at trigger and `perpsStopLossPct` up to 25 stands.

**If it fails.** If (a) is refused, the band is judged at placement: cap
`perpsStopLossPct` at the largest value (a) accepts, in core settings, the PUT
and the dashboard copy together, and re-run. Until then the open is refused
whenever its stop is refused (already the case), which leaves `perp-trend`
mostly idle rather than unprotected.

**Result.** _not run_

### D2 · Stop expiry bounds

**Probe.** Standalone stops with `OrderExpiry` of now + 4 min, now + 6 min,
now + 28 days (the value the worker uses) and now + 30 days + 1 h.

**Passes when.** 4 min and 30 days + 1 h are refused; 6 min and 28 days are
accepted. The signer does not enforce the 30-day cap; the worker's constant
does, so the refusal must come from the venue, not from us.

**If it fails.** Change the worker's constant to what the venue accepts, and
make protect.ts re-place early enough that no stop lapses.

**Result.** _not run_

### D3 · A standalone, position-tied stop

**Why.** protect.ts re-places a missing, wrong or expiring stop with a single
CreateOrder STOP_LOSS, `BaseAmount 0`, `ReduceOnly 1`. An OCO needs a TP
sibling, so this single form must work on its own.

**Probe.** Cancel C1's child, let protect.ts notice (P3), and watch it place
the standalone stop. Then close the position and watch the stop.

**Record.** The stop's order, its base as the venue reports it (tied to the
position or fixed), and its status after the position reaches zero.

**Passes when.** It is accepted, it follows the position, and it ends (or the
cleanup of C5 ends it) when the position is flat.

**If it fails.** No live opens: a position whose stop cannot be put back has
only the venue's liquidation behind it.

**Result.** _not run_

### D4 · A triggered stop's unfilled remainder

**Probe.** On a dust position, a stop whose trigger sits just beyond the mark
so it fires, with a tight execution price.

**Record.** The fill, and whether the remainder ends as status 9, 10 or 12, or
stays open. Record the mark at the moment it fired (orderBookDetails) to
confirm stops trigger on mark.

**Passes when.** A triggered stop that could not fill in full ends rather than
resting, and protect.ts treats "ended without closing the position" as a
missing stop (it re-places, or closes as a risk exit).

**Result.** _not run_

---

## E · Transactions, nonces and limits

### E1 · Is a sent transaction visible at once?

**Probe.** Send an order and read `tx?by=hash` immediately, then every 200 ms.

**Record.** How long `21500 not-found` is returned after the send was accepted.

**Passes when.** It turns visible well inside `ExpiredAt`; rule 9 already
never writes a row off as expired before `ExpiredAt + 120 s` with a measured
clock skew under 5 s, and this item shows that margin is real.

**Result.** _not run_

### E2 · Server-side `ExpiredAt` bounds

**Probe.** With the signer's clock frozen (the known-answer technique), sign
orders whose `ExpiredAt` is now + 60 s, the default now + 599 s, and 30 s in
the past.

**Passes when.** The past one is refused and the default accepted. Whether
60 s is accepted is recorded only: a shorter window for closes would be an
improvement, never a requirement.

**Result.** _not run_

### E3 · A later nonce kills the earlier one

**Probe.** Sign two cancels on the same key with nonces N and N + 1; send N + 1,
then N.

**Passes when.** N is refused. That is the whole of rule 9's replay model
(a close may be re-signed while the earlier one is ambiguous because the new
one, once executed, makes the old one dead).

**If it fails.** No live anything: the persistence model is wrong.

**Result.** _not run_

### E4 · Rate limits from the hosted egress

**Why.** Standard accounts get 60 requests a minute per IP and per L1 address,
`sendTx` inside them, signalled by HTTP 429 or 405 with no headers. Whether
`sendTx` from the hosted egress counts per IP (shared by every tenant) or per
L1 address decides whether one tenant can starve another's exits.

**Probe.** From the production egress, two dust accounts (two L1 addresses):
drive authenticated reads and `sendTx` from one past 60 a minute while the
other sends one order.

**Record.** Which requests got 429 or 405, and for which address.

**Passes when.** Limits are per L1 address for authenticated requests and
`sendTx`, so the per-address budget with 20 a minute kept for exits holds.

**If it fails.** Hosted live perps stay allowlisted to a handful of tenants
until a fleet-wide budget with an exits reserve exists (Phase 3's written
decision covers the egress question too).

**Result.** _not run_

---

## F · Funding

### F1 · The sign of funding

**Why.** The spike never saw a negative rate, so which side pays one, and the
sign `positionFunding` reports, are unproven. The paper engine books a charge
on the documented rule and never a gain on a guess.

**Probe.** Hold C1's position across two hour boundaries. Compare each
`positionFunding` row (sign, direction, value) to the hour's `fundings` rate
and direction, and to `fundingPaymentMicro`'s result for the same size.

**Passes when.** Every row matches to the micro, in sign and size. If a
negative rate occurs during the checklist, record that hour separately.

**If it fails.** Fix the parser and the paper engine to what the venue does
before live; until then live funding is booked as unread, which already holds
ratchets and fees.

**Result.** _not run_

---

## G · Money coming home

### G1 · Secure withdrawal and claim latency

**Probe.** Request an L2 withdrawal of 5 USDG of free collateral. Read
`withdrawalDelay` at the moment of the request. Poll `getPendingBalance(self,
3)` until it holds the amount; then watch for Lighter's relayer calling
`withdrawPendingBalance(self, 3, amount)` (a `WithdrawPending(self, 3, amount)`
log in a transaction we did not send). If it has not come within an hour, let
the worker claim through the wall.

**Record.** The quoted delay; seconds to pending; who claimed and when; the
receipt; how payouts.ts classified the payout (venue-margin, never capital)
and that equity's ratchets held while the money was in transit.

**Passes when.** The money reaches the agent's smart account and nowhere else,
every step is booked once, and the observed delay is inside what the
dashboard and README say (minutes; 626–1314 s was seen when the contract was
written).

**Result.** _not run_

---

## H · Drills

### H1 · Kill drill

**Probe.** With an open BTC position, its resting stop and free collateral:
`merrymen kill` (self-hosted). Repeat with the implemented hosted stand-down
through the dashboard's "discard & start over" on an allowlisted hosted
tenant.

**Record.** The `standdown-result` file: which positions closed (reduce-only
IOC within `max(perpsMaxSlippageBps, 150)` of mark, at most three attempts),
that each stop was cancelled only after its market read flat, the withdrawal
requested, and the owner's message word for word. Then the claim, as in G1.

**Passes when.** The venue agrees with the result; no stop was removed while
its position was open; the message names what is left and never says the
funds are in the smart account while anything is at Lighter.

**If it fails.** No live perps: a kill that strands leverage is the failure
rule 13 exists to prevent.

**Result.** _not run_

### H2 · Recover drill (owner key, no worker)

**Why.** The owner's escape hatch with the worker gone: priority requests from
the smart account itself, in one sudo UserOp.

**Probe.** Stop the worker. With an open position and collateral, run the
recover venue leg: `cancelAllOrders(idx)`, `changePubKey(idx, 16,
<fresh throwaway key>)`, `withdraw(idx, 3, 0, free)`; after the delay,
`withdrawPendingBalance(self, 3, amount)`. Run it twice: once with free cross
collateral, once with every USDG in isolated margin (cross collateral zero —
the 21126 case of B2).

**Record.** Each request's outcome; that an order signed with the old key is
now refused; the withdrawal paid; what the worker reports when started again
(it must see a key it did not seal at index 16 and refuse opens).

**Record, separately: does Lighter accept a canonical key that does NOT decode
to a curve point?** recover's throwaway is sampled to decode
(worker/src/recover.ts `ecgfp5Decodes`), so the drill above cannot answer this
by chance. Answer it on purpose, on the operator account, with nothing open:
one `changePubKey` alone to a canonical key `ecgfp5Decodes` rejects, then read
index 16. Write down whether it landed. Until this is recorded, the throwaway
stays decode-sampled — the unwind sends the key change beside the withdrawal
of all free cross collateral, and a refused key change beside a landed
withdrawal leaves cross collateral at 0, where 21126 blocks every later key
change.

**Passes when.** Orders are cancelled, the agent's key is revoked, free
collateral comes home, and the order of the batch that works with zero cross
collateral is the one recover uses.

**If it fails.** No live perps for anyone whose recover path this is; the
README's recover paragraph is corrected first.

**Result.** _not run_

### H3 · On-chain `createOrder` semantics

**Why.** The owner's L1 `createOrder(uint48, uint16, uint48, uint32, uint8,
uint8)` has no reduce-only flag and executes later, as a priority request. If
a resting stop fires first, a "close" sent this way could open a new,
unmanaged position of the same size.

**Probe.** With a dust long open, send an L1 `createOrder` selling the
position's size. Then, with the position already closed, send the same again.

**Record.** What each does to the position.

**Passes when.** Only if the second one provably cannot open a position may
recover offer on-chain closes.

**If it fails.** Recover never closes positions on chain — the contract's
default. It cancels, revokes the key and withdraws free collateral, and says
that open positions keep their stops until closed from the web or the CLI.

**Result.** _not run_

---

## After the checklist

| when every item above passes | what may switch on |
|---|---|
| A1–H3 all passed, results recorded here | live perps on the operator's own self-hosted install |
| and the fleet feed, the canonical-wall allowlist and paper perps have run hosted (Phase 1) and both mobile apps show the perps banner | Phase 2: signers offer the opt-in; hosted live only for `MERRYMEN_PERPS_LIVE_TENANTS` |
| and the written decisions in docs/perps.md "Decisions that need Milla" exist, and hosted children no longer share an OS user | Phase 3: general availability |

A later venue upgrade, a new signer release or a changed market table re-opens
the items it could affect; Lighter's contracts can be upgraded with no
effective notice, so re-run B1, C1, D1 and G1 after any upgrade you learn of.
