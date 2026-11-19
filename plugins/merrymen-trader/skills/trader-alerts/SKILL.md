---
name: trader-alerts
description: >-
  Price Alerts. Rings when a price, a stop or the opening bell hits. Turns
  the trade plan into three alerts in one go (the stop, the target and "flat
  by close" at your flat-by time), plus above / below / stop / target levels,
  percent moves from the previous close, any time of day, and the NYSE
  opening bell, each ringing once so you are not spammed. Knows NYSE hours
  with the 2026 and 2027 holidays and 1:00 p.m. early closes, works out New
  York time itself, fetches free delayed quotes (Yahoo chart JSON, Stooq
  CSV) one ticker at a time, and writes trader/prices.json for sizing and the
  risk check. Use when the user says "alert me when", "tell me if TSLA hits",
  "watch my stop", "watch my trade", "remind me to close by 3:55", "is the
  market open", "when does the market open", "get me a price", or right
  after /trader-exit writes a plan.
argument-hint: "[ticker] [price]"
---

# trader-alerts

Price Alerts watches the numbers so the user does not have to stare at a
chart. An alert is information, never an order: when a stop alert rings,
nothing is sold by this skill. Merrymen holds no resting stop or target
order, so these alerts are what watches the plan: when the stop, the target
or the flat-by time rings, getting out is a sell the user says yes to and the
owner approves in Merrymen (trader-broker flatten). Between a check and that
approval the price keeps moving, so a sale can fill well past the stop.

`${CLAUDE_SKILL_DIR}` below is this skill's folder (where this SKILL.md lives).

```bash
python3 "${CLAUDE_SKILL_DIR}/alerts.py" clock                          # NYSE open or closed, next open
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add --from-plan                # stop, target, flat by close from trader/plan.json
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add --opening-bell
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add --symbol TSLA --stop 358.32
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add --symbol TSLA --target 370.04
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add --at 15:55 --label "flat by close" --before-close
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add --symbol KO --pct 3
python3 "${CLAUDE_SKILL_DIR}/alerts.py" check                          # exit 0 = something rang
python3 "${CLAUDE_SKILL_DIR}/alerts.py" quote TSLA --write             # -> trader/prices.json
python3 "${CLAUDE_SKILL_DIR}/alerts.py" quote --holdings --write       # portfolio + plan tickers
python3 "${CLAUDE_SKILL_DIR}/alerts.py" list
python3 "${CLAUDE_SKILL_DIR}/alerts.py" reset tsla-plan-stop
```

`--now "2026-10-19 15:55"` pins the clock (New York time); `--offline DIR`
reads saved quote files instead of the network.

## What it reads and writes

| file | what |
| --- | --- |
| `trader/plan.json` | the trade from trader-exit, for `add --from-plan` |
| `trader/alerts.json` | the rules (`alerts.example.json` in this folder) |
| `trader/state/alerts.json` | which rules rang and when, so each rings once |
| `trader/prices.json` | the latest quotes, merged in, for trader-budget and trader-risk |
| `trader/portfolio.json` | the tickers held, for `quote --holdings` |

## Rule types

| type | rings when | rings again |
| --- | --- | --- |
| `above` / `target` | price at or above `price` | after `reset`, or on its own if `"rearm": true` and the price fell back |
| `below` / `stop` | price at or below `price` | same |
| `pct_move` | moved `pct` percent from the previous close (or `ref`), optional `direction` up or down | once per day at most |
| `time` | the New York clock passed `at` ("15:55") on a trading day | once per trading day |
| `opening_bell` | the NYSE is open | once per trading day |

A rule with `"date"` is watched on that New York date only; `--from-plan`
rules carry the plan's date, so yesterday's stop never rings today. A `time`
rule with `"before_close": true` moves 3 hours earlier on a 1:00 p.m. early
close, so "flat by close" at 15:55 rings at 12:55 on those days.

## Quotes

- `yahoo` (default): `query2.finance.yahoo.com/v8/finance/chart/<TICKER>`, an
  unofficial free JSON endpoint, one request per ticker, half a second apart.
  On a 429 it waits and tries once more; on a 429 or a 5xx after that it
  tries `query1`. It identifies itself as `day-trader-skill/2.0`.
- `stooq`: `stooq.com/q/l/?s=tsla.us&f=sd2t2ohlcv&h&e=csv`, Stooq's free CSV.
  It answered 404 on 2026-10-13; the parser stays for when it is back.
- Free quotes are unofficial, delayed and can lag. They are fine for alerts
  and for checking a size, not for timing an order. The broker's price is the
  one that fills. Each price in `trader/prices.json` keeps its quote time, and
  trader-risk only uses one under 15 minutes old.
- If both are down, read the stock token's Chainlink price from Merrymen
  (`get_token` for its address) and write it into `trader/prices.json` as
  `{"as_of": "...Z", "prices": {"TSLA": 366.48}}`, with the price's own time.

## The NYSE clock

Regular session 9:30 a.m. to 4:00 p.m. New York time, closed on weekends and
on these holidays, from nyse.com/markets/hours-calendars (read 2026-10-13):

- 2026: Jan 1, Jan 19, Feb 16, Apr 3 (Good Friday), May 25, Jun 19, Jul 3
  (Independence Day observed), Sep 7, Nov 26, Dec 25. Early close 1:00 p.m. on
  Nov 27 and Dec 24.
- 2027: Jan 1, Jan 18, Feb 15, Mar 26 (Good Friday), May 31, Jun 18
  (Juneteenth observed), Jul 5 (Independence Day observed), Sep 6, Nov 25,
  Dec 24 (Christmas observed). Early close 1:00 p.m. on Nov 26.

Daylight saving time is worked out in the tool, so it needs no time zone
files and ignores the computer's own zone. For any other year it says the
holiday list is unknown.

## Steps

1. Right after trader-exit writes the plan, run `add --from-plan`. Confirm
   the three alerts back to the user: the stop, the target and the flat-by time.
2. Run `check` while the trade is open: every few minutes from a Claude
   scheduled task or `/loop`. Each run fetches only the tickers in today's
   rules and rings each alert once. A check reads the latest delayed quote;
   it is not a live feed, and a price can pass a level between two checks.
3. Tell the user what rang in one line each. A stop or target alert means it
   is time to sell, now: `get_portfolio` for the holding's value, trader-broker
   `flatten`, a fresh quote, trader-risk, the user's yes, then the owner's
   approval in Merrymen. "Flat by close" means the same for anything still
   open. Never act for them, and never propose from the scheduled check.
4. Optional, for the phone: Merrymen's own `subscribe` with kind
   `watchlist_price` (the token's address and an `below` level at the stop)
   sends the owner a Telegram message even when Claude is not running. It
   needs a linked Telegram and the "Manage your alerts" permission at sign-in.
   It is a message only; it sells nothing.

## Example: the reel

TSLA on Monday 2026-10-19: entry 364.18 at 10:15 AM, stop 358.32, target
370.04, flat by 15:55. `add --from-plan` writes `tsla-plan-stop`,
`tsla-plan-target` and `tsla-flat-by` for that day. A `check` at 10:53 reads
the real 10:52 quote, 366.48, between the stop and the target:

```
NYSE OPEN (2026-10-19 10:53 New York, regular session).
Nothing hit. 3 rule(s) watched today, TSLA $366.48.
```

At 3:55 PM:

```
ALERT Flat by close: it is 15:55 New York (set for 15:55), the market closes at 16:00. If TSLA is still
open, close it: trader-broker flatten --symbol TSLA builds the sell ticket, then trader-risk, your yes
and your approval in Merrymen.
```

It rings once. The next morning the plan's three alerts are no longer
watched; with `add --opening-bell`, the bell rings at 9:30.

## Rules

- An alert is a fact about a price or the clock. Say it as a fact.
- Never present a quote as live. Free quotes are delayed and unofficial.
- Confirm every new rule back to the user: ticker, type, level, day.

## What it never does

It never places, cancels or changes an order, never claims a quote is
live, and never predicts where a price is going.

## Safety

- Education and tooling, not financial advice. A PASS is a rules check, not a recommendation.
- Paper by default (`"paper": true`): trader-risk blocks every order unless the Merrymen agent is in
  practice (paper) mode. Going live is the owner's own decision, made in Merrymen and in their own config.
- Nothing in this pack trades except trader-broker, and only through four gates: trader-risk passed that
  exact order today, the user typed an explicit yes for that one order in the chat, Claude's own
  permission card for propose_trade was allowed once, and the owner approved the proposal in Merrymen.
  The agent's signed limits still apply after that. Never set the Merrymen trade tools to "Always allow".
- Merrymen holds no resting stop or target order: getting out is a sell the owner approves, so it can
  fill well past the stop. No options, margin, short selling or leverage.
- Claude never sees wallet keys, never signs, never turns on live trading and never changes a signed
  limit. Sign-in happens on Merrymen's own page, never in the chat.
