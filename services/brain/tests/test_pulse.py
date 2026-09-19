"""Pulse must reserve a model call for the decision, inside its existing ceiling."""
import asyncio
import json
import pytest
from brain.graph import BrainGraph
from brain.schemas import DecideRequest, MarketState, PortfolioState, PortfolioQuality, BrainDecision


@pytest.mark.parametrize("action", ["buy", "sell", "hold"])
def test_pulse_decides_within_four_calls_without_committee_escalation(action):
    calls = []

    class Model:
        async def complete(self, **call):
            budget = call["budget"]
            budget.check_before(call["node"])
            budget.record(call["node"], "test", "offline", 10, 10)
            calls.append(call["node"])
            if call["node"].startswith("analyst:"):
                return json.dumps({"direction": "buy", "confidence": .9, "evidence_strength": .9, "note": "Volume and depth are recorded."})
            return json.dumps({"action": action, "confidence": .9, "suggested_delta_usdg": 5_000_000 if action == "buy" else -5_000_000 if action == "sell" else 0, "thesis": "Recorded activity supports this short-horizon paper decision."})

    req = DecideRequest(run_id="pulse-test", agent_id="test", trigger_id="timer", tier="pulse", stages="adaptive",
        portfolio=PortfolioState(snapshot_id="book", as_of=1, cash_usdg=100_000_000, equity_usdg=100_000_000, net_contributions_usdg=100_000_000,
            quality=PortfolioQuality(audit_passed=True, epoch=1, current_accounting_history_auditable=True, contributions_known=True, equity_complete=True, gas_basis="net", position_history_available=True)),
        market=MarketState(snapshot_id="market", as_of=1, instrument_id="merrymen:meme", symbol="MEME", instrument_class="memecoin",
            signals={"technical": "24h volume: $200000", "social": "50 distinct buyers", "liquidity": "$100000 pool reserves"}))
    result = asyncio.run(BrainGraph(Model()).run(req))
    assert isinstance(result, BrainDecision), result
    assert result.action == action
    assert len(calls) == 4
    assert calls[-1] == "portfolio-manager"
    assert "analyst:onchain" not in calls
    assert not any("risk" in c or "debate" in c for c in calls)
