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

#: What a lens concluded, or why it concluded nothing.
#:
#: THE LAST FOUR ARE NOT OPINIONS. `no-data` means the analyst looked and had
#: nothing usable — a real answer, and often the right one. The others mean WE
#: failed. They exist because the two were the same value until 2026-09-06, and
#: the difference is the whole point:
#:
#:   Brain runs on gpt-oss, a reasoning model. It spends its completion budget
#:   on chain-of-thought, `llm.complete` reads only `content`, and `parse_view`
#:   found no JSON in what came back — so it returned `no-data`. Five lenses
#:   reported "I have nothing" while the technical one was holding 400 published
#:   oracle rounds over 748 hours. An infrastructure failure was published as an
#:   investment opinion and nothing downstream could tell the difference.
Direction = Literal[
    "buy",
    "sell",
    "hold",
    "no-data",
    "parse-failed",
    "invalid-output",
    "empty-output",
    "provider-failed",
]

#: The arms that mean the pipeline broke rather than the evidence being thin.
#: A run whose lenses are all in here has not formed a view; it has failed, and
#: the trace, the dataset and the gate all need to be able to say so.
FAILURE_DIRECTIONS: frozenset[str] = frozenset(
    {"parse-failed", "invalid-output", "empty-output", "provider-failed"}
)

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

    A lens that returned something unparseable has told us nothing — but that is
    OUR failure, not a reading of the evidence, and it no longer wears the same
    word. `no-data` is reserved for an analyst that answered and said it had
    nothing; a missing, malformed or unusable answer gets its own arm, so a
    broken provider can never be read as a considered shrug.
    """
    text = (raw or "").strip()
    confidence = 0.0
    strength = 0.0

    if not text:
        # THE REASONING-MODEL CASE. The whole completion went to a channel we do
        # not read, so `content` came back empty. That is not an opinion about
        # the market; it is the absence of one.
        return AnalystView(
            lens=lens, direction="empty-output", confidence=0.0, evidence_strength=0.0, note=""
        )

    note = text[:400]
    try:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            # Prose came back where a JSON object was asked for.
            return AnalystView(
                lens=lens, direction="parse-failed", confidence=0.0, evidence_strength=0.0, note=note
            )
        d = json.loads(text[start : end + 1])
        raw_dir = str(d.get("direction", "")).strip().lower()
        if raw_dir in ("buy", "sell", "hold", "no-data"):
            direction: Direction = raw_dir  # type: ignore[assignment]
        else:
            # It parsed, and the shape was wrong. A different failure from a
            # different cause, so a different name — and the numbers beside it
            # are dropped: a confidence of 0.8 attached to a direction nothing
            # can read is not a weak opinion, it is no opinion wearing one.
            return AnalystView(
                lens=lens,
                direction="invalid-output",
                confidence=0.0,
                evidence_strength=0.0,
                note=str(d.get("note") or "")[:400] or note,
            )
        confidence = max(0.0, min(1.0, float(d.get("confidence") or 0.0)))
        strength = max(0.0, min(1.0, float(d.get("evidence_strength") or 0.0)))
        note = str(d.get("note") or "")[:400]
    except (ValueError, TypeError, AttributeError):
        return AnalystView(
            lens=lens, direction="parse-failed", confidence=0.0, evidence_strength=0.0, note=note
        )

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
