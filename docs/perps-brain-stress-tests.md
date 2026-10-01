# Perps Brain adversarial test report

Date: 2026-10-01. Scope: numerical research, the private Brain service,
worker approval handling and offline evaluation. No real trades, external
provider requests or paid model calls were made. Venue and model interactions
used synthetic data, mock transports or localhost servers.

## Defects reproduced and fixed

| Area | Defect | Correction |
| --- | --- | --- |
| Raw market data | Floating-point conversion could hide an invalid OHLC range at large raw prices. | Keep raw integer prices exact through validation and price differences. |
| Forecast intervals | Floating arithmetic could put the zero-win lower bound above zero. | Preserve exact zero-win and all-win endpoints. |
| Worker approval | A fabricated response ATR could widen market dislocation and drift guards. | Recompute Wilder ATR from the frozen 100-bar evidence. |
| Forecast integrity | Impossible sample counts, win frequencies, confidence bounds and costs were accepted, including HOLD records used for scoring. | Validate the named estimator's mathematical constraints and request-derived costs. |
| Committee output | Conflicting JSON keys, blank reasons or unfinished/refused/tool-call provider responses could be accepted. | Reject ambiguous, incomplete and malformed responses. |
| Budget and timing | Failed requests were uncounted, compatibility retries bypassed the perps no-retry setting, and final-call overruns could approve. | Count attempts at dispatch, validate usage, respect retry limits and recheck token/time budgets after calls. |
| HTTP boundary | Non-finite request values and non-ASCII authorization could produce HTTP 500 errors. | Return bounded validation/authentication refusals. |
| Performance comparison | Comparing completed trades alone could favor a candidate while ignoring a better marked result in the baseline's open positions. | Also compare whole-account marked P&L at identical fold boundaries. |
| Replay chronology | Overlapping archived reviews could let an old approval arrive after a newer HOLD. | Reject histories impossible under the worker's one-outstanding-review rule. |

Existing signed permissions, size limits, leverage limits, stop limits and
live-enablement gates were preserved. Synthetic approval fixtures were expanded
to contain enough history for the sample counts they claim.

## Verification actually run

- **365 numerical tests passed** in MerrymenBrain, including 128 seeded
  500-candle market paths: trends, ranges, flat markets, reversals, gaps,
  volatility changes, spikes and noise, for long and short candidates.
- Those tests also exercise malformed inputs, higher-cost monotonicity,
  funding direction, raw-price/time invariance, causal historical features,
  and every possible win count for sample sizes 1 through 133.
- **137 Brain service tests passed; 2 existing canary-fixture tests skipped.**
  This includes the existing spot service suite and 38 new adversarial cases.
  Bursts of 32 same-agent requests, cross-tenant independence, cancellation,
  provider failures and budget limits are covered.
- **1,077 Node tests passed, zero skipped:** all worker Brain and perps tests.
  New coverage includes malformed-field mutations, 400 overlapping review
  launches, 100 approval consumers, context changes, bounded HTTP bodies,
  failure recovery, and 42 replay timing combinations.
- **168 actual Python-to-TypeScript cases passed** in an additional offline
  contract matrix. Numerical outputs were accepted by the worker validator,
  and independently calculated ATR values agreed. Cases included 100–500-bar
  histories, zero/single-outcome samples, both sides, price scales up to
  10^12 and extreme funding.
- Worker, web, browser and SDK TypeScript checks passed. Numerical Ruff checks,
  targeted service Ruff checks, diff checks and vendored source verification
  passed.

The exported numerical source is MerrymenBrain commit
`a352780148ba`; the full commit and file hashes are recorded in
`services/brain/brain/vendor/merrymenbrain_perps/PROVENANCE.json`.

## Repeat the automated suites

In MerrymenBrain, using its development Python environment:

```sh
python -m pytest -q tests/test_perps_analysis.py tests/test_perps_stress.py
```

In Merrymen, using the Brain service Python environment for its suite:

```sh
cd services/brain
python -m pytest -q
```

From the Merrymen repository root:

```sh
node --import tsx --test --test-concurrency=4 worker/src/brain*.test.ts worker/src/perps/*.test.ts
npm run typecheck
python services/brain/check-perps-vendor.py
```

These checks establish robustness and agreement between components. Synthetic
markets and fake model replies do not demonstrate predictive skill, a higher
win rate or live profitability. No deployment or live activation was performed.
