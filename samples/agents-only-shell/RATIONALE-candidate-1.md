# THE WIRE

## The signature device

**The wire: a single vertical rail down the left of Feed and Agent, with elapsed time in the gutter, live nodes on the rail, and time spans breaking the run into segments.**

It earns the boldness budget because it is the only element that converts the app's one genuinely live asset — real epoch timestamps on all 42 posts — into something a stationary reader can see. A `2m` label is a fact. A `2m` label sitting on a rail beneath a lit node marked `now`, above a `nothing landed for 3 hours` gap, is a story about a market that has a pulse and sometimes doesn't. The rail costs one column of gutter, roughly 45px, and it pays for the entire "when" axis: every screen that carries it reads as a sequence rather than a list, and I never have to write the word "recent" anywhere.

The nodes are colour-coded by side (green buy, red sell, grey hold) and the newest one glows. The gutter reads `now` for the head of the wire and a ticking age for everything else, recomputed every second against `Date.now()`.

## Structure introduced, and the branches it deleted

The app had two divergent implementations of one idea — "an agent did a thing". `MoveTicket` and `MoveChorus` in `move.tsx`, plus an ad-hoc `Say` shape inside `Feed.tsx` that reassembled the same fields a third way. Each rendered the same `Thesis` with a different grammar and a different set of missing pieces.

I introduced two types in `src/beat.ts`:

- **`Beat`** — one domain event, discriminated on `trade | chorus`. It carries actor(s), action, symbol, size, and the contextual facts a size needs to mean anything (`weight`, `crowd`).
- **`Lane`** — one row of presentation, discriminated on `span | beat | lull`. Time headers and silences are first-class rows, not decorations conditionally injected between items.

`beatsOf()` folds theses into beats and does the chorus grouping in one place. `lanesOf()` walks beats and emits spans, lulls, and outsize flags. `Wire` renders lanes. That's the whole pipeline.

What it deleted:

- The `Say` type and its three formatting branches in `Feed.tsx`.
- `MoveTicket` and `MoveChorus`, replaced by one `BeatRow` with a `solo` flag for the one-agent case.
- Every ad-hoc "is this the first row" / "did the day change" conditional at render time. Lanes decide, components render.
- Three separate "N minutes ago" formatters, now one `elapsed()` in `src/clock.ts`.

`src/clock.ts` is the other new file: `useNow`, `elapsed`, `spellSpan`, `countdown`, and the strategy cadence table that drives every countdown in the app.

## FOMO mechanics, and the real data behind each

1. **Ticking ages, everywhere.** `Thesis.at` epochs, recomputed against `useNow(1000)`. Feed's hero is the live age of the newest trade and it counts up while you read it.
2. **Flip on change.** The `Flip` component re-keys on text change and runs `flip-up` / `flip-down`. Drives Feed's hero age and the two countdowns. Suppressed under `prefers-reduced-motion`.
3. **Chorus.** When several agents hit the same symbol on the same side inside a window, they collapse into one card with stacked faces and each agent's own reason underneath. Grouped in `beatsOf` from `slug` + `symbol` + `action` + proximity in `at`.
4. **Crowd unit on the number.** Every size ships with whatever context is true for it: `across 3` for a chorus, `at 21% of its book` when the actor's `glance.legs` has a weight for the name, `4 agents in it` otherwise. On a sell it becomes `5 agents still in` — computed by replaying every thesis to find each agent's newest action per symbol.
5. **Regret.** On a sell, if `SAMPLE_CHG` has the symbol up since, the row adds `MSFT is +0.33% since they sold.`
6. **Outsized trades.** `typicalSize()` takes the median trade on the wire; anything ≥3× gets a raised card, a `--pixel` figure, and `5× the size of a typical trade on the wire.`
7. **Lulls.** A gap over a threshold renders as `nothing landed for 3 hours`. Absence is content.
8. **The race.** Board computes windowed returns off `agent.curve` (24H / 7D / 30D / ALL), and rank movement by re-ranking the same window shifted back one point. Hero is the spread between the leader and your agent.
9. **Gap to next.** Your row carries `4.3% behind dusk. Catch it and you move up one.`
10. **Tier markers.** `TOP HALF ENDS HERE · +6.0% is the middle` and `UNDER WATER · 4 agents are down`, both derived from the live field.
11. **Last move under each board row.** `flint bought COIN · 5m`. The leaderboard is not settled; it is still trading.
12. **While it waited.** Agent screen lists names other agents bought that yours does not hold. Straight set difference between the crowd's positions and `mine.glance`.
13. **Pace.** `northstar traded 2 times today. The other 13 agents traded 24.`
14. **Strategy as follow.** You's strategy rows read `flint is up 72.4% running it` with the crew's faces and a `Run this` button beside it.
15. **Countdown to the next trade.** `nextRun()` from the per-strategy cadence table, ticking on both Agent and You.

## Considered and rejected

**A ticker pinned across every screen.** The brief invited it and I built it: a marquee strip under the status bar cycling the newest trades. I threw it away after looking at it. It competed with the wire for the same job, it was the only element on the screen you could not read at your own pace, and on Board it actively fought the ranking — your eye kept getting pulled off the row you were reading. The wire already says "this is live" without stealing attention, because it says it through structure rather than through motion. One live device per screen, and it should be the one you are already looking at.

**Auto-inserting new rows into Feed.** Also built, also cut. The data is fixtures with fixed timestamps, so anything "arriving" would have been theatre, and the brief's data is real epochs precisely so that liveness does not have to be faked. Worse, it moves the row you are reading. A feed that reorders under your cursor is hostile. The ticking age gets the same "still going" register at zero cost to the reader.

**Rendering `token.holders` as the crowd unit.** Rejected because every token in the fixtures has exactly 3 holders, so it would have been a constant dressed as a signal. I derived crowd from the theses instead, which varies per name and per side, and is true.

**A separate "Live" tab.** Considered as a home for the activity strip. Rejected: five tabs is already the ceiling, and if liveness needs its own tab then the other four are dead, which is exactly the failure mode I was trying to fix.

**Sparklines on every board row.** Cut to the top three plus the tier boundaries. Fourteen sparklines is a texture, not fourteen pieces of information, and it flattened the visual hierarchy that the tiers exist to create.

**`lightweight-charts` for the equity curves.** Available and unused. The existing `Spark` is an inline SVG polyline, it costs nothing, and at 40px tall a real charting library buys axis labels and crosshairs I would then have to suppress.

**Per-row price context (`$45.00 at $376.36`).** This is the fomo convention I most wanted and could not honestly ship: `token.priceUsd` is null with the backend worker down, so `coinPrice()` returns `—` for every name. I used share-of-book and crowd count instead, which are computable offline. If the lead grafts this candidate onto a live backend, the price belongs in `sideOf()` in `src/wire.tsx` as the first branch.

## Built and thrown away

- The pinned ticker (above), roughly 80 lines of component and CSS.
- Feed auto-insert with a `useEffect` timer (above).
- A "heat" column on Board showing trades-per-hour per agent. Real data, but it correlated almost perfectly with strategy cadence, so it was a slower way of reading the stamp already on the row.
- A day-divider treatment on the wire, superseded once spans went to seven finer buckets — the buckets do the job and never leave a stale `Today` header at the top of a five-minute feed.

## Honest assessment

**Weakest screen: Agent.** It is the only one where the wire is running in `solo` mode, which strips the strategy stamp and the second actor, so the rows lose most of the grammar that makes Feed work — every line starts with the same name. The "while it waited" strip is the strongest thing on it and it sits above the fold only because the book bar is short. If the lead takes this candidate as a base, Agent is where to graft.

**Board is strongest.** The tiers, markers, gap-to-next, and rank deltas do the most work per pixel, and the `you` chip inside the ranking is the one place where the user's own position is unambiguously legible against the field.

## Where I disagreed with the brief

The brief asks for density "in the way a trading floor is busy". I went dense but stopped short of the fomo reference density, because merrymen's rows carry a sentence of reasoning and fomo's do not. A reason is 12 words; a ticker symbol is four characters. Packing merrymen's rows to fomo's line-height would make the reasoning unreadable, and the reasoning is the only thing distinguishing this product from a trade blotter. I spent the density budget on more rows visible rather than on tighter rows.

I also read "presence and liveness treated as first-class rather than as a 6px dot" as an argument against decorative liveness, not for more of it. There is exactly one pulsing dot left in the app, next to your own agent's name, where it means "yours is running" and nothing else.
