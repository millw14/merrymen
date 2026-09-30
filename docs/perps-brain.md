# MerrymenBrain perpetuals driver

The optional **MerrymenBrain** driver reviews the existing `perp-trend` entry
candidate. It can approve that candidate or withhold it. It cannot increase its
size or leverage, loosen its stop, choose another side or market, or bypass the
owner's signed permissions and trading limits. The default driver remains
`perp-trend`.

## Enable it explicitly

1. Run the private Brain service with `BRAIN_TOKEN` and a separate
   `BRAIN_LLM_API_KEY`. Provider options are `BRAIN_LLM_BASE_URL`,
   `BRAIN_LLM_PROVIDER` and `BRAIN_QUICK_MODEL`.
2. Configure the worker's `brainUrl` and matching `brainToken`, or
   `MERRYMEN_BRAIN_URL` and `MERRYMEN_BRAIN_TOKEN`.
3. In Settings → Perpetuals, select **MerrymenBrain** as the driver
   (`perpsDriver: "brain"`). Start with paper mode and recorded evaluation.

Only BTC-PERP, ETH-PERP and SOL-PERP are eligible. Existing readiness checks,
energy allowances, permission expiry, live consent and operator gates continue
to apply. This setting does not enable live trading or promote a paper account.

## What makes the decision

The deterministic trend producer first supplies a risk-sized candidate. The
private `/v1/perps/decide` endpoint then runs the numerical module exported from
the MerrymenBrain repository. Its vendored source includes provenance and a
checksum verification step in the Brain image build.

The module compares closed four-hour candles with prior, non-overlapping
outcomes in a comparable trend and volatility regime. It checks trend alignment,
spread, funding, observable liquidity, mark/index basis and estimated costs.
The twelve-hour forecast must have enough historical samples, a lower
probability bound above 50%, and a positive lower bound on estimated net return.
These are **uncalibrated historical analog estimates**, not a demonstrated
probability of winning a completed trade.

A numerically qualified candidate receives at most three grounded model reviews:
bull, bear and risk. Every lens must return a valid acceptance. A model may veto;
it cannot turn a numerical hold into an approval or change the numerical
forecast. Invalid output, timeouts and provider errors produce a hold. Numerical
holds use no model calls. The committee has a shared 25-second ceiling and no
provider retries.

The strategy operates over hours and days: four-hour signals, a twelve-hour
forecast and the existing maximum holding time of seven days. Stops or other
protection may close a position earlier.

## Execution, cost estimates and outages

Research runs in the background, at most one outstanding review with a
five-minute cadence. The deterministic exits and protection loop keep running
while research is pending or unavailable. Only new Brain entries wait.

An approval lasts at most 120 seconds and is usable once. It binds the exact
agent, market, settings and permission context, closed candle, side and evidence
snapshot. Before execution the worker checks price drift, current costs,
liquidity, stop risk, size and leverage again. A settings or permission change
invalidates it. The execution deadline is persisted with the existing order
ledger; restarting cannot replay an in-memory approval.

The cost estimate walks both current book sides for the candidate's size within
its unchanged price limit. It charges the larger adverse average fill distance
from mark, plus spread, fees and adverse funding. Both sides need sufficient
executable depth with a cushion. The owner's maximum slippage allowance remains
a hard execution bound; it is not treated as the expected fill cost. A changed
book must still fit the original reviewed aggregate cost budget. The measured
book is an observable present estimate: future exit liquidity is unknown.

## Evidence and evaluation

The private decision journal records the exact source feed frame and hash,
request, context, completion time and response, including holds and unavailable
reviews. Execution reuses the review's decision ID. A recording larger than the
bounded journal allowance refuses entry. Brain perps research is withheld from
public thesis feeds.

Use [the snapshot recorder and replay workflow](perps-replay.md) to compare the
Brain driver with the baseline under identical caps, fees, funding and sampled
execution assumptions. Preserve reviews alongside their exact source frames and
later frames; an approval alone does not establish an outcome. Inspect net
return, drawdown, costs, sample size and uncertainty as well as win rate.
Synthetic tests verify controls and accounting, not investment performance.

There is no demonstrated improvement in win rate yet, and this driver does not
automatically promote itself to live trading. The existing
[mainnet acceptance checklist](perps-mainnet-checklist.md) still applies.
