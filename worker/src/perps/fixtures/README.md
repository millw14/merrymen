# Lighter fixtures

Real responses from Lighter's Robinhood instance (`https://api.rh.lighter.xyz`),
captured with read-only GETs on 2026-09-29 during the perps design spike, and
used by `markets.test.ts`, `api.test.ts` and `signer.test.ts`. Tests never touch
the network; these files are the venue as far as the tests know.

Rules for this directory:

- **Live captures are byte-for-byte what the venue returned.** Do not tidy,
  reformat or "fix" them: a parser that only works on a cleaned-up file is a
  parser that fails on the venue. The float noise in `total_asset_value`, the
  `"-0.000000"` position values, the fields Lighter omits when zero — all of it
  is the point.
- **Synthetic files say so in their name** (`synthetic.*`). They exist only for
  endpoints that need the account's own auth token, which the spike did not
  have. Each is built from the schema in lighter-python's `openapi.json`, and
  each must be replaced by a live capture during the Phase-0 mainnet checklist
  (`docs/perps.md`, Rollout).

| file | source | captured (UTC) |
|---|---|---|
| `orderBookDetails.perp.json` | `GET /api/v1/orderBookDetails?filter=perp` — all 57 perps | 2026-09-29 16:30 |
| `orderBooks.json` | `GET /api/v1/orderBooks` — 57 perps + 27 spot | 2026-09-29 15:34 |
| `account.22149.isolated.json` | `GET /api/v1/account?by=index&value=22149` — two ISOLATED positions; `collateral` 0.33 of a 150.86 account (the rule-12 trap) | 2026-09-29 15:37 |
| `account.10196.cross.json` | `GET /api/v1/account?by=index&value=10196` — cross, 23 open positions | 2026-09-29 15:37 |
| `account.7951.cross.json` | `GET /api/v1/account?by=index&value=7951` — `total_asset_value` float-rendered, 5 micro off the exact parts | 2026-09-29 15:37 |
| `account.18958.tied.json` | `GET /api/v1/account?by=index&value=18958` — isolated + cross, position-tied and pending SL/TP orders | 2026-09-29 16:21 |
| `account.39.spot.json` | `GET /api/v1/account?by=index&value=39` — USDG `locked_balance` 308,244.59 and 15 stock-token balances in the SPOT route, none of it in `total_asset_value` or C + ΣM + ΣU | 2026-09-29 15:59 |
| `orderBookOrders.1.json` | `GET /api/v1/orderBookOrders?market_id=1&limit=20` (BTC) | 2026-09-29 15:45 |
| `fundings.1.json` | `GET /api/v1/fundings?market_id=1&resolution=1h&…` — 4 hourly rows | 2026-09-29 16:05 |
| `fundings.2.json` | `GET /api/v1/fundings?market_id=2&resolution=1h&…` — 48 hourly rows | 2026-09-29 16:05 |
| `markPriceCandles.1.1h.json` | candle rows from `GET /api/v1/markPriceCandles?market_id=1&resolution=1h&start_timestamp=…&end_timestamp=…&count_back=500` (the spike's `fetch.py`), the last 120 BTC rows. The rows are verbatim; `fetch.py` kept only the `c` array, so the `{"code":200,"r":"1h","c":[…]}` envelope is re-assembled around them in the endpoint's documented shape | 2026-09-29 15:43 |
| `markPriceCandles.1.4h.json` | `GET /api/v1/markPriceCandles?market_id=1&resolution=4h&start_timestamp=1788558587&end_timestamp=1790718587&count_back=150` (BTC), one read-only GET, verbatim with its envelope. 150 rows on the 4 h grid; the LAST (`t` 1790712000000) was the candle still in progress at capture — the one perp-trend must drop. Rows carry an extra `sc` (sample count) the parser ignores. Used by `feed-history.test.ts` and `perp-trend.test.ts` | 2026-09-29 21:49:47 |
| `tx.1d806b89.json` | `GET /api/v1/tx?by=hash&value=1d806b89…` — CreateOrder with SkipNonce; signer known-answer vector 1 | 2026-09-29 15:45 |
| `tx.43de174b.json` | `GET /api/v1/tx?by=hash&value=43de174b…` — CreateOrder without attributes; signer known-answer vector 2 | 2026-09-29 15:42 |
| `recentTrades.1.json` | `GET /api/v1/recentTrades?market_id=1` — its first trade is `tx.43de174b`'s fill (account 26085, ask, taker) | 2026-09-29 15:42 |
| `recentTrades.3.json` | `GET /api/v1/recentTrades?market_id=3` — includes a trade with `taker_initial_margin_fraction_before` omitted | 2026-09-29 15:45 |
| `withdrawalDelay.json` | `GET /api/v1/withdrawalDelay` | 2026-09-29 15:45 |
| `ws.stream.0.jsonl` | every frame received on `wss://api.rh.lighter.xyz/stream?readonly=true`, one per line, verbatim: `connected`; `subscribed/market_stats` (all 57 perps) and its updates; `subscribed/order_book` for ETH (market 0) and 30 `update/order_book` deltas, a continuous `begin_nonce` → `nonce` chain; then the answers to `unsubscribe order_book/0` (`unsubscribed`), `ping` (`pong`) and `subscribe order_book/abc` (error 30005). Sent, in order: subscribe `market_stats/all`, subscribe `order_book/0`, then those three. Used by `feed.test.ts` | 2026-09-29 18:52 |
| `tx.notfound.json` | body of `GET /api/v1/tx?by=hash&value=<random 80 hex>` → HTTP 400 (recorded in the venue-signer review notes) | 2026-09-29 |
| `sendTx.400.invalid-market.json` | body of `POST /api/v1/sendTx` with `tx_type=14&tx_info={}` → HTTP 400 (the research geo-block probe) | 2026-09-29 |
| `nextNonce.6560.6.json` | body of `GET /api/v1/nextNonce?account_index=6560&api_key_index=6` (research notes) | 2026-09-29 |
| `synthetic.apikeys.json` | **synthetic**, `AccountApiKeys` schema; `public_key` rendered as the venue does (80 hex, no `0x`) | — |
| `synthetic.accountsByL1Address.json` | **synthetic**, `SubAccounts` schema, one master account | — |
| `synthetic.accountActiveOrders.json` | **synthetic**, `Orders` schema; the second order omits the zero-valued `is_ask`/`reduce_only`/`trigger_time` the way Go's omitempty would | — |
| `synthetic.positionFunding.json` | **synthetic**, `PositionFundings` schema | — |
| `synthetic.withdrawHistory.json` | **synthetic**, `WithdrawHistory` schema | — |
