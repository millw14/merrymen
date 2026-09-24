"""
THE SERVICE BOUNDARY. `POST /v1/decide` returns a validated BrainDecision.

Mirrors the browser service point for point, because that service exists for the
identical reason and its shape is already load-bearing here: pinned port, bind
`::`, no public domain, a bearer token that FAILS CLOSED when unset, and a typed
`{ok: …}` union rather than exceptions crossing the wire.

WHAT THIS SERVICE MUST NEVER HOLD: the store DEK, the session secret,
DATABASE_URL, any owner or session key, bundler or RPC house keys, or any
authority to construct calldata. It computes; Merrymen owns the database and the
money. Brain is outside the trust domain by construction, not by policy.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import secrets
import time

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

from .budget import AgentConcurrency, persist_usage, RunBudget, TIERS
from .credential import CredentialRefused, resolve as resolve_credential
from .cast import roster
from .graph import BrainGraph
from .outside_research import OutsideConfig, OutsideResearch, probe as probe_outside
from .llm import Llm, LlmConfig
from .schemas import BrainDecision, DecideRequest, Refusal, SCHEMA_VERSION

log = logging.getLogger(__name__)

#: When the startup wiring check re-probes merrymenbrain, in seconds after boot.
#: The two services deploy independently, so the first probe often runs before
#: merrymenbrain is up; a few spaced retries catch it without polling forever.
WIRING_CHECKS_SEC = (0, 30, 90, 300)


async def _report_wiring() -> None:
    """
    SAY IN THE DEPLOY LOGS WHETHER MERRYMENBRAIN IS WIRED.

    Brain has no public domain, so its /health is not something an operator can
    open in a browser. The deploy logs are. Each probe result is logged when it
    changes, until the wiring is complete or the checks run out. Warning level,
    because that is what reaches Railway's logs without a logging config.
    """
    last = None
    elapsed = 0
    for at in WIRING_CHECKS_SEC:
        await asyncio.sleep(at - elapsed)
        elapsed = at
        state = await _outside_state()
        if not state.get("configured"):
            if state.get("problem"):
                log.warning("merrymenbrain wiring: not configured (%s)", state["problem"])
            return
        wired = state.get("reachable") and state.get("auth_ok") and state.get("remote_ok")
        summary = "ok" if wired else (
            f"reachable={state.get('reachable')} auth_ok={state.get('auth_ok')} "
            f"remote_ok={state.get('remote_ok')} problem={state.get('problem') or state.get('remote_problem')}"
        )
        if summary != last:
            log.warning("merrymenbrain wiring: %s", summary)
            last = summary
        if wired:
            return


@contextlib.asynccontextmanager
async def _lifespan(_app: FastAPI):
    task = asyncio.create_task(_report_wiring())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(title="Merrymen Brain", version=SCHEMA_VERSION, lifespan=_lifespan)

_concurrency = AgentConcurrency()

# LAZY, AND DELIBERATELY SO.
#
# `LlmConfig.from_env` REFUSES when there is no Brain credential — the right
# behaviour for a decision and the wrong one for a process. Building the client
# at import time turns a missing key into a container that cannot start: the
# operator loses /health, loses the line saying WHICH thing is missing, and gets
# a crash loop instead of a diagnosis.
#
# Fail closed on the decision. Stay up to say why.
_graph_cache: BrainGraph | None = None


def _graph() -> BrainGraph:
    global _graph_cache
    if _graph_cache is None:
        _graph_cache = BrainGraph(Llm(LlmConfig.from_env()), outside=_outside())
    return _graph_cache


def _outside() -> OutsideResearch | None:
    """
    merrymenbrain's client, or None. NEVER RAISES.

    Outside research is optional, so nothing about it may stop a decision. Its
    config already falls back on bad numbers; this catches anything else, so a
    typo in an optional variable costs the second opinion and not the service.
    """
    try:
        cfg = OutsideConfig.from_env()
    except Exception as e:  # noqa: BLE001
        log.warning("outside research disabled: %s", type(e).__name__)
        return None
    return OutsideResearch(cfg) if cfg else None


def _credential_state() -> tuple[bool, str | None]:
    """Whether a usable credential is configured, for /health. Never the key itself."""
    try:
        return True, resolve_credential().fingerprint
    except CredentialRefused as e:
        return False, str(e)


def _require_token(authorization: str | None) -> None:
    """
    FAILS CLOSED WHEN UNSET.

    An auth check that passes when no token is configured is not an auth check;
    it is a service that is open in exactly the deployment where someone forgot.
    """
    want = os.getenv("BRAIN_TOKEN", "")
    if not want:
        raise HTTPException(status_code=503, detail="BRAIN_TOKEN is not configured; refusing every request")
    got = (authorization or "").removeprefix("Bearer ").strip()
    if not secrets.compare_digest(got, want):
        raise HTTPException(status_code=401, detail="bad token")


@app.get("/health")
async def health() -> dict:
    """
    Always answers, even when Brain cannot decide anything.

    A health endpoint reachable only once everything is configured tells you
    nothing on the day something is not.
    """
    key_ok, key_note = _credential_state()
    token_ok = bool(os.getenv("BRAIN_TOKEN"))
    return {
        # NOT ok UNLESS IT COULD ACTUALLY WORK. A green health check on a service
        # that would refuse every request is a lie an operator acts on.
        "ok": key_ok and token_ok,
        "schema_version": SCHEMA_VERSION,
        "key_configured": key_ok,
        "key": key_note if key_ok else None,
        "key_problem": None if key_ok else key_note,
        "token_configured": token_ok,
        "deep_model": os.getenv("BRAIN_DEEP_MODEL", "openai/gpt-oss-120b"),
        "quick_model": os.getenv("BRAIN_QUICK_MODEL", "openai/gpt-oss-20b"),
        "tiers": {k: vars(v) for k, v in TIERS.items()},
        "cast": roster(),
        "outside_research": await _outside_state(),
    }


async def _outside_state() -> dict:
    """
    Whether merrymenbrain is wired AND answering. Never the token or the URL.

    Optional, so it reports rather than decides: `ok` above does not depend on
    it. Any failure here, including a bad variable, is a field in the answer,
    never a failed health check.
    """
    try:
        cfg = OutsideConfig.from_env()
        if cfg is None:
            return {"configured": False}
        state = {"configured": True, "tiers": sorted(cfg.tiers), "timeout_sec": cfg.timeout_sec}
        state.update(await probe_outside(cfg))
        return state
    except Exception as e:  # noqa: BLE001
        return {"configured": False, "problem": type(e).__name__}


@app.post("/v1/decide")
async def decide(req: DecideRequest, authorization: str | None = Header(default=None)) -> JSONResponse:
    _require_token(authorization)

    if req.schema_version != SCHEMA_VERSION:
        # A TYPED REFUSAL, not a best-effort parse. Version skew between the
        # worker and this service is exactly when a best-effort parse produces
        # a decision nobody's contract describes.
        return JSONResponse(
            status_code=400,
            content={
                "ok": False,
                "refusal": Refusal(
                    run_id=req.run_id,
                    agent_id=req.agent_id,
                    reason="schema-version-unsupported",
                    detail=f"this service speaks {SCHEMA_VERSION}, the request said {req.schema_version}",
                    cost={"model_calls": 0, "tokens_in": 0, "tokens_out": 0, "usd": 0.0},
                ).model_dump(),
            },
        )

    lock = _concurrency.lock_for(req.agent_id)
    if lock.locked():
        # ONE RUN PER AGENT. Queuing would let a burst of triggers stack up
        # against a shared allowance; refusing tells the caller to back off.
        return JSONResponse(
            status_code=429,
            content={"ok": False, "detail": f"a run is already in flight for {req.agent_id}"},
        )

    try:
        graph = _graph()
    except CredentialRefused as e:
        # A TYPED REFUSAL, not a 500. The caller must be able to tell "Brain has
        # no key" from "Brain fell over" — only one of those is fixed by an
        # operator setting a variable.
        return JSONResponse(
            status_code=200,
            content={
                "ok": False,
                "refusal": Refusal(
                    run_id=req.run_id,
                    agent_id=req.agent_id,
                    reason="provider-unavailable",
                    detail=str(e),
                    cost={"model_calls": 0, "tokens_in": 0, "tokens_out": 0, "usd": 0.0},
                ).model_dump(),
            },
        )

    started = time.monotonic()
    async with lock:
        result = await graph.run(req)

    elapsed = round(time.monotonic() - started, 3)
    if isinstance(result, Refusal):
        persist_usage(
            RunBudget(req.run_id, req.agent_id, req.tier, TIERS[req.tier]),
            outcome=f"refused:{result.reason}",
            detail=result.detail,
        )
        return JSONResponse(
            status_code=200,
            content={"ok": False, "refusal": result.model_dump(), "seconds": elapsed},
        )

    assert isinstance(result, BrainDecision)
    return JSONResponse(
        status_code=200,
        content={"ok": True, "decision": result.model_dump(), "seconds": elapsed},
    )
