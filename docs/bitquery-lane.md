# The Bitquery lane: flow facts from one budgeted process

The orchestrator holds the fleet's paid Bitquery key and answers flow
questions about Robinhood Chain coins from it. Nothing else holds the key: no
tenant child, no Brain service and no web process. A child that wants flow
facts asks the orchestrator over IPC.

A reading covers one coin:

- DEX buys and sells over the trailing 5, 15 and 60 minutes: USD in each
  direction (from the quote leg of each trade), the number of transactions
  with a buy or a sell, and distinct buying and selling addresses.
- The venue (protocol) split over the hour.
- The largest single sells in the hour, as sizes and times only. No wallet or
  hash is included.
- Whether the coin's launcher sold on a DEX, or moved tokens out at all, in
  the last hour. "Launcher" is the address the Pons factory's own launch event
  recorded for the coin. This is `not-derivable` when the factory has no
  launch record for it.

A reading is an indexer's record. It is not a price, a forecast or a reason to
trade. It never reaches equity, P&L, sizing, a cap, a guard or a grant.
Distinct addresses are not proven distinct people. A `null` means unknown and
is never read as zero.

The lane also has a third query, Uniswap v3 pools created for a token. It is
meant as a later source for the early book and nothing calls it yet.

## Rollout

1. **Check the query shapes before setting the key.** The three queries are in
   `worker/src/venues/bitquery-lane.ts`: `TOKEN_FLOW_QUERY`,
   `CREATOR_FLOW_QUERY` and `V3_POOLS_QUERY`. They were written from Bitquery's
   Robinhood Chain and Trading API documentation and have only been tested
   against recorded-shape fixtures. Run each one in the Bitquery IDE with the
   plan's key, using a busy Robinhood token and a 60-minute window, and
   confirm these things:
   - the `Trading` cube accepts `count(distinct: …, if: …)` and a
     `Block.Time` condition inside `if:`, for both `Trader_Address` and
     `TransactionHeader_Hash`;
   - `sum(of: AmountsInUsd_Quote, …)` and
     `orderBy: {descending: AmountsInUsd_Quote}` are accepted, and one
     largest sell's quote-side USD matches the explorer's swap to within a few
     percent. Bitquery documents `AmountsInUsd_Base` as riding a smoothed
     reference price, so no figure here uses it;
   - a buy count is a count of transactions, not rows: pick a transaction
     with a multi-hop swap and check it counts once;
   - `Side: "Buy"` really is a trader buying the coin (compare one trade with
     the explorer);
   - the two-root creator query (`Trading` plus `EVM`) is accepted.

   If a shape is wrong, the lane logs the provider's reason once (scrubbed of
   addresses and keys) and answers `invalid-body` or `invalid-shape`. It never
   reports a wrong shape as no trades.
2. **Set `MERRYMEN_BITQUERY_API_KEY` on the orchestrator only.** Do not set it
   on `web`, on the Brain service, or under the names `BITQUERY_API_KEY` or
   `MERRYMEN_TOKEN`. `CHILD_SECRET_STRIP` removes all three names from every
   child. A copy on any other service is an extra credential for no purpose.
3. **Know that the gateway now spends too, and set its cap.** The same change
   fixed the worker's gateway header (below), so holders' discovery polls now
   reach the gateway's `MERRYMEN_GATEWAY_BITQUERY_KEY` instead of failing with
   401 for free. Each holder costs roughly 720 points a day at the default
   10-minute interval, and up to ten times that at 1 minute. The gateway caps
   all of them, plus its public memescope, with
   `MERRYMEN_GATEWAY_BITQUERY_POINTS_PER_DAY` (default `12500`), in two
   purses: the public memescope spends only its own 80% (10,000 a day; it
   refreshes at most every 45 s, matching the Markets page's own 45 s poll,
   which is at most 9,605 points a day, so it never runs out; a failed
   refresh waits out the same 45 s, so an outage cannot spend it either), and
   holders the other
   2,500, which the page can never spend, and at most 750 of them for any one
   holder (enough for the default interval all day; past it that wallet alone
   gets 429 until 00:00 UTC, so one holder at a 1-minute interval cannot
   starve the rest). The holders' purse covers three holders at the default
   interval all day. A gateway cap below about 12,000 leaves the memescope
   short of its 45 s day, and the page then serves its last rows until
   00:00 UTC. The gateway's cap and this lane's `MERRYMEN_BITQUERY_POINTS_PER_DAY`
   (default 25,000) are separate counters, and neither sees the other's
   spend: if the gateway's key is on the same plan as this lane, the operator
   sizes both to the plan, or puts the gateway on a plan of its own. Deploy
   the gateway with its cap before, or with, the worker.
4. **Read the boot line.** The orchestrator logs one of the following:
   - `bitquery lane: on — 25000 points/UTC day (20000 for child evidence), 60 requests/min, 3 at once`
   - `bitquery lane: off — …`, with the reason.
5. **Turn on child evidence by account.** Children may ask only if their smart
   account is listed in `MERRYMEN_DECISION_RESEARCH_ACCOUNTS`, the same
   allowlist that decision research already uses (see
   [`decision-research.md`](decision-research.md)). Add an account to it in the
   orchestrator's deploy environment, never in this repository: which agent's
   smart account is on the list is operator configuration, not documentation.
   The allowlist is checked on every request, so a change applies without a
   respawn. Deploy the Brain service from the same commit: the review sends
   the flow block only once its `/health` lists `onchain-flow`.
6. **Reconcile after a day.** Compare Bitquery's usage page with the lane's
   own counter (table `spend` in `<fleet home>/bitquery-lane/lane.sqlite`, with
   columns `points`, `calls` and `refused` per UTC day) plus the gateway's.
   If the real cost per call is higher than estimated, lower
   `MERRYMEN_BITQUERY_POINTS_PER_DAY` or the gateway's cap. Do not raise the
   per-query estimates in place of that.

To stop spending without removing the key, set `MERRYMEN_BITQUERY_LANE=0` and
redeploy. Every flow question then answers `unavailable`.

## Knobs (orchestrator)

| Var | Default | Meaning |
|---|---|---|
| `MERRYMEN_BITQUERY_API_KEY` | unset (lane off) | The plan's key. An `ory_at_…` V2 token is sent as `Authorization: Bearer`; anything else is sent as `X-API-KEY`. **Orchestrator only.** |
| `MERRYMEN_BITQUERY_LANE` | on when a key is set | `0` turns the lane off while keeping the key. |
| `MERRYMEN_BITQUERY_POINTS_PER_DAY` | `25000` (ceiling `100000`) | Points reserved per UTC day across every caller of this lane. 25,000 × 30 = 750,000. The gateway counts its own spend separately under `MERRYMEN_GATEWAY_BITQUERY_POINTS_PER_DAY` (default 12,500 a day: 10,000 for the public memescope at its 45 s refresh, 2,500 for holders); when both keys are on one plan, the operator sizes both to it. Child evidence may use at most 80% of it, so X answers are never starved. |
| `MERRYMEN_BITQUERY_RPM` | `60` (ceiling `90`) | Requests started per rolling minute. The plan allows 90. |

A knob that is not a positive whole number is logged by its length, never
echoed, and its default applies. A value above the ceiling is clamped, and the
boot line says so. Concurrency is fixed at 3 of the plan's 6, which leaves room
for the gateway and the IDE.

## How spending is bounded

| Query | Points reserved | Cached for |
|---|---|---|
| token flow (3 cubes) | 15 | 60 s |
| creator flow (2 cubes) | 10 | 120 s |
| v3 pools (1 cube) | 5 | 300 s |

- **Points are reserved before each call.** The reservation is atomic, in
  SQLite under the fleet home, against the UTC day. A crash between the
  reservation and the request can overstate spend but never understate it.
  When the counter cannot be read or written, the call is refused.
- **Evidence is counted on its own spend.** The day keeps two counts: every
  point (`spend.points`) and child evidence's (`spend.evidence_points`).
  Evidence fits only while its own count stays inside its 80% share and the
  day's total inside the day; an answer only the second. So what answers
  spend never comes out of evidence's share. A lane file from before this
  column counts all of each day it kept as evidence, which overstates that
  day's evidence and never understates it.
- **Failed requests keep their reservation**, because the provider may bill
  them. Bitquery documents realtime queries at a flat 5 points per cube. The
  Trading cube's price is not documented, so it is assumed to be the same.
- **One cache serves the fleet**, keyed by query and token. A cache hit keeps
  the time the answer was observed. Concurrent identical questions share one
  request, one way only: child evidence may join a request made for the
  orchestrator's own answer, but an answer never joins an evidence request, so
  a refusal at the evidence share never becomes an answer's refusal.
- **No request goes out without time to answer.** A caller waits at most 8 s
  for a rate turn or a slot, and only while the request would still get 3 s of
  its deadline. Otherwise it is answered `timeout` or `budget` with nothing
  reserved and nothing sent.
- **One reading has one deadline.** `flowFor` gives the flow query, the
  launcher lookup and the launcher's query 18 s together, under the broker's
  22 s ceiling, or less when the caller waits less. A child's request carries
  how long it waits (`timeoutMs`), and the orchestrator works on it for that
  less a quarter-second for the trip back (`ipcMarginMs`), never more than
  its ceiling, so nothing is still being sent or paid for after the child has
  given up. Short of time, the flow facts come back with the launcher
  `unavailable` rather than late.
- **Provider refusals back off the whole lane:**
  - `429` backs off on a ladder from 1 to 15 minutes, or for `Retry-After` if
    that is longer. `402` holds off for an hour. Both are persisted, so a
    restart does not hammer the provider.
  - `401` or `403` holds off for 15 minutes in memory only, so a corrected key
    arriving by redeploy is used at once.
  - Any other failure of one query is not retried for 15 s.
- **Each child is rate-limited separately.** A child gets 6 new questions a
  minute and 2 at once. A repeat of a question already in flight is free.
- **Every path ends in an answer or a failure word**: `unavailable`, `budget`,
  `provider-cooldown`, `timeout`, `network`, `invalid-body`, `invalid-shape`,
  `invalid-request` or `http-NNN`. The orchestrator's ceiling on one child
  answer is 22 s, and the child waits at most 25 s. Nothing throws, and no
  tick waits on the lane.

## Who can ask what

- **The orchestrator's own answers** call `flowFor(token)` and spend from the
  whole day. It lives in `worker/src/orchestrator-flow.ts`, and
  `orchestrator.ts` re-exports it. A pass such as `orchestrator-xpost.ts`
  should import it from `orchestrator-flow.ts`, which avoids an import cycle.
- **Flow facts reach X only as bands, never as figures.** An X post carries no
  number ([`x-posting.md`](x-posting.md) rule 2): the writer's `clean()` drops
  any fact with a digit, and the gate refuses a numeral or a quantity word. So
  for X replies, `flowXLines(result, seed)` (`worker/src/flow-facts.ts`)
  returns fixed, attributed glosses from a closed vocabulary, such as "on-chain
  data shows sells clearly outweighing buys over the last hour" or "per
  on-chain data, the buying over the last hour came from only a small group of
  addresses". Pass a seed such as `${tenant}|${token}` so two accounts are not
  handed the same words. Every gloss is pinned to pass the existing writer and
  X gate unchanged (`orchestrator-flow.test.ts`). **Do not change the writer
  or the gate to admit flow figures**; new wording goes into `FLOW_X_GLOSS`,
  through that test. The dollar figures and counts stay in the Brain lens.
  Nothing is said when there is nothing honest to say: no line for an hour
  with no indexed trades, and no line for a launcher who did not sell.
- **A child** uses `createFlowClient(processFlowPort())`
  (`worker/src/flow-broker.ts`) and may ask for one thing: the reading for a
  token address, and say how long it waits for it, which can only shorten
  the orchestrator's work. It cannot choose a query, a window, a limit or a creator. It
  never names a tenant, and if it adds one, the field is ignored and logged.
  The broker shares Fomo's IPC channel. That channel exists only while
  `MERRYMEN_FOMO_ENABLED=1`, and without it the client answers `unavailable`
  immediately.
- **The launcher is resolved on the orchestrator**, from the Pons factory's own
  launch event (`readLaunchCreator` in `worker/src/venues/pons.ts`), filtered
  by emitter at the node and checked again. The deployer a token reports about
  itself through the template's metadata getter is never used: any contract
  can answer that selector with a decoy address. The lookback is about 8
  hours (`MAX_LOOKBACK_BLOCKS`), so a coin launched earlier, or not launched
  through Pons, is `not-derivable`. A failed chain read is `unavailable`.
  Neither is ever reported as "did not sell". The address is used as a query
  variable and appears in no fact, log line or reply, and every rendering
  labels it by its source, the launchpad's launch record.

## Where it plugs in

- **Fast-Trencher entry reviews, research accounts only** (wired). The review
  in `worker/src/index.ts` asks through `worker/src/review-flow.ts` exactly
  where the momentum plan goes — an account on
  `MERRYMEN_DECISION_RESEARCH_ACCOUNTS`, live rail, an unheld coin — and only
  with a fresh tape row, since a review without one is never paid for. It asks
  when the review starts, beside the cost quotes and the candle and trade
  legs, with the same 5-second evidence budget as the request's deadline, so
  it cannot hold the review past what it already waited — but only when the
  tape row will still be current once the legs are done
  (`entryMayGoBlind`), so the review cannot then be skipped as blind with the
  reading spent and thrown away. Otherwise it asks right after the blind
  check passes, on what is left of the budget, and not at all when none is
  left. The budget travels
  on the request, so the orchestrator stops the reading when the review stops
  waiting: on a slow lane the flow facts come back with the launcher
  `unavailable`, and no launcher query is sent after the review gave up.
  - `renderFlowLens(result)` turns the reading into a block of at most 1,200
    characters: an attribution line ("Indexer data, not a forecast"), one
    compact JSON object, and a closing "WHAT THIS IS NOT" line. It is `null`
    on any failure, on an hour with no indexed trades, or if anything in it
    looks like an address; then nothing is sent.
  - The block goes under its own signals key, `onchain-flow`
    (`ONCHAIN_FLOW_LENS`), never into `technical`. `services/brain` lists the
    key in `schemas.py` `LENS_KEYS` and so on `/health` `lens_keys`; no desk
    asks for it, so it costs no analyst call and takes no pulse slot. The
    manager reads it directly, after the measured market input and fenced as
    "the same trades as the tape, counted by another indexer"
    (`graph.py` `ONCHAIN_FLOW`, cut at 1,200).
  - The worker sends it only to a Brain whose `/health` lists the key
    (`BrainCapabilityProbe` on `lens_keys`), so an older Brain never sees it.
    A decide that carried it and came back unreachable (how a 422 arrives)
    turns it off until `/health` says yes again.
  - A child asks only when the orchestrator wrote `MERRYMEN_FLOW_BROKER=1` into
    its environment, which it does when the lane is on and the child has the
    IPC channel. Without it no question is sent and nothing is waited for. The
    orchestrator never passes on a copy from its own environment.
  - Each review logs `[trencher] flow SYMBOL: lens`, `no-block` (read, nothing
    to render) or the failure word.
- **X answers**, with research on (`MERRYMEN_XPOST_RESEARCH=1`, an active
  owner's answers; [`x-posting.md`](x-posting.md) "Research for answers"):
  `orchestrator.ts` hands the research `flowFor` only while the lane is on,
  for a Robinhood Chain contract a tag carried or a coin resolved to. The
  reading's deadline is the answer's eight-second share
  (`flowFor(token, { timeoutMs })`), and it is said only through
  `flowXLines(result, "<tenant>|<token>")`. Answers spend from the whole day,
  so they have their own count per UTC day, taken before the read:
  `answerReadingsPerDay`, the points child evidence cannot spend divided by a
  whole reading (15 + 10 points), which is 200 with the defaults. Even if
  answers spend all of it first, evidence keeps its 20,000: the lane weighs
  evidence against its own count, not the day's. The orchestrator
  logs `xpost: answers may read onchain flow — up to N readings per UTC day`
  once, when the X poster is built.
- **Early book.** `BitqueryLane.v3Pools(token)` returns PoolCreated
  candidates from the pinned Uniswap v3 factory. Each one still has to be
  confirmed with the factory's `getPool` and pass the existing depth, TWAP and
  divergence guards before it can be priced. A candidate is never a route on
  its own.

## Also fixed with this lane

- **Gateway auth.** Merry Circle tokens were sent to the gateway in
  `X-API-KEY`, but the gateway reads only `Authorization: Bearer`. Every
  holder's discovery call failed with 401 and was reported as an expired token.
  Gateway calls now send the token as Bearer, and the hint names the actual
  cause: a 401 is the token, a 403 is the holdings, and a 503 is the gateway's
  own state. **This starts gateway spending**, so the gateway gained a
  fleet-wide daily cap in the same change (rollout step 3).
- **No discovery fan-out.** `BITQUERY_API_KEY` and `MERRYMEN_TOKEN` are
  stripped from children. In hosted mode both are house keys that a child can
  only read from the environment, and discovery defaults on, so either one on
  the orchestrator would have made every child poll Bitquery. A hosted child
  also no longer reads the house's brain key as a gateway discovery token. A
  tenant's own gateway brain key still opens discovery on that tenant's own
  quota.
