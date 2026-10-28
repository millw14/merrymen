"""
WHY A LENS SAID "provider-failed", and the fault that made most of them say it.

Production, 2026-10-10 to 10-12: a quarter to over half of Trencher Brain
reviews lost their technical or social lens to `provider-failed`, while the
liquidity lens never failed once in more than 1,400 calls. Every
portfolio-manager refusal that carried its error text read "400 Bad Request";
none said "rate limited". Probed against Groq directly:

  - gpt-oss refuses `reasoning_effort: "none"` ("must be one of `low`,
    `medium`, or `high`"), so this module dropped the hint, which means the
    model's default: medium reasoning.
  - Medium reasoning spends most of the 1,400-token output cap before the answer
    starts; a long lens prompt spends all of it.
  - JSON mode cannot validate a truncated answer: 400 `json_validate_failed`,
    and the identical retry fails the same way.

So the fix is the step down to the lowest effort the model names, and the
diagnostics are a kind, a status and a code on every failure, in a bounded
line with no secret and no model output in it.
"""

from __future__ import annotations

import json
import logging
from itertools import count

import httpx
import pytest

from brain import llm as llm_mod
from brain.budget import RunBudget, TIERS
from brain.graph import BrainGraph
from brain.llm import (
    REASONING_FIELD,
    Llm,
    LlmConfig,
    ProviderError,
    _REASONING_EFFORT_REFUSED,
    _REASONING_HINT_REFUSED,
    _REASONING_NONE_STEP_DOWN,
    _lowest_offered_effort,
)
from brain.schemas import DecideRequest, MarketState, PortfolioQuality, PortfolioState

KEY = "test-key-0123456789abcdef"

#: Groq's refusal, verbatim, for gpt-oss and `reasoning_effort: "none"`.
GROQ_NONE_REFUSED = {
    "error": {
        "message": "`reasoning_effort` must be one of `low`, `medium`, or `high`",
        "type": "invalid_request_error",
    }
}

#: Groq's JSON-mode rejection of the model's own (here truncated) output.
GROQ_JSON_INVALID = {
    "error": {
        "message": "Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.",
        "type": "invalid_request_error",
        "code": "json_validate_failed",
        "failed_generation": '{"direction":"buy","note":"MATERIAL-SECRET-SENTINEL',
    }
}

OK = {
    "choices": [{"message": {"content": '{"direction":"hold","confidence":0.5}'}, "finish_reason": "stop"}],
    "usage": {"prompt_tokens": 10, "completion_tokens": 5},
}

_urls = count()


def _cfg(quick: str = "openai/gpt-oss-20b") -> LlmConfig:
    # A fresh base URL per test: the hint memory is process-wide.
    return LlmConfig(
        base_url=f"https://provider-{next(_urls)}.invalid/v1",
        api_key=KEY,
        deep_model="openai/gpt-oss-120b",
        quick_model=quick,
    )


def _budget() -> RunBudget:
    return RunBudget(run_id="r", agent_id="0xa", tier="research", limits=TIERS["research"])


@pytest.fixture
def no_sleep(monkeypatch):
    slept: list[float] = []

    async def fake(delay: float) -> None:
        slept.append(delay)

    monkeypatch.setattr(llm_mod.asyncio, "sleep", fake)
    return slept


# ── the fault ──────────────────────────────────────────────────────────────


async def test_a_refused_none_steps_down_to_the_lowest_named_effort_not_the_default():
    """
    The fix. Dropping the field on Groq's refusal asked gpt-oss for MEDIUM
    reasoning; the refusal itself names `low`, and `low` is what is sent.
    """
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body)
        if body.get(REASONING_FIELD) == "none":
            return httpx.Response(400, json=GROQ_NONE_REFUSED)
        return httpx.Response(200, json=OK)

    cfg = _cfg()
    llm = Llm(cfg, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    budget = _budget()

    await llm.complete(node="analyst:technical", budget=budget, system="s", user="u")
    await llm.complete(node="analyst:social", budget=budget, system="s", user="u")

    assert [b.get(REASONING_FIELD) for b in seen] == ["none", "low", "low"], seen
    assert budget.model_calls == 2, "the refused hint never reached a model"
    assert _REASONING_NONE_STEP_DOWN[(cfg.base_url, "openai/gpt-oss-20b")] == "low"
    # Not "this endpoint refuses the hint": the hint is still being sent.
    assert cfg.base_url not in _REASONING_HINT_REFUSED


async def test_the_step_down_is_per_model_so_a_model_that_takes_none_keeps_it():
    """qwen3 takes "none" behind the same Groq base URL that gpt-oss refuses it on."""
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body)
        if body["model"].startswith("openai/gpt-oss") and body.get(REASONING_FIELD) == "none":
            return httpx.Response(400, json=GROQ_NONE_REFUSED)
        return httpx.Response(200, json=OK)

    # A quick model in the reasoning families that is not gpt-oss.
    cfg = _cfg(quick="qwen/qwen3-thinking-32b")
    llm = Llm(cfg, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    await llm.complete(node="portfolio-manager", budget=_budget(), system="s", user="u", deep=True)
    await llm.complete(node="analyst:technical", budget=_budget(), system="s", user="u")

    assert [(b["model"], b.get(REASONING_FIELD)) for b in seen] == [
        ("openai/gpt-oss-120b", "none"),
        ("openai/gpt-oss-120b", "low"),
        ("qwen/qwen3-thinking-32b", "none"),
    ]


async def test_a_refused_step_down_drops_the_hint_and_cannot_loop():
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body)
        if REASONING_FIELD in body:
            return httpx.Response(400, json=GROQ_NONE_REFUSED)
        return httpx.Response(200, json=OK)

    cfg = _cfg()
    llm = Llm(cfg, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    await llm.complete(node="analyst:technical", budget=_budget(), system="s", user="u")
    await llm.complete(node="analyst:social", budget=_budget(), system="s", user="u")

    assert [b.get(REASONING_FIELD) for b in seen] == ["none", "low", None, None]
    assert (cfg.base_url, "low") in _REASONING_EFFORT_REFUSED


def test_only_quoted_efforts_count_as_offered():
    assert _lowest_offered_effort(GROQ_NONE_REFUSED["error"]["message"]) == "low"
    assert _lowest_offered_effort("one of 'minimal', 'low', 'medium'") == "minimal"
    # Prose that merely contains the letters is not an offer.
    assert _lowest_offered_effort("'reasoning_effort' is not allowed below this tier") is None
    # And "medium" alone is never a step DOWN from "none".
    assert _lowest_offered_effort("`reasoning_effort` must be `medium`") is None


# ── the diagnostics ────────────────────────────────────────────────────────


async def test_json_mode_rejection_is_named_and_never_leaks_the_generation(caplog, no_sleep):
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(400, json=GROQ_JSON_INVALID)

    llm = Llm(_cfg(), client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    with caplog.at_level(logging.WARNING, logger="brain.llm"):
        with pytest.raises(ProviderError) as info:
            await llm.complete(node="analyst:technical", budget=_budget(), system="s", user="u", json_schema={})

    e = info.value
    assert (e.kind, e.status, e.code) == ("invalid-json", 400, "json_validate_failed")
    assert "400 invalid-json json_validate_failed" in str(e)
    assert calls == 2, "the ordinary bounded retry"
    assert no_sleep == [1.0], "a pause between attempts, none after the last"
    lines = [r.getMessage() for r in caplog.records]
    assert len(lines) == 2 and all("kind=invalid-json status=400 code=json_validate_failed" in l for l in lines)
    for text in (*lines, str(e)):
        assert "MATERIAL-SECRET-SENTINEL" not in text, "the model's output is never logged"
        assert KEY not in text


async def test_a_rate_limit_says_so_with_the_providers_own_numbers(caplog, no_sleep):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            headers={
                "retry-after": "7",
                "x-ratelimit-remaining-requests": "14000",
                "x-ratelimit-remaining-tokens": "0",
            },
            json={"error": {"message": "Rate limit reached for model", "type": "tokens", "code": "rate_limit_exceeded"}},
        )

    llm = Llm(_cfg(), client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    with caplog.at_level(logging.WARNING, logger="brain.llm"):
        with pytest.raises(ProviderError) as info:
            await llm.complete(node="analyst:social", budget=_budget(), system="s", user="u")

    assert (info.value.kind, info.value.status) == ("rate-limit", 429)
    assert no_sleep == [1.5], "the old loop also slept 3s after its final 429, for nothing"
    line = caplog.records[-1].getMessage()
    assert "kind=rate-limit status=429" in line
    assert "retry_after=7" in line and "remaining_tokens=0" in line


@pytest.mark.parametrize(
    ("response", "kind", "status"),
    [
        (httpx.Response(503, text="upstream unavailable"), "server", 503),
        (httpx.Response(401, json={"error": {"message": f"Invalid API Key {KEY}"}}), "auth", 401),
        (httpx.Response(400, json={"error": {"message": "context length exceeded"}}), "bad-request", 400),
    ],
)
async def test_each_status_gets_its_kind_and_the_key_is_scrubbed(response, kind, status, caplog, no_sleep):
    llm = Llm(_cfg(), client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _r: response)))
    with caplog.at_level(logging.WARNING, logger="brain.llm"):
        with pytest.raises(ProviderError) as info:
            await llm.complete(node="analyst:technical", budget=_budget(), system="s", user="u")
    assert (info.value.kind, info.value.status) == (kind, status)
    assert all(KEY not in r.getMessage() for r in caplog.records)
    assert KEY not in str(info.value)


async def test_a_timeout_is_a_timeout(no_sleep):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    llm = Llm(_cfg(), client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    with pytest.raises(ProviderError) as info:
        await llm.complete(node="analyst:technical", budget=_budget(), system="s", user="u")
    assert info.value.kind == "timeout" and info.value.status is None
    assert "timeout ReadTimeout" in str(info.value)


async def test_an_answer_cut_at_the_cap_is_logged(caplog):
    cut = {
        "choices": [{"message": {"content": '{"direction":'}, "finish_reason": "length"}],
        "usage": {"prompt_tokens": 900, "completion_tokens": 1400},
    }
    llm = Llm(_cfg(), client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _r: httpx.Response(200, json=cut))))
    with caplog.at_level(logging.WARNING, logger="brain.llm"):
        await llm.complete(node="analyst:technical", budget=_budget(), system="s", user="u")
    line = caplog.records[-1].getMessage()
    assert "output cap reached (completion_tokens=1400 max_tokens=1400" in line


async def test_the_lens_note_carries_the_kind(no_sleep):
    """What the manager reads in the dossier, and the orchestrator's refusal detail, name the fault."""
    llm = Llm(
        _cfg(),
        client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _r: httpx.Response(400, json=GROQ_JSON_INVALID))),
    )
    req = DecideRequest(
        run_id="r", agent_id="0xa", trigger_id="timer", tier="research", stages="adaptive",
        persona="Trencher.",
        portfolio=PortfolioState(
            snapshot_id="book", as_of=1, cash_usdg=100_000_000, equity_usdg=100_000_000,
            net_contributions_usdg=100_000_000,
            quality=PortfolioQuality(
                audit_passed=True, epoch=1, current_accounting_history_auditable=True,
                contributions_known=True, equity_complete=True, gas_basis="net",
                position_history_available=True)),
        market=MarketState(
            snapshot_id="market", as_of=1, instrument_id="merrymen:meme", symbol="MEME",
            instrument_class="memecoin", signals={"technical": "24h volume: $200000"}),
    )
    out, view = await BrainGraph(llm)._analyst(req, _budget(), "technical", "material")
    assert view.direction == "provider-failed"
    assert "invalid-json json_validate_failed" in view.note
    assert "MATERIAL-SECRET-SENTINEL" not in out.text
