# Terminal port debt — what the redesign left behind

The terminal redesign (PR #96) moved every screen into `web/src/terminal/` and
left the components it replaced in the tree, unimported. They are not dead code
in the ordinary sense: **each one is the written record of a rule the live screen
does not yet enforce**, and several are the subject of source-reading honesty
tests that still pass over surfaces nobody can reach.

An audit of all ten, one agent per component, reached the same verdict on every
one of them: **not safe to delete yet.** Deleting them today would remove the
specification before the implementation exists. So they stay, the debt is
written down here, and `web/src/mounted.test.ts` fails if the list of vacuous
guards ever grows.


## Pre-merge classification — 2026-09-06

Classified before the terminal shipped, against one rule: anything touching
financial or risk disclosure, actual execution state, wallet authority, or
misleading buy/sell status is MUST HAVE. Everything else follows.

**MUST HAVE — fixed before the merge, all four:**

1. **Holder entries dropped `paper` and `basisSource`** (`EntryTimeline` debt) —
   simulated books and pre-trade estimates rendered as settled fills on the
   public token chart and in the holder table. *Misleading buy/sell status.*
2. **The public profile showed `landed` alone** — an agent with ten paper fills
   published "0 Completed trades". *Misleading execution state.*
3. **The desktop price axis had no formatter** — a coin at 2.8e-6 rendered as
   `$0.00`, a real number shown as nothing. *Financial disclosure.*
4. **No error boundary anywhere** — one throw from the chart renderer unmounted
   the entire terminal. *Unsafe public experience.*

**CAN FOLLOW — everything else below.** None of it states something untrue about
money on a page a stranger can open:

- `PriceLine` oracle series, `EquityLine` drawdown figure, `Feed.tsx` deletion
- `WallBand`/`WallPanel` successor — wallet authority IS disclosed, on `/grant`
  and in `LimitsPanel` (caps, addresses, expiry); the band was a summary of it
- `YouClient` rail notices — refusal reasons now reach the screen via
  `reject_rule`
- `TokensClient` screening disclosures and the `shown` fallback
- `LimitsPanel` rendering "—" for three states — it conflates, but it asserts
  nothing false, and it is the owner’s own screen rather than a public one
- `/tokens` alias, `Search` partial list, `attributionLogo`, `truncated`,
  the dynamic import, dead CSS and fonts

## How to retire an entry

For each component, in this order:

1. **Port the disclosure** to the screen that replaced it. Not the value — the
   sentence. A number reaching the screen is not the same as the caveat being
   rendered beside it.
2. **Move the assertion.** Re-point the `honesty.test.ts` block at the screen and
   confirm it fails before the port and passes after. A bare re-point that turns
   green without the port is worse than nothing: it launders the gap.
3. **Delete the component**, its now-dead CSS, and its entry in
   `KNOWN_DEBT` in `web/src/mounted.test.ts`.

Do not do 3 before 1. Do not do 2 before 1.

## The ten

### `components/TokenFacts.tsx` → `terminal/screens/Token.tsx`
Nine disclosures. `Token.tsx` fetches the whole `TokenMarket` and keeps only
`symbolClash`, so all of this is display work rather than plumbing:
- the refused-index sentence, checked **before** the absent-from-index one
- "no feed" as its own state, distinct from a dash and from a chart-derived close
- the halted chip gated on `paused === true`, never on truthiness
- the corporate-action chip (`bars.ts` already scales by `uiMultiplier` silently)
- feed age as text plus the >1h stale chip (today only a hover tooltip carries it)
- the on-chain holder count and its sub-50 thin-base callout — `token.holders`
  reaches the screen and is never read; "Holders" counts agent seats instead
- the "TWO BARS AND NOT THREE" paragraph, the only record that the dollar
  buy/sell split was considered and permanently refused
- the virtual-seed / pre-graduation reason, which must travel with any future
  depth or liquidity cell

Widen `MarketTok` and `LiveToken` in `terminal/live.ts` with `priceUpdatedAt`,
`paused`, `uiMultiplier`, `volume24hUsd`; `/api/market` already ships them.

18 of the 35 assertions in `app/(app)/t/[token]/honesty.test.ts` target this
file. Seven of the ten blocks assert properties `Token.tsx` does not have, so a
bare re-point turns the suite red without saying which disclosure is missing.
Two need rewriting rather than moving: the `!/\b4H\b/` check would fail on the
legitimate 4H chart window, and the TWO-BARS refusal has no render site.

### `components/EntryTimeline.tsx` → `terminal/screens/Token.tsx`
- `paper` and `basisSource` on a holder: simulated entries and quoted estimates
  currently render as real fills. Add both to `Seat` in `terminal/bars.ts`,
  populate in `Token.tsx`, render on both pin paths (`tv.tsx`, `DitherChart.tsx`)
  with the dashed treatment already defined in `styles/token.css`.
- holders with `enteredAt === null` are coerced to 0 and silently filtered out of
  the chart, so it shows fewer faces than the table lists and says nothing.
- the fills-query failure and the fetch failure collapse into one sentence that
  names neither.

### `components/PriceLine.tsx` → `terminal/tv.tsx`, `terminal/DitherChart.tsx`
The oracle series is not drawn at all on the new token screen. `PriceLine` drew
Chainlink `latestRoundData` history with its own caption about what a 24/5 feed
does and does not cover. Decide whether that surface is retired or restored; if
retired, `captions.test.ts`'s oracle-axis block goes with it.

### `components/EquityLine.tsx` → `terminal/screens/Profile.tsx`
**Largely done.** The `contributionsEvidenced` gate and its refusal copy are
ported and pinned in `terminal/honesty.test.ts`. What remains is the drawdown
figure and the `equity-line-gate.test.ts` re-point.

### `components/Feed.tsx` → `terminal/screens/Feed.tsx`, `terminal/wire.tsx`
**Done.** The unreadable-vs-quiet distinction is ported into
`terminal/ui.tsx#ReadEmpty` in this component's own words. The file can go as
soon as `WallBand`/`ThesisCard` stop needing it as a reference.

### `components/WallBand.tsx`, `components/WallPanel.tsx` → no successor
The wall band has **no replacement on any reachable surface**. Before the
redesign it was mounted in two places. Decide whether the policy-wall summary is
retired from the product or belongs on `screens/Agent.tsx` / `screens/You.tsx`.
This is a product decision, not a port.

### `app/(app)/you/YouClient.tsx` → `terminal/screens/You.tsx`
The rail notices, the trade tape and its refusal strings. `rail-notices.test.ts`
pins `railNotices(feed?.events)` against a component nothing mounts.

### `app/(app)/tokens/TokensClient.tsx` → `terminal/screens/Home.tsx`
- the launchpad-unreadable notice, and `indexUnreachable` rendered **once above
  the table** rather than as twenty-five identical dashes
- the screening bar stated in words ("25 trades from 3 distinct addresses"), so an
  empty list reads as a screen rather than as the world
- `scanned` — the count that makes a genuine zero credible
- `Home.tsx` swaps an empty filtered list for the top 8 by 24h change under the
  same headers, which makes "nothing passed the filter" indistinguishable from
  "here is the market". Fix that first or the ports above render dead code.

### `components/CandleChart.tsx` → `terminal/tv.tsx`
- `priceFormatter`: a coin at 2.8e-6 renders as `$0.00` on the desktop price
  axis, and a gridline crumb of -1.73e-18 prints verbatim. `tv.tsx` enables the
  right price scale at ≥1100px and sets no `localization`.
- `priceFormat: { precision: 8, minMove: 1e-8 }` on both series.
- a try/catch around the chart effect. `tv.tsx` has none and the library is now a
  static import inside a single tree with no error boundary, so a throw from
  `createChart` unmounts the whole terminal rather than one chart.
- `role="img"` and the spoken series summary on the canvas.
- `attributionLogo: true`. It is `false` in `tv.tsx`, and the only two mentions
  of TradingView left in the product are inside the orphan — the licence asks for
  a user-reachable link.
- `withGaps` returns `truncated` and `tv.tsx` drops it, so a capped chart
  presents itself as the whole range. `format.test.ts` asserts "the cap is
  reported, not hidden" about a value no renderer reads.
- the dynamic import. `lightweight-charts` is now in the shell bundle for every
  route, including Settings and Wallet.

## Also outstanding, outside the orphans

- `/tokens` renders Home under a "Markets" title with no redirect, and the
  launchpad view it used to serve is gone.
- `Search` says "Nothing with that name." from a partial client-side list while
  `/api/search` sits unused.
- The public profile prints an unread trade count as "0 Completed trades".
- `HostedControls#LimitsPanel` renders "—" for "no grant signed", "still loading"
  and "we could not read your grant" alike.
- The guided tour's per-address progress: a new signed-in address inherits the
  anonymous visitor's completed state.
- Agent faces and stock logos are hotlinked from the browser, bypassing
  `/api/coin-image`, which exists to stop exactly that.
- `verifiedAdapter` prints "curve adapter verified." after swallowing an RPC
  failure, and rejects a genuine adapter that reverts with a custom error.
- ~4,300 lines under `components/` and ~5,750 lines of CSS under `styles/` are
  unreachable; `styles/scoped.test.ts` now enforces an invariant over dead CSS.
- `layout.tsx` loads three `next/font` families no live CSS consumes, and
  GeistPixel is committed twice byte-for-byte.
