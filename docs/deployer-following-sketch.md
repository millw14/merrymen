# Following a deployer — a sketch, not a plan

## What was asked for

From the beta group, alongside the asset-mode request:

> "if someone want to build a strategy on pons tokens or long tokens or stocks
> only, you should have a step by step setting that let you choose the baske and
> also **add adresses and deployer adresses where the agent look and decide**
> based on your strategy and parameters collected by chatting with the agent"

The "add addresses" half shipped — Settings and the create wizard both take a
contract address now, and a coin named in the wizard is sealed into the first
signature. This is the other half: naming a **launcher** rather than a token, so
the agent considers whatever they launch next.

**Not built.** This is the shape and the cost, so the decision can be made on
evidence rather than on enthusiasm.

---

## The good news: the data already exists and is thrown away

`worker/src/venues/pons.ts` watches the launch event, and its header records
that the field order was established by probing a real launch:

> "topic1 answers `symbol()` as an ERC-20, topic2 answers `token()` pointing
> back at topic1 AND `getReserves()` — so it is the curve — and **topic3 answers
> neither, so it is the creator**."

It is decoded (`pons.ts:158`, `creator: addressFromTopic(log.topics[3]!)`) into
the `PonsLaunch` object, and then goes nowhere: `creator` appears **zero times**
in `worker/src/index.ts`, and `discovered_pools` has no column for it.

A second, independent source exists too — `worker/src/venues/pons-meta.ts` reads
a `deployer` from the launchpad template's metadata getter. **These two can
disagree**, and which one is authoritative is an open question this sketch does
not answer. The event's `creator` is the cheaper and harder-to-forge of the two
(it is a log topic, not a self-declared metadata field), so it is the one to
build on.

---

## The bad news, and it is the important half

`worker/src/venues/pons-activity.ts` has **already measured this signal**,
against the real outcome — a curve selling out, which happens to 1.57% of
launches:

```
>= 25 trades in the first 180s   keeps 12.6%, holds 96% of graduations   7.6x
>= 100 trades in the first 180s  keeps  4.4%                            16.9x
>= 3 distinct buyers at 60s      keeps 40.6%, holds 100% of graduations
zero trades at 60s               kills 19.3% at no cost to recall
```

> "And the ones that sound good and are not: a dev buy in the launch transaction
> (1.1x), having socials (1.0x), **the creator's launch history (1.3x)**.
> …TRADING is the signal; everything else is decoration."

**1.3x, against 7.6x–16.9x for early trading.** That is the single most
important fact in this document, and it was measured here, on this launchpad.

It does not kill the feature, because it measures a different thing: a
*generic* "this creator has launched before" score, not "this specific owner
deliberately chose to follow this specific launcher." An owner following someone
they know from elsewhere is expressing information the scorer does not have.

But it does change what the feature is **for**. This is a *discovery source*,
not an edge — a way for an owner to point the agent at a stream they care about,
with the same budgets and gates binding afterwards. It should be built and
described that way, and it should never be presented as a signal that improves
outcomes, because the measurement we have says it does not.

---

## Shape, if built

**1. Persist the creator.** One `ALTER TABLE discovered_pools ADD COLUMN creator
TEXT`, following twelve existing precedents in `store.ts` (`decimals`,
`liquidity_usd`, `curve`, `quote_token`, `graduation_threshold`, …). It must use
the same `COALESCE(excluded.x, x)` device the pool-key and curve columns use, and
for the same stated reason: a re-sighting that lacks the field — the gateway
path, an older worker, the other discoverer — must never blank one already
captured.

**2. Thread it.** `pons.ts` already decodes it; `index.ts` passes a
`PoolCandidate` to `recordCandidate`. One field, one hop.

**3. A settings list.** `followedDeployers?: string[]`, validated as addresses,
tenant-settable, in the PUT allowlist (a field missing there is *"silently
dropped while the PUT returns {ok:true}"*), and in `strategyKey` or it is inert.

**4. One filter, at the two consumers that already read `recentCandidates`** —
`proposeClassEntries` and `trenchCandidates`. Not a third selection mechanism:
`index.ts` already warns that its two basket filters must agree, and this must
not become a third thing that can drift.

**5. It is not permission, and the copy must say so.** The wall still refuses any
asset the signature does not name, the scout budget still bounds unpriceable
buys, the per-trade cap still holds, and the asset mode still applies. Following
a deployer means "consider these", never "buy these".

---

## What makes it harder than it looks

**A deployer is a pseudonym, not an identity.** Anyone can launch from a fresh
address. A launcher an owner follows can rotate addresses between launches and
the follow silently stops matching — no error, no event, just nothing arriving.
Worse in the other direction: an address with one hit and fifty rugs is
indistinguishable at the address level from one with fifty hits.

**Absent is not "not by them".** Every row in `discovered_pools` today has no
creator, so on the day this ships a follow list matches nothing until new
launches arrive. Backfilling means re-scanning historical launch logs. Until
then the screen must say "watching from now on" rather than showing an empty
result that reads as "this deployer has launched nothing".

**The prune will eat the history.** `pruneDiscovered` trims to the 5,000 newest
rows and the launchpad adds roughly ten an hour — about 21 days to full
turnover, against a 14-day grant. A "show me what this deployer has launched"
view built on this table is a 21-day window, not a history, and saying otherwise
would repeat the mistake `knownCurves()`'s comment already records.

**Following is a targeting primitive.** An owner can be told to follow an
address by someone who benefits from them buying it. Everything downstream still
binds — that is the point of the wall — but the feature does make "paste this
address" a more effective thing for a stranger to say, and the copy should not
make it feel endorsed.

---

## Cost

Roughly a day, most of it not in the filter:

| | |
|---|---|
| column + migration + `COALESCE` | small, twelve precedents |
| thread `creator` through `recordCandidate` | small |
| settings field: core, worker, PUT branch, `strategyKey`, UI | the usual five stations |
| the filter at two consumers | small |
| backfill scan of historical launch logs | **the real cost**, and optional |
| copy that does not oversell a 1.3x signal | small, and the part most likely to be got wrong |

---

## Recommendation

**Do not build it next.** Not because it is hard, but because the repo has
already measured the signal underneath it at 1.3x and written down that trading
activity is what works. Shipping a discovery source that owners will reasonably
read as an edge, immediately after telling several of them their agents were not
trading for reasons nobody explained, spends trust on the weakest thing in the
backlog.

If it is built, build it as what it is — a stream an owner may point at, with
every existing gate intact and copy that says following is not endorsement — and
put the backfill behind a flag so the first version is cheap.

The stronger version of what was actually asked for is already shipping: name a
coin in the wizard and it is covered by the first signature, with no re-sign and
no `no-exit` refusal. That removes the pain the deployer request was reaching
past.
