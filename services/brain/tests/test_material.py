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
