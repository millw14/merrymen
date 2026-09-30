# MerrymenBrain perpetual-market evidence

`analyze(request, now_ms=...)` is a separate, strict, bounded research interface
for an already risk-sized BTC/ETH/SOL perpetual candidate. It never constructs
orders or selects position size, leverage, wallet permissions or stop ceilings.
The caller retains those responsibilities and must validate the response's
account, snapshot, market, candle, side, expiry and strategy version.

The module measures four-hour trend, one-day/week direction, ATR, directional
efficiency, mark/index basis, depth and estimated round-trip costs. It compares
non-overlapping historical three-bar outcomes in similar causally measured
regimes. Every historical label is fully observed before the current decision.
Insufficient history, disagreement, poor liquidity, extension, expensive funding
or an unsupported edge produces a hold. A grounded bull/bear/risk committee can
veto a qualifying candidate; it cannot replace the measured numbers or approve
a numerical refusal.

## Meaning of the forecast

`win_probability` is an **uncalibrated empirical frequency** that a signed
twelve-hour mark move clears the current estimated fees, spread, slippage and
opposing funding. Receiving funding is never credited. It is not the probability
that an actual stop-managed trade profits. Historical funding and book fills are
not reconstructed from current values. A favorable move already consumed between
the signal close and the entry mark is charged as an extra cost; large drift
refuses entry. Wilson and mean intervals describe the
sample; serial dependence and regime changes can make them overconfident.

The policy and thresholds are fixed under `STRATEGY_VERSION`. They have not been
selected by optimizing the supplied history. Unit tests establish invariants,
not alpha. Promotion requires chronological holdout and newly recorded forward
shadow outcomes, compared with the unchanged trend baseline at identical costs
and risk. Report net expectancy, drawdown, loss tails, sample size, coverage and
calibration alongside win rate. Abstention and failed reads must remain distinct.

The standard TradingAgents graph is intentionally not reused as an executable
perps decision: its stock ratings, date-based lookups and free-text fallback do
not express fresh leveraged-market authority. This package can be exported into
Merrymen's existing authenticated Brain service without importing that graph or
its provider/data-source dependencies. The export records its source commit,
file hashes and license, and supports a byte-for-byte consistency check.
