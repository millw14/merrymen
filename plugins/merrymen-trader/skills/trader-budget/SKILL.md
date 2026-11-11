---
name: trader-budget
description: >-
  Budget Manager. Sizes every position to your budget, your max loss per
  trade and your Merrymen agent's own signed limits. Reads the trade plan
  from trader-exit (entry, stop, target), finds the USDG amount that fits
  inside every limit (max loss per trade, position cap, max order, cash after
  your buffer, the agent's per-trade limit, the owner-order cap and half of
  what is left of its 24-hour budget), says which limit decided it, and
  writes ONE Merrymen order (a USDG amount of one stock token, by address)
  to trader/orders.json. A stop too far away for your max loss is a plain
  refusal, not a smaller order. Nothing is sent. Use when the user says "how
  much should I buy", "size this trade", "I have $200 on my Merryman", "I
  only want to risk $2 a trade", "set my rules", "keep 10% in cash", or
  after /trader-exit writes a plan.
argument-hint: "[budget in USDG]"
---

# trader-budget

The Budget Manager turns a plan ("buy TSLA at 364.18, stop 358.32") into an
exact order ("buy 25.00 USDG of the TSLA stock token"), inside rules the user
sets once. The stop decides the size: the further away the stop, the smaller
the amount. Merrymen buys a dollar amount, so the size is in cents, not whole
shares, and the agent's own signed limits are limits here too. It writes a
proposal only. trader-risk checks it and trader-broker asks the user yes or
no. Day trading loses most people money. Sizing to a max loss keeps each loss
small; it does not make a trade win.

`${CLAUDE_SKILL_DIR}` below is this skill's folder (where this SKILL.md lives).

```bash
python3 "${CLAUDE_SKILL_DIR}/size.py"                        # trader/plan.json + trader/config.json
python3 "${CLAUDE_SKILL_DIR}/size.py" --write                # write trader/orders.json
python3 "${CLAUDE_SKILL_DIR}/size.py" --json                 # the sizing as JSON
```

`--now "2026-10-19 10:15"` pins the clock (New York time). A plan for
another day is refused: make a new one with trader-exit.

## What it reads and writes

| file | what |
| --- | --- |
| `trader/config.json` | the rules (start from `config.example.json` in this folder) |
| `trader/plan.json` | the trade: entry, stop, target, setup, flat-by time (trader-exit writes it) |
| `trader/merrymen/tokens.json` | Merrymen's stock tokens: the address for the symbol (trader-broker, step 1) |
| `trader/merrymen/agent.json` | the agent's signed limits and what is left today (trader-broker, step 1) |
| `trader/prices.json` | optional: a fresh price above the plan's entry means a bigger risk (trader-alerts writes it) |
| `trader/portfolio.json` | optional: its cash caps the size (trader-broker keeps it) |
| `trader/orders.json` | the one proposed order it writes with `--write` |

## Step 1: set the rules once

If `trader/config.json` does not exist, copy `config.example.json` into
`trader/config.json` and ask the user for each value in plain words:

- **merrymen_agent**: the agent id from `list_agents` (trader-broker). Empty
  blocks every order.
- **budget**: how much of the agent's money this pack may use for day trades,
  in USDG. Only money they can afford to lose.
- **cash_buffer_pct**: how much always stays in cash (default 10).
- **max_loss_per_trade_usd**: the most one trade may lose if it is sold at the stop (default 2).
- **max_position_pct**, **max_order_usd**, **min_order_usd**: the biggest position (50% of the
  budget), the biggest order (50) and the smallest order (1).
- The day limits trader-risk enforces: **max_daily_loss_usd** (6), **max_trades_per_day** (3),
  **min_reward_risk** (1.0), **require_stop** (true), **no_entries_before** / **no_entries_after**
  ("09:45" / "15:30") and **flat_by** ("15:55"), all New York time.
- **reserve_exit_budget** (true): Merrymen's 24-hour budget figure counts sells as well as buys, so
  an entry uses at most half of what is left, keeping the other half for the sell that closes it.
- **max_quote_gap_pct** (1.0): how far the token's quoted price may be from the stock price the plan
  was made on.
- **blocked**: tickers they never want to trade.
- Keep **paper** true until they have watched it work with the agent in practice mode.

## Step 2: size the trade

```bash
python3 "${CLAUDE_SKILL_DIR}/size.py" --write
```

The amount is the smallest of these, down to the cent:

| limit | USDG |
| --- | --- |
| max loss | `max_loss_per_trade_usd` / risk a share (entry minus stop) x entry |
| position cap | budget x `max_position_pct` |
| max order | `max_order_usd` |
| cash | budget minus the cash buffer, never more than the cash in `trader/portfolio.json` |
| agent per trade | the per-trade limit signed into the agent's permission |
| owner-order cap | the owner's Settings, max per chat trade |
| agent 24h budget | what is left of the agent's 24-hour budget, halved with `reserve_exit_budget` |

The entry it sizes at: the plan's entry, or the price in `trader/prices.json`
if it is fresh (under 15 minutes old) and higher. A price that ran up since the
plan means a bigger loss at the same stop, so a smaller amount. A lower price
never shrinks the risk. Merrymen takes market orders only: there is no limit order.

It refuses, and writes no order, when: nothing fits, the order is under the
minimum, reward:risk is under `min_reward_risk`, the stop is not below the
entry, the target is not above it (the move already happened), the plan is
for another day, the ticker is blocked, the plan is a short, the symbol is
not one of Merrymen's stock tokens (or has two registry addresses), or the
token is paused. Say the reason to the user in one line.

## Step 3: show the user

Show the limits, which one decided the size, the USDG amount, about how many
shares that is, and the max loss at the stop. Say plainly that Merrymen holds
no resting stop: the stop is a plan, and getting out is a sell they approve,
so it can fill well past the stop. Then hand over: `quote_trade` for exactly
that amount (trader-broker), then `/trader-risk`.

## Example: the reel

TSLA on Monday 2026-10-19. Opening-range breakout: entry 364.18 at 10:15 AM,
stop 358.32 (the opening-range midpoint), target 370.04 (1R). Risk 5.86 a
share. The example config ($200, 10% cash buffer, $2 max loss) and an agent
whose permission allows 25 USDG a trade, 100 left today:

```
Limits in USDG (Merrymen buys a dollar amount; the smallest one wins):
  max loss          $2 max loss / 5.86 risk a share x 364.18                       124.29
  position cap      50% of $200                                                    100.00
  max order         $50                                                             50.00
  cash              budget $200 minus the $20 cash buffer                          180.00
  agent per trade   signed per-trade limit 25 USDG                                  25.00  <- binds
  owner-order cap   Settings, max per chat trade 25 USDG                            25.00
  agent 24h budget  100 USDG left in 24h, half kept for the sell                    50.00

Size: 25.00 USDG of TSLA (token 0x1a1a...1a1a), about 0.068647 shares. Max loss if it is sold at the stop: $0.41.
```

It writes:

```json
{"symbol": "TSLA", "side": "buy", "notional": "25.00", "type": "market", "time_in_force": "day",
 "venue": "merrymen", "agent": "robin", "token": "0x1a1a...1a1a",
 "why": "opening-range breakout on TSLA: 25.00 USDG, about 0.068647 shares, bound by agent per trade ($0.41 at the stop 358.32)",
 "plan": {"entry": 364.18, "stop": 358.32, "target": 370.04, "risk_per_share": 5.86, "qty": 0.068647,
          "max_loss": 0.41, "setup": "orb", "entry_time": "10:15 AM", "flat_by": "15:55"}}
```

`plan` is a note for trader-risk and trader-broker and is never sent; `why`
goes to the owner as Claude's note on the proposal. trader-risk measures the
loss again from the token's quoted price with fees and gas both ways ($0.50
in the reel), and that is the figure the ticket shows.

## Weights mode

Upstream's weights mode (split a budget across a list) writes plain buys with
no stop. With `"broker": "merrymen"` it is refused: this pack proposes one
planned day trade at a time.

## Rules

- Proposals only. This skill never calls a Merrymen tool that changes anything.
- Never size money the user has not said is for this. Ask for the budget and the max loss.
- Every number comes from the config, the plan, the prices or the saved Merrymen results. Nothing is guessed.
- No projections: never say what a trade will make. A target is a plan, not a forecast.
- Free Yahoo prices are unofficial and can lag. The token's quoted price is the one that fills.

## What it never does

It never proposes, approves or schedules a trade, never raises a limit on its
own, never shrinks a stop to fit a bigger amount, never sizes a token outside
Merrymen's stock-token registry, and never sizes options, margin or short positions.

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
