"""
WHAT A MERRYMAN'S DECISION IS, as a type rather than as prose.

The contract is the whole point of this service. Upstream returns markdown from
its structured-output helper — `invoke_structured_or_freetext` validates a
Pydantic model and then throws it away in favour of `render(result)` — which
leaves the TypeScript side regex-parsing English to decide what to trade. That
is the single change that makes this a service instead of a TUI.

THREE RULES THIS FILE ENFORCES, none of them stylistic:

  1. NO ADDRESSES, EVER. Brain emits `instrument_id` and `symbol`; trusted
     TypeScript resolves those to a canonical allowlisted address. A model that
     can emit an 0x… string can emit one nobody allowlisted, and it would travel
     toward the executor. The validator below rejects the shape outright rather
     than trusting a prompt to have discouraged it.
  2. NO FLOATING-POINT MONEY. Sizes cross the service boundary as integer
     micro-USDG. A JSON float is not a quantity of money.
  3. EVERY DECISION CARRIES ITS COST. Not as telemetry bolted on afterwards —
     as a required field, so a decision that cannot say what it cost cannot be
     returned at all.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA_VERSION = "1.0.0"

# An 0x-prefixed 20-byte address, in any case. Deliberately broad: the point is
# to catch anything address-SHAPED, not to validate a real address.
_ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
# Calldata, a signature selector, or a long hex blob. Same reasoning.
_HEXBLOB = re.compile(r"0x[0-9a-fA-F]{16,}")

Action = Literal["buy", "sell", "hold"]
Tier = Literal["pulse", "research", "deep"]


def _reject_executable(text: str, field: str) -> str:
    """
    Refuse anything that could be executed rather than read.

    Applied to every free-text field a model writes, because the thesis is
    PUBLISHED and the evidence is PERSISTED — an address that reaches either has
    escaped the boundary just as surely as one in a size field.
    """
    if _ADDRESS.search(text):
        raise ValueError(
            f"{field} contains an address-shaped string. Brain names instruments, "
            f"never addresses — trusted code resolves instrument_id to an address."
        )
    if _HEXBLOB.search(text):
        raise ValueError(f"{field} contains a hex blob that could be calldata")
    return text


class ModelUse(BaseModel):
    """Which model answered for which node — attribution, per call."""

    model_config = ConfigDict(extra="forbid")

    node: str
    provider: str
    model: str


class Cost(BaseModel):
    """
    WHAT THIS DECISION COST. Required, not optional.

    A background feature nobody had switched on once consumed an entire daily
    token allowance on a shared house key, and the first person to notice was a
    user whose chat stopped working. The counter existed nowhere. It exists here
    before the first call rather than after the first incident.
    """

    model_config = ConfigDict(extra="forbid")

    model_calls: int = Field(ge=0)
    tokens_in: int = Field(ge=0)
    tokens_out: int = Field(ge=0)
    usd: float = Field(ge=0)


class Evidence(BaseModel):
    """One claim, and where it came from. Not a quote — a citation."""

    model_config = ConfigDict(extra="forbid")

    source: str
    ref: str
    claim: str

    @field_validator("source", "ref", "claim")
    @classmethod
    def _no_executables(cls, v: str) -> str:
        return _reject_executable(v, "evidence")


class ChangedView(BaseModel):
    """When the agent changed its mind, what it changed from and why."""

    model_config = ConfigDict(extra="forbid")

    from_view: str = Field(alias="from")
    why: str

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class BrainDecision(BaseModel):
    """
    The one object a Merryman's thinking produces.

    The thesis and the trade intention come from HERE, together. Merrymen never
    trades first and asks a model to explain itself afterwards, so the public
    post and the execution intent are two readings of one decision rather than
    two separate model calls that can disagree.
    """

    model_config = ConfigDict(extra="forbid")

    schema_version: str = SCHEMA_VERSION
    decision_id: str
    agent_id: str
    created_at: int  # unix seconds
    trigger_id: str | None = None

    action: Action

    # ── WHAT, never WHERE ──────────────────────────────────────────────────
    instrument_id: str
    symbol: str

    confidence: float = Field(ge=0.0, le=1.0)

    # ── MONEY IS AN INTEGER ────────────────────────────────────────────────
    # Micro-USDG (1e-6 USDG), signed for the delta. A float here would make the
    # size of a position a function of IEEE-754 rounding.
    suggested_delta_usdg: int
    target_position_usdg: int | None = Field(default=None, ge=0)

    # ── THE REASONING, WHICH IS ALSO THE PUBLIC POST ───────────────────────
    thesis: str
    evidence: list[Evidence] = Field(default_factory=list)
    bull_case: str = ""
    bear_case: str = ""
    risks: list[str] = Field(default_factory=list)
    invalidation: list[str] = Field(default_factory=list)
    time_horizon: str = ""
    changed_view: ChangedView | None = None

    tier: Tier
    #: What depth this decision actually ran at, which under `adaptive` is
    #: decided per-run rather than configured. Recorded because "did escalating
    #: help?" cannot be answered from a setting, only from what happened.
    depth_used: Literal["analysts", "analysts+debate", "full"] = "analysts"
    #: Why it escalated, or why it did not. Empty when no decision was needed.
    escalation_reasons: list[str] = Field(default_factory=list)
    #: The action the analysts alone arrived at, when a deeper pass then ran.
    #: This is the whole measurement: escalation only matters where these differ.
    candidate_action: Action | None = None
    cost: Cost
    models: list[ModelUse] = Field(default_factory=list)

    @field_validator("instrument_id", "symbol", "thesis", "bull_case", "bear_case", "time_horizon")
    @classmethod
    def _no_executables(cls, v: str) -> str:
        return _reject_executable(v, "field")

    @field_validator("risks", "invalidation")
    @classmethod
    def _no_executables_in_list(cls, v: list[str]) -> list[str]:
        for item in v:
            _reject_executable(item, "list field")
        return v

    @model_validator(mode="after")
    def _coherent(self) -> BrainDecision:
        """
        A decision has to agree with itself.

        Caught here rather than downstream because the two halves are written by
        a model and a model can produce "sell" with a positive delta. Policy
        would refuse it later, but by then it has already been persisted and
        possibly published.
        """
        if self.action == "hold" and self.suggested_delta_usdg != 0:
            raise ValueError("action 'hold' must carry a zero delta")
        if self.action == "buy" and self.suggested_delta_usdg <= 0:
            raise ValueError("action 'buy' must carry a positive delta")
        if self.action == "sell" and self.suggested_delta_usdg >= 0:
            raise ValueError("action 'sell' must carry a negative delta")
        if not self.thesis.strip():
            raise ValueError("a decision without a thesis is not publishable")
        return self


# ── WHAT BRAIN IS TOLD ─────────────────────────────────────────────────────


class PortfolioQuality(BaseModel):
    """
    HOW MUCH THE PORTFOLIO STATE CAN BE TRUSTED, machine-readable.

    Brain refuses or downgrades on an incomplete snapshot as a rule in code, not
    as a hope about a prompt — see `gate.py`. This mirrors the worker's own
    quality object rather than inventing a second vocabulary for the same facts.
    """

    model_config = ConfigDict(extra="forbid")

    audit_passed: bool = False
    epoch: int = 1
    contributions_known: bool = False
    equity_complete: bool = False
    gas_basis: Literal["gross", "net", "unknown"] = "unknown"
    position_history_available: bool = False
    quarantined_assets_present: bool = False


class Position(BaseModel):
    model_config = ConfigDict(extra="forbid")

    instrument_id: str
    symbol: str
    qty: str  # decimal string — never a float
    value_usdg: int  # micro-USDG
    cost_basis_usdg: int | None = None


class PortfolioState(BaseModel):
    """What the agent owns, as the accounting layer reports it."""

    model_config = ConfigDict(extra="forbid")

    snapshot_id: str
    as_of: int
    cash_usdg: int  # micro-USDG
    equity_usdg: int
    net_contributions_usdg: int | None = None  # None = UNKNOWN, not zero
    positions: list[Position] = Field(default_factory=list)
    quality: PortfolioQuality = Field(default_factory=PortfolioQuality)
    #: CORE'S VERDICT ON PUBLISHABILITY, carried not re-derived.
    #:
    #: packages/core decides this once, for the worker, the web tier, social and
    #: Brain. Re-deriving it here would be a second accounting implementation —
    #: the exact thing the canonical snapshot exists to prevent — and it would
    #: drift the moment either side changed a rule. None means no canonical
    #: snapshot was supplied and the local gate must decide alone.
    pnl_publishable: bool | None = None
    pnl_unavailable: str | None = None


class MarketState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    snapshot_id: str
    as_of: int
    instrument_id: str
    symbol: str
    instrument_class: Literal["equity-token", "crypto-native", "memecoin", "stablecoin"]
    price_usd: str | None = None
    # Free-form per-source material. Everything in here is UNTRUSTED: it is
    # scraped or vendor-supplied text that an attacker may have written.
    signals: dict[str, str] = Field(default_factory=dict)


class DecideRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: str = SCHEMA_VERSION
    run_id: str
    agent_id: str
    trigger_id: str | None = None

    portfolio: PortfolioState
    market: MarketState

    # Personality and risk appetite, as Merrymen holds them.
    persona: str = ""
    risk_appetite: Literal["conservative", "balanced", "aggressive"] = "balanced"

    # Prior theses with realised outcomes, for continuity and reflection.
    memory: list[str] = Field(default_factory=list)

    tier: Tier = "research"
    # WHICH STAGES RUN — and the default is `adaptive`, not `full`.
    #
    # Measured on the first ten scenarios: analysts-only scored 10/10 at 45
    # calls, the full committee 9/10 at 90. The committee cost 2.3x the tokens
    # and changed two decisions, both for the worse. Defaulting to it would be
    # paying double for a measured regression.
    #
    # `adaptive` runs the analysts, forms a candidate, and escalates only when
    # the situation gives an adversarial pass something to work with. The three
    # fixed depths remain, for ablation.
    stages: Literal["adaptive", "analysts", "analysts+debate", "full"] = "adaptive"


class Refusal(BaseModel):
    """
    A TYPED NO, not an exception and not a best-effort answer.

    The whole reason Brain exists behind an accounting layer is that a confident
    number computed from unknown inputs is worse than no number. Refusing has to
    be as expressible as deciding.
    """

    model_config = ConfigDict(extra="forbid")

    schema_version: str = SCHEMA_VERSION
    run_id: str
    agent_id: str
    reason: Literal[
        "portfolio-quality-insufficient",
        "budget-exhausted",
        "insufficient-data",
        "schema-version-unsupported",
        "provider-unavailable",
        "output-invalid",
    ]
    detail: str
    cost: Cost
