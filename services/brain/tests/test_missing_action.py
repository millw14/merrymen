"""A model answer with no `action` must refuse, not become a confident hold.

A WRONG action was already caught: the schema types it as a literal, pydantic
raises, and the graph turns that into `output-invalid`. A MISSING one was not.
`data.get("action", "hold")` filled it in, a hold forces delta to 0 so the delta
rule passed, and the only remaining guard was a non-empty thesis — so the run
recorded a MODEL_HOLD carrying whatever confidence the model happened to report,
for a decision the model never made.

It is invisible downstream precisely because "hold" is the right answer most of
the time, and it is likeliest on the path that matters here: a model dropping a
key under a low-effort reasoning hint.
"""
import asyncio
import json
import pytest
from brain.graph import BrainGraph
from brain.schemas import DecideRequest, MarketState, PortfolioState, PortfolioQuality, BrainDecision, Refusal


def _request(run_id):
    return DecideRequest(
        run_id=run_id, agent_id="test", trigger_id="timer", tier="pulse", stages="adaptive",
        persona="Trencher: short-horizon memecoin trading. Hold if evidence is insufficient.",
        portfolio=PortfolioState(
            snapshot_id="book", as_of=1, cash_usdg=100_000_000, equity_usdg=100_000_000,
            net_contributions_usdg=100_000_000,
            quality=PortfolioQuality(
                audit_passed=True, epoch=1, current_accounting_history_auditable=True,
                contributions_known=True, equity_complete=True, gas_basis="net",
                position_history_available=True)),
        market=MarketState(
            snapshot_id="market", as_of=1, instrument_id="merrymen:meme", symbol="MEME",
            instrument_class="memecoin",
            signals={"technical": "24h volume: $200000", "social": "50 distinct buyers",
                     "liquidity": "$100000 pool reserves"}))


class _Model:
    """Analysts answer normally; the manager returns whatever `manager` says."""

    def __init__(self, manager):
        self.manager = manager

    async def complete(self, **call):
        budget = call["budget"]
        budget.check_before(call["node"])
        budget.record(call["node"], "test", "offline", 10, 10)
        if call["node"].startswith("analyst:"):
            return json.dumps({"direction": "hold", "confidence": .5,
                               "evidence_strength": .5, "note": "Recorded activity is mixed."})
        return json.dumps(self.manager)


def test_missing_action_refuses_instead_of_holding():
    # The exact shape: a well-formed answer that simply dropped one key. Every
    # other field is valid, which is why nothing else caught it.
    result = asyncio.run(BrainGraph(_Model({
        "confidence": .55,
        "suggested_delta_usdg": 0,
        "thesis": "Recorded activity is mixed and the depth is thin.",
    })).run(_request("missing-action")))
    assert isinstance(result, Refusal), f"expected a refusal, got {result}"
    assert result.reason == "output-invalid"
    # And it must say WHICH key, or the next reader is decoding this from a
    # stack trace the way this one was found.
    assert "action" in result.detail


def test_a_real_hold_is_still_a_hold():
    # The other direction, and the one that must not regress: an explicit hold
    # is a decision the model made and has to survive untouched.
    result = asyncio.run(BrainGraph(_Model({
        "action": "hold",
        "confidence": .55,
        "suggested_delta_usdg": 0,
        "thesis": "Recorded activity is mixed and the depth is thin.",
    })).run(_request("real-hold")))
    assert isinstance(result, BrainDecision), result
    assert result.action == "hold"


@pytest.mark.parametrize("action", ["buy", "sell"])
def test_an_expressed_action_is_unaffected(action):
    # Raising on a missing key can only ADD refusals. It must not be able to
    # change a decision the model actually expressed.
    result = asyncio.run(BrainGraph(_Model({
        "action": action,
        "confidence": .9,
        "suggested_delta_usdg": 5_000_000 if action == "buy" else -5_000_000,
        "thesis": "Recorded activity supports this short-horizon decision.",
    })).run(_request(f"expressed-{action}")))
    assert isinstance(result, BrainDecision), result
    assert result.action == action


def test_a_null_action_is_refused_too():
    # `"action": None` passes an `in` check but is not an action. str(None)
    # would have become "none", which is not a literal the schema accepts, so
    # this already refused — pinned so the `in` check above cannot be "fixed"
    # into a truthiness test that lets it through as a hold.
    result = asyncio.run(BrainGraph(_Model({
        "action": None,
        "confidence": .55,
        "suggested_delta_usdg": 0,
        "thesis": "Recorded activity is mixed.",
    })).run(_request("null-action")))
    assert isinstance(result, Refusal), f"expected a refusal, got {result}"
    assert result.reason == "output-invalid"
