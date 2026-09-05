"""
WHEN IS IT WORTH THINKING HARDER?

The measured result on the first ten scenarios was uncomfortable for the
architecture we inherited:

    analysts-only    10/10 correct   45 calls    36,593 tokens   3.7s
    + bull/bear       9/10           63 calls    61,449 tokens   5.6s
    full committee    9/10           90 calls   103,164 tokens   7.5s

The committee cost 2.3x the tokens and twice the latency, and both decisions it
changed were changed for the worse — `strong_bear` went `sell → sell → hold`,
which is a risk committee talking a desk out of a correct exit. That is not an
argument for never debating. It is an argument against debating BY DEFAULT.

So depth becomes a decision rather than a setting: run the analysts, form a
candidate, and escalate only when the candidate shows one of the specific
conditions where a second opinion has something to work with. Everything else
finishes at analyst depth.

THE CONDITIONS ARE ABOUT THE INPUT, NOT THE OUTPUT. "The model said it was
unsure" is a weak signal — a model's stated confidence is the least reliable
number it produces. What is checkable: the analysts disagreed with each other,
the trade is large relative to the book, or the position is being opened rather
than held. Those are facts about the situation, and they are the situations
where an adversarial pass can actually find something.

EVERY ESCALATION IS RECORDED with its reason, so the question "does escalating
help?" is answerable from the data rather than argued from taste.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

EscalationReason = Literal[
    "analysts-disagree",
    "large-relative-to-book",
    "opening-a-position",
    "low-confidence",
    "no-escalation",
]


@dataclass(frozen=True)
class EscalationVerdict:
    escalate: bool
    reasons: list[EscalationReason]
    detail: str

    @property
    def primary(self) -> EscalationReason:
        return self.reasons[0] if self.reasons else "no-escalation"


#: A candidate wanting more than this share of equity is a big enough bet that a
#: second opinion is cheap by comparison.
LARGE_TRADE_FRACTION = 0.25
#: Below this the model is telling us it is guessing. Weak on its own, which is
#: why it never escalates alone — see `assess`.
LOW_CONFIDENCE = 0.45

_BULLISH = re.compile(r"\b(bullish|buy|upside|strong|positive|breakout|golden cross|beat)\b", re.I)
_BEARISH = re.compile(r"\b(bearish|sell|downside|weak|negative|breakdown|miss|resign|delayed)\b", re.I)


def analysts_disagree(reports: list[str]) -> bool:
    """
    Did the lenses point in different directions?

    Crude on purpose: a keyword split over the analyst text. The alternative is
    another model call to judge disagreement, which costs exactly what
    escalating costs and therefore cannot be the thing that decides whether to
    escalate. A cheap signal that is right most of the time is the correct tool
    for a gate whose whole job is avoiding an expensive call.
    """
    bull = bear = 0
    for r in reports:
        b, s = len(_BULLISH.findall(r)), len(_BEARISH.findall(r))
        if b > s:
            bull += 1
        elif s > b:
            bear += 1
    return bull > 0 and bear > 0


def assess(
    *,
    action: str,
    confidence: float,
    delta_usdg: int,
    equity_usdg: int,
    holds_position: bool,
    analyst_reports: list[str],
) -> EscalationVerdict:
    """
    Decide whether this candidate is worth a second opinion. PURE.

    A HOLD never escalates. The expensive path exists to stress-test a decision
    to move money, and the measured regressions both went the other way — the
    committee turning a correct `sell` into a `hold`. Paying 2.3x to make a
    non-trade more thoroughly a non-trade is the worst trade available.
    """
    reasons: list[EscalationReason] = []

    if action == "hold":
        return EscalationVerdict(False, [], "a hold costs nothing to be wrong about in the short run")

    if analysts_disagree(analyst_reports):
        reasons.append("analysts-disagree")

    if equity_usdg > 0 and abs(delta_usdg) > equity_usdg * LARGE_TRADE_FRACTION:
        reasons.append("large-relative-to-book")

    if action == "buy" and not holds_position:
        # Opening is the asymmetric one: a new position can be wrong in a way
        # that adding to a working one cannot, and there is no prior thesis to
        # have been tested by events.
        reasons.append("opening-a-position")

    if confidence < LOW_CONFIDENCE and reasons:
        # NEVER ALONE. A model's stated confidence is the least reliable number
        # it emits, so it sharpens a case that already exists rather than making
        # one — otherwise every hedged answer buys itself a committee.
        reasons.append("low-confidence")

    if not reasons:
        return EscalationVerdict(False, [], "no condition met; the analysts were coherent and the size is ordinary")

    return EscalationVerdict(
        True,
        reasons,
        "escalating because " + ", ".join(r.replace("-", " ") for r in reasons),
    )
