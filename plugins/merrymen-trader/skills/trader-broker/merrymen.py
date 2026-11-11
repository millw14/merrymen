#!/usr/bin/env python3
"""Merrymen as the broker. Standard library only, no network.

This module never talks to Merrymen. Claude calls the Merrymen MCP tools and
saves what they return, word for word, into trader/merrymen/:

  tokens.json   discover_tokens with list "established": the curated stock-token
                registry (symbol, token address, Chainlink price, paused)
  agent.json    {"agent": "<id from list_agents>",
                 "status":   <get_agent_status for that agent>,
                 "controls": <get_agent_controls for that agent>}
  quotes.json   the quote_trade result for the order about to be checked
                (one result, or a list of them)

trader-budget, trader-risk and trader-broker read those files through the
functions here, so all three see the same token, the same limits and the
same quote. The checks are a pre-flight: Merrymen re-checks the signed
limits when the proposal is made, when the owner approves it and when the
agent executes it. A pre-flight that passes is not permission to trade.

    python3 merrymen.py summary             # what the three files say, in plain words
    python3 merrymen.py summary --json
"""

import argparse
import datetime
import json
import math
import os
import re
import sys

ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
TICKER = re.compile(r"^[A-Z]{1,6}([.\-][A-Z]{1,2})?$")
TOKENS_PATH = os.path.join("trader", "merrymen", "tokens.json")
AGENT_PATH = os.path.join("trader", "merrymen", "agent.json")
QUOTES_PATH = os.path.join("trader", "merrymen", "quotes.json")

AGENT_MAX_AGE_MINUTES = 10      # an older limits snapshot is refreshed before an order
QUOTE_MAX_AGE_SECONDS = 120     # proposals re-quote, but the pre-flight wants today's price
MAX_QUOTE_GAP_PCT = 1.0         # the token's price vs the stock price the plan was made on
RUNNING = {"armed", "active"}
STOPPED = {"killed", "expired", "error"}
TRADING_MODES = {"paper", "live"}
CENT = 0.005


class MerrymenError(Exception):
    pass


# ---------------------------------------------------------------- small helpers

def _f(x):
    if isinstance(x, bool):
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def parse_utc(text):
    """ISO time -> naive UTC, or None."""
    if not text:
        return None
    try:
        dt = datetime.datetime.fromisoformat(str(text).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = (dt - dt.utcoffset()).replace(tzinfo=None)
    return dt


def floor_cent(x):
    return math.floor(float(x) * 100 + 1e-7) / 100.0


def ceil_cent(x):
    return math.ceil(float(x) * 100 - 1e-7) / 100.0


def money(x):
    return "$" + "{:,.2f}".format(float(x))


def read_doc(path, what, required=True):
    if not path or not os.path.exists(path):
        if required:
            raise MerrymenError("no %s at %s" % (what, path))
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except json.JSONDecodeError as e:
        raise MerrymenError("%s is not valid JSON: %s" % (path, e))


def _unwrap(doc):
    """A tool result saved with its envelope ({"structuredContent": {...}}) or bare."""
    if isinstance(doc, dict) and isinstance(doc.get("structuredContent"), dict):
        return doc["structuredContent"]
    return doc


# ---------------------------------------------------------------- tokens

def token_map(doc):
    """discover_tokens(list "established") pages -> {SYMBOL: [registry items]}.

    Accepts one page, a list of pages, or a bare list of items. Only registry
    items count: the curated stock tokens, never a pool that borrowed a ticker."""
    doc = _unwrap(doc)
    pages = doc if isinstance(doc, list) else [doc]
    items = []
    for p in pages:
        p = _unwrap(p)
        if isinstance(p, dict) and isinstance(p.get("items"), list):
            items.extend(p["items"])
        elif isinstance(p, dict) and p.get("address"):
            items.append(p)
    out = {}
    for it in items:
        if not isinstance(it, dict) or it.get("origin", "registry") != "registry":
            continue
        sym = str(it.get("symbol") or "").strip().upper()
        addr = str(it.get("address") or "").strip()
        if not sym or not ADDRESS.match(addr):
            continue
        out.setdefault(sym, []).append({
            "symbol": sym, "address": addr.lower(), "name": it.get("name"),
            "stock_kind": it.get("stock_kind"), "paused": it.get("paused"),
            "price_usd": _f(it.get("price_usd")), "price_updated_at": it.get("price_updated_at"),
        })
    return out


def resolve_token(tmap, sym):
    """(item, None) for exactly one registry token with this symbol, else (None, why)."""
    sym = str(sym or "").strip().upper()
    found = tmap.get(sym) or []
    addrs = sorted({t["address"] for t in found})
    if not addrs:
        return None, ("%s is not one of Merrymen's stock tokens (trader/merrymen/tokens.json, from "
                      "discover_tokens \"established\"); this pack trades only those" % sym)
    if len(addrs) > 1:
        return None, ("%s has %d registry addresses (%s): refusing to guess which one"
                      % (sym, len(addrs), ", ".join(addrs)))
    return found[0], None


# ---------------------------------------------------------------- the agent

def agent_snapshot(doc):
    """agent.json -> the facts the checks use. Missing figures stay None."""
    doc = _unwrap(doc)
    if not isinstance(doc, dict):
        raise MerrymenError("trader/merrymen/agent.json must be an object with agent, status and controls")
    status = _unwrap(doc.get("status")) or {}
    controls = _unwrap(doc.get("controls")) or {}
    if not isinstance(status, dict) or not isinstance(controls, dict):
        raise MerrymenError("agent.json: status and controls must be the get_agent_status and "
                            "get_agent_controls results")
    limits = controls.get("signed_limits") or {}
    budget = controls.get("budget_24h") or {}
    risk = controls.get("risk_settings") or {}
    perm = status.get("permission") or {}
    agent = str(doc.get("agent") or controls.get("agent") or status.get("agent") or "").strip()
    ids = {str(x).strip() for x in (doc.get("agent"), controls.get("agent"), status.get("agent")) if x}
    observed = [t for t in (parse_utc(controls.get("observed_at")), parse_utc(status.get("observed_at"))) if t]
    blocker = status.get("live_blocker")
    if isinstance(blocker, dict):
        blocker = blocker.get("text") or blocker.get("code") or json.dumps(blocker, sort_keys=True)
    return {
        "agent": agent,
        "ids_agree": len(ids) <= 1,
        "name": status.get("name"),
        "mode": str(status.get("mode") or "unknown").lower(),
        "status": str(status.get("status") or "unknown").lower(),
        "live_blocker": blocker or None,
        "expires_at": parse_utc(limits.get("expires_at") or perm.get("expires_at")),
        "has_expiry_field": bool(limits.get("expires_at") or perm.get("expires_at")),
        "per_trade_usdg": _f(limits.get("per_trade_usdg")),
        "per_day_usdg": _f(limits.get("per_day_usdg")),
        "spent_usdg": _f(budget.get("spent_usdg")),
        "remaining_usdg": _f(budget.get("remaining_usdg")),
        "ops_remaining": _f(budget.get("ops_remaining")),
        "budget_book": budget.get("book"),
        "ceiling_usdg": _f(risk.get("chat_action_ceiling_usdg")),
        "max_impact_bps": _f(risk.get("max_impact_bps")),
        "slippage_bps": _f(risk.get("slippage_bps")),
        "observed_at": min(observed) if observed else None,
    }


def sizing_caps(agent, reserve_exit=True):
    """The agent's own limits as dollar caps on one entry: [(name, usd, how)]."""
    caps = []
    if agent.get("per_trade_usdg") is not None:
        caps.append(("agent per trade", agent["per_trade_usdg"],
                     "signed per-trade limit %s USDG" % _num(agent["per_trade_usdg"])))
    if agent.get("ceiling_usdg") is not None and agent["ceiling_usdg"] > 0:
        caps.append(("owner-order cap", agent["ceiling_usdg"],
                     "Settings, max per chat trade %s USDG" % _num(agent["ceiling_usdg"])))
    left = agent.get("remaining_usdg")
    if left is not None:
        if reserve_exit:
            caps.append(("agent 24h budget", max(left, 0) / 2.0,
                         "%s USDG left in 24h, half kept for the sell" % _num(left)))
        else:
            caps.append(("agent 24h budget", max(left, 0), "%s USDG left in 24h" % _num(left)))
    return caps


def _num(x):
    x = float(x)
    return str(int(round(x))) if abs(x - round(x)) < 0.005 else "%.2f" % x


# ---------------------------------------------------------------- quotes

def quotes_list(doc):
    doc = _unwrap(doc)
    if doc is None:
        return []
    items = doc if isinstance(doc, list) else [doc]
    out = []
    for q in items:
        q = _unwrap(q)
        if isinstance(q, dict) and isinstance(q.get("quote"), dict) and "side" not in q:
            q = q["quote"]           # a propose_trade result carries its quote
        if isinstance(q, dict) and q.get("side"):
            out.append(q)
    return out


def find_quote(doc, side, token, amount):
    """The quote_trade result for exactly this side, token and USDG amount (newest wins)."""
    best = None
    for q in quotes_list(doc):
        if str(q.get("side", "")).lower() != side or str(q.get("token", "")).lower() != str(token).lower():
            continue
        amt = _f((q.get("amount_in") or {}).get("human"))
        if side == "buy" and (amt is None or abs(amt - amount) > CENT):
            continue
        t = parse_utc(q.get("quoted_at"))
        if best is None or (t and (best[0] is None or t > best[0])):
            best = (t, q)
    return best[1] if best else None


def quote_facts(q):
    verdict = q.get("impact_verdict") or {}
    fee = q.get("merrymen_trade_fee") or {}
    gas = q.get("gas") or {}
    return {
        "quoted": bool(q.get("quoted")),
        "why_not": q.get("why_not"),
        "quoted_at": parse_utc(q.get("quoted_at")),
        "implied_price": _f(q.get("implied_price_usd")),
        "impact_bps": _f(q.get("price_impact_bps")),
        "impact_ok": verdict.get("ok") is True,
        "impact_detail": verdict.get("detail") or verdict.get("rule"),
        "fee_usdg": _f(fee.get("usdg")) or 0.0,
        "gas_usdg": _f(gas.get("expected_usdg")),
        "min_out": _f((q.get("min_out") or {}).get("human")),
    }


# ---------------------------------------------------------------- the order checks

def is_merrymen(order):
    return str(order.get("venue", "")).lower() == "merrymen"


def order_checks(order, kind, ref, stop, cfg, tmap, agent, quotes_doc, now_utc, flat_by_utc=None):
    """Merrymen's part of the pre-trade check for one order.

    Returns {"block": [...]  reasons for any order,
             "entry": [...]  reasons for an entry (warnings for an exit),
             "warn": [...], "info": [...],
             "loss": max loss at the stop with the token's price and costs, or None}"""
    block, entry, warn, info = [], [], [], []
    loss = None
    side = str(order.get("side", "")).lower()
    sym = str(order.get("symbol", "")).strip().upper()
    token = str(order.get("token") or "").strip()
    amount = _f(order.get("notional"))
    paper = cfg.get("paper", True)

    # format: a Merrymen order is a USDG amount of one token, nothing else
    if not ADDRESS.match(token):
        block.append("merrymen: the order has no token address (0x and 40 hex digits)")
    if order.get("qty") is not None or amount is None or amount <= 0:
        block.append("merrymen: give the order as a USDG amount (notional), not shares")
    elif abs(amount * 100 - round(amount * 100)) > 1e-6:
        block.append("merrymen: amounts are whole cents, got %r" % order.get("notional"))
    if str(order.get("type", "market")).lower() != "market":
        block.append("merrymen: Merrymen takes market orders only (no limit or stop orders)")
    for k in ("limit_price", "stop_price", "order_class", "take_profit_limit_price", "stop_loss_stop_price",
              "stop_loss_limit_price", "trail_price", "trail_percent", "advanced_instructions"):
        if order.get(k) is not None:
            block.append("merrymen: %s is an Alpaca field; Merrymen has no resting stop or bracket orders" % k)
            break
    if not str(order.get("agent") or "").strip():
        block.append("merrymen: the order names no agent")

    # the token: exactly one registry token with this symbol, and the same address
    item, why = resolve_token(tmap, sym)
    if item is None:
        block.append("merrymen: " + why)
    elif ADDRESS.match(token) and item["address"] != token.lower():
        block.append("merrymen: the order's token %s is not the registry's %s address %s"
                     % (token, sym, item["address"]))
    elif item.get("paused") is True:
        (entry if kind == "entry" else warn).append(
            "merrymen: %s is paused (halted) in the registry; its oracle price is not moving" % sym)

    # the agent snapshot: present, fresh, the right agent
    if agent is None:
        block.append("merrymen: no agent snapshot (trader/merrymen/agent.json from get_agent_status and "
                     "get_agent_controls)")
        return {"block": block, "entry": entry, "warn": warn, "info": info, "loss": None}
    want = str(cfg.get("merrymen_agent") or "").strip()
    if not agent["ids_agree"]:
        block.append("merrymen: agent.json mixes results from different agents")
    if not want:
        block.append("merrymen: set \"merrymen_agent\" in trader/config.json to the agent id from list_agents")
    elif agent["agent"] != want:
        block.append("merrymen: agent.json is for %r, your config says %r" % (agent["agent"], want))
    if str(order.get("agent") or "").strip() and agent["agent"] != str(order.get("agent")).strip():
        block.append("merrymen: the order is for agent %r but the snapshot is for %r"
                     % (order.get("agent"), agent["agent"]))
    max_age = float(cfg.get("merrymen_agent_max_age_minutes") or AGENT_MAX_AGE_MINUTES)
    if agent["observed_at"] is None:
        block.append("merrymen: the agent snapshot has no observed_at; save the tool results as returned")
    else:
        age = (now_utc - agent["observed_at"]).total_seconds() / 60.0
        if age > max_age:
            block.append("merrymen: the agent snapshot is %d minutes old (limit %d); call get_agent_status "
                         "and get_agent_controls again" % (int(age), int(max_age)))

    # running, and in the book the config asks for
    st, mode = agent["status"], agent["mode"]
    if st in STOPPED:
        block.append("merrymen: the agent's status is %s; it will not trade" % st)
    elif st not in RUNNING:
        (entry if kind == "entry" else warn).append(
            "merrymen: the agent's status is %s, not armed or active" % st)
    if mode not in TRADING_MODES:
        block.append("merrymen: the agent's mode is %s, so it is not trading%s"
                     % (mode, (": " + agent["live_blocker"]) if agent["live_blocker"] else ""))
    elif paper and mode != "paper":
        block.append("merrymen: your config says paper (\"paper\": true) but the agent trades REAL funds "
                     "(mode live). Switch the agent to practice in Merrymen, or decide to go live yourself")
    elif not paper and mode == "paper":
        warn.append("the agent is in practice mode: this fills on paper, no real money moves")
    if mode == "live":
        warn.append("LIVE: approving this in Merrymen spends real funds")

    # the signed permission must outlive the trade
    exp = agent["expires_at"]
    if exp is None:
        block.append("merrymen: no signed permission expiry in the snapshot; the owner must sign one in Merrymen")
    elif now_utc >= exp:
        block.append("merrymen: the agent's trading permission expired at %sZ; re-sign it in Merrymen"
                     % exp.strftime("%Y-%m-%d %H:%M"))
    elif kind == "entry" and flat_by_utc is not None and exp <= flat_by_utc:
        entry.append("merrymen: the permission expires at %sZ, before your flat-by time: the agent could "
                     "not sell this position. Re-sign it in Merrymen first" % exp.strftime("%Y-%m-%d %H:%M"))

    # the signed limits (Merrymen enforces these too; this says so before a proposal is made)
    if amount:
        if agent["per_trade_usdg"] is not None and amount > agent["per_trade_usdg"] + CENT:
            block.append("merrymen: %s is over the signed per-trade limit of %s USDG"
                         % (money(amount), _num(agent["per_trade_usdg"])))
        if agent["ceiling_usdg"] and amount > agent["ceiling_usdg"] + CENT:
            block.append("merrymen: %s is over the owner-order cap of %s USDG (Settings, max per chat trade)"
                         % (money(amount), _num(agent["ceiling_usdg"])))
        left = agent["remaining_usdg"]
        if left is not None:
            need = amount * 2 if (kind == "entry" and cfg.get("reserve_exit_budget", True)) else amount
            if need > left + CENT:
                msg = ("merrymen: %s USDG left in the agent's 24-hour budget; this %s needs %s%s"
                       % (_num(left), kind, money(need),
                          " (the buy and the sell that closes it)" if need > amount else ""))
                (entry if kind == "entry" else warn).append(msg)
        ops = agent["ops_remaining"]
        if ops is not None:
            need_ops = 2 if kind == "entry" else 1
            if ops < need_ops:
                (entry if kind == "entry" else warn).append(
                    "merrymen: %d operation%s left in the agent's 24 hours; this %s needs %d"
                    % (int(ops), "" if int(ops) == 1 else "s", kind, need_ops))

    # the quote: today's price for this exact order
    if amount and ADDRESS.match(token):
        q = find_quote(quotes_doc, side, token, amount)
        if q is None:
            msg = ("merrymen: no quote for %s %s USDG of %s; call quote_trade and save it to "
                   "trader/merrymen/quotes.json" % (side, _num(amount), sym))
            (entry if kind == "entry" else warn).append(msg)
        else:
            f = quote_facts(q)
            max_q = float(cfg.get("merrymen_quote_max_age_seconds") or QUOTE_MAX_AGE_SECONDS)
            if not f["quoted"]:
                (entry if kind == "entry" else warn).append(
                    "merrymen: Merrymen could not quote it: %s" % (f["why_not"] or "no route"))
            elif f["quoted_at"] is None or (now_utc - f["quoted_at"]).total_seconds() > max_q:
                (entry if kind == "entry" else warn).append(
                    "merrymen: the quote is older than %d seconds; quote it again" % int(max_q))
            elif side == "buy" and not f["impact_ok"]:
                entry.append("merrymen: the agent would refuse this buy: %s"
                             % (f["impact_detail"] or "price impact over its cap"))
            elif f["implied_price"] and ref:
                gap = (f["implied_price"] / ref - 1.0) * 100.0
                cap = float(cfg.get("max_quote_gap_pct", MAX_QUOTE_GAP_PCT))
                info.append("token price %.4f vs the stock's %.2f: %+.2f%%; impact %s bps; fee %s"
                            % (f["implied_price"], ref, gap,
                               _num(f["impact_bps"]) if f["impact_bps"] is not None else "?",
                               money(f["fee_usdg"])))
                if abs(gap) > cap + 1e-9:
                    entry.append("merrymen: the token trades %+.2f%% from the stock price %.2f the plan uses "
                                 "(limit %s%%): the token is not tracking the chart, or is not one share"
                                 % (gap, ref, _num(cap)))
                if kind == "entry" and stop and side == "buy":
                    # Bought at the token's price, sold when the STOCK reaches the stop. Measured from the
                    # higher of the two prices, so a premium that vanishes on the way out is counted.
                    top = max(f["implied_price"], ref)
                    gas = f["gas_usdg"] or 0.0
                    costs = 2 * f["fee_usdg"] + 2 * gas
                    loss = ceil_cent(amount * (1.0 - stop / top) + costs)
                    info.append("max loss with the token's price and costs: %s (%s at the stop + %s fees "
                                "and gas, both ways)" % (money(loss), money(amount * (1.0 - stop / top)),
                                                         money(costs)))
            if f["min_out"] is not None and side == "buy" and f["implied_price"]:
                info.append("the quote's minimum: %s tokens at the agent's slippage" % ("%.6f" % f["min_out"]))
    return {"block": block, "entry": entry, "warn": warn, "info": info, "loss": loss}


def flat_by_utc(today, flat_by, eastern_to_utc):
    """'2026-10-19' + '15:55' New York -> naive UTC, or None."""
    m = re.match(r"^(\d{1,2}):(\d{2})$", str(flat_by or ""))
    if not m:
        return None
    d = datetime.date.fromisoformat(today)
    return eastern_to_utc(datetime.datetime.combine(d, datetime.time(int(m.group(1)), int(m.group(2)))))


# ---------------------------------------------------------------- propose_trade

def idempotency_key(fp, today, n):
    """One key per yes: a retried call never makes a second proposal, a new yes makes a new one."""
    return "trader-%s-%s-%d" % (today.replace("-", ""), fp, n)


def propose_input(order, key):
    """The exact propose_trade arguments. "why" and "plan" are ours, never sent."""
    note = str(order.get("why") or "")[:280]
    out = {"agent": str(order.get("agent")), "side": str(order.get("side")).lower(),
           "token": str(order.get("token")).lower(), "amount_usdg": round(float(order["notional"]), 2),
           "idempotency_key": key}
    if note:
        out["note"] = note
    return out


# ---------------------------------------------------------------- summary

def summary(tokens_path=TOKENS_PATH, agent_path=AGENT_PATH, now_utc=None):
    now_utc = now_utc or datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    tdoc = read_doc(tokens_path, "token list", required=False)
    adoc = read_doc(agent_path, "agent snapshot", required=False)
    tmap = token_map(tdoc) if tdoc is not None else {}
    agent = agent_snapshot(adoc) if adoc is not None else None
    return {"tokens": {s: [t["address"] for t in v] for s, v in sorted(tmap.items())},
            "agent": agent, "now": now_utc}


def main(argv=None):
    ap = argparse.ArgumentParser(description="What the saved Merrymen results say (trader-broker).")
    sub = ap.add_subparsers(dest="cmd")
    p = sub.add_parser("summary")
    p.add_argument("--tokens", default=TOKENS_PATH)
    p.add_argument("--agent", default=AGENT_PATH)
    p.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    if a.cmd != "summary":
        ap.print_help()
        return 1
    try:
        s = summary(a.tokens, a.agent)
    except MerrymenError as e:
        print("merrymen.py: %s" % e, file=sys.stderr)
        return 1
    if a.json:
        print(json.dumps(s, indent=2, default=lambda x: x.strftime("%Y-%m-%dT%H:%M:%SZ")))
        return 0
    print("Stock tokens: %d (%s)" % (len(s["tokens"]), ", ".join(s["tokens"]) or "none: save discover_tokens "
                                     "\"established\" to %s" % a.tokens))
    dupes = [k for k, v in s["tokens"].items() if len(v) > 1]
    if dupes:
        print("Symbols with more than one address (never traded): %s" % ", ".join(dupes))
    ag = s["agent"]
    if ag is None:
        print("Agent: no snapshot at %s" % a.agent)
        return 1
    age = ((s["now"] - ag["observed_at"]).total_seconds() / 60.0) if ag["observed_at"] else None
    print("Agent %s (%s): status %s, mode %s%s" % (ag["agent"] or "?", ag["name"] or "unnamed", ag["status"],
                                                 ag["mode"], (", blocker: %s" % ag["live_blocker"])
                                                 if ag["live_blocker"] else ""))
    print("Permission expires: %s" % (ag["expires_at"].strftime("%Y-%m-%d %H:%MZ") if ag["expires_at"] else "unknown"))
    print("Per trade %s, per day %s, left in 24h %s USDG, operations left %s, owner-order cap %s"
          % tuple("none" if v is None else _num(v) for v in (ag["per_trade_usdg"], ag["per_day_usdg"],
                                                              ag["remaining_usdg"], ag["ops_remaining"],
                                                              ag["ceiling_usdg"])))
    print("Snapshot age: %s" % ("%d minutes" % int(age) if age is not None else "unknown"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
