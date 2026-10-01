"""Strict, bounded market evidence for a separate perpetuals research contract."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any

BAR_MS = 14_400_000
SCHEMA_VERSION = "perps-1"
MARKETS = {"BTC-PERP", "ETH-PERP", "SOL-PERP"}
KEYS = {
    "schema_version", "run_id", "agent_id", "snapshot_id", "market", "as_of_ms",
    "expires_at_ms", "candidate", "candles", "mark_price", "index_price", "spread_bps",
    "taker_fee_bps", "slippage_bps", "funding_ppm_per_hour", "depth_ratio",
}


class InputError(ValueError):
    """Unusable evidence; a caller must not turn this into entry permission."""


def integer(value: Any, name: str, minimum: int = 0) -> int:
    if type(value) is not int or not minimum <= value <= 2**53 - 1:
        raise InputError(f"invalid {name}")
    return value


def number(value: Any, name: str, minimum: float, maximum: float) -> float:
    if type(value) not in (int, float) or not minimum <= value <= maximum or not math.isfinite(value):
        raise InputError(f"invalid {name}")
    return float(value)


def price(value: Any, name: str) -> int:
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{0,19}", value):
        raise InputError(f"invalid {name}: expected positive integer price text")
    # Keep raw prices exact through OHLC validation and differences. Converting
    # first to float can collapse distinct 20-digit prices and accept a high
    # below its close (or a low above it).
    return int(value)


def identifier(value: Any, name: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9:._-]{1,160}", value):
        raise InputError(f"invalid {name}")
    return value


@dataclass(frozen=True)
class Candle:
    t: int
    o: int
    h: int
    low: int
    c: int


def validate(req: dict, now_ms: int) -> list[Candle]:
    if not isinstance(req, dict) or set(req) != KEYS:
        raise InputError("unexpected or missing perps evidence fields")
    if req["schema_version"] != SCHEMA_VERSION or not isinstance(req["market"], str) or req["market"] not in MARKETS:
        raise InputError("unsupported perps schema or market")
    for name in ("run_id", "agent_id", "snapshot_id"):
        identifier(req[name], name)
    now_ms = integer(now_ms, "now_ms", 1)
    as_of = integer(req["as_of_ms"], "as_of_ms", 1)
    expiry = integer(req["expires_at_ms"], "expires_at_ms", 1)
    if as_of > now_ms + 2_000 or now_ms - as_of > 60_000:
        raise InputError("snapshot is stale or from the future")
    if expiry <= now_ms or not as_of < expiry <= as_of + 120_000:
        raise InputError("snapshot decision authority expired or exceeds two minutes")
    candidate = req["candidate"]
    if not isinstance(candidate, dict) or set(candidate) != {"side", "bar_t", "stop_bps"}:
        raise InputError("invalid candidate fields")
    if candidate["side"] not in ("long", "short"):
        raise InputError("invalid candidate side")
    integer(candidate["bar_t"], "candidate bar")
    number(candidate["stop_bps"], "stop_bps", 1, 10_000)
    price(req["mark_price"], "mark_price")
    price(req["index_price"], "index_price")
    for name in ("spread_bps", "taker_fee_bps", "slippage_bps"):
        number(req[name], name, 0, 10_000)
    number(req["funding_ppm_per_hour"], "funding_ppm_per_hour", -1_000_000, 1_000_000)
    number(req["depth_ratio"], "depth_ratio", 0, 1_000_000_000)
    raw = req["candles"]
    if not isinstance(raw, list) or not 100 <= len(raw) <= 500:
        raise InputError("100 to 500 closed four-hour candles are required")
    candles = []
    for row in raw:
        if not isinstance(row, dict) or set(row) != {"t", "o", "h", "l", "c"}:
            raise InputError("invalid candle fields")
        c = Candle(integer(row["t"], "candle time"), *(price(row[k], k) for k in ("o", "h", "l", "c")))
        if not c.low <= min(c.o, c.c) <= max(c.o, c.c) <= c.h:
            raise InputError("inconsistent candle range")
        if candles and c.t != candles[-1].t + BAR_MS:
            raise InputError("candles must be ordered, contiguous and unique")
        if c.t + BAR_MS > as_of:
            raise InputError("in-progress or future candle")
        candles.append(c)
    if as_of - (candles[-1].t + BAR_MS) >= BAR_MS + 60_000:
        raise InputError("latest closed candle is missing")
    if candidate["bar_t"] != candles[-1].t:
        raise InputError("candidate does not bind the latest closed candle")
    return candles
