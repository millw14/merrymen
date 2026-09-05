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

import os
import secrets
import time

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

from .budget import AgentConcurrency, persist_usage, RunBudget, TIERS
from .graph import BrainGraph
from .llm import Llm, LlmConfig
from .schemas import BrainDecision, DecideRequest, Refusal, SCHEMA_VERSION

app = FastAPI(title="Merrymen Brain", version=SCHEMA_VERSION)

_concurrency = AgentConcurrency()
_llm = Llm(LlmConfig.from_env())
_graph = BrainGraph(_llm)


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
    cfg = _llm.cfg
    return {
        "ok": True,
        "schema_version": SCHEMA_VERSION,
        "provider": cfg.provider,
        "deep_model": cfg.deep_model,
        "quick_model": cfg.quick_model,
        "key_configured": bool(cfg.api_key),
        "token_configured": bool(os.getenv("BRAIN_TOKEN")),
        "tiers": {k: vars(v) for k, v in TIERS.items()},
    }


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

    started = time.monotonic()
    async with lock:
        result = await _graph.run(req)

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
