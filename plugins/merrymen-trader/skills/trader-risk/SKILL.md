---
name: trader-risk
description: >-
  Risk Manager. Checks every trade against your limits and your Merrymen
  agent's signed limits and stops anything over them, before it can become a
  Merrymen proposal. For a day trade: a stop is
  required, the loss at the stop must fit your max loss per trade (measured
  from the higher of the plan's entry and a fresh price), reward:risk must
  meet your minimum, the day's total risk must fit your daily loss limit, no
  more than your trades per day, and no new entries outside your entry
  window or when the market is closed. It also keeps the basics: blocked
  tickers, order size, position cap, cash buffer, margin, short sales,
  options and crypto, malformed orders, duplicates and a daily order limit.
  For Merrymen: the right agent, a fresh limits snapshot, paper config only
  with a paper agent, a permission that outlives the flat-by time, the
  signed per-trade limit and 24-hour budget, the registry token address, and
  a fresh quote whose price tracks the stock. Getting out is never blocked
  by a day limit. Prints PASS or
  BLOCK with the reason and records the verdicts so trader-broker only shows
  an order that passed. Use when the user says "check my order", "is this
  safe", "risk check", "does this break my rules", "can I take this trade",
  "how much have I risked today", or before /trader-broker, always.
argument-hint: "[path to orders.json]"
---

# trader-risk

The Risk Manager is the gate between a proposal and Merrymen. Every order
written by trader-budget or trader-broker's flatten passes through it. A
BLOCK is final for that order: it does not go to the user for a yes, and it
never becomes a Merrymen proposal. Merrymen checks its own signed limits again
when the proposal is made, when the owner approves it and when the agent
executes it; this check says no first, with the reason, before anyone is asked. Most people who day trade lose money. These limits
keep each loss and each day's losses small. They do not make a trade win.

`${CLAUDE_SKILL_DIR}` below is this skill's folder (where this SKILL.md lives).

```bash
python3 "${CLAUDE_SKILL_DIR}/check.py"                           # trader/ files; writes trader/state/risk.json
python3 "${CLAUDE_SKILL_DIR}/check.py" --json
python3 "${CLAUDE_SKILL_DIR}/check.py" --no-write                # look without recording
python3 "${CLAUDE_SKILL_DIR}/check.py" --now "2026-10-19 10:15"  # pin the clock (New York time)
```

## What it reads and writes

| file | what |
| --- | --- |
| `trader/orders.json` | the proposed orders (trader-budget, or trader-broker's flatten) |
| `trader/config.json` | the limits (trader-budget ships `config.example.json`) |
| `trader/portfolio.json` | cash and holdings; if missing, a fresh account funded with the budget |
| `trader/prices.json` | a fresh price raises the entry it measures risk from; also values holdings |
| `trader/merrymen/tokens.json` | Merrymen's stock tokens: the registry address for each symbol, paused or not |
| `trader/merrymen/agent.json` | the agent's status, mode, permission expiry, signed limits and 24-hour budget |
| `trader/merrymen/quotes.json` | the `quote_trade` result for this exact order |
| `trader/state/broker.json` | what was proposed or filled today: duplicates, trades per day, daily loss |
| `trader/state/risk.json` | the verdicts it writes, with a fingerprint of each exact order |

## Entries and exits

An **entry** opens or adds to a position: a buy, or a sell that would go
short. An **exit** only reduces what you already hold. Getting out must
always be possible, so an exit is checked for format, asset and short sales
only. Every other rule (day limits, entry window, loss, reward:risk, blocked
list, size, duplicates) turns into a warning for an exit, never a BLOCK.

## The checks

Orders are checked in file order, as if each passed order had filled, so a
batch that is fine order by order but breaks a limit together is caught.

| check | blocks when |
| --- | --- |
| format | no symbol, side not buy or sell, both or neither of qty and notional, a limit order with no limit price; with `"broker": "merrymen"`, anything but a Merrymen order (a USDG amount of one token address for one agent, market only, no bracket fields) |
| asset | an option symbol while `allow_options` is false; crypto or anything that is not a US stock or ETF ticker |
| short | a sell of more than you hold (`allow_short` false) |
| blocked | (entries) the ticker is on the `blocked` list |
| size | (entries) under `min_order_usd` or over `max_order_usd` |
| position | (entries) the stock would be over `max_position_pct` of the account |
| cash | (entries) the buy would leave less than the cash buffer, or need margin |
| stop | (entries) no stop while `require_stop` is true (the order's plan stop); a stop on the wrong side of the entry |
| loss | (entries) the loss at the stop over `max_loss_per_trade_usd`: the amount x (entry minus stop) / entry, or, when bigger, measured from the token's quoted price with fees and gas both ways |
| reward:risk | (entries) (target minus entry) / (entry minus stop) under `min_reward_risk` |
| daily loss | (entries) the max losses at the stops of today's entries, plus this one, over `max_daily_loss_usd` |
| trades | (entries) `max_trades_per_day` entries already placed today |
| window | (entries) before `no_entries_before` or after `no_entries_after`, or the market is closed |
| pdt | (entries, only with `pdt_guard` true) 3 day trades already in the last 5 business days |
| duplicate | (entries) the same symbol and side twice in one batch, or already placed today |
| daily limit | (entries) `max_orders_per_day` orders already placed today |

Merrymen's checks (`"broker": "merrymen"`). Some block any order, even a sell:

| check | blocks when |
| --- | --- |
| token | the symbol is not exactly one token in Merrymen's stock-token registry, or the order's address is not that token's |
| agent | no `merrymen_agent` in the config; `agent.json` is missing, older than 10 minutes, mixes two agents or is for another agent |
| running | the agent is killed, expired or in error; (entries) not armed or active |
| book | `"paper": true` and the agent is not in paper mode; the agent is idle or its mode is unknown |
| permission | no signed permission, or it has expired; (entries) it expires before today's flat-by time, so the agent could not sell |
| signed limits | over the signed per-trade limit or the owner-order cap; (entries) the 24-hour budget left cannot cover the buy AND the sell (`reserve_exit_budget`), or fewer than 2 operations are left |
| paused | (entries) the token is paused in the registry |
| quote | (entries) no `quote_trade` for this exact side, token and amount, one older than 120 seconds, one Merrymen could not route, or one whose price impact the agent would refuse |
| gap | (entries) the token's quoted price is more than `max_quote_gap_pct` (1%) from the stock price the plan uses: the token is not tracking the chart, or it is not one share |

A Merrymen sell of a token the agent holds is always an exit: Merrymen sells at
most what the agent holds, so it can never go short.

How the numbers work:

- **The entry it measures from**: the limit price for a limit order. For a
  market order, the HIGHER of the plan's entry and a fresh price from
  `trader/prices.json` (under 15 minutes old). A plan written at 10:15 cannot
  understate the risk at 10:55 after the price ran up. An older price is not
  used, and it says so.
- **Daily loss** counts the full max loss of every entry proposed or filled
  today, win or lose, as trader-broker logged it. A proposal still waiting for
  the owner counts; one that expired, was refused or was cancelled does not.
  A proposal that failed counts, because Merrymen may have traded it anyway.
- **The window** is New York time, worked out in the tool (daylight saving
  included), never from the computer's clock zone. Weekends and NYSE holidays
  are closed. On a 1:00 p.m. early close the window ends 3 hours earlier too.
  Set both `no_entries_*` to null to switch the window off.
- **pdt_guard** (off by default) counts a day trade as a symbol bought and
  sold on the same day in the log, plus any entry placed today (it is meant
  to be flat by the close). FINRA removed the $25,000 pattern-day-trader
  minimum (Regulatory Notice 26-10, effective June 4, 2026; firms may phase
  in until October 20, 2027), so some brokers still apply the old rule: turn
  `pdt_guard` on if yours does.

Warnings do not block, but say them to the user: a LIVE agent, a stop that
lives only in the plan (always, on Merrymen: it holds no resting stop), a
price too old to use, an early close today.

## Steps

1. If the price may have moved since the plan, refresh it first
   (trader-alerts: `alerts.py quote TSLA --write`). Refresh
   `trader/merrymen/agent.json` (`get_agent_status`, `get_agent_controls`) and
   `quote_trade` the exact order into `trader/merrymen/quotes.json`.
2. Run `check.py`. Exit code 0 means every order passed, 1 means at least one
   was blocked.
3. Tell the user the result in plain words, order by order: the max loss at
   the stop, reward:risk, and how much of today's limits it uses. For a
   BLOCK, give the reason and the fix (a smaller amount, a closer stop from
   trader-exit, wait for the window, a fresh quote, or skip the trade). Never
   change a limit yourself, and never suggest loosening the agent's signed
   limits to make a trade fit.
4. If the order changes in any way, run the check again. trader-broker matches
   each order to its verdict by fingerprint, so an edited order is not ready
   until it passes again, and a verdict from yesterday does not count today.

## Example: the reel, on Merrymen

The TSLA order from trader-budget (25.00 USDG) at 10:15 AM on Monday
2026-10-19, paper agent, with the token quoted at 364.90:

```
PASS  #1 buy TSLA $25, entry
          token price 364.9000 vs the stock's 364.18: +0.20%; impact 12 bps; fee $0.01
          max loss with the token's price and costs: $0.50 ($0.45 at the stop + $0.04 fees and gas, both ways)
          entry 364.18 (the plan's entry), stop 358.32, target 370.04: risk 5.86 a share
          max loss $0.50 (limit $2), reward:risk 1.00 (min 1)
          today before this: 0 of 3 trades, $0 of $6 daily loss
        ~ the stop 358.32 is in the plan only, not at the broker: set a stop alert (trader-alerts: alerts.py add --from-plan)

1 passed, 0 blocked at 2026-10-19 10:15 New York. Cash after the passed orders: $175 (paper account).
```

The same order against a live agent, with the token quoted at 370.00:

```
BLOCK #1 buy TSLA $25, entry
        - merrymen: your config says paper ("paper": true) but the agent trades REAL funds (mode live). Switch the agent to practice in Merrymen, or decide to go live yourself
        - merrymen: the token trades +1.60% from the stock price 364.18 the plan uses (limit 1%): the token is not tracking the chart, or is not one share
```

At 9:40 it is blocked by the window (no new entries before 9:45). The 3:55 PM
sell that closes the position passes, even though it is after the 3:30 entry
cutoff and has no quote yet: it is an exit (the missing quote is a warning).

## Rules

- A PASS only means the order is allowed to be shown to the user. It is not a yes.
- Every number comes from the config, the order, the portfolio, the prices, the saved Merrymen
  results or the broker log.
- Free Yahoo prices are unofficial and can lag; the token's price is the one that fills, and a
  sale at the stop can fill worse than the stop in a fast market.

## What it never does

It never proposes a trade, never edits an order to make it pass, never
loosens a limit, never blocks a sell that only gets the user out on a day
limit or the entry window, and never treats a PASS as the user's yes. A sell
is blocked only where Merrymen would refuse it anyway (a stale or wrong agent
snapshot, an expired permission, a stopped agent, the wrong book, the wrong
token, over the signed per-trade limit): refresh the snapshot, or flatten in
parts.

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
