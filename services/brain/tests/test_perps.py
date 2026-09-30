"""Real exported market engine + bounded committee, with zero paid model calls."""
from __future__ import annotations

import asyncio
import copy
import json
import time

import httpx
import pytest
from pydantic import ValidationError

from brain.perps import PerpsDecideRequest, numerical_review, review_perps
from brain.server import app
from brain.vendor.merrymenbrain_perps import STRATEGY_VERSION

BAR = 14_400_000


def request(side="long", **changes):
    now = int(time.time() * 1000)
    latest = now // BAR * BAR - BAR
    sign = 1 if side == "long" else -1
    rows = []
    for i in range(180):
        close = 200_000 + sign * i * 100
        opening = close - sign * 100
        rows.append({"t": latest - (179 - i) * BAR, "o": str(opening), "h": str(max(opening, close) + 450), "l": str(min(opening, close) - 450), "c": str(close)})
    return PerpsDecideRequest.model_validate({
        "schema_version": "perps-1", "run_id": "test-run", "agent_id": "agent-a", "snapshot_id": "a" * 64,
        "market": "BTC-PERP", "as_of_ms": now, "expires_at_ms": now + 120_000,
        "candidate": {"side": side, "bar_t": latest, "stop_bps": 300}, "candles": rows,
        "mark_price": rows[-1]["c"], "index_price": rows[-1]["c"], "spread_bps": 1, "taker_fee_bps": 1,
        "slippage_bps": 1, "funding_ppm_per_hour": 0, "depth_ratio": 3, **changes,
    })


class FakeLlm:
    def __init__(self, outputs=None):
        self.outputs = outputs or [json.dumps({"verdict": "accept", "reason": "The supplied directional evidence supports the candidate."})] * 3
        self.calls = []

    async def complete(self, **kwargs):
        self.calls.append(kwargs)
        assert kwargs["max_attempts"] == 1
        assert "api_key" not in kwargs["user"] and "agent_id" not in kwargs["user"]
        kwargs["budget"].record(kwargs["node"], "fake", "fake", 20, 10)
        raw = self.outputs[len(self.calls) - 1]
        if isinstance(raw, Exception):
            raise raw
        return raw


@pytest.mark.parametrize("side", ["long", "short"])
async def test_real_engine_and_three_lenses_preserve_forecast_and_candidate(side, monkeypatch, tmp_path):
    monkeypatch.setenv("BRAIN_USAGE_LOG", str(tmp_path / "usage.jsonl"))
    req = request(side)
    numerical = numerical_review(req)
    assert numerical["action"] == side
    llm = FakeLlm()
    out = await review_perps(req, llm, numerical)
    assert len(llm.calls) == 3
    assert out["action"] == side
    assert out["forecast"] == numerical["forecast"]
    assert out["strategy_version"] == STRATEGY_VERSION
    assert out["forecast"]["calibrated"] is False
    assert len(out["committee"]) == 3
    assert json.loads((tmp_path / "usage.jsonl").read_text())["model_calls"] == 3


async def test_numeric_hold_cannot_be_approved_by_a_model():
    req = request(depth_ratio=0)
    llm = FakeLlm()
    out = await review_perps(req, llm)
    assert out["action"] == "hold" and not llm.calls
    assert "insufficient-depth-cushion" in out["reason_codes"]


@pytest.mark.parametrize("raw", [
    '{"verdict":"veto","reason":"The uncertainty supports waiting."}',
    "accept this trade", '{"verdict":"accept","reason":"ok","leverage":100}',
    '{"verdict":"accept","reason":null}', RuntimeError("provider unavailable"),
])
async def test_committee_failure_or_veto_only_withholds(raw, monkeypatch, tmp_path):
    monkeypatch.setenv("BRAIN_USAGE_LOG", str(tmp_path / "usage.jsonl"))
    req = request()
    numeric = numerical_review(req)
    out = await review_perps(req, FakeLlm([raw]), numeric)
    assert out["action"] == "hold"
    assert out["forecast"] == numeric["forecast"]
    assert numeric["action"] == "long", "input record was not mutated"


async def test_expiry_during_a_model_call_is_not_renewed(monkeypatch, tmp_path):
    monkeypatch.setenv("BRAIN_USAGE_LOG", str(tmp_path / "usage.jsonl"))
    req = request()
    numerical = numerical_review(req)
    class Late(FakeLlm):
        async def complete(self, **kwargs):
            raw = await super().complete(**kwargs)
            monkeypatch.setattr("brain.perps.time.time", lambda: req.expires_at_ms / 1000)
            return raw
    assert (await review_perps(req, Late(), numerical))["action"] == "hold"


@pytest.mark.parametrize("mutation", [
    lambda r: r.update(extra="execute"), lambda r: r.update(market="DOGE-PERP"),
    lambda r: r.update(depth_ratio=float("nan")), lambda r: r["candidate"].update(leverage=100),
    lambda r: r.update(candles=r["candles"][:99]),
])
def test_http_contract_rejects_unexpected_authority_and_bad_evidence(mutation):
    raw = request().model_dump()
    mutation(raw)
    with pytest.raises(ValidationError):
        PerpsDecideRequest.model_validate(raw)


async def test_endpoint_auth_and_real_numeric_hold_never_need_a_provider(monkeypatch):
    monkeypatch.setenv("BRAIN_TOKEN", "secret")
    monkeypatch.delenv("BRAIN_LLM_API_KEY", raising=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://brain.test") as client:
        raw = request(depth_ratio=0).model_dump()
        assert (await client.post("/v1/perps/decide", json=raw)).status_code == 401
        result = await client.post("/v1/perps/decide", json=raw, headers={"Authorization": "Bearer secret"})
        assert result.status_code == 200
        body = result.json()
        assert body["ok"] is True and body["decision"]["action"] == "hold"
        assert body["decision"]["snapshot_id"] == raw["snapshot_id"]
