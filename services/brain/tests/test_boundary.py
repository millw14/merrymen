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
from brain.analyst import AnalystView, disagreement, parse_view
from brain.escalation import assess as escalate
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
        holds_position=False, disagree=disagreement([]),
    )
    assert not v.escalate


def _view(lens: str, direction: str, conf: float) -> AnalystView:
    return AnalystView(lens=lens, direction=direction, confidence=conf, evidence_strength=0.7, note="")


def test_disagreement_is_computed_from_fields_not_prose():
    # The keyword scan this replaces fired ZERO times across 36 scenarios,
    # including ones built to disagree. Analysts write carefully — a bear case
    # opens "the breakout is real, but…" and scores bullish.
    two_sided = disagreement([_view("technical", "buy", 0.72), _view("news", "sell", 0.66)])
    assert two_sided.present
    assert disagreement([_view("technical", "buy", 0.8), _view("news", "buy", 0.7)]).present is False


def test_a_hedge_is_not_a_side():
    # Two analysts who each half-believe opposite things are not in conflict.
    # They are both saying they do not know, which is agreement about the
    # evidence — and paying 45 calls for it is the false positive that would
    # make escalation worthless.
    weak = disagreement([_view("technical", "buy", 0.72), _view("news", "sell", 0.30)])
    assert weak.present is False
    assert "no two-sided conviction" in weak.detail


def test_an_unparseable_analyst_is_no_data_not_a_guess():
    assert parse_view("news", "not json at all").direction == "no-data"
    assert parse_view("news", "").direction == "no-data"
    good = parse_view("technical", '{"direction":"buy","confidence":0.7,"evidence_strength":0.6,"note":"n"}')
    assert good.direction == "buy" and good.confidence == 0.7


def test_disagreeing_analysts_escalate():
    v = escalate(
        action="buy", confidence=0.8, delta_usdg=1_000, equity_usdg=1_000_000,
        holds_position=True, disagree=disagreement([_view("technical", "buy", 0.8), _view("news", "sell", 0.7)]),
    )
    assert v.escalate and "analysts-disagree" in v.reasons


def test_the_size_and_opening_rules_are_off_because_they_measured_harmful():
    # 36 scenarios: escalation changed 7 decisions, 1 improved and 6 regressed,
    # and every change went trade -> hold. The debate stack has a systematic bias
    # toward inaction, so escalating a trade candidate reliably kills it.
    from brain.escalation import SIZE_AND_OPENING_RULES_ENABLED

    assert SIZE_AND_OPENING_RULES_ENABLED is False
    big = escalate(
        action="buy", confidence=0.9, delta_usdg=400_000, equity_usdg=1_000_000,
        holds_position=False, disagree=disagreement([]),
    )
    assert not big.escalate, "a large opening bet no longer buys a committee"


def test_genuine_two_sided_disagreement_still_escalates():
    # The one rule kept: it has a principled case and it never fired on the set
    # where the others did harm, so nothing measured argues against it.
    v = escalate(
        action="buy", confidence=0.8, delta_usdg=1_000, equity_usdg=1_000_000,
        holds_position=True,
        disagree=disagreement([_view("technical", "buy", 0.8), _view("news", "sell", 0.7)]),
    )
    assert v.escalate and v.reasons == ["analysts-disagree"]


def test_low_confidence_never_escalates_on_its_own():
    # A model's stated confidence is the least reliable number it emits. If it
    # escalated alone, every hedged answer would buy itself a committee.
    v = escalate(
        action="buy", confidence=0.05, delta_usdg=1_000, equity_usdg=1_000_000,
        holds_position=True, disagree=disagreement([]),
    )
    assert not v.escalate, "low confidence sharpens an existing case, it does not make one"


def test_an_ordinary_add_to_a_working_position_does_not_escalate():
    v = escalate(
        action="buy", confidence=0.7, delta_usdg=10_000, equity_usdg=1_000_000,
        holds_position=True, disagree=disagreement([]),
    )
    assert not v.escalate
    assert v.primary == "no-escalation"


def test_brain_consumes_cores_auditability_verdict_and_keeps_no_floor():
    """
    THERE IS NO SECOND ACCOUNTING IMPLEMENTATION HERE.

    The 36-scenario ablation once caught a local epoch floor defaulting to 1
    while packages/core refused anything below 2 — `epoch_one` returned BUY on a
    book core called unmeasurable, and the local rule was the LENIENT half. The
    fix at the time was to make the two constants agree.

    Both constants were wrong together. `epoch >= 2` was a proxy for "this
    history predates the accounting fix", and the epoch boundary only opens for
    an account that HAS pre-cutover rows — so every agent minted after the fix
    sat at epoch 1 for ever and could never be sized. Measured on the live
    fleet: 24 of 24 accounts.

    So the floor is gone rather than corrected, and the verdict arrives on the
    snapshot. A knob that can be set to the lenient value is a knob that will be.
    """
    import inspect

    from brain import gate as gate_mod
    from brain.schemas import PortfolioQuality, PortfolioState

    assert not hasattr(gate_mod, "MIN_AUDITABLE_EPOCH"), "the local floor must be gone, not renamed"
    assert "min_epoch" not in inspect.signature(gate_mod.assess).parameters, (
        "and not survive as a tunable parameter"
    )

    def book(**q):
        return PortfolioState(
            snapshot_id="s", as_of=1, cash_usdg=300_000_000, equity_usdg=300_000_000,
            net_contributions_usdg=300_000_000,
            quality=PortfolioQuality(
                audit_passed=True, contributions_known=True, equity_complete=True,
                gas_basis="net", position_history_available=True, **q,
            ),
        )

    # THE CASE THAT MATTERS: a clean agent created after the cutover, still at
    # epoch 1 because nothing ever needed quarantining for it, may be sized.
    clean_new = gate_assess(book(epoch=1, current_accounting_history_auditable=True))
    assert clean_new.may_size, "a clean epoch-1 book must be sizeable"

    # The case the old proxy got right, which must keep working.
    legacy = gate_assess(book(epoch=1, current_accounting_history_auditable=False))
    assert legacy.verdict == "refuse"
    assert not legacy.may_size
    assert "before the accounting fix" in legacy.why

    # A fresh epoch is not a licence either.
    dirty_two = gate_assess(book(epoch=2, current_accounting_history_auditable=False))
    assert not dirty_two.may_size, "the number 2 does not clear a legacy row"

    # FAILS CLOSED on could-not-ask, and says so distinctly.
    unknown = gate_assess(book(epoch=2, current_accounting_history_auditable=None))
    assert unknown.verdict == "refuse"
    assert "could not be established" in unknown.why

    # And a snapshot from a worker that predates the field defaults to None,
    # so it is refused rather than read as clean.
    assert PortfolioQuality().current_accounting_history_auditable is None

    # The number alone moves nothing, in either direction.
    for epoch in (1, 2, 7):
        assert gate_assess(book(epoch=epoch, current_accounting_history_auditable=True)).may_size
        assert not gate_assess(book(epoch=epoch, current_accounting_history_auditable=False)).may_size


def test_the_auditability_verdict_survives_the_wire():
    """A parser that coerced None to False would turn "could not look" into a
    finding, and lose the distinction the refusal message rests on."""
    from brain.snapshot import from_canonical

    base = {
        "schemaVersion": "1.0.0", "snapshotId": "s", "agentId": "0xa", "asOf": 1, "epoch": 1,
        "cashUsdg": 1, "vaultUsdg": 0, "positionsUsdg": 0, "quarantinedUsdg": 0, "equityUsdg": 1,
        "netContributionsUsdg": 1, "gasUsdg": 0, "positions": [],
        "pnl": {"usdgSinceContribution": 0, "publishable": True, "unavailable": None, "gasBasis": "net"},
    }
    q = {"auditPassed": True, "epoch": 1, "contributionsKnown": True, "equityComplete": True,
         "gasBasis": "net", "positionHistoryAvailable": True, "quarantinedAssetsPresent": False}

    for sent, expected in ((True, True), (False, False), (None, None)):
        snap = from_canonical({**base, "quality": {**q, "currentAccountingHistoryAuditable": sent}})
        assert snap.quality.current_accounting_history_auditable is expected, f"sent {sent!r}"

    # Absent means unknown, not clean.
    snap = from_canonical({**base, "quality": q})
    assert snap.quality.current_accounting_history_auditable is None


# ── the measurement boundary ────────────────────────────────────────────────
#
# A rule that fires almost never in production is indistinguishable, from the
# data, from a rule that is broken. Escalation is now exactly that: the size and
# opening rules are off on measured evidence, a hold never escalates by design,
# and every production decision so far has been a hold. `escalation_reasons`
# describes only the runs that escalated, so the live record says "no
# escalation" over and over and cannot say whether that was right.


def test_every_run_records_where_the_lenses_landed():
    """The analysts already answered in fields. Nothing throws that away."""
    import inspect

    from brain import graph as graph_mod

    src = inspect.getsource(graph_mod.BrainGraph._assemble)
    assert "analyst_views=" in src, "the decision must carry the lens verdicts"
    assert "views" in inspect.signature(graph_mod.BrainGraph._assemble).parameters, (
        "_assemble cannot record what it is not given"
    )
    # Both exits — the cheap one that stops at analyst depth and the deep one —
    # have to pass them. The cheap exit is the common case in production, so a
    # miss there is a miss everywhere that matters.
    think = inspect.getsource(graph_mod.BrainGraph._think)
    assert think.count("views=views") == 2, "both _assemble call sites must pass the views"


def test_the_recorded_signal_carries_no_model_prose():
    """
    STRUCTURE ONLY. `AnalystView.note` is up to 400 characters derived from news
    and social text — an injection surface, the largest thing in the record, and
    not what the question needs. A direction and two floats are.
    """
    from brain.schemas import AnalystSignal

    assert "note" not in AnalystSignal.model_fields
    assert set(AnalystSignal.model_fields) == {
        "lens",
        "direction",
        "confidence",
        "evidence_strength",
    }
    # extra="forbid", so a note cannot be smuggled in by a caller either.
    with pytest.raises(Exception):
        AnalystSignal(lens="news", direction="buy", confidence=0.5, evidence_strength=0.5, note="x")


def test_a_recorded_signal_is_bounded_on_every_field():
    from brain.schemas import AnalystSignal

    for bad in (
        {"confidence": 1.4},
        {"confidence": -0.1},
        {"evidence_strength": 2.0},
        {"direction": "moon"},
        {"lens": "x" * 41},
    ):
        kw = {"lens": "news", "direction": "buy", "confidence": 0.5, "evidence_strength": 0.5}
        kw.update(bad)
        with pytest.raises(Exception):
            AnalystSignal(**kw)


def test_the_signal_survives_a_lens_that_said_nothing():
    """
    `no-data` is a real answer and the one most worth recording — a run where
    three lenses had nothing is a run whose hold means something different from
    a run where three lenses agreed. It must not be dropped for being empty.
    """
    from brain.schemas import AnalystSignal

    view = parse_view("news", "the model returned prose instead of json")
    assert view.direction == "no-data"
    s = AnalystSignal(
        lens=view.lens,
        direction=view.direction,
        confidence=view.confidence,
        evidence_strength=view.evidence_strength,
    )
    assert s.direction == "no-data" and s.confidence == 0.0


def test_memory_is_fenced_like_everything_else_we_did_not_write():
    """
    Memory reads as the agent's own past words, which is what makes it feel
    trusted. It is not: a remembered thesis is model prose written while reading
    scraped news and social text, so anything that steered the agent last week
    arrives wearing its own voice. That is the permanent-foothold case — an
    injection that survives into every later prompt because it was written down.

    It was unfenced for as long as `memory` was always empty. The worker now
    populates it, which is exactly when the gap stops being dormant.
    """
    import inspect

    from brain import graph as graph_mod

    src = inspect.getsource(graph_mod.BrainGraph._think)
    i = src.index("WHAT THIS AGENT THOUGHT BEFORE")
    # The fence must be applied to the memory block itself, not merely present
    # somewhere else in the method.
    assert "_fence(" in src[i : i + 400], "the memory block must be fenced"
    assert "own-memory" in src[i : i + 400], "and labelled as what it is"

def test_a_clean_epoch_one_book_can_actually_be_sized():
    """
    THE POINT OF THE WHOLE GATE CHANGE, proved without spending a token.

    `_assemble` applies the gate AFTER parsing, on purpose: a model told it may
    not size will still sometimes size, and the difference between "asked
    nicely" and "cannot" is the whole design. So the question "can the canary
    produce a genuine BUY with a non-zero delta?" is answerable here — it is a
    property of the gate and the assembler, not of what a model happens to feel
    about TSLA on a given afternoon.

    Both directions are asserted. A clean epoch-1 book must let a buy through
    with its size intact; a legacy book must still flatten it to a hold. If only
    the first were checked, deleting the gate would pass.
    """
    import asyncio

    from brain.analyst import AnalystView
    from brain.budget import RunBudget, TIERS
    from brain.escalation import EscalationVerdict
    from brain.graph import BrainGraph
    from brain.schemas import DecideRequest, MarketState, PortfolioQuality, PortfolioState

    def book(auditable):
        return PortfolioState(
            snapshot_id="s", as_of=1, cash_usdg=10_000_000, equity_usdg=10_000_000,
            net_contributions_usdg=10_000_000,
            quality=PortfolioQuality(
                audit_passed=True, epoch=1, current_accounting_history_auditable=auditable,
                contributions_known=True, equity_complete=True, gas_basis="net",
                position_history_available=True,
            ),
        )

    def assemble(auditable):
        req = DecideRequest(
            schema_version="1.0.0", run_id="r", agent_id="0xa", trigger_id="t",
            portfolio=book(auditable),
            market=MarketState(
                snapshot_id="m", as_of=1, instrument_id="merrymen:tsla", symbol="TSLA",
                instrument_class="equity-token", price_usd="412.50", signals={},
            ),
        )
        graph = BrainGraph(llm=None)  # never called — _assemble does no I/O
        return graph._assemble(
            req,
            RunBudget(run_id="r", agent_id="0xa", tier="research", limits=TIERS["research"]),
            gate_assess(book(auditable)),
            # What a bullish analyst pass would hand the assembler.
            {"action": "buy", "confidence": 0.72, "suggested_delta_usdg": 2_000_000,
             "thesis": "the breakout held on volume"},
            bull="", bear="", depth_used="analysts",
            escalation=EscalationVerdict(False, [], "no condition met"),
            candidate_action="buy",
            views=[AnalystView(lens="technical", direction="buy", confidence=0.72,
                               evidence_strength=0.6, note="")],
        )

    # A CLEAN EPOCH-1 BOOK — every live account is one of these.
    clean = assemble(True)
    assert clean.action == "buy", "a clean epoch-1 book must be able to buy"
    assert clean.suggested_delta_usdg == 2_000_000, "and keep the size it proposed"

    # THE OTHER DIRECTION, so deleting the gate cannot pass this test.
    legacy = assemble(False)
    assert legacy.action == "hold"
    assert legacy.suggested_delta_usdg == 0, "a book we cannot audit is flattened, not merely warned"


def test_the_two_economics_rules_cannot_drift():
    """
    The judgement exists twice — `worker/src/execution-cost.ts` and
    `brain/escalation.py` — because the worker needs it for intents it has not
    sent and Brain needs it to label a decision it is returning, and neither can
    import the other. Duplication is the right call there; SILENT duplication is
    not, so the thresholds are pinned against each other.
    """
    import re
    from pathlib import Path

    from brain.escalation import ENFORCE_TRADE_ECONOMICS, MIN_EDGE_OVER_GAS, judge_economics

    ts = (Path(__file__).resolve().parents[3] / "worker" / "src" / "execution-cost.ts").read_text(
        encoding="utf-8"
    )
    assert re.search(rf"MIN_EDGE_OVER_GAS = {MIN_EDGE_OVER_GAS}\b", ts), "the margins must match"
    assert re.search(
        rf"ENFORCE_TRADE_ECONOMICS = {str(ENFORCE_TRADE_ECONOMICS).lower()}\b", ts
    ), "and so must whether either side enforces"

    # The verdicts themselves, on the canary's own numbers: a 0.764720 USDG cost.
    gas = 764_720
    assert judge_economics(expected_edge_usdg=100_000, expected_gas_usdg=gas) == "uneconomic"
    assert judge_economics(expected_edge_usdg=900_000, expected_gas_usdg=gas) == "marginal"
    assert judge_economics(expected_edge_usdg=gas * 2, expected_gas_usdg=gas) == "viable"
    # UNKNOWN when either side is missing — never the permissive answer.
    assert judge_economics(expected_edge_usdg=None, expected_gas_usdg=gas) == "unknown"
    assert judge_economics(expected_edge_usdg=5_000_000, expected_gas_usdg=None) == "unknown"


def test_the_manager_is_told_the_marginal_cost_and_that_setup_is_sunk():
    """
    A manager told "gas has averaged 1.74 USDG a trade" on trades of 1.67 would
    correctly stop trading, about a number that is wrong: 5.51M of the canary's
    first operation's 6.02M gas was the account deployment and the permission
    wall, and no future decision can unspend it.
    """
    import inspect

    from brain import graph as graph_mod

    src = inspect.getsource(graph_mod.BrainGraph._decide)
    assert "expected_trade_gas_usdg" in src, "the manager must be told what the next trade costs"
    assert "already paid" in src and "already spent" in src, "and that the setup cost is sunk"
    assert "cost_note" in src and "{cost_note}" in src, "and the note must actually reach the prompt"
    # UNKNOWN IS STATED, NOT ZEROED. A cost nobody could price is not a free trade.
    assert "COULD NOT BE PRICED" in src
    assert "Do not assume it is zero" in src
