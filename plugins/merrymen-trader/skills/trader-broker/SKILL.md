---
name: trader-broker
description: >-
  Order Executor for Merrymen. Turns an order that trader-risk passed into
  ONE Merrymen trade proposal for the user's own agent, never without their
  yes. Shows each order as a plain ticket (a USDG amount of one stock token,
  the plan's stop and target, the max loss with the token's price and costs)
  plus the exact propose_trade call, records the yes word for word, then
  Claude's own permission card asks again and the owner approves the
  proposal in Merrymen. Links the agent (list_agents, get_agent_status,
  get_agent_controls) and the stock-token list (discover_tokens), follows a
  proposal with get_proposal, records fills, and builds the sell that closes
  a day trade by the flat-by time. Paper (practice) by default. Use when the
  user says "place the order", "buy it", "execute", "send it to Merrymen",
  "trade it on my Merryman", "close my position", "flatten", "get me out",
  "connect Merrymen", "set up paper trading", or after /trader-risk passes.
argument-hint: "[order number]"
---

# trader-broker

The Order Executor is the only skill in this pack that can lead to a trade,
so it is the strictest. The broker is the user's own Merrymen agent: Claude
never holds keys, never signs and never trades directly. It prepares a
proposal; the owner approves it in Merrymen; the agent executes it inside its
own signed limits. A trade happens only after four gates, every time, for
every order:

1. **trader-risk passed this exact order today** (matched by fingerprint,
   which covers the token address and the agent).
2. **The user typed an explicit yes for this one order** in the chat.
3. **The user allowed Claude's own permission card** for `propose_trade`, once.
4. **The owner approved the proposal in Merrymen**, signed in on Merrymen's
   own page, within 15 minutes. The agent's signed per-trade limit, daily
   budget, drawdown breaker and permission expiry still apply after that.

Three yeses from the user, one PASS from the rules. No yes, no trade.

`${CLAUDE_SKILL_DIR}` below is this skill's folder (where this SKILL.md lives).

```bash
python3 "${CLAUDE_SKILL_DIR}/merrymen.py" summary                # what the saved Merrymen results say
python3 "${CLAUDE_SKILL_DIR}/ticket.py" show                     # every ticket, READY or not
python3 "${CLAUDE_SKILL_DIR}/ticket.py" approve --index 1 --reply "yes"
python3 "${CLAUDE_SKILL_DIR}/ticket.py" result --index 1 --status proposed --proposal-id prp_... --approval-url URL
python3 "${CLAUDE_SKILL_DIR}/ticket.py" result --index 1 --status paper_filled --filled-qty 0.0685 --filled-price 364.95
python3 "${CLAUDE_SKILL_DIR}/ticket.py" flatten --symbol TSLA --value-usdg 25.40
python3 "${CLAUDE_SKILL_DIR}/ticket.py" log
```

`ticket.py` and `merrymen.py` never talk to Merrymen. Claude calls the
Merrymen tools and saves what they return; the scripts render tickets, check
that a reply is a real yes for that order, build the flatten ticket, and keep
the log in `trader/state/broker.json`. `--now "2026-10-19 10:15"` pins the
clock (New York time).

## What it reads and writes

| file | what |
| --- | --- |
| `trader/merrymen/tokens.json` | `discover_tokens` with list "established": Merrymen's stock tokens, by address |
| `trader/merrymen/agent.json` | `{"agent": id, "status": get_agent_status, "controls": get_agent_controls}` |
| `trader/merrymen/quotes.json` | the `quote_trade` result for the order being checked |
| `trader/orders.json` | the proposed orders (trader-budget writes it; `flatten` replaces it) |
| `trader/state/risk.json` | trader-risk's verdicts; only a PASS from today is READY |
| `trader/state/broker.json` | every yes, no, proposal and outcome, with each entry's max loss |
| `trader/portfolio.json` | cash and token amounts, updated by `fill` and by `result --filled-qty` |
| `trader/plan.json` | the flat-by time for `flatten` |

Save tool results exactly as returned, as JSON. Never type the numbers in by
hand: trader-risk reads the agent's limits and the quote from these files.

## Setup: the Merrymen connection

This pack uses the Merrymen MCP server through the `merrymen` plugin. It
needs Claude Code (the scripts run locally).

1. Install the Merrymen plugin from the same marketplace, if it is not there:
   `/plugin install merrymen@merrymen`. Its server is `https://mcp.merrymen.dev/mcp`.
2. Sign in: `/mcp`, choose `plugin:merrymen:merrymen`, Authenticate. On the
   Merrymen page, tick **Suggest trades for you to approve** (it starts
   unticked) as well as the read permissions, then Allow. Sign-in happens on
   that page, never in the chat. The connector listed in Claude's directory
   does not carry the trade tools; use this plugin's server.
3. **Keep `propose_trade` and `cancel_proposal` on ask.** When Claude Code
   asks to use them, answer yes for that one call, never "don't ask again".
   In `.claude/settings.json`, never put them under `allow`; to make the rule
   explicit, add them under `"permissions": {"ask": [...]}` with the full names
   `/mcp` shows for the plugin's tools.
4. The agent: `list_agents`. If there is more than one, ask which. Put its id
   in `trader/config.json` as `"merrymen_agent"`. With it empty, trader-risk
   blocks every order.
5. Check it, read only: `get_agent_status` for that agent. `mode` must be
   `paper` while `"paper": true` (the default): trader-risk blocks a paper
   config that meets a live agent. Going live is the owner's decision, made in
   Merrymen and in their own config, never by Claude.

## Step 1: link (once a session, and before every order)

1. `discover_tokens` with list `established` (every page). Save the result(s)
   to `trader/merrymen/tokens.json`. These are the only tokens this pack
   trades: Merrymen's curated stock tokens, each with its address, Chainlink
   price and paused flag. A symbol is never enough; the address is the identity.
2. `get_agent_status` and `get_agent_controls` for the agent. Save both, as
   returned, in `trader/merrymen/agent.json`:
   `{"agent": "<id>", "status": {...}, "controls": {...}}`. trader-risk wants
   it under 10 minutes old, so refresh it right before each order.
3. `python3 "${CLAUDE_SKILL_DIR}/merrymen.py" summary` reads it back: tokens,
   mode, permission expiry, per-trade limit, what is left of the 24-hour budget.

## Steps: the entry

1. trader-budget wrote the order (a USDG amount, `"venue": "merrymen"`).
   Call `quote_trade` for exactly that agent, side, token and `amount_usdg`,
   and save it to `trader/merrymen/quotes.json`. Then `/trader-risk`.
2. `ticket.py show`. Only READY tickets go to the user. A ticket that is NOT
   READY or BLOCKED goes back to `/trader-risk`.
3. Show ONE ticket and ask: "Propose this trade to Merrymen? Reply yes or no."
   One order per question. Never offer "yes to all".
4. Run `ticket.py approve --index N --reply "<the user's reply, word for word>"`.
   If it prints "Not recorded", the reply was not an explicit yes for this
   order (for example "sure", "yes to all", or a yes that names a different
   stock or amount). Ask again. Never turn a reply into a yes yourself.
5. Only after "Recorded your yes", call `propose_trade` with exactly the JSON
   it printed, idempotency key included (a retried call then never makes a
   second proposal). Claude's permission card appears: allow it once, or deny.
6. Record it: `ticket.py result --index N --status proposed --proposal-id <id>
   --approval-url <approval_url>`, or `--status denied` if the card was
   denied, or `--status failed --note "..."` if the call itself failed.
7. Give the user the `approval_url`. They sign in to Merrymen and approve or
   decline it there; it expires 15 minutes after it was made. Approval
   re-quotes a buy and refuses it if the price moved past the quoted minimum
   or the agent's paper/live mode changed.
8. When they say they have decided, `get_proposal`. `awaiting_approval`,
   `approved`, `submitted`, `executing` and `filled_awaiting_ledger` are not
   outcomes: check again later. Then record the outcome:
   - `confirmed` (on chain) or `paper_filled` (practice): `ticket.py result
     --index N --status confirmed|paper_filled --filled-qty Q --filled-price P`,
     the token amount and the USD price per token from `get_proposal`'s result
     or the matching `get_trades` row. That records it in `trader/portfolio.json`.
   - `refused`, `expired`, `cancelled` or `rejected`: `--status` that. Nothing traded.
   - `failed`: `--status failed`. Merrymen also calls an outcome it could not
     confirm failed, so it may have traded: check `get_trades` and
     `get_portfolio` before anything else. It keeps counting against today's
     limits and is never proposed again blind.
   A proposal that ended without a trade (expired, cancelled, a failed call)
   can be tried again only with a fresh quote, a new trader-risk PASS and a new yes.
9. To withdraw a proposal the owner has not approved, or an approved trade the
   agent has not picked up: `cancel_proposal` (Claude's card asks), then
   `get_proposal` and record the outcome.

## Steps: while it is open, and out by the close

Merrymen holds **no resting stop-loss or take-profit order**. The stop and the
target are a plan. trader-alerts watches them, and getting out is a sell the
owner approves in Merrymen, so it can fill well past the stop. Say so plainly.

- trader-alerts watches the stop, the target and the flat-by time
  (`alerts.py add --from-plan`).
- When one rings, or by `flat_by` (15:55 New York), sell what is open:
  1. `get_portfolio` for the agent (its current book): the token's value in USDG.
  2. `ticket.py flatten --symbol TSLA --value-usdg <value>` writes a market sell
     for that value plus 1% (Merrymen sells at most what the agent holds, so
     this sells all of it), never over the signed per-trade limit. If it says
     PART ONLY, sell the rest the same way after the first part fills.
  3. Refresh `trader/merrymen/agent.json`, `quote_trade` the sell, save it, `/trader-risk`.
     A sell of a token the agent holds is never blocked by the daily limits or
     the entry window.
  4. `ticket.py show`, the user's yes for that one order, `propose_trade`, the
     owner's approval, `get_proposal`, `result`, as above.
- A permission that expires during the day leaves the position unsellable by
  the agent: trader-risk blocks an entry whose permission ends before the flat-by time.

## Example: the reel, on Merrymen

TSLA on Monday 2026-10-19 at 10:15 AM, paper agent `robin` with a signed
per-trade limit of 25 USDG. trader-budget sized 25.00 USDG (the per-trade
limit binds), the quote put the token at 364.90 against the stock's 364.18,
and trader-risk passed it:

```
ORDER 1 of 1, PAPER (the agent's practice book), Merrymen
  BUY 25.00 USDG of TSLA on Merrymen, market
  token 0x1a1a...1a1a, agent robin
  plan: stop 358.32, target 370.04 (watched by trader-alerts; Merrymen holds no stop order)
  max loss about $0.50 if it is sold at the stop, with the token's price and costs
  why: opening-range breakout on TSLA: 25.00 USDG, about 0.068647 shares, bound by agent per trade
  READY: trader-risk PASS, waiting for your yes
  Claude will call propose_trade with exactly (the key is set when you say yes):
    {"agent": "robin", "side": "buy", "token": "0x1a1a...1a1a", "amount_usdg": 25.0,
     "idempotency_key": "<set at your yes>", "note": "opening-range breakout on TSLA: ..."}
  Nothing trades on that call. Merrymen returns an approval link; the owner signs in there and
  approves within 15 minutes, and the agent's signed limits still apply after that.
```

The user replies "yes". Claude records it, calls `propose_trade`, the card
asks once more, and Merrymen answers with a proposal id and an approval link.
The user approves it in Merrymen; `get_proposal` reports `paper_filled`. The
`why` goes to the owner as Claude's note; the plan stays in the file.

## What it never does

- Never proposes a trade without the first three gates, never two orders on one
  yes, and never approves anything in Merrymen: that is the owner's click.
- Never proposes from a scheduled or background task: nobody is there to say yes.
- Never asks for, reads, stores or repeats keys, passwords, seed phrases or
  sign-in codes. Sign-in happens on Merrymen's own page.
- Never switches the agent to live, changes a signed limit, re-signs a permission
  or proposes a settings change to make a trade fit. Those are the owner's, in Merrymen.
- Never trades a token that is not in Merrymen's stock-token registry, and never by symbol alone.
- Never promises a fill price: the agent re-prices at execution with its own slippage limit.

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
