"""The named desk, and merrymenbrain's report as one more untrusted input.

Two promises, both tested without a model or a network:

  the cast      every seat has a character, and the character comes AFTER the
                house rules in every system prompt it appears in
  the outside   merrymenbrain's report reaches the manager fenced and labelled,
                and every way it can fail leaves the decision unchanged
"""
from __future__ import annotations

import asyncio
import json
import time

import httpx
import pytest

from brain.cast import CAST, seat_for, voice
from brain.graph import BrainGraph, HOUSE_RULES, _DESK, _DEFAULT_DESK, _system
from brain.outside_research import FENCE_LABEL, OutsideConfig, OutsideReport, OutsideResearch, parse
from brain.schemas import (
    BrainDecision,
    DecideRequest,
    LENS_KEYS,
    MarketState,
    PortfolioQuality,
    PortfolioState,
)


def _request(tier="research", cls="equity-token", symbol="TSLA"):
    return DecideRequest(
        run_id="cast-test", agent_id="test", trigger_id="timer", tier=tier, stages="adaptive",
        persona="Steady basket. Hold if evidence is insufficient.",
        portfolio=PortfolioState(
            snapshot_id="book", as_of=1, cash_usdg=100_000_000, equity_usdg=100_000_000,
            net_contributions_usdg=100_000_000,
            quality=PortfolioQuality(
                audit_passed=True, epoch=1, current_accounting_history_auditable=True,
                contributions_known=True, equity_complete=True, gas_basis="net",
                position_history_available=True)),
        market=MarketState(
            snapshot_id="market", as_of=1, instrument_id=f"merrymen:{symbol.lower()}", symbol=symbol,
            instrument_class=cls, signals={"technical": "20d over 50d on 3x volume"}))


class _Recorder:
    def __init__(self):
        self.system: dict[str, str] = {}
        self.user: dict[str, str] = {}

    async def complete(self, **call):
        call["budget"].check_before(call["node"])
        call["budget"].record(call["node"], "test", "offline", 10, 10)
        self.system[call["node"]] = call["system"]
        self.user[call["node"]] = call["user"]
        if call["node"].startswith("analyst:"):
            return json.dumps({"direction": "hold", "confidence": .5, "evidence_strength": .5, "note": "mixed"})
        return json.dumps({"action": "hold", "confidence": .5, "suggested_delta_usdg": 0,
                           "thesis": "Mixed evidence; holding."})


# ── the cast ────────────────────────────────────────────────────────────────


def test_every_lens_any_desk_can_run_has_a_character():
    for lens in LENS_KEYS:
        assert seat_for(f"analyst:{lens}") is not None, lens
    for desk in list(_DESK.values()) + [_DEFAULT_DESK]:
        for lens in desk:
            assert seat_for(f"analyst:{lens}") is not None, lens


def test_committee_seats_are_the_merrymen():
    # Pinned by name: merrymenbrain's cast.py must say the same thing.
    assert seat_for("debate:bull").name == "Little John"
    assert seat_for("debate:bear").name == "Will Stutely"
    assert seat_for("risk:conservative").name == "Wat o' the Crabstaff"
    assert seat_for("portfolio-manager").name == "Robin Hood"


def test_no_character_is_seated_twice():
    names = [s.name for s in CAST.values()]
    assert len(names) == len(set(names))


def test_rules_then_character_then_job():
    text = _system("debate:bull", "You argue the bull case.")
    rules, seat, job = text.index(HOUSE_RULES), text.index("Little John"), text.index("You argue")
    assert rules == 0 and rules < seat < job


def test_an_unknown_node_keeps_the_rules_and_gets_no_character():
    assert voice("analyst:nothing") == ""
    assert _system("analyst:nothing", "job") == f"{HOUSE_RULES}\n\njob"


def test_every_prompt_in_a_run_is_in_character():
    model = _Recorder()
    result = asyncio.run(BrainGraph(model).run(_request()))
    assert isinstance(result, BrainDecision)
    assert "Will Scarlet" in model.system["analyst:technical"]
    assert "Robin Hood" in model.system["portfolio-manager"]
    for node, system in model.system.items():
        assert system.startswith(HOUSE_RULES), node


# ── merrymenbrain's report ──────────────────────────────────────────────────

REPORT = {
    "symbol": "TSLA", "rating": "Overweight", "action": "buy", "trade_date": "2026-09-23",
    "completed_at": int(time.time()) - 3600, "review": False,
    "decision": "Add gradually; delivery beat is real.", "decided_by": "Robin Hood",
    "seats": {"bull": "Little John", "bear": "Will Stutely"},
    "debate": {"bull": "Deliveries beat.", "bear": "Margins still thin."},
}


class _Outside(OutsideResearch):
    def __init__(self, report):
        super().__init__(OutsideConfig(url="http://x", token="t"))
        self.report = report
        self.asked = 0

    async def fetch(self, req):
        self.asked += 1
        return self.report


def _outside_report():
    return parse({"report": REPORT, "age_sec": 3600}, "TSLA", 86_400)


def test_the_report_reaches_the_manager_fenced():
    model = _Recorder()
    outside = _Outside(_outside_report())
    asyncio.run(BrainGraph(model, outside=outside).run(_request()))
    pm = model.user["portfolio-manager"]
    assert outside.asked == 1
    assert "OUTSIDE RESEARCH" in pm and "NOT INDEPENDENT" in pm
    assert f"<untrusted source='{FENCE_LABEL}'>" in pm
    assert "not independent" in FENCE_LABEL
    assert "merrymenbrain bull case: Deliveries beat." in pm
    # The other desk's voices are not named after this desk's seats.
    block = pm[pm.index("OUTSIDE RESEARCH"):]
    block = block[: block.index("</untrusted>")]
    assert "Robin Hood" not in block and "Little John" not in block


def test_no_report_means_an_unchanged_dossier():
    with_none, without = _Recorder(), _Recorder()
    asyncio.run(BrainGraph(with_none, outside=_Outside(None)).run(_request()))
    asyncio.run(BrainGraph(without).run(_request()))
    assert with_none.user["portfolio-manager"] == without.user["portfolio-manager"]


@pytest.mark.parametrize(
    "tier,cls,asked",
    [("research", "equity-token", True), ("deep", "crypto-native", True),
     ("pulse", "equity-token", False), ("research", "memecoin", False), ("research", "stablecoin", False)],
)
def test_only_researchable_runs_ask(tier, cls, asked):
    outside = _Outside(None)
    assert outside.wants(_request(tier=tier, cls=cls)) is asked


def test_unconfigured_is_off():
    assert OutsideConfig.from_env({}) is None
    assert OutsideConfig.from_env({"MERRYMENBRAIN_URL": "http://x"}) is None
    cfg = OutsideConfig.from_env({"MERRYMENBRAIN_URL": "http://x/", "MERRYMENBRAIN_TOKEN": "t", "MERRYMENBRAIN_TIERS": "deep"})
    assert cfg.url == "http://x" and cfg.tiers == {"deep"}


@pytest.mark.parametrize(
    "body",
    [
        None,
        {"report": None, "age_sec": 10},
        {"report": {k: v for k, v in REPORT.items() if k != "completed_at"}, "age_sec": 10},  # no timestamp
        {"report": REPORT, "age_sec": 90_000},                       # stale
        {"report": {**REPORT, "symbol": "NVDA"}, "age_sec": 10},     # wrong asset
        {"report": {**REPORT, "action": "yolo"}, "age_sec": 10},     # not an action
    ],
)
def test_unusable_bodies_are_dropped(body):
    assert parse(body, "TSLA", 86_400) is None


def test_hex_never_reaches_the_dossier():
    r = parse({"report": {**REPORT, "decision": "route via 0x" + "ab" * 20}, "age_sec": 5}, "TSLA", 86_400)
    assert isinstance(r, OutsideReport)
    assert "0xabab" not in r.text and "[redacted-hex]" in r.text


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_fetch_reads_a_queued_response_with_an_older_report():
    def handler(request):
        assert request.headers["authorization"] == "Bearer t"
        assert json.loads(request.content) == {"symbol": "TSLA", "instrument_class": "equity-token"}
        return httpx.Response(202, json={"ok": True, "status": "queued", "report": REPORT, "age_sec": 7200})

    async def go():
        async with _client(handler) as c:
            return await OutsideResearch(OutsideConfig(url="http://x", token="t"), client=c).fetch(_request())

    r = asyncio.run(go())
    # The older of the two ages wins: the service said 2h, the report says 1h.
    assert r is not None and r.action == "buy" and r.age_sec >= 7200


@pytest.mark.parametrize("fail", ["500", "timeout", "garbage"])
def test_every_failure_is_none(fail):
    def handler(request):
        if fail == "500":
            return httpx.Response(500, json={"detail": "boom"})
        if fail == "timeout":
            raise httpx.ReadTimeout("slow", request=request)
        return httpx.Response(200, content=b"not json")

    async def go():
        async with _client(handler) as c:
            return await OutsideResearch(OutsideConfig(url="http://x", token="t"), client=c).fetch(_request())

    assert asyncio.run(go()) is None


# ── the review's fixes ──────────────────────────────────────────────────────


def test_a_stale_report_cannot_be_passed_off_as_fresh():
    # An old merrymenbrain reset age_sec on a failed refresh. The report's own
    # completed_at still says three days, and that is what counts.
    stale = {**REPORT, "completed_at": int(time.time()) - 3 * 86_400}
    assert parse({"report": stale, "age_sec": 60}, "TSLA", 86_400) is None


@pytest.mark.parametrize("patch", [{"review": True}, {"rating": "REVIEW"}, {"rating": "review", "review": False}])
def test_an_unreadable_committee_run_is_not_a_hold_vote(patch):
    assert parse({"report": {**REPORT, **patch, "action": "hold"}, "age_sec": 10}, "TSLA", 86_400) is None


@pytest.mark.parametrize(
    "env,timeout,max_age",
    [
        ({"MERRYMENBRAIN_TIMEOUT_SEC": "3s", "MERRYMENBRAIN_MAX_AGE_SEC": "24h"}, 3.0, 86_400),
        # Out of range is CLAMPED: a too-long timeout to the cap, a too-tight
        # staleness bound to the tightest allowed, never back to the loose default.
        ({"MERRYMENBRAIN_TIMEOUT_SEC": "600", "MERRYMENBRAIN_MAX_AGE_SEC": "30"}, 10.0, 60),
        ({"MERRYMENBRAIN_TIMEOUT_SEC": "3", "MERRYMENBRAIN_MAX_AGE_SEC": "86400.0"}, 3.0, 86_400),
        ({"MERRYMENBRAIN_TIMEOUT_SEC": "2.5", "MERRYMENBRAIN_MAX_AGE_SEC": "3600"}, 2.5, 3_600),
    ],
)
def test_bad_optional_numbers_fall_back_instead_of_crashing(env, timeout, max_age):
    cfg = OutsideConfig.from_env({"MERRYMENBRAIN_URL": "http://x", "MERRYMENBRAIN_TOKEN": "t", **env})
    assert (cfg.timeout_sec, cfg.max_age_sec) == (timeout, max_age)


@pytest.mark.parametrize("tiers", ["", " ", "\t", ",", " , "])
def test_a_blank_tier_list_means_the_default(tiers):
    cfg = OutsideConfig.from_env({"MERRYMENBRAIN_URL": "http://x", "MERRYMENBRAIN_TOKEN": "t", "MERRYMENBRAIN_TIERS": tiers})
    assert cfg.tiers == {"research", "deep"}


def test_a_dripping_server_cannot_hold_a_decision():
    # httpx's read timeout restarts per chunk; the fetch has a TOTAL deadline.
    async def slow(request):
        await asyncio.sleep(5)
        return httpx.Response(200, json={"report": REPORT, "age_sec": 1})

    async def go():
        async with _client(slow) as c:
            o = OutsideResearch(OutsideConfig(url="http://x", token="t", timeout_sec=0.2), client=c)
            started = time.monotonic()
            r = await o.fetch(_request())
            return r, time.monotonic() - started

    r, took = asyncio.run(go())
    assert r is None and took < 1.0


def test_the_risk_committee_never_reads_half_a_fence():
    from brain.graph import _fence, _tail_outside_fences

    dossier = (
        "ANALYST REPORTS\n" + "x" * 3000
        + "\n\nOUTSIDE RESEARCH — UNTRUSTED\n" + _fence("merrymenbrain", "Buy now. " * 300)
        + "\n\nBULL CASE\n" + "b" * 500 + "\n\nBEAR CASE\n" + "c" * 500
    )
    for limit in range(1000, 6000, 7):
        plan = _tail_outside_fences(dossier, limit)
        assert plan.count("<untrusted") == plan.count("</untrusted>"), limit
        assert "Buy now." not in plan or "<untrusted source='merrymenbrain'>" in plan, limit
        assert plan.endswith("c" * 500)


def test_the_caveat_survives_any_slice_that_keeps_the_other_desk():
    # The header above the fence can be cut; the label on the fence cannot.
    from brain.graph import _fence, _tail_outside_fences
    from brain.outside_research import dossier_block

    report = _outside_report()
    dossier = "x" * 3000 + dossier_block(report, _fence) + "\n\nBULL CASE\n" + "b" * 400
    for limit in range(200, 4000, 3):
        plan = _tail_outside_fences(dossier, limit)
        if "merrymenbrain rating" in plan:
            assert f"<untrusted source='{FENCE_LABEL}'>" in plan, limit


@pytest.mark.parametrize(
    "status,body,expect",
    [
        (200, {"ok": True, "key_problem": None, "pending": 0}, {"reachable": True, "auth_ok": True, "remote_ok": True}),
        (200, {"ok": False, "key_problem": "no model key"}, {"remote_ok": False, "remote_problem": "no model key"}),
        (401, {"detail": "bad token"}, {"reachable": True, "auth_ok": False}),
        (503, {"detail": "no token"}, {"reachable": True, "auth_ok": False}),
    ],
)
def test_health_probe_names_what_is_wrong(status, body, expect):
    from brain.outside_research import probe

    async def go():
        async with _client(lambda request: httpx.Response(status, json=body)) as c:
            return await probe(OutsideConfig(url="http://x", token="t"), client=c)

    state = asyncio.run(go())
    for k, v in expect.items():
        assert state[k] == v, (k, state)


def test_health_probe_survives_an_unreachable_desk():
    from brain.outside_research import probe

    def refuse(request):
        raise httpx.ConnectError("refused", request=request)

    async def go():
        async with _client(refuse) as c:
            return await probe(OutsideConfig(url="http://x", token="t"), client=c)

    assert asyncio.run(go()) == {"reachable": False, "problem": "ConnectError"}


def test_health_and_decide_survive_a_bad_optional_variable(monkeypatch):
    from fastapi.testclient import TestClient

    import brain.server as server

    monkeypatch.setenv("MERRYMENBRAIN_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("MERRYMENBRAIN_TOKEN", "t")
    monkeypatch.setenv("MERRYMENBRAIN_TIMEOUT_SEC", "3s")
    monkeypatch.setenv("MERRYMENBRAIN_MAX_AGE_SEC", "24h")
    r = TestClient(server.app).get("/health")
    assert r.status_code == 200
    assert r.json()["outside_research"]["configured"] is True
    assert server._outside() is not None


def test_startup_says_in_the_logs_whether_the_desk_is_wired(monkeypatch, caplog):
    # Brain has no public domain, so the deploy logs are where an operator looks.
    import brain.server as server

    states = iter([
        {"configured": True, "reachable": False, "problem": "ConnectError"},
        {"configured": True, "reachable": False, "problem": "ConnectError"},   # unchanged: not logged again
        {"configured": True, "reachable": True, "auth_ok": True, "remote_ok": True},
        {"configured": True, "reachable": True, "auth_ok": True, "remote_ok": True},  # never reached
    ])

    async def fake_state():
        return next(states)

    monkeypatch.setattr(server, "_outside_state", fake_state)
    monkeypatch.setattr(server, "WIRING_CHECKS_SEC", (0, 0, 0, 0))
    with caplog.at_level("WARNING", logger="brain.server"):
        asyncio.run(server._report_wiring())
    lines = [r.getMessage() for r in caplog.records if "merrymenbrain wiring" in r.getMessage()]
    assert lines == [
        "merrymenbrain wiring: reachable=False auth_ok=None remote_ok=None problem=ConnectError",
        "merrymenbrain wiring: ok",
    ]
