"""Merrymen as the broker: sizing in USDG, the pre-flight checks and the proposal log.

The saved results below have the shapes the Merrymen MCP tools return
(web/src/mcp/tools: discover_tokens, get_agent_status, get_agent_controls,
quote_trade, propose_trade). The trade is the upstream reel's: TSLA on Monday
2026-10-19, entry 364.18 at 10:15, stop 358.32, target 370.04.
"""

import contextlib
import copy
import io
import json
import os
import shutil
import tempfile
import unittest

from _load import load, ROOT

mm = load("trader-broker", "merrymen")
size = load("trader-budget", "size")
risk = load("trader-risk", "check")
ticket = load("trader-broker", "ticket")

TSLA = "0x" + "1a" * 20
NVDA = "0x" + "2b" * 20
IMPOSTOR = "0x" + "3c" * 20
NOW = "2026-10-19 10:15"            # New York; 14:15 UTC
NOW_UTC = "2026-10-19T14:15:00Z"

PLAN = {"symbol": "TSLA", "side": "buy", "date": "2026-10-19", "setup": "orb", "entry_time": "10:15 AM",
        "entry": 364.18, "stop": 358.32, "target": 370.04, "flat_by": "15:55",
        "stop_label": "the opening range's midpoint", "target_label": "1R"}

CFG = {"broker": "merrymen", "merrymen_agent": "robin", "paper": True, "budget": 200, "cash_buffer_pct": 10,
       "max_position_pct": 50, "max_order_usd": 50, "min_order_usd": 1, "max_loss_per_trade_usd": 2,
       "max_daily_loss_usd": 6, "max_trades_per_day": 3, "max_orders_per_day": 10, "min_reward_risk": 1.0,
       "require_stop": True, "no_entries_before": "09:45", "no_entries_after": "15:30", "flat_by": "15:55",
       "reserve_exit_budget": True, "max_quote_gap_pct": 1.0, "fractional": True}

TOKENS = {"list": "established", "ranking": "registry", "total": 3, "next_cursor": None, "items": [
    {"origin": "registry", "rank": 1, "address": TSLA, "symbol": "TSLA", "name": "Tesla", "kind": "stock",
     "stock_kind": "stock", "price_usd": 364.2, "price_source": "chainlink", "price_missing_reason": None,
     "price_updated_at": "2026-10-19T14:14:30Z", "paused": False, "volume_24h_usd": 120000, "holders": 900,
     "flags": {}, "caveats": []},
    {"origin": "registry", "rank": 2, "address": NVDA, "symbol": "NVDA", "name": "NVIDIA", "kind": "stock",
     "stock_kind": "stock", "price_usd": None, "price_source": None, "price_missing_reason": "halted",
     "price_updated_at": None, "paused": True, "volume_24h_usd": None, "holders": None, "flags": {},
     "caveats": []},
    {"origin": "index_pool", "rank": 3, "address": IMPOSTOR, "symbol": "TSLA", "name": "Tesla (pool)"},
]}

STATUS = {"agent": "robin", "name": "Robin", "account": "0x0000000000000000000000000000000000000001", "chain_id": 4663, "status": "active",
          "mode": "paper", "mode_explained": "Practising with simulated money.", "live_blocker": None,
          "strategy": "steady-basket", "permission": {"granted_at": "2026-10-15T09:00:00Z",
                                                       "expires_at": "2026-10-22T09:00:00Z", "expired": False,
                                                       "days_left": 2},
          "observed_at": "2026-10-19T14:13:00Z"}
CONTROLS = {"agent": "robin",
            "signed_limits": {"per_trade_usdg": 25, "per_day_usdg": 100, "max_drawdown_pct": 5,
                              "max_ops_per_day": 20, "granted_at": "2026-10-15T09:00:00Z",
                              "expires_at": "2026-10-22T09:00:00Z", "enforced_where": "..."},
            "budget_24h": {"book": "paper", "spent_usdg": 0, "remaining_usdg": 100, "ops": 0, "ops_remaining": 20,
                           "note": "..."},
            "risk_settings": {"slippage_bps": 100, "max_impact_bps": 150, "stop_loss_bps": None,
                              "take_profit_bps": None, "chat_action_ceiling_usdg": 25, "tick_seconds": 60,
                              "launch_buying": {"enabled": False, "per_entry_usdg": None, "max_positions": None}},
            "controls": [], "observed_at": "2026-10-19T14:13:00Z"}
AGENT = {"agent": "robin", "status": STATUS, "controls": CONTROLS}


def quote(amount=23.75, price=364.9, side="buy", token=TSLA, at="2026-10-19T14:14:30Z", ok=True, quoted=True):
    return {"quoted": quoted, "why_not": None if quoted else "no pool", "side": side, "token": token,
            "token_decimals": 18,
            "amount_in": {"token": "0xusdg", "raw": "0", "human": amount},
            "expected_out": {"token": token, "raw": "0", "human": amount / price},
            "min_out": {"raw": "0", "human": amount / price * 0.99, "slippage_bps": 100},
            "implied_price_usd": price, "price_impact_bps": 12,
            "impact_verdict": {"ok": ok, "rule": None if ok else "impact-cap",
                               "detail": None if ok else "impact 400 bps over the 150 bps cap", "cap_bps": 150},
            "route": {"venue": "uniswap-v3", "fee_tier_bps": 30, "hops": []},
            "routes_considered": {}, "gas": {"units_estimate": "1", "swap_leg_units": "1", "expected_usdg": 0.01,
                                             "note": ""},
            "merrymen_trade_fee": {"bps": 5, "usdg": 0.0125, "note": ""}, "block_number": "1",
            "quoted_at": at, "source": "chain", "caveats": []}


def tmap():
    return mm.token_map(TOKENS)


def agent(**changes):
    doc = copy.deepcopy(AGENT)
    for path, value in changes.items():
        where, key = path.split("__")
        doc[where][key] = value
    return mm.agent_snapshot(doc)


def sized(cfg=CFG, ag=None, plan=PLAN):
    s = size.size_merrymen(plan, cfg, tmap(), ag or agent(), today="2026-10-19")
    return s, size.merrymen_order(s)


def checked(order, cfg=CFG, ag="default", quotes="default", now=NOW, portfolio=None, state=None):
    docs = {"tokens": tmap(), "agent": agent() if ag == "default" else ag,
            "quotes": [quote(float(order["notional"]))] if quotes == "default" else quotes}
    res = risk.check([order], cfg, portfolio, {}, state, None, risk.parse_now(now), None, docs)
    return res["results"][0]


class Tokens(unittest.TestCase):
    def test_registry_only_and_by_address(self):
        m = tmap()
        self.assertEqual([t["address"] for t in m["TSLA"]], [TSLA.lower()])   # the pool that borrowed TSLA is ignored
        item, why = mm.resolve_token(m, "tsla")
        self.assertEqual(item["address"], TSLA.lower())
        self.assertIsNone(mm.resolve_token(m, "AAPL")[0])

    def test_two_registry_addresses_for_one_symbol_is_refused(self):
        doc = copy.deepcopy(TOKENS)
        doc["items"].append(dict(doc["items"][0], address="0x" + "4d" * 20))
        item, why = mm.resolve_token(mm.token_map(doc), "TSLA")
        self.assertIsNone(item)
        self.assertIn("refusing to guess", why)

    def test_pages_and_envelopes(self):
        pages = [{"structuredContent": TOKENS}, {"items": []}]
        self.assertIn("TSLA", mm.token_map(pages))


class Universe(unittest.TestCase):
    def test_only_tradable_tokens_reach_the_scanner(self):
        lines, left = mm.universe_lines(tmap())
        self.assertEqual(lines, ["TSLA|Tesla"])
        self.assertEqual(left, ["NVDA (paused)"])


class Agent(unittest.TestCase):
    def test_snapshot(self):
        a = agent()
        self.assertEqual((a["agent"], a["mode"], a["status"]), ("robin", "paper", "active"))
        self.assertEqual((a["per_trade_usdg"], a["remaining_usdg"], a["ceiling_usdg"]), (25, 100, 25))
        self.assertEqual(a["expires_at"].isoformat(), "2026-10-22T09:00:00")
        self.assertTrue(a["ids_agree"])

    def test_mixed_agents_are_noticed(self):
        self.assertFalse(agent(controls__agent="shogun")["ids_agree"])


class Budget(unittest.TestCase):
    def test_the_reel_on_merrymen(self):
        s, o = sized()
        # max loss allows 2 x 364.18 / 5.86 = $124.29; the signed per-trade limit binds: $25 less 5%, so
        # the sell that closes it still fits under $25 after a rise (Merrymen applies the limit to sells)
        self.assertEqual(s["bound_by"], "agent per trade")
        self.assertEqual(s["amount_usdg"], 23.75)
        self.assertEqual(s["qty"], 0.065215)
        self.assertEqual(s["max_loss"], 0.39)            # 23.75 x 5.86 / 364.18 = 0.382, up to the cent
        self.assertEqual(o["notional"], "23.75")
        self.assertEqual((o["venue"], o["agent"], o["token"]), ("merrymen", "robin", TSLA.lower()))
        for alpaca in ("qty", "order_class", "stop_loss_stop_price", "take_profit_limit_price", "limit_price"):
            self.assertNotIn(alpaca, o)
        self.assertEqual(o["plan"]["stop"], 358.32)

    def test_the_max_loss_binds_when_the_agent_allows_more(self):
        cfg = dict(CFG, max_loss_per_trade_usd=0.2)
        s, o = sized(cfg, agent(controls__signed_limits=dict(CONTROLS["signed_limits"], per_trade_usdg=500)))
        self.assertEqual(s["bound_by"], "max loss")
        self.assertEqual(o["notional"], "12.42")          # 0.2 x 364.18 / 5.86 = 12.429, down to the cent

    def test_half_the_24h_budget_is_kept_for_the_sell(self):
        ag = agent(controls__budget_24h=dict(CONTROLS["budget_24h"], remaining_usdg=30))
        s, o = sized(ag=ag)
        self.assertEqual((s["bound_by"], o["notional"]), ("agent 24h budget", "15.00"))
        s, o = sized(dict(CFG, reserve_exit_budget=False), ag)
        self.assertEqual(o["notional"], "23.75")

    def test_room_for_the_sell_under_the_per_trade_limit(self):
        s, o = sized(dict(CFG, exit_headroom_pct=0))
        self.assertEqual(o["notional"], "25.00")
        s, o = sized(dict(CFG, exit_headroom_pct=10))
        self.assertEqual(o["notional"], "22.50")

    def test_refusals(self):
        with self.assertRaisesRegex(size.SizeError, "paused"):
            size.size_merrymen(dict(PLAN, symbol="NVDA"), CFG, tmap(), agent(), today="2026-10-19")
        with self.assertRaisesRegex(size.SizeError, "not one of Merrymen's stock tokens"):
            size.size_merrymen(dict(PLAN, symbol="AAPL"), CFG, tmap(), agent(), today="2026-10-19")
        with self.assertRaisesRegex(size.SizeError, "agent snapshot"):
            size.size_merrymen(PLAN, CFG, tmap(), None, today="2026-10-19")
        ag = agent(controls__budget_24h=dict(CONTROLS["budget_24h"], remaining_usdg=0))
        s, o = sized(ag=ag)
        self.assertIsNone(o)
        self.assertIn("nothing fits", s["refusal"])

    def test_cli_writes_a_merrymen_order_and_refuses_limits_and_weights(self):
        d = tempfile.mkdtemp()
        try:
            paths = {n: os.path.join(d, n + ".json") for n in ("plan", "config", "tokens", "agent", "orders")}
            for n, doc in (("plan", PLAN), ("config", CFG), ("tokens", TOKENS), ("agent", AGENT)):
                with open(paths[n], "w") as fh:
                    json.dump(doc, fh)
            base = ["--plan", paths["plan"], "--config", paths["config"], "--mm-tokens", paths["tokens"],
                    "--mm-agent", paths["agent"], "--now", NOW, "--portfolio", os.path.join(d, "none.json"),
                    "--prices", os.path.join(d, "noprices.json")]
            with open(base[-1], "w") as fh:
                json.dump({"prices": {}}, fh)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(size.main(base + ["--write", paths["orders"]]), 0)
            self.assertIn("Merrymen holds no resting stop", out.getvalue())
            with open(paths["orders"]) as fh:
                self.assertEqual(json.load(fh)["orders"][0]["notional"], "23.75")
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                self.assertEqual(size.main(base + ["--limit"]), 1)
                self.assertEqual(size.main(base + ["--weights", "TSLA=100"]), 1)
            self.assertIn("market orders only", err.getvalue())
            self.assertIn("weights mode", err.getvalue())
        finally:
            shutil.rmtree(d)


class Risk(unittest.TestCase):
    def setUp(self):
        self.s, self.o = sized()

    def test_pass_with_the_token_price_and_costs_in_the_max_loss(self):
        r = checked(self.o)
        self.assertEqual(r["verdict"], "PASS", r["reasons"])
        # sold when TSLA reaches 358.32, measured from the token's 364.90: 23.75 x (1 - 358.32/364.90) = 0.4283,
        # plus 2 x 0.0125 fee and 2 x 0.01 gas = 0.4733, up to the cent
        self.assertEqual(r["max_loss"], 0.48)
        self.assertTrue(any("token price 364.9000 vs the stock's 364.18: +0.20%" in x for x in r["info"]))

    def block(self, order=None, **kw):
        r = checked(order or self.o, **kw)
        self.assertEqual(r["verdict"], "BLOCK")
        return " | ".join(r["reasons"])

    def test_paper_config_never_reaches_a_live_agent(self):
        why = self.block(ag=agent(status__mode="live"))
        self.assertIn("REAL funds", why)

    def test_stale_or_missing_agent_snapshot(self):
        self.assertIn("minutes old", self.block(now="2026-10-19 10:30"))
        self.assertIn("no agent snapshot", self.block(ag=None))

    def test_the_configured_agent_only(self):
        self.assertIn("set \"merrymen_agent\"", self.block(cfg=dict(CFG, merrymen_agent="")))
        self.assertIn("your config says", self.block(cfg=dict(CFG, merrymen_agent="shogun")))
        self.assertIn("different agents", self.block(ag=agent(controls__agent="shogun")))

    def test_stopped_agent_and_expiring_permission(self):
        self.assertIn("killed", self.block(ag=agent(status__status="killed")))
        exp = dict(CONTROLS["signed_limits"], expires_at="2026-10-19T19:00:00Z")   # 15:00 New York
        self.assertIn("before your flat-by", self.block(ag=agent(controls__signed_limits=exp)))
        gone = dict(CONTROLS["signed_limits"], expires_at="2026-10-19T14:00:00Z")
        self.assertIn("expired", self.block(ag=agent(controls__signed_limits=gone)))

    def test_an_entry_leaves_room_for_its_sell(self):
        full = dict(self.o, notional="25.00")
        self.assertIn("no room under the 25 USDG per-trade cap", self.block(full, quotes=[quote(25.0)]))
        r = checked(full, cfg=dict(CFG, exit_headroom_pct=0), quotes=[quote(25.0)])
        self.assertEqual(r["verdict"], "PASS", r["reasons"])

    def test_signed_limits(self):
        big = dict(self.o, notional="30.00")
        why = self.block(big, quotes=[quote(30.0)])
        self.assertIn("signed per-trade limit of 25", why)
        self.assertIn("owner-order cap of 25", why)
        low = agent(controls__budget_24h=dict(CONTROLS["budget_24h"], remaining_usdg=40))
        self.assertIn("the buy and the sell that closes it", self.block(ag=low))

    def test_the_quote(self):
        self.assertIn("no quote", self.block(quotes=[]))
        self.assertIn("no quote", self.block(quotes=[quote(24.0)]))        # a quote for another amount
        self.assertIn("older than 120 seconds", self.block(quotes=[quote(at="2026-10-19T14:10:00Z")]))
        self.assertIn("would refuse", self.block(quotes=[quote(ok=False)]))
        self.assertIn("could not quote", self.block(quotes=[quote(quoted=False)]))
        self.assertIn("not tracking the chart", self.block(quotes=[quote(price=370.0)]))
        self.assertIn("not tracking the chart", self.block(quotes=[quote(price=355.0)]))

    def test_costs_can_push_the_loss_over_the_limit(self):
        r = checked(self.o, cfg=dict(CFG, max_loss_per_trade_usd=0.45))
        self.assertEqual(r["verdict"], "BLOCK")
        self.assertIn("with the token's price, fees and gas", " ".join(r["reasons"]))

    def test_the_token_must_be_the_registry_address(self):
        self.assertIn("is not the registry's", self.block(dict(self.o, token=IMPOSTOR),
                                                          quotes=[quote(token=IMPOSTOR)]))

    def test_alpaca_orders_do_not_go_to_merrymen(self):
        alpaca = {"symbol": "TSLA", "side": "buy", "qty": "8", "type": "market", "time_in_force": "day",
                  "order_class": "bracket", "take_profit_limit_price": "370.04", "stop_loss_stop_price": "358.32",
                  "plan": {"entry": 364.18, "stop": 358.32, "target": 370.04}}
        self.assertIn("not a Merrymen order", self.block(alpaca, quotes=[]))

    def test_a_sell_of_what_the_agent_holds_is_an_exit(self):
        pf = {"cash": 175, "positions": [{"ticker": "TSLA", "shares": 0.068647,
                                          "lots": [{"date": "2026-10-19", "shares": 0.068647, "cost": 25}]}]}
        sell = {"symbol": "TSLA", "side": "sell", "notional": "20.00", "type": "market", "time_in_force": "day",
                "venue": "merrymen", "agent": "robin", "token": TSLA.lower()}
        r = checked(sell, now="2026-10-19 15:56", portfolio=pf, quotes=[],
                    ag=agent(status__observed_at="2026-10-19T19:55:00Z", controls__observed_at="2026-10-19T19:55:00Z"))
        self.assertEqual((r["verdict"], r["kind"]), ("PASS", "exit"), r["reasons"])
        self.assertTrue(any("no quote" in w for w in r["warnings"]))
        r = checked(sell, quotes=[])             # holds nothing: a short, never allowed
        self.assertEqual(r["verdict"], "BLOCK")
        r = checked(dict(sell, notional="26.00"), now="2026-10-19 15:56", portfolio=pf, quotes=[],
                    ag=agent(status__observed_at="2026-10-19T19:55:00Z", controls__observed_at="2026-10-19T19:55:00Z"))
        self.assertIn("signed per-trade limit", " ".join(r["reasons"]))   # Merrymen would refuse it too


class Fingerprint(unittest.TestCase):
    def test_the_token_and_agent_are_bound(self):
        _, o = sized()
        self.assertNotEqual(risk.fingerprint(o), risk.fingerprint(dict(o, token=IMPOSTOR)))
        self.assertNotEqual(risk.fingerprint(o), risk.fingerprint(dict(o, agent="shogun")))
        self.assertEqual(risk.fingerprint(o), ticket.fingerprint(o))
        self.assertEqual(risk.fingerprint(o), risk.fingerprint(dict(o, why="changed")))

    def test_the_plans_stop_and_target_are_bound(self):
        # Merrymen holds no stop order, so the stop lives in the plan: a wider stop after a PASS is a new order
        _, o = sized()
        for k, v in (("stop", 340.0), ("target", 400.0), ("entry", 360.0)):
            moved = dict(o, plan=dict(o["plan"], **{k: v}))
            self.assertNotEqual(risk.fingerprint(o), risk.fingerprint(moved), k)
            self.assertEqual(risk.fingerprint(moved), ticket.fingerprint(moved), k)
        self.assertNotEqual(risk.fingerprint(o), risk.fingerprint(dict(o, plan={})))
        self.assertEqual(risk.fingerprint(o), risk.fingerprint(dict(o, plan=dict(o["plan"], setup="flag"))))

    def test_alpaca_fingerprints_do_not_move(self):
        alpaca = {"symbol": "TSLA", "side": "buy", "qty": "8", "type": "market", "time_in_force": "day",
                  "plan": {"stop": 358.32}}
        self.assertEqual(risk.fingerprint(alpaca), risk.fingerprint(dict(alpaca, plan={"stop": 1.0})))


class Yes(unittest.TestCase):
    def setUp(self):
        _, self.o = sized()

    def test_every_number_in_a_yes_must_be_on_the_ticket(self):
        ok, why = ticket.parse_yes("yes buy 30 USDG of TSLA, target 370.04", self.o)
        self.assertFalse(ok)
        self.assertIn("30", why)
        self.assertFalse(ticket.parse_yes("yes 23.75 and 50", self.o)[0])
        for reply in ("yes", "yes, 23.75 USDG of TSLA", "yes TSLA 23.75, 358.32 and 370.04", "yes 23.75 TSLA, max loss 0.48"):
            self.assertTrue(ticket.parse_yes(reply, self.o, extra=[0.48, 1])[0], reply)
        self.assertTrue(ticket.parse_yes("yes, order 1", self.o, extra=[0.48, 1])[0])


class Broker(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        _, self.order = sized()
        self.p = {n: os.path.join(self.d, n + ".json")
                  for n in ("orders", "config", "risk", "state", "portfolio", "plan", "tokens", "agent")}
        for n, doc in (("orders", {"orders": [self.order]}), ("config", CFG), ("plan", PLAN), ("tokens", TOKENS),
                       ("agent", AGENT)):
            with open(self.p[n], "w") as fh:
                json.dump(doc, fh)
        self.risk_at(NOW)

    def tearDown(self):
        shutil.rmtree(self.d)

    def risk_at(self, now):
        state = None
        if os.path.exists(self.p["state"]):
            with open(self.p["state"]) as fh:
                state = json.load(fh)
        ag = copy.deepcopy(AGENT)
        utc = risk.parse_now(now).strftime("%Y-%m-%dT%H:%M:%SZ")
        ag["status"]["observed_at"] = ag["controls"]["observed_at"] = utc
        docs = {"tokens": tmap(), "agent": mm.agent_snapshot(ag), "quotes": [quote(23.75, at=utc)]}
        res = risk.check([self.order], CFG, None, {}, state, None, risk.parse_now(now), None, docs)
        with open(self.p["risk"], "w") as fh:
            json.dump(res, fh)
        return res

    def run_cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        common = ["--orders", self.p["orders"], "--config", self.p["config"], "--risk", self.p["risk"],
                  "--state", self.p["state"]]
        argv = list(args)
        if argv[0] in ("show", "approve", "decline", "result"):
            argv = argv[:1] + common + argv[1:]
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = ticket.main(argv)
        return code, out.getvalue() + err.getvalue()

    def state(self):
        with open(self.p["state"]) as fh:
            return json.load(fh)["orders"]

    def test_the_ticket_shows_the_propose_trade_call(self):
        code, out = self.run_cli("show", "--now", NOW)
        self.assertEqual(code, 0, out)
        self.assertIn("PAPER (the agent's practice book), Merrymen", out)
        self.assertIn("BUY 23.75 USDG of TSLA on Merrymen", out)
        self.assertIn("Claude will call propose_trade", out)
        self.assertIn('"amount_usdg": 23.75', out)
        self.assertIn("max loss about $0.48", out)        # trader-risk's figure, with the token's price and costs
        self.assertIn("Merrymen holds no stop order", out)

    def test_yes_then_proposal_then_fill(self):
        code, out = self.run_cli("approve", "--index", "1", "--reply", "yes to all", "--now", NOW)
        self.assertEqual(code, 1)
        code, out = self.run_cli("approve", "--index", "1", "--reply", "yes buy 30 of TSLA", "--now", NOW)
        self.assertIn("Not recorded", out)
        code, out = self.run_cli("approve", "--index", "1", "--reply", "yes, 23.75 USDG of TSLA", "--now", NOW)
        self.assertEqual(code, 0, out)
        self.assertIn("max loss about $0.48", out)      # the figure the ticket showed, not the sizing's $0.39
        call = json.loads(out[out.index("{"):out.index("}") + 1])
        fp = risk.fingerprint(self.order)
        self.assertEqual(call, {"agent": "robin", "side": "buy", "token": TSLA.lower(), "amount_usdg": 23.75,
                                "idempotency_key": "trader-20261019-%s-1" % fp, "note": self.order["why"]})
        code, out = self.run_cli("result", "--index", "1", "--status", "placed", "--now", NOW)
        self.assertIn("never \"placed\" by Claude", out)
        code, out = self.run_cli("result", "--index", "1", "--status", "proposed", "--proposal-id", "prp_x",
                                 "--now", NOW)
        self.assertIn("prp_ and 32 hex digits", out)
        pid = "prp_" + "ab" * 16
        code, out = self.run_cli("result", "--index", "1", "--status", "proposed", "--proposal-id", pid,
                                 "--approval-url", "https://app.merrymen.dev/approve/" + pid, "--now", NOW)
        self.assertEqual(code, 0, out)
        code, out = self.run_cli("show", "--now", NOW)
        self.assertIn("PROPOSED at", out)
        self.assertEqual(code, 1)                           # not ready: nobody is asked twice
        # it counts against today's limits while it waits
        self.assertEqual(len(risk.placed_today({"orders": self.state()}, "2026-10-19")), 1)
        code, out = self.run_cli("result", "--index", "1", "--status", "paper_filled", "--now", NOW)
        self.assertIn("--filled-qty", out)
        code, out = self.run_cli("result", "--index", "1", "--status", "paper_filled", "--filled-qty", "0.0685",
                                 "--filled-price", "364.95", "--portfolio", self.p["portfolio"], "--now", "2026-10-19 10:18")
        self.assertEqual(code, 0, out)
        self.assertIn("paper: no real money moved", out)
        with open(self.p["portfolio"]) as fh:
            pf = json.load(fh)
        self.assertEqual(pf["positions"][0]["shares"], 0.0685)
        self.assertEqual(pf["cash"], round(200 - 0.0685 * 364.95, 2))
        self.assertEqual(len(risk.placed_today({"orders": self.state()}, "2026-10-19")), 1)

    def test_an_expired_proposal_can_be_tried_again_after_a_new_check(self):
        self.run_cli("approve", "--index", "1", "--reply", "yes", "--now", NOW)
        pid = "prp_" + "cd" * 16
        self.run_cli("result", "--index", "1", "--status", "proposed", "--proposal-id", pid, "--now", NOW)
        code, out = self.run_cli("result", "--index", "1", "--status", "expired", "--now", "2026-10-19 10:31")
        self.assertEqual(code, 0, out)
        self.assertEqual(risk.placed_today({"orders": self.state()}, "2026-10-19"), [])   # ended: no longer counted
        code, out = self.run_cli("show", "--now", "2026-10-19 10:31")
        self.assertIn("DONE: expired", out)                  # the old check does not count
        self.risk_at("2026-10-19 10:32")
        code, out = self.run_cli("show", "--now", "2026-10-19 10:32")
        self.assertIn("READY again", out)
        code, out = self.run_cli("approve", "--index", "1", "--reply", "yes", "--now", "2026-10-19 10:32")
        self.assertIn("-2\"", out)                           # a new yes, a new idempotency key

    def test_a_proposal_that_failed_may_have_traded(self):
        self.run_cli("approve", "--index", "1", "--reply", "yes", "--now", NOW)
        self.run_cli("result", "--index", "1", "--status", "proposed", "--proposal-id", "prp_" + "aa" * 16,
                     "--now", NOW)
        code, out = self.run_cli("result", "--index", "1", "--status", "failed", "--now", "2026-10-19 10:20")
        self.assertIn("may have traded", out)
        self.assertEqual(len(risk.placed_today({"orders": self.state()}, "2026-10-19")), 1)
        res = self.risk_at("2026-10-19 10:21")
        self.assertIn("duplicate: a buy TSLA was already placed today", " ".join(res["results"][0]["reasons"]))
        # and if the rules were loosened, the ticket still refuses to offer it again
        res["results"][0].update(verdict="PASS", reasons=[])
        ok, label, _ = ticket.status_of(self.order, res, {"orders": self.state()}, "2026-10-19")
        self.assertFalse(ok)
        self.assertIn("never propose it again blind", label)

    def test_a_failed_call_is_settled_with_the_same_key(self):
        # a timeout may have made a proposal: no new key, no second proposal, and it counts meanwhile
        self.run_cli("approve", "--index", "1", "--reply", "yes", "--now", NOW)
        key = self.state()[-1]["idempotency_key"]
        code, out = self.run_cli("result", "--index", "1", "--status", "failed", "--note", "timeout", "--now", NOW)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.state()[-1]["status"], "call_failed")
        self.assertIn('"idempotency_key": "%s"' % key, out)
        self.assertEqual(len(risk.placed_today({"orders": self.state()}, "2026-10-19")), 1)
        res = self.risk_at("2026-10-19 10:17")
        self.assertIn("duplicate", " ".join(res["results"][0]["reasons"]))
        res["results"][0].update(verdict="PASS", reasons=[])           # even if the rules let it through
        ok, label, _ = ticket.status_of(self.order, res, {"orders": self.state()}, "2026-10-19")
        self.assertFalse(ok)
        self.assertIn("same idempotency_key %s" % key, label)
        code, out = self.run_cli("result", "--index", "1", "--status", "denied", "--now", "2026-10-19 10:17")
        self.assertIn("a proposal may exist", out)
        code, out = self.run_cli("result", "--index", "1", "--status", "failed", "--now", "2026-10-19 10:18")
        self.assertEqual(self.state()[-1]["idempotency_key"], key)        # still the same key
        pid = "prp_" + "12" * 16
        code, out = self.run_cli("result", "--index", "1", "--status", "proposed", "--proposal-id", pid,
                                 "--now", "2026-10-19 10:18")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.state()[-1]["proposal_id"], self.state()[-1]["idempotency_key"]), (pid, key))

    def test_a_denied_card_can_be_tried_again(self):
        self.run_cli("approve", "--index", "1", "--reply", "yes", "--now", NOW)
        self.run_cli("result", "--index", "1", "--status", "denied", "--now", NOW)
        self.assertEqual(risk.placed_today({"orders": self.state()}, "2026-10-19"), [])
        self.risk_at("2026-10-19 10:17")
        code, out = self.run_cli("show", "--now", "2026-10-19 10:17")
        self.assertIn("READY again", out)

    def test_recording_a_fill_can_be_resumed_and_never_doubles(self):
        self.run_cli("approve", "--index", "1", "--reply", "yes", "--now", NOW)
        pid = "prp_" + "34" * 16
        self.run_cli("result", "--index", "1", "--status", "proposed", "--proposal-id", pid, "--now", NOW)
        broken = os.path.join(self.p["orders"], "portfolio.json")      # a file's child: the write fails
        fill = ["--filled-qty", "0.0651", "--filled-price", "364.95"]
        with self.assertRaises(OSError):
            self.run_cli("result", "--index", "1", "--status", "paper_filled", *fill, "--portfolio", broken,
                         "--now", "2026-10-19 10:18")
        self.assertEqual(self.state()[-1]["status"], "paper_filled")    # the outcome is on disk
        self.assertFalse(os.path.exists(self.p["portfolio"]))
        for _ in range(2):                                               # resumed, then a harmless repeat
            code, out = self.run_cli("result", "--index", "1", "--status", "paper_filled", *fill,
                                     "--portfolio", self.p["portfolio"], "--now", "2026-10-19 10:19")
            self.assertEqual(code, 0, out)
            self.assertIn("Resumed", out)
        with open(self.p["portfolio"]) as fh:
            pf = json.load(fh)
        self.assertEqual(pf["positions"][0]["shares"], 0.0651)
        self.assertEqual(pf["applied_fills"], [pid])
        self.assertEqual(sum(1 for r in self.state() if r.get("fill_ref") == pid), 1)
        code, out = self.run_cli("result", "--index", "1", "--status", "paper_filled", "--filled-qty", "0.07",
                                 "--filled-price", "364.95", "--portfolio", self.p["portfolio"], "--now", "2026-10-19 10:20")
        self.assertIn("differs from the fill already recorded", out)

    def test_a_refused_proposal_stays_done(self):
        self.run_cli("approve", "--index", "1", "--reply", "yes", "--now", NOW)
        self.run_cli("result", "--index", "1", "--status", "proposed", "--proposal-id", "prp_" + "ef" * 16,
                     "--now", NOW)
        self.run_cli("result", "--index", "1", "--status", "refused", "--now", "2026-10-19 10:20")
        self.risk_at("2026-10-19 10:21")
        code, out = self.run_cli("show", "--now", "2026-10-19 10:21")
        self.assertIn("DONE: refused", out)

    def hold(self, shares):
        with open(self.p["portfolio"], "w") as fh:
            json.dump({"cash": 100, "positions": [{"ticker": "TSLA", "shares": shares,
                                                   "lots": [{"date": "2026-10-19", "shares": shares, "cost": 70}]}]}, fh)

    def test_flatten_sells_the_holding_and_respects_the_per_trade_limit(self):
        self.hold(0.0651)

        def flat(value):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = ticket.main(["flatten", "--symbol", "TSLA", "--value-usdg", value, "--orders", self.p["orders"],
                                    "--config", self.p["config"], "--plan", self.p["plan"],
                                    "--mm-tokens", self.p["tokens"], "--mm-agent", self.p["agent"],
                                    "--portfolio", self.p["portfolio"], "--now", "2026-10-19 15:55"])
            with open(self.p["orders"]) as fh:
                return code, out.getvalue(), json.load(fh)["orders"][0]
        code, out, o = flat("20.10")
        self.assertEqual(code, 0, out)
        self.assertEqual((o["side"], o["notional"], o["token"], o["venue"]), ("sell", "20.31", TSLA.lower(), "merrymen"))
        code, out, o = flat("26.40")                         # worth more than the $25 per-trade limit
        self.assertEqual(o["notional"], "25.00")
        self.assertIn("PART ONLY", out)
        self.flat = flat

    def test_each_part_of_a_multi_part_exit_is_its_own_order(self):
        self.test_flatten_sells_the_holding_and_respects_the_per_trade_limit()
        os.remove(self.p["portfolio"])
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(ticket.main(["flatten", "--symbol", "TSLA", "--value-usdg", "75", "--orders",
                                          self.p["orders"], "--config", self.p["config"], "--mm-tokens",
                                          self.p["tokens"], "--mm-agent", self.p["agent"], "--portfolio",
                                          self.p["portfolio"]]), 1)             # nothing recorded: no ticket
        self.hold(0.2)                                       # $75 under a $25 cap: three parts
        _, _, first = self.flat("75.00")
        _, _, again = self.flat("74.90")                     # the same part, a moment later: the same order
        self.assertEqual((first["notional"], first["holding"]), ("25.00", "0.2"))
        self.assertEqual(ticket.fingerprint(first), ticket.fingerprint(again))
        self.hold(0.1315)                                    # the first part filled and was recorded
        _, _, second = self.flat("50.00")
        self.assertEqual(second["notional"], "25.00")
        self.assertNotEqual(ticket.fingerprint(first), ticket.fingerprint(second))
        # a ticket made before the fill was recorded no longer matches what is held
        with open(self.p["portfolio"]) as fh:
            pf = json.load(fh)
        r = checked(first, now="2026-10-19 15:56", portfolio=pf, quotes=[],
                    ag=agent(status__observed_at="2026-10-19T19:55:00Z", controls__observed_at="2026-10-19T19:55:00Z"))
        self.assertIn("run ticket.py flatten again", " ".join(r["reasons"]))
        r = checked(second, now="2026-10-19 15:56", portfolio=pf, quotes=[],
                    ag=agent(status__observed_at="2026-10-19T19:55:00Z", controls__observed_at="2026-10-19T19:55:00Z"))
        self.assertEqual(r["verdict"], "PASS", r["reasons"])


class Docs(unittest.TestCase):
    def test_the_example_config_is_merrymen_and_paper(self):
        with open(os.path.join(ROOT, "trader-budget", "config.example.json")) as fh:
            cfg = json.load(fh)
        self.assertEqual(cfg["broker"], "merrymen")
        self.assertIs(cfg["paper"], True)
        self.assertEqual(cfg["merrymen_agent"], "")          # empty blocks every order until it is set
        self.assertIs(cfg["reserve_exit_budget"], True)
        self.assertEqual(cfg["exit_headroom_pct"], 5)
        for k in ("allow_options", "allow_margin", "allow_short"):
            self.assertIs(cfg[k], False)

    def test_the_broker_skill_names_the_merrymen_tools(self):
        with open(os.path.join(ROOT, "trader-broker", "SKILL.md"), encoding="utf-8") as fh:
            text = fh.read()
        for tool in ("list_agents", "get_agent_status", "get_agent_controls", "discover_tokens", "quote_trade",
                     "propose_trade", "get_proposal", "cancel_proposal", "get_portfolio"):
            self.assertIn("`%s`" % tool, text)
        self.assertNotIn("place_stock_order", text)


if __name__ == "__main__":
    unittest.main()
