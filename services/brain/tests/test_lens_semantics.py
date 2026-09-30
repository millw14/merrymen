"""A lens with no time dimension must be able to answer, and to object.

MEASURED on the fleet 2026-09-20: the liquidity lens returned `hold` on 173 of
173 observations, while technical and social — same suffix, same runs, but each
handed m5/h1/h6/h24 windows — voted buy about a fifth of the time.

That was not caution. The liquidity block carries reserve, route depth, FDV and
a maximum entry size: levels, with no price, no change, no volume and no flow.
"buy" as the suffix means it is a claim about direction, which the block cannot
support; `no-data` is false when the depth is plainly readable; and the Trencher
persona closes `sell` ("a bearish view means HOLD, not SELL"). `hold` was the
only arm left, every time.

The cost was never the missing buys — `direction` gates nothing. It is that a
pool with $8M of depth and a pool about to be drained both printed `hold`, so
the lens had no way to object to either. These tests pin that it now can.
"""
import asyncio
import json
import pytest
from brain.analyst import LENS_DIRECTION_SEMANTICS, STRUCTURED_SUFFIX
from brain.graph import BrainGraph
from brain.schemas import DecideRequest, MarketState, PortfolioState, PortfolioQuality, BrainDecision


def _request(signals):
    return DecideRequest(
        run_id="lens-test", agent_id="test", trigger_id="timer", tier="pulse", stages="adaptive",
        persona="Trencher: short-horizon memecoin trading. A bearish view means HOLD, not SELL.",
        portfolio=PortfolioState(
            snapshot_id="book", as_of=1, cash_usdg=100_000_000, equity_usdg=100_000_000,
            net_contributions_usdg=100_000_000,
            quality=PortfolioQuality(
                audit_passed=True, epoch=1, current_accounting_history_auditable=True,
                contributions_known=True, equity_complete=True, gas_basis="net",
                position_history_available=True)),
        market=MarketState(
            snapshot_id="market", as_of=1, instrument_id="merrymen:meme", symbol="MEME",
            instrument_class="memecoin", signals=signals))


SIGNALS = {
    "technical": "24h volume: $200000",
    "social": "50 distinct buyers",
    "liquidity": '{"onchainRouteDepthUsd": 7941061, "maxEntryUsd": 5}',
}


class _Recorder:
    """Captures what each lens was actually asked."""

    def __init__(self, manager=None):
        self.prompts: dict[str, str] = {}
        self.manager = manager or {
            "action": "hold", "confidence": .5, "suggested_delta_usdg": 0,
            "thesis": "Recorded activity is mixed.",
        }

    async def complete(self, **call):
        call["budget"].check_before(call["node"])
        call["budget"].record(call["node"], "test", "offline", 10, 10)
        self.prompts[call["node"]] = call["user"]
        if call["node"].startswith("analyst:"):
            return json.dumps({"direction": "hold", "confidence": .5,
                               "evidence_strength": .5, "note": "depth is ample"})
        self.prompts["manager"] = call["user"]
        return json.dumps(self.manager)


def _run(model, signals=SIGNALS):
    return asyncio.run(BrainGraph(model).run(_request(signals)))


class TestArmsTheLensCanAnswer:
    def test_the_liquidity_lens_is_told_what_its_arms_mean(self):
        m = _Recorder()
        _run(m)
        asked = m.prompts["analyst:liquidity"]
        assert "the depth you can see supports entering" in asked
        assert "too thin, too concentrated, or costly to exit" in asked

    def test_it_is_told_a_small_entry_into_a_deep_pool_is_worth_saying(self):
        # The owner's words: the $5 cap is a sizing constraint, not evidence
        # that a token has no opportunity. The lens is told so explicitly.
        m = _Recorder()
        _run(m)
        asked = m.prompts["analyst:liquidity"]
        assert "entry limit is a portfolio constraint, not a fact about the pool" in asked

    def test_no_data_stays_reserved_for_depth_that_could_not_be_read(self):
        # The failure this must not create: an unavailable metric arriving as a
        # bearish one. `no-data` may never become "depth I disliked".
        assert "Never use this for depth you dislike" in LENS_DIRECTION_SEMANTICS["liquidity"]

    @pytest.mark.parametrize("lens", ["technical", "social"])
    def test_directional_lenses_are_left_alone(self, lens):
        # They already vote buy ~20% of the time on the base suffix. Redefining
        # their arms would change behaviour that is working.
        assert lens not in LENS_DIRECTION_SEMANTICS
        m = _Recorder()
        _run(m)
        assert "the depth you can see supports entering" not in m.prompts[f"analyst:{lens}"]

    def test_every_lens_still_gets_the_base_suffix(self):
        m = _Recorder()
        _run(m)
        for lens in ("technical", "social", "liquidity"):
            assert STRUCTURED_SUFFIX.strip() in m.prompts[f"analyst:{lens}"], lens

    def test_the_semantics_are_appended_not_substituted(self):
        # Replacing the suffix would drop the JSON shape and every lens would
        # start failing to parse.
        m = _Recorder()
        _run(m)
        asked = m.prompts["analyst:liquidity"]
        assert asked.index(STRUCTURED_SUFFIX.strip()) < asked.index("the depth you can see supports entering")


class TestTheManagerCanReadTheBrackets:
    def test_the_dossier_explains_what_hold_means(self):
        # `[hold conf=0.88]` from a lens sure the pool is deep read as a strong
        # vote AGAINST trading — the inverse of what it meant.
        m = _Recorder()
        _run(m)
        dossier = m.prompts["manager"]
        assert "abstention" in dossier
        assert "not a vote against trading" in dossier

    def test_it_explains_what_confidence_measures(self):
        m = _Recorder()
        _run(m)
        assert "how sure it is OF ITS READING, not how strongly it wants to act" in m.prompts["manager"]

    def test_a_hold_that_names_a_reservation_is_still_a_reservation(self):
        # The legend must not teach the manager to discard every hold. A lens
        # that objects has to keep its weight.
        m = _Recorder()
        _run(m)
        assert "A `hold` that names a reservation is a reservation" in m.prompts["manager"]

    def test_the_reports_themselves_still_arrive(self):
        m = _Recorder()
        _run(m)
        dossier = m.prompts["manager"]
        assert "[analyst:liquidity]" in dossier
        assert "depth is ample" in dossier, "the note is where the real reading lives"


class TestNothingElseMoved:
    @pytest.mark.parametrize("action", ["buy", "sell", "hold"])
    def test_an_expressed_decision_is_unaffected(self, action):
        # Neither change may alter what the desk decides when the model has
        # actually decided something.
        m = _Recorder(manager={
            "action": action, "confidence": .9,
            "suggested_delta_usdg": 5_000_000 if action == "buy" else -5_000_000 if action == "sell" else 0,
            "thesis": "Recorded activity supports this short-horizon decision.",
        })
        result = _run(m)
        assert isinstance(result, BrainDecision), result
        assert result.action == action

    def test_a_lens_with_no_material_gets_no_semantics(self):
        # A missing liquidity signal must not acquire semantics for evidence it
        # does not have.
        m = _Recorder()
        _run(m, signals={"technical": "24h volume: $200000", "social": "50 buyers"})
        assert "analyst:liquidity" not in m.prompts
