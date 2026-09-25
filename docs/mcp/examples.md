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
   `confirmed` (only once the on-chain receipt and the recorded fill agree), or
   `paper_filled`, `refused`, `failed`, `expired`. `cancel_proposal` withdraws it
   until your agent picks it up.

Your agent re-checks its limits, the market and its permission before it
executes, and may still refuse.

## Change a setting

`propose_settings_change {changes: {strategistStopLossBps: 800}, idempotency_key}`
(needs `drafts:write`) returns a before/after diff and an approval link. Only
settings you could change by chat are allowed; live trading, safety floors,
custom tokens and Telegram controls stay on the dashboard, and signed limits
need a new signature.

## Alerts

`list_notification_channels`, then `subscribe {kind: "trade_confirmed"}` or
`{kind: "summary", params: {period: "day", hour_utc: 18}}` (needs
`notifications:manage`). Alerts go to your linked Telegram from Merrymen's
background worker, deduplicated and retried; `list_deliveries` shows what was
sent.

## Weekly report and export

`get_summary {period: "week"}` for a structured summary; `create_export {kind:
"trades", format: "csv"}` for a file that expires in 24 hours, readable as the
resource `merrymen://exports/{id}` or downloadable while signed in.
