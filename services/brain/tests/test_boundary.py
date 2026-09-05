"""
THE THREE BOUNDARIES, tested without spending a token.

Each of these is a rule that only matters when someone is not paying attention,
which is exactly when a test is the only thing enforcing it:

  the credential boundary   Brain cannot spend the fleet's allowance
  the accounting boundary   Brain carries core's figures, never derives them
  the depth boundary        the committee runs on evidence, not by default
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from brain.budget import RunBudget, TIERS
from brain.credential import CredentialRefused, resolve
from brain.escalation import analysts_disagree, assess as escalate
from brain.gate import assess as gate_assess
from brain.graph import BrainGraph
from brain.schemas import DecideRequest
from brain.snapshot import SnapshotUnreadable, from_canonical, pnl_line

SNAPSHOT = Path(__file__).resolve().parent.parent / ".eval" / "canary-snapshot.json"


# ── the credential boundary ────────────────────────────────────────────────


def test_brain_will_not_use_the_fleet_key():
    # The 24 live agents read GROQ_API_KEY. A background feature once emptied
    # that allowance and the first symptom was a user's chat breaking.
    with pytest.raises(CredentialRefused, match="same credential"):
        resolve({"BRAIN_LLM_API_KEY": "shared", "GROQ_API_KEY": "shared"})


def test_brain_refuses_when_it_has_no_key_of_its_own():
    with pytest.raises(CredentialRefused, match="not set"):
        resolve({"GROQ_API_KEY": "fleet"})
    # …and says WHERE the tempting key is, so the fix is obvious.
    with pytest.raises(CredentialRefused, match="fleet's key"):
        resolve({"GROQ_API_KEY": "fleet"})


def test_a_distinct_key_is_accepted_and_never_logged_whole():
    c = resolve({"BRAIN_LLM_API_KEY": "gsk_brainkey_abcd", "GROQ_API_KEY": "fleet"})
    assert c.source == "BRAIN_LLM_API_KEY"
    assert c.fingerprint == "…abcd"
    assert c.key not in c.fingerprint


# ── the accounting boundary ────────────────────────────────────────────────


@pytest.mark.skipif(not SNAPSHOT.exists(), reason="canonical snapshot fixture not generated")
def test_brain_carries_cores_equity_rather_than_summing_it():
    raw = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    st = from_canonical(raw)
    # 3.334 cash + 6.55 TSLA = 9.884. Summing positions HERE would be a second
    # NAV implementation and would miss the vault and quarantined legs.
    assert st.equity_usdg == raw["equityUsdg"] == 9_884_000
    assert st.net_contributions_usdg == 10_000_000


@pytest.mark.skipif(not SNAPSHOT.exists(), reason="canonical snapshot fixture not generated")
def test_core_has_the_last_word_on_publishability():
    raw = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    # The canary's contributions are repaired and evidenced, but it is still in
    # epoch 1 — unauditable by construction. Brain must not decide otherwise.
    assert raw["pnl"]["publishable"] is False
    assert raw["pnl"]["unavailable"] == "epoch-unauditable"
    g = gate_assess(from_canonical(raw))
    assert g.verdict == "downgrade-to-hold"
    assert not g.may_size
    assert "epoch unauditable" in g.why


def test_a_snapshot_missing_a_figure_is_refused_not_filled_in():
    with pytest.raises(SnapshotUnreadable, match="equityUsdg"):
        from_canonical(
            {
                "schemaVersion": "1.0.0",
                "snapshotId": "s",
                "asOf": 1,
                "cashUsdg": 100,
                "quality": {},
                # equityUsdg absent — the temptation is to sum the positions.
            }
        )


def test_an_unknown_schema_version_is_refused():
    with pytest.raises(SnapshotUnreadable, match="1.0.0"):
        from_canonical({"schemaVersion": "2.0.0"})


def test_the_prompt_line_never_states_a_return_it_cannot_back():
    unmeasurable = pnl_line({"pnl": {"publishable": False, "unavailable": "contributions-unknown"}})
    assert "NOT MEASURABLE" in unmeasurable
    assert "Do not state or imply a return" in unmeasurable

    gross = pnl_line({"pnl": {"publishable": True, "usdgSinceContribution": -116_000, "gasBasis": "gross"}})
    assert "-0.116000 USDG" in gross
    assert "GROSS of gas" in gross, "the qualifier travels with the figure"


# ── the depth boundary ─────────────────────────────────────────────────────


def test_a_hold_never_escalates():
    # Both measured regressions went committee-turns-a-trade-into-a-hold. Paying
    # 2.3x to make a non-trade more thoroughly a non-trade is the worst trade
    # available.
    v = escalate(
        action="hold", confidence=0.2, delta_usdg=0, equity_usdg=1_000_000,
        holds_position=False, analyst_reports=["bullish", "bearish"],
    )
    assert not v.escalate


def test_disagreeing_analysts_escalate():
    assert analysts_disagree(["strong breakout, bullish", "auditor resigned, bearish"])
    assert not analysts_disagree(["bullish beat", "positive upside"])
    v = escalate(
        action="buy", confidence=0.8, delta_usdg=1_000, equity_usdg=1_000_000,
        holds_position=True, analyst_reports=["strong bullish breakout", "weak, negative, breakdown"],
    )
    assert v.escalate and "analysts-disagree" in v.reasons


def test_a_large_bet_escalates():
    v = escalate(
        action="buy", confidence=0.9, delta_usdg=400_000, equity_usdg=1_000_000,
        holds_position=True, analyst_reports=["bullish"],
    )
    assert v.escalate and "large-relative-to-book" in v.reasons


def test_low_confidence_never_escalates_on_its_own():
    # A model's stated confidence is the least reliable number it emits. If it
    # escalated alone, every hedged answer would buy itself a committee.
    v = escalate(
        action="buy", confidence=0.05, delta_usdg=1_000, equity_usdg=1_000_000,
        holds_position=True, analyst_reports=["bullish and positive"],
    )
    assert not v.escalate, "low confidence sharpens an existing case, it does not make one"


def test_an_ordinary_add_to_a_working_position_does_not_escalate():
    v = escalate(
        action="buy", confidence=0.7, delta_usdg=10_000, equity_usdg=1_000_000,
        holds_position=True, analyst_reports=["bullish beat", "positive upside"],
    )
    assert not v.escalate
    assert v.primary == "no-escalation"


def test_brains_epoch_floor_agrees_with_core():
    # The 36-scenario ablation caught this: the local gate defaulted to an epoch
    # floor of 1 while packages/core reports anything below 2 as unpublishable,
    # so `epoch_one` returned BUY on a book core calls unmeasurable. Two epoch
    # rules is a second accounting implementation, and the local one was the
    # LENIENT half — the dangerous direction to drift in.
    from brain.gate import MIN_AUDITABLE_EPOCH
    from brain.schemas import PortfolioQuality, PortfolioState

    assert MIN_AUDITABLE_EPOCH == 2, "must match computePnl in packages/core"

    epoch_one = PortfolioState(
        snapshot_id="s", as_of=1, cash_usdg=300_000_000, equity_usdg=300_000_000,
        net_contributions_usdg=300_000_000,
        quality=PortfolioQuality(
            audit_passed=True, epoch=1, contributions_known=True, equity_complete=True,
            gas_basis="net", position_history_available=True,
        ),
    )
    g = gate_assess(epoch_one)
    assert g.verdict == "refuse"
    assert not g.may_size, "epoch 1 is forensic; nothing may be sized against it"
