"""
THE CEILING EXISTS BEFORE THE FIRST CALL.

On 2026-08-31 a background feature nobody had switched on consumed an entire
200,000-token daily allowance (195,881 used) on a shared house key, and the
first person to notice was a user whose chat had stopped working. Nothing
counted. The only defences were an interval timer, a step cap, and flags
defaulting off — three ways of hoping.

So this module is written before any node that calls a model, and every call
goes through it. It is not telemetry. A call that would breach the ceiling does
not happen: `spend()` raises, the run returns a typed refusal, and the partial
cost is still reported. A truncated decision is not a cheaper decision, it is a
wrong one, so the run refuses rather than returning what it managed to think.

PER-AGENT CONCURRENCY IS ONE. Not a performance choice — two runs for the same
agent would double its spend against a shared allowance while producing two
decisions that disagree, and the trigger layer cannot dedupe what it cannot see.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path

from .schemas import Cost, ModelUse, Tier


class BudgetExceeded(RuntimeError):
    """The ceiling was reached. Carries what had been spent when it happened."""

    def __init__(self, detail: str, spent: Cost) -> None:
        super().__init__(detail)
        self.detail = detail
        self.spent = spent


@dataclass(frozen=True)
class TierLimits:
    """
    What a tier is ALLOWED, not what it is expected to use.

    The numbers come from counting upstream's graph rather than from taste:
    a full committee run is 16-41 model calls depending on debate depth. These
    ceilings sit above the expected shape and below anything pathological.
    """

    max_calls: int
    max_tokens: int
    #: Wall-clock ceiling. "No 60-second Brain calls" — a decision that takes
    #: longer than this is not late, it is stuck, and the trigger that woke it
    #: will fire again.
    max_seconds: float


TIERS: dict[Tier, TierLimits] = {
    # Triage. Is this even worth thinking about?
    "pulse": TierLimits(max_calls=4, max_tokens=30_000, max_seconds=25.0),
    # The working tier: analysts, one debate round, a manager, a decision.
    "research": TierLimits(max_calls=24, max_tokens=200_000, max_seconds=55.0),
    # Full committee. Reachable, but never the default.
    "deep": TierLimits(max_calls=45, max_tokens=500_000, max_seconds=110.0),
}

#: USD per 1M tokens, by model. Unknown models price at 0 and SAY SO in the
#: report rather than silently reporting a free run.
PRICES: dict[str, tuple[float, float]] = {
    "llama-3.3-70b-versatile": (0.59, 0.79),
    "llama-3.1-8b-instant": (0.05, 0.08),
    "openai/gpt-oss-120b": (0.15, 0.75),
    "openai/gpt-oss-20b": (0.10, 0.50),
    "moonshotai/kimi-k2-instruct-0905": (1.00, 3.00),
    "qwen/qwen3-32b": (0.29, 0.59),
}


def price_of(model: str, tokens_in: int, tokens_out: int) -> float:
    rate = PRICES.get(model)
    if rate is None:
        return 0.0
    return (tokens_in / 1_000_000) * rate[0] + (tokens_out / 1_000_000) * rate[1]


@dataclass
class RunBudget:
    """
    One run's allowance, and the record of what it actually spent.

    Mutable on purpose: it is threaded through every node so the accounting is
    the same object the ceiling is checked against. Two objects would drift.
    """

    run_id: str
    agent_id: str
    tier: Tier
    limits: TierLimits
    started_at: float = field(default_factory=time.monotonic)

    model_calls: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    usd: float = 0.0
    models: list[ModelUse] = field(default_factory=list)
    #: Per-node call counts, so an ablation can say WHERE the tokens went.
    by_node: dict[str, int] = field(default_factory=dict)
    by_node_tokens: dict[str, int] = field(default_factory=dict)

    @property
    def elapsed(self) -> float:
        return time.monotonic() - self.started_at

    def cost(self) -> Cost:
        return Cost(
            model_calls=self.model_calls,
            tokens_in=self.tokens_in,
            tokens_out=self.tokens_out,
            usd=round(self.usd, 6),
        )

    def check_before(self, node: str) -> None:
        """
        Refuse the NEXT call if it cannot be afforded. Checked before, not after.

        Checking afterwards is how you discover the ceiling by breaching it.
        """
        if self.model_calls >= self.limits.max_calls:
            raise BudgetExceeded(
                f"{self.tier} allows {self.limits.max_calls} model calls and {node} would be "
                f"number {self.model_calls + 1}",
                self.cost(),
            )
        if self.tokens_in + self.tokens_out >= self.limits.max_tokens:
            raise BudgetExceeded(
                f"{self.tier} allows {self.limits.max_tokens} tokens and {node} would exceed it "
                f"(spent {self.tokens_in + self.tokens_out})",
                self.cost(),
            )
        if self.elapsed >= self.limits.max_seconds:
            raise BudgetExceeded(
                f"{self.tier} allows {self.limits.max_seconds}s and {node} would start at "
                f"{self.elapsed:.1f}s",
                self.cost(),
            )

    def record(self, node: str, provider: str, model: str, tin: int, tout: int) -> None:
        self.model_calls += 1
        self.tokens_in += tin
        self.tokens_out += tout
        self.usd += price_of(model, tin, tout)
        self.models.append(ModelUse(node=node, provider=provider, model=model))
        self.by_node[node] = self.by_node.get(node, 0) + 1
        self.by_node_tokens[node] = self.by_node_tokens.get(node, 0) + tin + tout


class AgentConcurrency:
    """
    ONE RUN PER AGENT AT A TIME.

    A second concurrent run for one agent doubles its spend against a shared
    allowance and produces two decisions that can disagree — and whichever
    lands second silently wins. The lock is per-agent rather than global so one
    slow agent cannot stall the fleet.
    """

    def __init__(self) -> None:
        self._locks: dict[str, asyncio.Lock] = {}

    def lock_for(self, agent_id: str) -> asyncio.Lock:
        lock = self._locks.get(agent_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[agent_id] = lock
        return lock


def usage_log_path() -> Path:
    return Path(os.getenv("BRAIN_USAGE_LOG", "brain-usage.jsonl"))


def persist_usage(budget: RunBudget, outcome: str, detail: str = "") -> None:
    """
    Append what this run spent, whatever became of it.

    A REFUSED run is logged too, and that is the point: the runs that produced
    nothing are exactly the ones an unmetered system loses track of, and they
    cost the same as the ones that worked.
    """
    row = {
        "at": int(time.time()),
        "run_id": budget.run_id,
        "agent_id": budget.agent_id,
        "tier": budget.tier,
        "outcome": outcome,
        "detail": detail,
        "model_calls": budget.model_calls,
        "tokens_in": budget.tokens_in,
        "tokens_out": budget.tokens_out,
        "usd": round(budget.usd, 6),
        "seconds": round(budget.elapsed, 3),
        "by_node": budget.by_node,
        "by_node_tokens": budget.by_node_tokens,
    }
    try:
        path = usage_log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row) + "\n")
    except OSError:
        # Never let the accounting write take a decision down — but this is the
        # one failure that must be loud, because an unmeasured run is how the
        # original incident stayed invisible.
        print(f"[brain] WARNING: could not persist usage for {budget.run_id}")
