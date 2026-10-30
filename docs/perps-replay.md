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

## Capture the existing public feed

`capture-public-feed-cli.ts` records the `lighter-feed.json` already published
by the fleet feed. It opens no network connection, loads no `.env`, grant,
private ledger or signing key, and does not start a second feed. The input must
be that named regular file; a final symlink is refused. Unknown fields,
including nested fields, are refused so a mistaken secret-bearing input cannot
be copied into a recording. Feed observation times remain unchanged.

Run on the host with the existing feed, writing to a **new** directory outside
source control. The explicit opt-in applies only to capture; it enables no
worker or trading permission:

```sh
MERRYMEN_PERPS_CAPTURE_PUBLIC_FEED=1 node --import tsx \
  worker/src/perps/capture-public-feed-cli.ts \
  /existing/fleet-home/lighter-feed.json /private/perps-capture-2026-10-30 \
  120 5000
```

This example samples 120 times, five seconds apart (about ten minutes). The
arguments are sample count and interval in milliseconds. Limits are 8,640
samples, 1–60 second intervals, at most 24 hours of scheduled sampling, 1 MiB
per input frame and 64 MiB of recorded frame lines. The directory is created
with mode `0700` and files with `0600`. It refuses an existing directory.
`frames.ndjson` preserves each complete sample as it is read and synced;
`replay.json` and `capture.json` finalize the recording on completion or a
handled SIGINT/SIGTERM. The NDJSON and replay file duplicate the frames, so
allow at least 128 MiB per maximum-sized run. A hard process/host failure may
leave only complete NDJSON lines; do not present that as a completed capture.

A missing, malformed, oversized, future-dated or unrecognized feed is retained
as `{ "atMs": ..., "feed": null }`. The next good sample does not erase that
gap. Replay stops at the first unread frame with unknown final equity. The
capture exits 2 for an interrupted/bounded/incomplete recording or any unread
frame, 1 for invalid invocation or an execution error, and 0 only when all
requested samples were readable. A backwards/nonadvancing system clock stops
capture instead of fabricating a later timestamp.

Replay the finalized recording with the existing offline engine:

```sh
node --import tsx worker/src/perps/backtest-cli.ts \
  /private/perps-capture-2026-10-30/replay.json \
  > /private/perps-capture-2026-10-30/result.json
```

The capture's replay assumptions are explicit: 100 simulated USDG, a 25 USDG
per-trade cap, 100 USDG daily cap, 48 operations per day, two opening energy
slots and a 5% drawdown breaker; strategy settings retain the shipped defaults.
These are replay inputs, not a signed permission or proof of an owner's actual
limits. Keep `capture.json`, `frames.ndjson`, `replay.json`, `result.json`, the
commit SHA and the exact replay command together. A complete capture only
means its requested frames were recorded; a complete replay only means those
samples were interpretable under its assumptions. Neither establishes live
performance, safety between samples, or readiness to trade real funds.
