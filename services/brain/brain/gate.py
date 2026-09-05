"""
WHAT BRAIN IS ALLOWED TO CONCLUDE FROM A BOOK IT CANNOT TRUST.

This is a rule in code, deliberately, and not an instruction in a prompt. The
whole accounting effort this service sits behind exists because a confident
number computed from unknown inputs is worse than no number — and a prompt that
says "be careful if the data is incomplete" is exactly the kind of hope that
produced the original bug. A model asked to be careful will still produce a
percentage.

TWO OUTCOMES, and the difference matters:

  REFUSE     the state is bad enough that no useful decision exists. Returns a
             typed refusal; no model is called, so it costs nothing.
  DOWNGRADE  the state supports a smaller claim. Brain may still think, but it
             may not size a position from a denominator nobody can back — so
             the decision is capped to `hold`, which is a real answer rather
             than a hedge.

The gate is PURE and returns its reasoning, so a refusal can be explained to an
owner without re-running anything.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .schemas import PortfolioState

Verdict = Literal["proceed", "downgrade-to-hold", "refuse"]

#: THE SAME FLOOR packages/core uses in `computePnl`. Epoch 1 predates auditable
#: flows by construction; its rows are kept for forensics and are never presented
#: as measured. If core changes this, this changes — it is one rule with two
#: homes, and the homes must not drift.
MIN_AUDITABLE_EPOCH = 2


@dataclass(frozen=True)
class GateResult:
    verdict: Verdict
    why: str
    #: Handed to the prompt so the model is told the same thing the gate decided.
    caveats: list[str]

    @property
    def may_size(self) -> bool:
        return self.verdict == "proceed"


def assess(portfolio: PortfolioState, *, min_epoch: int = MIN_AUDITABLE_EPOCH) -> GateResult:
    """
    Decide what this book supports. PURE.

    `min_epoch` MATCHES CORE. It defaulted to 1 while the accounting repair was
    still running, and the 36-scenario ablation caught what that cost:
    `epoch_one` returned BUY on a book that packages/core reports as
    unpublishable. Two epoch rules is exactly the second accounting
    implementation the canonical snapshot exists to prevent — and the local one
    was the LENIENT half, which is the dangerous direction to drift in.

    It stays a parameter so a caller can state a different floor deliberately,
    but the default now agrees with `computePnl`.
    """
    q = portfolio.quality
    caveats: list[str] = []

    # ── CORE HAS THE LAST WORD ON PUBLISHABILITY ────────────────────────────
    #
    # When a canonical snapshot supplied a verdict, it is the verdict. Brain may
    # decide what it will REASON about, but it does not get a second opinion on
    # whether a book's performance can be stated — that is accounting, it lives
    # in packages/core, and two implementations of it is the failure this whole
    # snapshot exists to prevent.
    if portfolio.pnl_publishable is False:
        why = (portfolio.pnl_unavailable or "unknown").replace("-", " ")
        if portfolio.net_contributions_usdg is None or not q.contributions_known:
            return GateResult(
                verdict="refuse",
                why=f"core reports performance unmeasurable: {why}",
                caveats=[],
            )
        return GateResult(
            verdict="downgrade-to-hold",
            why=f"core reports performance is not publishable ({why}), so nothing may be sized against it",
            caveats=[f"core: performance not publishable — {why}"],
        )

    # ── REFUSE: no denominator at all ────────────────────────────────────────
    #
    # Contributions UNKNOWN is not contributions ZERO. Equity minus zero is the
    # owner's bankroll presented as profit, which is the original bug; a model
    # handed that state will reason about a P&L that does not exist.
    if portfolio.net_contributions_usdg is None or not q.contributions_known:
        return GateResult(
            verdict="refuse",
            why=(
                "contributed capital is not on record, so there is no denominator for "
                "performance. Equity minus an unknown is not profit."
            ),
            caveats=[],
        )

    if q.epoch < min_epoch:
        return GateResult(
            verdict="refuse",
            why=f"epoch {q.epoch} is below the auditable floor of {min_epoch}",
            caveats=[],
        )

    # ── DOWNGRADE: a book that can be read but not measured ─────────────────
    if not q.equity_complete:
        caveats.append("the equity series has gaps, so drawdown and trend are not reliable")
    if not q.audit_passed:
        caveats.append("the ledger has not passed an audit; treat position values as approximate")
    if q.gas_basis != "net":
        caveats.append(
            f"performance is {q.gas_basis}-of-gas — trading costs are not subtracted, so small "
            f"edges are overstated"
        )
    if q.quarantined_assets_present:
        caveats.append("some holdings are quarantined and carried at cost, not at market")
    if not q.position_history_available:
        caveats.append("there is no position history, so nothing can be said about how this book got here")

    if portfolio.net_contributions_usdg <= 0:
        # Known, and zero or negative. That IS knowledge — it means no real
        # capital is at stake — but it is not a denominator, so no percentage
        # and no sizing decision can rest on it.
        return GateResult(
            verdict="downgrade-to-hold",
            why=(
                "net contributed capital is zero or negative, so there is nothing to size "
                "a position against"
            ),
            caveats=caveats,
        )

    # Three or more caveats is not a book to trade off. The threshold is a
    # judgement, but a stated one, rather than a model's mood on the day.
    if len(caveats) >= 3:
        return GateResult(
            verdict="downgrade-to-hold",
            why=f"{len(caveats)} separate quality problems; the book can be described but not traded from",
            caveats=caveats,
        )

    return GateResult(verdict="proceed", why="portfolio quality supports a sized decision", caveats=caveats)
