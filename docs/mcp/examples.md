# Examples

These show what a connected assistant does with Merrymen's tools. Tool names
are exact; responses are abbreviated. Every example works with the default
(read + chat) permissions unless it says otherwise.

## "How is my agent doing?" (portfolio inspection)

1. `list_agents` → your agent's id, name, paper/live mode, status.
2. `get_portfolio` → per book (paper and live separately): valuation time,
   cash, savings (Morpho), positions with price, source, staleness, cost and
   unrealised P&L (null when a price or cost is missing, with the reason), gas
   ETH apart, warnings.
3. `get_performance {period: "week"}` → equity change, deposits and
   withdrawals, the change they don't explain, max drawdown, realised P&L from
   evidenced sells only, fees and gas.
4. `compare_paper_live` when both books have history — side by side, never added
   together.

A good answer states the valuation time, keeps paper and live apart, and says
when a figure is unknown instead of treating it as zero.

## "Why hasn't my agent traded?" (inactivity diagnosis)

`explain_agent_inactivity {window_hours: 24}` returns a primary cause and a
checklist, each with the observed value, the threshold and when it was
recorded:

- permission (signed? expired?), worker liveness (heartbeat age vs
  max(180 s, 2 × tick + 90 s)), live rail (e.g. `no-gas`, `live-not-enabled`),
  funding, settings consent (live trading off, paper off, launch buying off),
  pause, market data, provider failures, model holds (a deliberate HOLD is not
  a fault), policy refusals by rule (e.g. `daily-cap`), quote failures (e.g.
  `no-route`), execution failures (reverted), data freshness;
- `what_owner_can_do`: concrete steps such as "re-sign at /grant", "send ETH
  for gas", "turn on live trading in Settings" — the assistant can't do these
  for you.

Follow up with `list_decisions` (stored explanations and gate outcomes) and
`get_refusals` (a histogram of refusal rules with remedies).

## Research a token

1. `search_tokens {query: "NVDA"}` → every match by address, flagging
   duplicate symbols and launchpad coins that impersonate a trusted ticker.
2. `get_token {address}` → price, source, observation time, liquidity, volume,
   with names and descriptions marked untrusted.
3. `get_candles {address, window: "1h"}`, `get_pool_activity {address}` → bars
   and buy/sell flow.
4. `check_token_eligibility {address}` (needs `agents:read`) → whether *your*
   agent could trade it: discoverable, priceable and executable, each with
   reasons.
5. `add_to_watchlist {address}` (needs `watchlist:manage`) — watching never buys.

## Talk with your agent

`send_message {message: "What's your plan for today?", request_id: "…"}` (needs
`chat:write`). The agent answers from Merrymen's own view of its state. It
cannot change settings or trade from a message; if it would suggest an action,
the reply says to do it in Merrymen (`proposal_stripped: true`). If your client
times out, `get_conversation` returns the reply when it lands.

`submit_research {title, body, sources: [urls]}` shares a note your agent will
see in conversations, labelled external and untrusted. It does not change
trading rules.

## Backtest a strategy

`run_backtest {strategy: "steady-basket", symbols: ["NVDA","AAPL"], data: "oracle", days: 30, initial_usdg: 1000, variants: [{label: "default"}, {label: "smaller buys", buy_per_tick_usdg: 10}]}`
(needs `jobs:run`) returns a `job_id` immediately. The job runs in Merrymen's
background worker, so it survives your client disconnecting. `get_job {job_id}`
returns progress and then, per variant: return, max drawdown, trades,
turnover, the execution-cost assumption, data coverage and limitations. It is
a simulation, not a promise.

## Prepare a trade and approve it

Needs `trade:propose`.

1. `quote_trade {side: "buy", token, amount_usdg: 10}` → expected amount, the
   minimum at your agent's slippage, price impact vs its cap, route, gas and
   fees. Places nothing.
2. `propose_trade {side, token, amount_usdg, idempotency_key}` → a proposal and
   an `approval_url`. Nothing is traded yet.
3. You open the link, sign in, see exactly what will happen (paper or real
   money, the bound minimum, a fresh price, your limits) and approve or decline.
4. `get_proposal {proposal_id}` follows it: `submitted` → `executing` →
   `filled_awaiting_ledger` → `confirmed` (only once the on-chain receipt and
   the recorded fill agree), or `paper_filled`, `refused`, `failed`,
   `expired`. `executing` is not an outcome: it also covers an order the agent
   has finished whose trade record has not reached the ledger yet, so poll
   again. `cancel_proposal` withdraws it until your agent picks it up.

What `result` carries, by outcome:

| Status | Keys in `result` |
|---|---|
| `confirmed` | `tx_hash`, `usdg_actual` (the USDG the order moved, only when known exactly — read from the receipt, or a buy's own input — otherwise null, never the quote's estimate), `fill_qty_raw`, `basis_source` (`receipt`; `quote` when the fill was booked from the quote because the receipt could not be read; null when not recorded) |
| `filled_awaiting_ledger` | `tx_hash`, `note` |
| `executing` | `note`, and `tx_hash` once the transaction was sent |
| `paper_filled` | `note`, and `simulated_because` (a rule) when the agent booked it on paper for a reason |
| `refused` | `why`, `rule`, `rule_family`, `rule_label`, `rule_remedy` (`rule_detail_withheld: true` when raw error text was deliberately not relayed); `rule: null` with `agent_said_untrusted` (the agent's own sentence, cut and marked untrusted) when no rule was recorded |
| `failed` | as `refused`, plus `tx_hash` when it reached the chain and reverted — **or** `why` and `outcome_unknown: true` |
| `expired`, `cancelled`, `rejected` | `why` |

**`outcome_unknown: true` means "check your trades", not "it did not
happen".** The agent finished the order, but no trade record that is clearly
this order's reached the ledger in time, so Merrymen will not say either way.
Look at `get_trades` before proposing the same trade again.

Your agent re-checks its limits, the market and its permission before it
executes, and may still refuse.

**Which proposals an assistant sees.** Only those about an agent shared with
its own connection, of kinds its permissions cover (a trade needs
`trade:propose`, a setting change or draft `drafts:write`, a post
`social:write`), plus agent drafts, which belong to no agent yet. Anything
else — another agent's proposal, or another owner's — is `not_found` to
`get_proposal`, `list_proposals` and `cancel_proposal`.

## Change a setting

`propose_settings_change {changes: {strategistStopLossBps: 800}, idempotency_key}`
(needs `drafts:write`) returns a before/after diff and an approval link. Only
settings you could change by chat are allowed; live trading, safety floors,
custom tokens and Telegram controls stay on the dashboard, and signed limits
need a new signature. If a setting changes after the proposal was made, the
approval refuses rather than overwrite it; ask for a fresh proposal.

## Draft an agent setup

`create_agent_draft {name: "Robin", strategy: "steady-basket", basket: ["NVDA","AAPL"], risk_level: "balanced", idempotency_key}`
(needs `drafts:write`) returns an approval link and:

- `left_out`: what the draft could not carry, each with `key` and `why`. A
  risk level carries only settings that can be changed by conversation (stop
  loss, take profit, amount per buy, max per AI trade, slippage); the
  price-impact safety floor (`maxImpactBps`) is left out and stays a
  dashboard setting.
- `diff`: each drafted setting's current value → drafted value, **only when
  an agent is shared with this connection**; otherwise `null`, and the
  assistant never learns your current settings. The approval page always
  shows you the full before/after.

Approving saves the draft to your settings. If you already run an agent, the
changes apply to it at once; if not, you still choose its limits and sign its
trading permission yourself — a draft never creates trading authority. As
with a setting change, approval refuses if any drafted setting changed since
the draft was made.

## Alerts

`list_notification_channels`, then `subscribe {kind: "trade_confirmed"}` or
`{kind: "summary", params: {period: "day", hour_utc: 18}}` (needs
`notifications:manage`). Alerts go to your linked Telegram from Merrymen's
background worker, deduplicated and retried; `list_deliveries` shows what was
sent.

`trade_confirmed` announces live **trades** only: swaps and launchpad curve
trades, one message per operation, with its transaction. A transfer or a
savings-vault move is not a trade and is not announced, and neither is a copy
of an older operation that a redeploy wrote into the ledger again. A sell's
realised P&L is stated only when both its proceeds and the cost it sold
against were read from receipts. Otherwise the message says why it is left
out, and only as far as the evidence goes: "estimated" when the sale's own
proceeds, or a buy still in the cost it sold against, was booked from the
quote; otherwise that it could not be confirmed both sides came from
receipts — which is not a claim that anything was estimated.

## Weekly report and export

`get_summary {period: "week"}` for a structured summary; `create_export {kind:
"trades", format: "csv"}` for a file that expires in 24 hours, readable as the
resource `merrymen://exports/{id}`. Its `download_url` opens
`/connect/export/<id>` in Merrymen: sign in as the owner and press Download
(the file is served only to your own signed-in session, never to the link
itself).
