"""
AN ANALYST'S VERDICT AS FIELDS, so disagreement is arithmetic.

The keyword heuristic this replaces fired ZERO times across 36 scenarios,
including ones built specifically to disagree — `conflicting` hands the desk a
clean breakout and an antitrust investigation in the same breath. A signal that
never fires is not a conservative signal, it is an absent one, and it was
silently carrying a third of the escalation gate.

Why it failed is worth writing down, because the fix is not "better keywords":
it counted bullish and bearish WORDS in an analyst's prose. Analysts write
carefully. A bear case says "the breakout is real, but…" and scores as bullish;
a bull case that acknowledges risk scores as mixed. The words are about the
evidence, not about the verdict, and no list of them recovers the verdict.

So each analyst now returns its verdict as FIELDS alongside its prose, and
disagreement is computed from the fields. No extra model call: the analyst was
already being asked: it is now asked for its answer in a shape that can be
compared.

    technical: BUY  0.72
    news:      HOLD 0.41
    sentiment: SELL 0.66
                       → two sides present, both convinced → escalate
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Literal

Direction = Literal["buy", "sell", "hold", "no-data"]

#: Below this an analyst is hedging, and a hedge is not a side in a disagreement.
#: Two analysts who each half-believe opposite things are not in conflict; they
#: are both saying they do not know, which is agreement about the evidence.
CONVICTION = 0.5


@dataclass(frozen=True)
class AnalystView:
    lens: str
    direction: Direction
    confidence: float
    #: How much the lens actually had to work with, separate from how sure it is.
    #: A confident read of thin evidence and a confident read of thick evidence
    #: are different things and an escalation gate should be able to tell them
    #: apart.
    evidence_strength: float
    note: str

    @property
    def counts(self) -> bool:
        """Whether this view is a side, rather than a shrug."""
        return self.direction in ("buy", "sell") and self.confidence >= CONVICTION


def parse_view(lens: str, raw: str) -> AnalystView:
    """
    Read an analyst's answer. NEVER raises.

    A lens that returned something unparseable has told us nothing, and the
    honest reading of nothing is `no-data` — not a guess at its direction from
    whatever prose came back, which is the mistake this module exists to undo.
    """
    text = (raw or "").strip()
    direction: Direction = "no-data"
    confidence = 0.0
    strength = 0.0
    note = text[:400]

    try:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            d = json.loads(text[start : end + 1])
            raw_dir = str(d.get("direction", "no-data")).strip().lower()
            if raw_dir in ("buy", "sell", "hold", "no-data"):
                direction = raw_dir  # type: ignore[assignment]
            confidence = max(0.0, min(1.0, float(d.get("confidence") or 0.0)))
            strength = max(0.0, min(1.0, float(d.get("evidence_strength") or 0.0)))
            note = str(d.get("note") or "")[:400]
    except (ValueError, TypeError, AttributeError):
        pass

    return AnalystView(lens=lens, direction=direction, confidence=confidence, evidence_strength=strength, note=note)


@dataclass(frozen=True)
class Disagreement:
    present: bool
    detail: str
    buy: int
    sell: int
    hold: int
    no_data: int


def disagreement(views: list[AnalystView]) -> Disagreement:
    """
    Do the lenses actually point opposite ways? PURE, deterministic, free.

    Requires a CONVICTION on both sides. One analyst weakly leaning against three
    strong ones is not a debate worth 45 extra model calls — it is a minority
    report, and the manager already sees it in the dossier.
    """
    buy = sum(1 for v in views if v.direction == "buy" and v.counts)
    sell = sum(1 for v in views if v.direction == "sell" and v.counts)
    hold = sum(1 for v in views if v.direction == "hold")
    nodata = sum(1 for v in views if v.direction == "no-data")

    if buy and sell:
        return Disagreement(
            True,
            f"{buy} lens(es) say buy and {sell} say sell, each above {CONVICTION:.2f} conviction",
            buy,
            sell,
            hold,
            nodata,
        )
    return Disagreement(
        False,
        (
            f"no two-sided conviction (buy {buy}, sell {sell}, hold {hold}, no-data {nodata})"
            if views
            else "no analyst views"
        ),
        buy,
        sell,
        hold,
        nodata,
    )


#: Appended to every analyst prompt. The prose is still wanted — it is what the
#: manager reasons over and what the thesis is built from — so this asks for BOTH
#: rather than replacing one with the other.
STRUCTURED_SUFFIX = """

Reply with a single JSON object and nothing else:
{
  "direction": "buy" | "sell" | "hold" | "no-data",
  "confidence": 0.0-1.0,
  "evidence_strength": 0.0-1.0,
  "note": "at most 120 words, what your lens sees and how strongly"
}

`direction` is YOUR LENS'S verdict, not the desk's. `no-data` if your lens has
nothing usable — that is a useful answer and far better than a guess.
`evidence_strength` is how much you had to work with; `confidence` is how sure
you are of your read of it. They are different numbers and a thin-but-clear
signal should say so."""
