"""The worker's closed research projection survives every decision leg."""
import asyncio
import json

from brain.graph import BrainGraph
from brain.schemas import BrainDecision, DecideRequest, MarketState, PortfolioQuality, PortfolioState


def test_long_strategy_and_closed_research_guidance_reach_analysts_and_manager():
    calls = []
    tail = "Explain project purpose only as attributed source claims."

    class Model:
        async def complete(self, **call):
            budget = call["budget"]
            budget.check_before(call["node"])
            budget.record(call["node"], "test", "offline", 10, 10)
            calls.append(call["node"])
            assert "strategy-brief" in call["user"]
            assert "never override portfolio gates or measured evidence" in call["user"]
            assert tail in call["user"]
            if call["node"].startswith("analyst:"):
                return json.dumps({"direction": "hold", "confidence": .8, "evidence_strength": .8, "note": "Measured volume is available."})
            return json.dumps({"action": "hold", "confidence": .8, "suggested_delta_usdg": 0, "thesis": "Waiting for stronger evidence."})

    req = DecideRequest(
        run_id="brief-test", agent_id="test", tier="pulse", stages="adaptive",
        persona="Trencher: " + "context " * 250 + tail,
        portfolio=PortfolioState(
            snapshot_id="book", as_of=1, cash_usdg=100_000_000,
            equity_usdg=100_000_000, net_contributions_usdg=100_000_000,
            quality=PortfolioQuality(audit_passed=True, epoch=1, current_accounting_history_auditable=True,
                                     contributions_known=True, equity_complete=True, gas_basis="net", position_history_available=True)),
        market=MarketState(snapshot_id="market", as_of=1, instrument_id="merrymen:meme", symbol="MEME", instrument_class="memecoin",
                           signals={"technical": "24h volume: $200000", "social": "50 distinct buyers", "liquidity": "$100000 pool reserves"}),
    )
    result = asyncio.run(BrainGraph(Model()).run(req))
    assert isinstance(result, BrainDecision), result
    assert result.action == "hold"
    assert calls[-1] == "portfolio-manager"
    assert len(calls) == 4
