"""Causal market features and explicit uncertainty, never model-written win probabilities.

An analog outcome is a signed mark move over three closed bars, minus today's
conservative estimated costs. It is a proxy forecast, NOT a realized trade win
rate: intrabar stops, future funding, fills and liquidation require venue replay.
The fixed policy is intentionally selective. No parameter is fitted on the
current sample; held-out and forward evidence are still required to establish skill.
"""

from __future__ import annotations

import math
import statistics
import time

from .schema import SCHEMA_VERSION, Candle, price, validate

STRATEGY_VERSION = "merrymenbrain-perps-analogs-v1"
HORIZON_BARS = 3
MIN_ANALOGS = 20
LOOKBACK = 24
FEATURE_WARMUP = 100


def _features(candles: list[Candle], end: int) -> dict:
    # Every feature reads only bars available at this historical decision time.
    window = candles[end - FEATURE_WARMUP + 1:end + 1]
    ema = sum(c.c for c in window[:24]) / 24
    for c in window[24:]:
        ema += 2 / 25 * (c.c - ema)
    recent = candles[end - LOOKBACK:end + 1]
    travel = sum(abs(b.c - a.c) for a, b in zip(recent[:-1], recent[1:], strict=True))
    efficiency = abs(recent[-1].c - recent[0].c) / travel if travel else 0.0
    true_ranges = [max(b.h - b.low, abs(b.h - a.c), abs(b.low - a.c)) for a, b in zip(window[:-1], window[1:], strict=True)]
    atr = sum(true_ranges[:14]) / 14
    for tr in true_ranges[14:]:
        atr = (13 * atr + tr) / 14
    close = candles[end].c
    daily_bps = (close / candles[end - 6].c - 1) * 10_000
    week_bps = (close / candles[max(0, end - 42)].c - 1) * 10_000
    direction = 1 if close > ema and daily_bps > 0 else -1 if close < ema and daily_bps < 0 else 0
    regime = "trend" if efficiency >= 0.35 and direction else "range" if efficiency < 0.2 else "transition"
    return {
        "regime": regime, "direction": direction, "efficiency_24": efficiency,
        "atr_bps": atr / close * 10_000, "ema_distance_atr": (close - ema) / atr if atr else 0.0,
        "return_1d_bps": daily_bps, "return_1w_bps": week_bps,
    }


def _wilson(wins: int, n: int) -> tuple[float, float]:
    z = 1.959963984540054
    p = wins / n
    denominator = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denominator
    radius = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator
    return max(0.0, center - radius), min(1.0, center + radius)


def analyze(req: dict, *, now_ms: int | None = None) -> dict:
    """Research one already risk-sized candidate; approve its side or abstain.

    No network, keys, wallet data, files, clocks in the model, or order construction.
    A replay supplies its observation clock explicitly. InputError is a refusal.
    """
    candles = validate(req, int(time.time() * 1000) if now_ms is None else now_ms)
    side = req["candidate"]["side"]
    sign = 1 if side == "long" else -1
    latest = _features(candles, len(candles) - 1)
    mark, index = price(req["mark_price"], "mark"), price(req["index_price"], "index")
    basis_bps = (mark / index - 1) * 10_000
    # Funding receipts are never credited as expected profit. Opposing funding
    # is charged over the whole twelve-hour horizon. Spread and slippage cover
    # both legs; a service or LLM cannot lower the caller's estimates.
    funding_cost = max(0.0, sign * req["funding_ppm_per_hour"]) / 100 * (HORIZON_BARS * 4)
    drift_bps = (mark / candles[-1].c - 1) * 10_000
    entry_cost = max(0.0, sign * drift_bps)
    cost = 2 * (req["taker_fee_bps"] + req["slippage_bps"] + req["spread_bps"]) + funding_cost + entry_cost
    outcomes: list[float] = []
    last_label_end = -1
    # Compare equally warmed features. Earlier bars cannot supply the same
    # EMA/ATR state as the current 100-bar window, even though they are causal.
    for i in range(FEATURE_WARMUP - 1, len(candles) - HORIZON_BARS):
        if i < last_label_end:
            continue
        then = _features(candles, i)
        if then["regime"] != latest["regime"] or then["direction"] != sign:
            continue
        if not 0.5 * latest["atr_bps"] <= then["atr_bps"] <= 2 * latest["atr_bps"]:
            continue
        if abs(then["efficiency_24"] - latest["efficiency_24"]) > 0.25:
            continue
        end = i + HORIZON_BARS
        outcomes.append(sign * (candles[end].c / candles[i].c - 1) * 10_000 - cost)
        last_label_end = end
    n = len(outcomes)
    probability = sum(x > 0 for x in outcomes) / n if n else None
    lower, upper = _wilson(sum(x > 0 for x in outcomes), n) if n else (None, None)
    mean = statistics.mean(outcomes) if n else None
    # This descriptive interval is not a calibrated guarantee; regimes can
    # change and even non-overlapping returns remain serially dependent.
    mean_lower = mean - 2.1 * statistics.stdev(outcomes) / math.sqrt(n) if n > 1 else None
    reasons = []
    if latest["regime"] != "trend" or latest["direction"] != sign:
        reasons.append("market-regime-disagrees")
    if abs(latest["ema_distance_atr"]) > 3:
        reasons.append("extended-from-trend")
    if sign * latest["return_1w_bps"] <= 0:
        reasons.append("higher-timeframe-disagrees")
    if abs(basis_bps) > max(50, latest["atr_bps"]):
        reasons.append("mark-index-dislocation")
    if abs(drift_bps) > max(25, 0.2 * latest["atr_bps"]):
        reasons.append("entry-moved-from-signal")
    if req["depth_ratio"] < 1.25:
        reasons.append("insufficient-depth-cushion")
    if cost > req["candidate"]["stop_bps"] * 0.15:
        reasons.append("costs-consume-risk-budget")
    if n < MIN_ANALOGS:
        reasons.append("insufficient-comparable-history")
    if lower is None or lower <= 0.5 or mean_lower is None or mean_lower <= 0:
        reasons.append("edge-not-supported")
    features = {**latest, "basis_bps": basis_bps, "funding_cost_bps": funding_cost, "entry_drift_bps": drift_bps,
                "depth_ratio": req["depth_ratio"], "spread_bps": req["spread_bps"]}
    return {
        "schema_version": SCHEMA_VERSION, "strategy_version": STRATEGY_VERSION,
        **{k: req[k] for k in ("run_id", "agent_id", "snapshot_id", "market", "as_of_ms", "expires_at_ms")},
        "candidate_bar_t": req["candidate"]["bar_t"], "candidate_side": side,
        "action": side if not reasons else "hold", "reason_codes": reasons,
        "features": features,
        "forecast": {
            "method": "causal-regime-analogs-v1", "horizon_bars": HORIZON_BARS,
            "target": "signed-mark-return-after-estimated-costs", "samples": n,
            "win_probability": probability, "lower_95": lower, "upper_95": upper,
            "mean_net_bps": mean, "mean_lower_95_bps": mean_lower, "cost_bps": cost,
            "calibrated": False,
        },
    }
