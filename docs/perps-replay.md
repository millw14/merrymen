# Replay the default perpetuals strategy

The offline replay runs `perp-trend`, the policy checks, protection rules and
paper settlement engine against **recorded Lighter feed snapshots**. It does
not load a grant, read a private key, contact the venue or modify an agent's
ledger.

From the repository root:

```sh
node --import tsx worker/src/perps/backtest-cli.ts replay.json > result.json
```

`replay.json` has this shape:

```json
{
  "config": {
    "initialCashUsdg": 100,
    "perTradeUsdg": 50,
    "dailyUsdg": 500,
    "maxOpsPerDay": 50,
    "energyOpensPerDay": 2,
    "maxDrawdownBps": 500,
    "settings": { "perpsMarkets": ["BTC-PERP", "ETH-PERP"] }
  },
  "frames": [
    { "atMs": 1790718587000, "feed": "replace with the full lighter-feed.json object captured at this time" }
  ]
}
```

The example explains the envelope; replace the `feed` string with an actual
version 1 feed object. Each frame needs the complete feed, including its real
market specifications, fees, order-book depth, closed four-hour candles and
settled hourly funding. Capture the existing public `lighter-feed.json`
atomically, preserving its timestamps; do not substitute today's depth or
specifications into a historical candle series. `atMs` is the clock at which
that snapshot was available. Frames must increase strictly in time. The
normal strict feed parser rejects future observations and incomplete candles.

Omitted settings use the shipped defaults: two-times maximum leverage, 25
USDG per position, 50 USDG total open notional, 30 USDG collateral and a 5%
stop ceiling. The strategy's breakout, ATR, cooldown and maximum holding-time
rules are unchanged. The supplied sealed cap and energy allowance are replay
assumptions, explicitly included in the result; they confer no authority on a
live worker. Replay spend and operation budgets use a trailing 24-hour window.

## Reading the result

- All money is a decimal string in micro-USDG; divide by 1,000,000 to display
  USDG. Prices and sizes in fill records retain their venue precision.
- `curve` contains sampled cash, margin, unrealized P&L and total equity.
  `tailPositions` are still open at the end. They are marked at the last
  readable snapshot, never sold at an invented final price.
- `events` records entries, closes, stops, liquidation, funding, idles and
  policy refusals. Fees and funding come from the feed and paper engine.
- Every completed sample verifies the identity: equity equals initial cash
  plus realized P&L plus funding minus fees plus unrealized P&L.
- `complete: false` and `finalEquityMicro: null` mean the run stopped on
  unread input. `failure` identifies the first gap. The prior curve remains
  available as a **partial run**, not a result for the full period.
- Exit code is 0 for a complete replay, 2 for an incomplete replay and 1 for
  malformed configuration, input or execution failure.

## Limits of the evidence

This is a sampled replay, not an intrabar reconstruction. A stop or liquidation
crossing between recorded marks is unknown; `maxSampleGapMs` makes the sampling
gap visible. IOC orders walk the recorded depth without latency or market
impact, and successive actions do not deplete it. Funding uses the index in
the sample that books the hour because the feed has no historical hourly
index. Missing owed funding stops the run rather than counting as zero. A
sample immediately after an hour boundary may therefore be incomplete until
the venue publishes that funding.

Deposits, withdrawals, signing delays, network outages, ADL and the venue's
liquidation queue are outside this replay. Keep the raw input alongside the
result. Synthetic regression fixtures demonstrate behavior and accounting;
they are not evidence of investment returns. Mainnet execution remains subject
to [the live checklist](perps-mainnet-checklist.md).

## Record public snapshots without trading

The recorder reads an existing local public feed file. It never starts a worker,
loads an account or connects to a venue:

```sh
node --import tsx worker/src/perps/backtest-cli.ts record /path/to/lighter-feed.json capture.jsonl 3600 2000
```

This records for 3,600 seconds at a 2,000 ms interval. Duration is required and
limited to 24 hours; Ctrl-C closes the file. The output must be new. Keep enough
disk space for the full raw feed at every sample. JSONL stores the untouched
feed bytes, their SHA-256, a canonical frame SHA-256, receive and observation
clocks, and the elapsed interval. Venue specifications retain their original
observation clocks inside the raw feed. Failed reads and malformed/future feeds
are preserved as gaps. Loading the recording verifies its hashes and timestamp
chain, and a gap stops replay instead of being silently discarded. Neither a
local hash nor a supplied timestamp independently certifies a dataset's origin.

A replay input may replace `frames` with `"recording": "capture.jsonl"`; paths
are resolved relative to the input JSON. The standalone recorder adds no I/O to
the production feed writer.

## Replay recorded MerrymenBrain reviews

Add `strategyVersion` and `brainDecisions` to the replay input:

```json
{
  "config": { "initialCashUsdg": 100 },
  "recording": "capture.jsonl",
  "strategyVersion": "merrymenbrain-perps-analogs-v1",
  "brainDecisions": []
}
```

Each decision artifact has `sourceFrameSha256`, `sourceNews`,
`sourceNewsSha256`, the original runtime `context` fingerprint, full `request`,
full `response` (or null on failure), and `completedAtMs`. Preserve **every**
review, including HOLD and failures. Empty
decisions produce no Brain entries. Do not reconstruct a request using a later
feed: the source frame must be the exact feed and account state used when the
request began, with `frame.atMs === request.as_of_ms`. A separately polling
recorder does not automatically capture that exact decision frame; include the
original decision frame in the replay timeline as well. The live decision journal
stores this as `sourceFrame` beside the request/response. The CLI merges supplied
`sourceFrame` artifacts into the sampled timeline, verifies their hashes and
refuses conflicting observations at the same timestamp.

A later execution frame also needs an independently observed
`news: { "market": "BTC-PERP", "evidence": { ... } }` snapshot for that market.
The adapter checks that it is fresh and unchanged from the reviewed news.
Feed-only recordings lack this observation and therefore refuse Brain opens;
they cannot establish a news-aware trade outcome. An attached news snapshot is
only as trustworthy as its capture process; a hash alone does not prove origin.

The adapter rebuilds the request from the source frame and the replay's causal,
risk-sized candidate, then verifies the snapshot hash, account, run, market and
closed candle. Changing capital, settings or previous trades can invalidate a
later archived request; `producerDiagnostics` exposes these mismatches. A run
contains one account/context, uniquely ordered request clocks, and no overlapping
reviews, matching the live worker's single-flight behavior. The
model may approve the same candidate or veto it. Its response is usable only on
a **later frame**, after completion and before expiry. At use, the market,
closed candle, side, price drift, maximum size and leverage are checked again;
the normal execution policy remains binding. Protection and deterministic exits
continue without an approval. No historical model call or provider spending is
performed by this command.

## Net trade metrics and forecast targets

`completedTrades` groups each entry and all its partial reductions until the
position becomes flat. Its `netMicro` includes entry/exit fees and every funding
payment. `metrics` reports completed win rate, net expectancy, profit factor,
loss streak, worst trade, drawdown, liquidations, fees and funding. A small gross
gain that loses money after costs counts as a loss. Open tails and their booked
costs are separate; they never become fabricated completed wins. Profit factor
is null when there is no losing completed trade, rather than an infinite score.
Incomplete runs are labelled incomplete, even if their prefix made money.

`forecasts` scores a different target: signed return from the last closed signal
candle to the close three four-hour bars later, minus the response's frozen
estimated cost in basis points. It includes Brier score and reliability bins.
A missing future target is unscored. These probabilities remain
`calibrated: false`; this mark-price proxy is **not** the probability of a
profitable completed trade. Overlapping labels are correlated, and a short
sample cannot establish predictive skill.

## Chronological comparison and held-out intervals

```sh
node --import tsx worker/src/perps/backtest-cli.ts evaluate evaluation.json > evaluation-result.json
```

The input uses the same `config`, `frames`/`recording` and `brainDecisions`, plus
a `plan` with `strategyVersion`, `frozenAtMs`, `provenance` (`forward-capture`,
`historical-reconstruction` or `synthetic`), and `folds`. Each fold contains
`trainEndMs`, `testStartMs` and `testEndMs` in milliseconds. Test intervals are
chronological, non-overlapping and end-exclusive. The candidate must be frozen
before every test interval. The gap between training end and test start must
cover `purgeMs`: it defaults to the full 168-hour maximum trade horizon and may
never be shorter than the forecast's 12-hour outcome horizon. Use the full
longer horizon whenever training labels include trade outcomes.

This command performs no fitting or parameter search. Each held-out interval
starts flat and compares the frozen trend baseline with the recorded candidate
under identical capital, caps, fees, funding and book execution. It reports all
folds and marked tails. It never concatenates independently reset equity curves
into a misleading aggregate drawdown. `pooledMarkedNetMicro` sums ending equity
minus starting equity across folds, including open positions at their final
observed marks, fees and booked funding. Comparisons require improvement in
both completed-trade P&L and this whole-account result: leaving a loss open or
realizing a smaller gain before the baseline cannot manufacture improvement.
Marked results are null if any fold is empty or incomplete; marks are not
claims of executable closing prices. `minimumCompletedTrades` defaults to 100
**per variant per fold**. Incomplete input, too few trades, fewer than three
test intervals or synthetic/historical-only data yield insufficient evidence.
Sample sufficiency is not significance: even a report requiring forward risk
review always says `promotionAuthorized: false`.

For a performance claim, additionally require a locked newly observed forward
cohort, uncertainty estimates that preserve temporal/market correlation, and
conservative latency and cost stress. A retrospective LLM may know historical
outcomes from pretraining despite causal numeric features. Do not tune prompts
or thresholds on the final holdout, mix same-time markets across folds, relax
owner limits, or select only profitable reviews. No real performance dataset or
improved win-rate result is included with these synthetic regression tests.
