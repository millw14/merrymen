"""
EVERY PROMPT, BYTE FOR BYTE, for requests that carry no desk policy.

WHY A SNAPSHOT AND NOT SUBSTRINGS. The trusted desk-policy channel
(`strategy_terms`, `horizon`) is opt-in: a Brain deploy must change nothing for
a worker that does not send it. Substring tests prove what a prompt contains;
only a byte comparison proves nothing ELSE moved — a reordered sentence, a new
blank line, a heading that changed for everyone. The fixture was generated from
the prompts as they stood BEFORE the channel existed, so it pins today's
behaviour rather than whatever the channel's own code produces.

THE CASES COVER EVERY NODE AND EVERY BRANCH a prompt is built in: a pulse
memecoin review (three analysts and a decision), a full-committee equity run
with the gate shut and the trade cost unknown (analysts, both debaters, three
risk voices, a decision), and a following run with trader material (the
SELECTIVE_FOLLOWING system block and the third-party dossier block).

UPDATING IT. Set BRAIN_UPDATE_PROMPT_SNAPSHOT=1 and run this file ONLY when a
prompt change is the point of the commit, and say so in the commit. An update
made to quiet a failure is exactly the regression this file exists to catch.

No model is called and nothing leaves the process.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest

from brain.graph import BrainGraph
from brain.schemas import (
    BrainDecision,
    DecideRequest,
    MarketState,
    PortfolioQuality,
    PortfolioState,
    Position,
)

SNAPSHOT = Path(__file__).resolve().parent / "data" / "prompts_without_desk_policy.json"

PERSONA = (
    "Trencher: short-horizon memecoin trading. Evaluate real volume, two-sided flow, "
    "liquidity, costs and reversal risk. Hold if evidence or net edge is insufficient."
)


def _quality(**over) -> PortfolioQuality:
    base = dict(
        audit_passed=True, epoch=1, current_accounting_history_auditable=True,
        contributions_known=True, equity_complete=True, gas_basis="net",
        position_history_available=True,
    )
    base.update(over)
    return PortfolioQuality(**base)


def _portfolio(*, quality=None, positions=None) -> PortfolioState:
    return PortfolioState(
        snapshot_id="book-1", as_of=1_760_000_000, cash_usdg=40_000_000, equity_usdg=52_500_000,
        net_contributions_usdg=50_000_000, positions=positions or [], quality=quality or _quality(),
    )


def pulse_memecoin(**extra) -> DecideRequest:
    return DecideRequest(
        run_id="snap-pulse", agent_id="agent-a", trigger_id="scheduled-review_1", tier="pulse",
        persona=PERSONA,
        memory=["Held MEME for 20 minutes; exited flat after volume faded.", "Previous view: hold."],
        portfolio=_portfolio(),
        market=MarketState(
            snapshot_id="mkt-1", as_of=1_760_000_000, instrument_id="merrymen:meme", symbol="MEME",
            instrument_class="memecoin", price_usd="0.0000123", expected_trade_gas_usdg=760_000,
            signals={
                "technical": "5m: +4.1% on $18,200 volume; 1h: +11% on $140,000; 24h: -6%.",
                "social": "5m: 41 buys / 22 sells from 37 distinct buyers.",
                "liquidity": "Pool reserves about $96,000; depth to 2% impact about $1,900.",
                "builder": "Directory page lists a site and a repository updated 3 days ago.",
            },
        ),
        **extra,
    )


def full_equity_shut_gate(**extra) -> DecideRequest:
    return DecideRequest(
        run_id="snap-full", agent_id="agent-b", trigger_id="price-move_2", tier="research", stages="full",
        persona="You are Robin, a Merryman.",
        portfolio=_portfolio(
            quality=_quality(equity_complete=False, quarantined_assets_present=True, position_history_available=False),
            positions=[Position(instrument_id="merrymen:tsla", symbol="TSLA", qty="0.1", value_usdg=12_500_000)],
        ),
        market=MarketState(
            snapshot_id="mkt-2", as_of=1_760_000_000, instrument_id="merrymen:tsla", symbol="TSLA",
            instrument_class="equity-token", price_usd="125.00", expected_trade_gas_usdg=None,
            signals={
                "technical": "20-day 118.4, 50-day 117.9; volume 1.4x the 30-day average.",
                "news": "Quarterly deliveries reported above consensus.",
                "sentiment": "Two peers published a hold on TSLA this week.",
            },
        ),
        **extra,
    )


FLOW = (
    "Source: trader activity reported by a third-party platform, grouped by Merrymen.\n"
    "Activity over 24h: 5 distinct buyers and 2 distinct sellers. [ref:snap1]"
)


def following_memecoin(**extra) -> DecideRequest:
    req = pulse_memecoin(**extra)
    signals = {**req.market.signals, "trader-flow": FLOW}
    signals.pop("builder")
    return req.model_copy(update={
        "run_id": "snap-follow",
        "market": req.market.model_copy(update={"signals": signals}),
    })


CASES = {
    "pulse-memecoin": pulse_memecoin,
    "full-equity-shut-gate": full_equity_shut_gate,
    "following-memecoin": following_memecoin,
}


class Recorder:
    """Deterministic answers for every node, and a record of what each was asked."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def complete(self, **call):
        call["budget"].check_before(call["node"])
        call["budget"].record(call["node"], "test", "offline", 10, 10)
        self.calls.append(call)
        node = call["node"]
        if node.startswith("analyst:"):
            return json.dumps({"direction": "hold", "confidence": .5, "evidence_strength": .5,
                               "note": "nothing decisive in this lens"})
        if node == "portfolio-manager":
            return json.dumps({"action": "hold", "confidence": .5, "suggested_delta_usdg": 0,
                               "thesis": "Evidence is mixed; holding.", "time_horizon": "short"})
        return f"{node}: the evidence is thin either way."

    def prompts(self) -> list[dict]:
        return [
            {"node": c["node"], "deep": bool(c.get("deep", False)), "system": c["system"], "user": c["user"]}
            for c in self.calls
        ]


def record(req: DecideRequest) -> tuple[list[dict], object]:
    model = Recorder()
    result = asyncio.run(BrainGraph(model).run(req))
    return model.prompts(), result


def test_every_prompt_without_a_desk_policy_is_byte_identical_to_the_snapshot():
    got = {}
    for name, build in CASES.items():
        prompts, result = record(build())
        assert isinstance(result, BrainDecision), (name, result)
        got[name] = prompts

    if os.getenv("BRAIN_UPDATE_PROMPT_SNAPSHOT") == "1":
        SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
        SNAPSHOT.write_text(json.dumps(got, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        pytest.skip("prompt snapshot rewritten; review the diff before committing it")

    want = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    assert sorted(got) == sorted(want)
    for name in want:
        assert [p["node"] for p in got[name]] == [p["node"] for p in want[name]], name
        for g, w in zip(got[name], want[name]):
            # One assertion per field, so a failure names the node and the half.
            assert g["deep"] == w["deep"], (name, w["node"])
            assert g["system"] == w["system"], (name, w["node"], "system")
            assert g["user"] == w["user"], (name, w["node"], "user")


def test_the_cases_reach_every_node_and_branch():
    # A snapshot that never reached a branch cannot say the branch is unchanged.
    nodes = {p["node"] for build in CASES.values() for p in record(build())[0]}
    assert {"debate:bull", "debate:bear", "risk:aggressive", "risk:conservative", "risk:neutral",
            "portfolio-manager", "analyst:trader-flow", "analyst:builder", "analyst:news"} <= nodes
    follow, _ = record(following_memecoin())
    assert "THIRD-PARTY TRADER ACTIVITY IS IN THIS DOSSIER" in follow[-1]["system"]
    shut, _ = record(full_equity_shut_gate())
    assert "YOU MAY NOT SIZE A POSITION" in shut[-1]["user"]
    assert "COULD NOT BE PRICED" in shut[-1]["user"]
