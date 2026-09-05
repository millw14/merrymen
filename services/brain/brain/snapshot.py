"""
THE CANONICAL SNAPSHOT, AS BRAIN RECEIVES IT — and never as Brain computes it.

`packages/core/src/portfolio-snapshot.ts` is the one implementation of what a
book is worth and whether its P&L may be published. This module is the Python
side of that wire, and its single rule is that it CARRIES those figures rather
than deriving them.

That rule is load-bearing rather than tidy. The worker computed equity from
balances, the web recomputed it from mirrored rows, and they disagreed; a third
implementation here would disagree with both, and Brain's disagreement would be
the one that reached an owner as a published thesis. So:

  - equity is read, never summed from positions;
  - P&L is read, never computed from equity minus contributions;
  - `publishable` is read, never inferred from the presence of a number.

`from_canonical` will REFUSE a payload missing any of those, because the
alternative — filling a gap with a computation — is exactly the thing this file
exists to prevent. A snapshot Brain cannot read is a refusal, not a guess.
"""

from __future__ import annotations

from typing import Any

from .schemas import PortfolioQuality, PortfolioState, Position


class SnapshotUnreadable(ValueError):
    """The payload is not a canonical snapshot Brain can carry."""


def _require(d: dict[str, Any], key: str) -> Any:
    if key not in d:
        raise SnapshotUnreadable(
            f"canonical snapshot is missing '{key}'. Brain carries this figure and does not "
            f"compute it — a missing field is a refusal, not a gap to fill."
        )
    return d[key]


def from_canonical(payload: dict[str, Any]) -> PortfolioState:
    """
    Parse a `PortfolioSnapshot` as emitted by packages/core. PURE.

    Field names arrive in the TypeScript camelCase the core module emits; they
    are not re-cased on the wire, because a rename is a place two sides can
    drift and the JSON is the contract.
    """
    version = payload.get("schemaVersion")
    if version != "1.0.0":
        raise SnapshotUnreadable(
            f"this build reads canonical snapshot 1.0.0, the payload said {version!r}"
        )

    q = _require(payload, "quality")
    quality = PortfolioQuality(
        audit_passed=bool(q.get("auditPassed", False)),
        epoch=int(q.get("epoch", 1)),
        contributions_known=bool(q.get("contributionsKnown", False)),
        equity_complete=bool(q.get("equityComplete", False)),
        gas_basis=q.get("gasBasis", "unknown"),
        position_history_available=bool(q.get("positionHistoryAvailable", False)),
        quarantined_assets_present=bool(q.get("quarantinedAssetsPresent", False)),
    )

    positions = [
        Position(
            instrument_id=str(p["instrumentId"]),
            symbol=str(p["symbol"]),
            qty=str(p.get("qtyRaw", "0")),
            value_usdg=int(p["valueUsdg"]),
            cost_basis_usdg=None if p.get("costBasisUsdg") is None else int(p["costBasisUsdg"]),
        )
        for p in payload.get("positions", [])
    ]

    return PortfolioState(
        snapshot_id=str(_require(payload, "snapshotId")),
        as_of=int(_require(payload, "asOf")),
        cash_usdg=int(_require(payload, "cashUsdg")),
        # READ, NOT SUMMED. Summing positions here would be a second NAV
        # implementation, and it would be wrong in a specific way: it would miss
        # the vault and quarantined legs the core identity includes.
        equity_usdg=int(_require(payload, "equityUsdg")),
        # NULL SURVIVES AS NULL. `contributions unknown` is the arm every
        # consumer must handle, and coercing it to 0 is the original bug.
        net_contributions_usdg=(
            None
            if payload.get("netContributionsUsdg") is None
            else int(payload["netContributionsUsdg"])
        ),
        positions=positions,
        quality=quality,
        pnl_publishable=(payload.get("pnl") or {}).get("publishable"),
        pnl_unavailable=(payload.get("pnl") or {}).get("unavailable"),
    )


def pnl_line(payload: dict[str, Any]) -> str:
    """
    The P&L as CORE decided it, phrased for a prompt.

    Brain is told the answer rather than the ingredients, so there is no version
    of this where a model does the arithmetic and gets a different number than
    the dashboard shows.
    """
    pnl = payload.get("pnl") or {}
    if not pnl.get("publishable"):
        why = pnl.get("unavailable") or "unknown"
        return (
            f"PERFORMANCE IS NOT MEASURABLE for this book ({why.replace('-', ' ')}). "
            f"Do not state or imply a return, a percentage, or a profit."
        )
    micro = int(pnl.get("usdgSinceContribution") or 0)
    basis = pnl.get("gasBasis", "unknown")
    sign = "-" if micro < 0 else ""
    whole, frac = divmod(abs(micro), 1_000_000)
    qualifier = " (GROSS of gas — trading costs are not subtracted)" if basis != "net" else ""
    return f"Performance since contributed capital: {sign}{whole}.{frac:06d} USDG{qualifier}."
