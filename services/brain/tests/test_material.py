"""
THE MATERIAL BOUNDARY — the one the budget cannot enforce.

`check_before` bounds the call AFTER the current one. So an oversized block of
lens material passes the ceiling test and then breaches it inside the very call
it was cleared for: the research tier is 200,000 tokens, and a single renderer
that grows without a cap reaches that on its own, in one call, having already
been approved. The budget is the wrong place to catch it; the request schema is
the only place that sees the material before a token is spent.

This repo has the scar: a research loop once consumed 195,881 of 200,000 tokens
on a key the whole fleet shares, and the first symptom was a user's chat
breaking. Three new memecoin lenses are three more renderers pointed at that
same ceiling.

The key allowlist is a second, quieter rule. A lens costs a model call whether
or not it was fed, so material under a key no desk reads is paid for and
discarded — and a desk asking for a lens no request may carry is a hole that
answers NO DATA AVAILABLE forever at full price. graph.py checks that pairing at
import; these check it from the other side.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from brain.graph import _DESK, _DEFAULT_DESK, _lenses_for
from brain.schemas import LENS_KEYS, MAX_LENS_CHARS, MAX_SIGNALS_CHARS, MarketState

BASE = dict(
    snapshot_id="s",
    as_of=1,
    instrument_id="merrymen:wif",
    symbol="WIF",
    instrument_class="memecoin",
)


def test_one_oversized_renderer_cannot_reach_the_tier_ceiling():
    # The failure this exists for, in one line: not a slow leak across a run,
    # but a single block big enough to blow a call that was already approved.
    with pytest.raises(ValidationError, match="over 8000"):
        MarketState(**BASE, signals={"liquidity": "x" * (MAX_LENS_CHARS + 1)})


def test_nor_can_several_that_are_each_individually_fine():
    # A per-lens cap alone is not a bound on a run: the memecoin desk asks for
    # four lenses and the equity desk for five, so the whole-request total is
    # the figure that actually sits under the ceiling.
    each = "y" * MAX_LENS_CHARS
    with pytest.raises(ValidationError, match="signals total"):
        MarketState(**BASE, signals={"technical": each, "onchain": each, "social": each, "liquidity": each})


def test_material_under_a_key_no_desk_reads_is_refused():
    # Not a typo guard. Material here is paid for at the analyst that reads it,
    # so a key nobody reads is a cost with no reader — and silently ignoring it
    # would let a supplier believe a lens was fed when it never was.
    with pytest.raises(ValidationError, match="is not a lens"):
        MarketState(**BASE, signals={"holders": "top wallet owns 40%"})


def test_every_lens_any_desk_asks_for_may_actually_be_supplied():
    # The pairing, from the request's side. graph.py raises at import if a desk
    # names a lens outside LENS_KEYS; this fails loudly rather than at import if
    # that check is ever removed.
    asked = {lens for desk in [*_DESK.values(), _DEFAULT_DESK] for lens in desk}
    assert asked <= LENS_KEYS, f"desk asks for lenses no request may carry: {sorted(asked - LENS_KEYS)}"


def test_the_memecoin_desk_can_be_fed_the_lens_the_worker_now_renders():
    # The change this file arrived with: `liquidity` is on the memecoin desk and
    # the worker computes it from reserves it already read. A cap that refused
    # the material it was written for would be a cap that broke the feature.
    assert "liquidity" in _lenses_for("memecoin")
    ok = MarketState(**BASE, signals={"liquidity": "OVERHANG: the price would fall 36.0%"})
    assert ok.signals["liquidity"].startswith("OVERHANG")


def test_the_ceilings_stay_far_under_the_tier():
    # ~4 chars a token. The whole-request cap is ~6,000 tokens of material
    # against a 200,000-token research tier — deliberately an order of magnitude
    # clear, because the budget cannot correct an overshoot mid-call.
    from brain.budget import TIERS

    assert MAX_SIGNALS_CHARS / 4 < TIERS["research"].max_tokens / 10
    assert MAX_LENS_CHARS <= MAX_SIGNALS_CHARS


def test_the_memecoin_desk_can_be_fed_the_builder_lens():
    """
    THE FIFTH LENS, and the first that is not a reading of the tape.

    Same pairing check as `liquidity` above and for the same reason: a desk
    that asks for a lens the request schema will not carry answers NO DATA
    AVAILABLE forever, at the price of a model call every time.
    """
    assert "builder" in LENS_KEYS
    assert "builder" in _lenses_for("memecoin")
    ok = MarketState(**BASE, signals={"builder": "A public directory of projects on this chain"})
    assert ok.signals["builder"].startswith("A public directory")


def test_the_builder_lens_is_last_on_the_memecoin_desk():
    """
    ORDER IS PRIORITY, because the pulse tier keeps the first three lenses that
    have material and drops the rest. The tape moves inside a pulse; whether
    somebody is shipping does not, so it is the reading that can wait.
    """
    meme = _lenses_for("memecoin")
    assert meme[-1] == "builder"
    for market_lens in ("technical", "onchain", "liquidity"):
        assert meme.index(market_lens) < meme.index("builder")


def test_no_other_desk_asks_for_a_builder_reading():
    """
    An equity token on this chain is a wrapper around a company's shares, and
    "who ships Apple" is not a question this lens is being asked. A desk that
    asked would be billed for an analyst the worker never supplies material to.
    """
    for instrument_class, lenses in _DESK.items():
        if instrument_class == "memecoin":
            continue
        assert "builder" not in lenses, instrument_class
    assert "builder" not in _DEFAULT_DESK


def test_the_builder_arms_forbid_no_data_for_a_record_it_dislikes():
    """
    THE ONE CONFUSION THIS LENS EXISTS TO PREVENT, pinned in the prompt.

    An unlisted coin is never given material at all — the worker omits the
    block and the graph says NO DATA AVAILABLE. So if an analyst that WAS shown
    a record may also answer `no-data`, an unlisted coin and a coin with a dead
    team collapse into one answer, which is exactly the distinction the whole
    lens was built to carry.
    """
    from brain.analyst import LENS_DIRECTION_SEMANTICS

    arms = LENS_DIRECTION_SEMANTICS["builder"]
    assert "Never use this for a record you dislike" in arms
    # Wrapped across a line in the source, so the check is on the claim rather
    # than on where the prompt happens to break.
    assert "diligent rug" in arms
    assert "Shipping is not safety" in arms


def test_a_pulse_run_still_affords_only_three_analysts():
    """
    The budget is `TIERS["pulse"].max_calls` = 4, one of which is the decision.
    Reserving a slot must not become a way of buying a fourth analyst.
    """
    from brain.budget import TIERS
    from brain.graph import PULSE_ANALYSTS, _pulse_lenses

    assert PULSE_ANALYSTS == TIERS["pulse"].max_calls - 1
    fed = {lens: "material" for lens in _lenses_for("memecoin")}
    assert len(_pulse_lenses(_lenses_for("memecoin"), fed)) == PULSE_ANALYSTS


def test_the_builder_lens_gets_a_slot_when_it_has_material():
    """
    THE BUG THIS EXISTS TO PREVENT, and it was live in production.

    `builder` is last on the memecoin desk and pulse is the only tier that desk
    is ever asked for, so a strict prefix of the first three fed lenses never
    reached it. Measured on the fleet 2026-09-22: every memecoin review ran
    technical, social and liquidity, and the builder lens was not consulted a
    single time.
    """
    from brain.graph import _pulse_lenses

    desk = _lenses_for("memecoin")
    # Exactly the production shape: onchain unfed, everything else fed.
    signals = {"technical": "t", "social": "s", "liquidity": "l", "builder": "b"}
    chosen = _pulse_lenses(desk, signals)
    assert "builder" in chosen, "the one lens that is not a reading of the tape"
    assert len(chosen) == 3, "and it did not buy itself an extra call"


def test_the_held_slot_displaces_a_market_lens_rather_than_the_budget():
    # The trade, pinned: three correlated readings of one tape, minus one, plus
    # the uncorrelated one. If this ever stops being a displacement it has
    # become a budget increase and should be argued for as one.
    from brain.graph import _pulse_lenses

    desk = _lenses_for("memecoin")
    without = _pulse_lenses(desk, {"technical": "t", "social": "s", "liquidity": "l"})
    with_builder = _pulse_lenses(desk, {"technical": "t", "social": "s", "liquidity": "l", "builder": "b"})
    assert len(without) == len(with_builder)
    assert set(without) - set(with_builder), "something had to give way"


def test_a_desk_whose_reserved_lens_is_unfed_behaves_exactly_as_before():
    """
    The common case — most launchpad coins are unlisted, so `builder` is
    usually empty — and it must be bit-for-bit the old behaviour.
    """
    from brain.graph import PULSE_ANALYSTS, _pulse_lenses

    desk = _lenses_for("memecoin")
    signals = {"technical": "t", "social": "s", "liquidity": "l"}
    old = [lens for lens in desk if signals.get(lens)][:PULSE_ANALYSTS]
    assert _pulse_lenses(desk, signals) == old


def test_reports_come_back_in_desk_order_not_selection_order():
    # A reserved lens is picked first and must still be REPORTED where the desk
    # puts it, or the same run reads differently depending on what was fed.
    from brain.graph import _pulse_lenses

    desk = _lenses_for("memecoin")
    chosen = _pulse_lenses(desk, {"technical": "t", "liquidity": "l", "builder": "b"})
    assert chosen == [lens for lens in desk if lens in set(chosen)]
    assert chosen.index("technical") < chosen.index("builder")


def test_only_a_scarce_lens_may_hold_a_slot():
    """
    Membership is about SCARCITY plus INDEPENDENCE, not importance. A lens that
    is usually fed would displace a market lens on nearly every run — a
    different decision entirely, and one that belongs in the desk order where
    it can be seen.
    """
    from brain.graph import PULSE_RESERVED_LENSES

    assert PULSE_RESERVED_LENSES == frozenset({"builder"})
    assert PULSE_RESERVED_LENSES <= LENS_KEYS, "a reserved lens no desk may carry is dead weight"
