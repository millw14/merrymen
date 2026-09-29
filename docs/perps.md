# Perpetuals (Lighter on Robinhood Chain)

An owner can let their Merryman trade perpetual futures — long or short, with
leverage — on the markets Lighter lists on Robinhood Chain (BTC, ETH, SOL, large
US stocks, SPY/QQQ, gold…). Collateral is USDG, posted from the agent's own
smart account into Lighter's settlement contract on chain 4663, and every
withdrawal can only ever come back to that same account.

This file is the contract that `packages/core/src/perps.ts`, the wall entry in
`packages/core/src/wall.ts`, the modules under `worker/src/perps/`, the perp
lane in `worker/src/index.ts`, the perp tables in `worker/src/store.ts`, the
keygen and grant routes, the Settings section, the Telegram, MCP and CLI
surfaces and the docs are built against. Where a rule and the code disagree,
the code is wrong. `docs/perps-mainnet-checklist.md` lists what must be proven
with a small amount on mainnet before live perps are switched on for anyone.

## The venue, as measured (2026-09-29)

Every row was probed on mainnet or read from Lighter's own source. The probes
are recorded beside the constants in `packages/core/src/perps.ts`.

| fact | value |
|---|---|
| Venue | Lighter's **Robinhood instance** — its own zk-rollup, sequencer and liquidity, settling on Robinhood Chain (not zkLighter/Ethereum) |
| REST / WS | `https://api.rh.lighter.xyz` · `wss://api.rh.lighter.xyz/stream` |
| L2 signing chain id | `466324` (the Go signer defaults to 304 — never use the default) |
| Settlement contract | ZkLighter proxy `0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d` on 4663; upgradeable by a 3-of-5 Safe through a gatekeeper whose security council can skip the 21-day notice (L2BEAT: every upgrade so far was fast-tracked) |
| Collateral | USDG `0x5fc5…d168`, Lighter asset index **3**, perps route **0**, tick size 1, minimum deposit 1 USDG |
| Deposit | `USDG.approve(proxy, a)` then `deposit(address _to, uint16 3, uint8 0, uint256 a)` (`0x8a857083`). The Lighter account is keyed on `_to`, created by the first deposit, and its index is `addressToAccountIndex(self)` once that lands. Real ERC-4337 accounts already deposit this way |
| API key registration | on-chain `changePubKey(uint48 account, uint8 keyIndex, bytes pubKey40)` (`0x17010c68`), authenticated only by `msg.sender`. A Kernel smart account can call it; no EIP-191/1271 signature is involved. The `NIL` "my own account" shortcut in Lighter's GitHub is **not** deployed on 4663. A key cannot be changed while cross collateral is 0 (error 21126) |
| What an API key can do | trade, cancel, change leverage and isolated margin, create sub-accounts, move funds between accounts **under the same L1 address**, mint public-pool shares, and request a **secure withdrawal that can only pay the account's L1 address** (our Kernel). It cannot transfer to another owner, fast-withdraw, register keys off-chain or approve an integrator — each needs an ECDSA L1 signature the Kernel cannot make. There is no per-key scope |
| Secure withdrawal | L2 `Withdraw` (tx 13, no destination field) → the venue's current `withdrawalDelay` (observed 8–22 min) → pending balance on the contract → `withdrawPendingBalance(owner, 3, amount)` (`0x2f25807e`, anyone may call, always pays `owner`; Lighter's relayer usually claims it) → `WithdrawPending(owner, 3, amount)` |
| Owner escape hatches | the account's L1 address (the Kernel, driven by the owner key in a sudo UserOp) can call `withdraw`, `cancelAllOrders`, `createOrder` and `changePubKey` directly as priority requests |
| Markets | 57 perps (ids 0–56; ETH=0, BTC=1, SOL=3), 27 spot books (ids ≥2048, never touched here). Many perp symbols equal Robinhood stock-token symbols |
| Leverage and margin | per **(account, market)** state set by L2 `UpdateLeverage` (tx 20: IMF in 1/10000, margin mode 0 cross / 1 isolated), never an order field; changeable only while that market has no position and no order. Default IMF 5000 (2x); minimum IMF 200 (50x) for BTC/ETH/SPY/QQQ, 400 (25x) SOL/XAU/XAG, 500–1000 most stocks, 2000–3333 memes and pre-IPO. `maintenance_margin_fraction` is a **per-market constant** (60% of the market's minimum IMF), not 60% of the chosen IMF |
| Isolated liquidation | long `(entry − AM/|s|)/(1 − MMF)`, short `(entry + AM/|s|)/(1 + MMF)` with `AM = notional × IMF`; matches the venue's `liquidation_price` on 25/25 live isolated positions |
| Orders | integer price and size in the market's decimals. Market = IOC with a worst price. Stops/take-profits (types 2/4) fire on mark, need an `OrderExpiry` between 5 min and 30 days, and their execution price must be within 5% of the trigger. Grouped orders (tx 28): OTO `[entry, SL]`, OTOCO `[entry, SL, TP]`, whose children (BaseAmount 0, ReduceOnly) are sized to the **executed parent**, not the position |
| Nonces | per (account, key). We use `SkipNonce` (attribute 4): a nonce only has to exceed the previous one, and once any later nonce executes every earlier pending tx on that key is dead. The signer sets `ExpiredAt` = its clock + 599 s and takes no argument for it |
| Tx hash | Poseidon2 over the tx fields — deterministic and known before sending. The Schnorr signature is randomised, so only the exact signed bytes can be re-sent |
| Funding | hourly, peer-to-peer. `/fundings` `rate` is percent per hour; `value = index × rate / 100` USDG per base unit, paid by the side named in `direction` |
| Fees | Standard accounts: 0% maker and taker, 300 ms taker latency. Liquidation fee up to 1% to the insurance pool |
| Minimum order | `max(min_quote_amount = 10 USDG, min_base_amount × price)` — on 2026-09-29 about 17 USDG for BTC, 13 for ETH, 12 for SOL |
| Rate limits | Standard: 60 requests per rolling minute per IP **and** per L1 address (trades/recentTrades effectively 40); authenticated requests count only per L1 address; `sendTx` counts inside the 60; L2 `Withdraw` 2/min, `UpdateLeverage` 40/min. Signalled by HTTP 429 **or** 405, with no rate headers; a firewall block is a static 60 s for the whole IP and also throttles the WebSocket (200 client messages/min per IP) |
| Public data | an account's positions, trades and leverage are publicly readable by account index or L1 address |
| Testnet | there is **no** Lighter on Robinhood testnet 46630 — perps are paper-only there |
| Region | Lighter's terms exclude the US, UK, Canada and sanctioned jurisdictions; Robinhood Wallet perps also exclude Switzerland, the UAE and Singapore |

## The rules that are not negotiable

1. **Off until the owner turns it on, twice, from the dashboard.** `perpsEnabled`
   (default off) lets the agent trade perps on paper. Real perps also need the
   account's own live rail (`liveTradingEnabled`, read directly), a separate
   `perpsLiveEnabled` consent stored with its consent version, timestamp and
   the owner's regional attestation, and a grant carrying the perps permission
   (rule 3). No perps field has an environment term (the `liveTradingEnabled`
   precedent, `worker/src/settings.ts`); `trencherLiveEnabled` and
   `classSnipeEnabled` are **not** the model. Chat, Telegram, MCP and partners
   cannot set any perps field and say where it is done. The consent names
   leverage, liquidation, funding, the venue and its terms, the excluded
   regions, that the venue publishes the account's positions, and what the
   wall does not bound (rule 4). The operator may only *restrict*:
   `MERRYMEN_PERPS=off|paper|live` (hosted default `paper`, self-hosted
   default `live`), `MERRYMEN_PERPS_LIVE_TENANTS` (hosted allowlist), and
   `MERRYMEN_HALT_PERP_ENTRIES=1` (entries off, exits and protection on).

2. **The account owns its venue account; money only ever comes back home.** The
   Lighter account's L1 address is the agent's own smart account. Nothing here
   creates, funds or trades a Lighter account keyed on any other address. The
   worker never signs `CreateSubAccount` (9), `Transfer` (12),
   `UpdateAccountConfig` (41), `UpdateAccountAssetConfig` (42) or
   `ApproveIntegrator` (45) — `signer.ts` does not expose them — and never
   requests a fast withdrawal.

3. **The wall grows by exactly four sealed things, and only by re-signing.** The
   opt-in marker `perp-lighter-v1` (chain 4663 only, a frozen route like
   `energy-buy-v1`) adds:
   - the proxy to the **USDG approve's `ONE_OF`** (`usdgSpenders`, amount still
     `≤ perTradeUsdg`) — never to the uncapped stock `spenders`;
   - `deposit(self, 3, 0, ≤ perTradeUsdg)` — all four words pinned;
   - `changePubKey(open, EQUAL keyIndex, EQUAL 0x60, EQUAL 40, EQUAL w4, EQUAL
     w5)` where `w4 = pk[0:32]` and `w5 = pk[32:40]` **right-padded to a full
     32-byte word** — the exact API public key sealed at signing. The offset
     pin (`0x60`) is load-bearing: without it the contract's decoder could be
     pointed at other bytes. `w0` is open by necessity (the account index is
     unknown at signing); the only reachable effect is registering the sealed
     key;
   - `withdrawPendingBalance(self, 3, open)` — it can only pay this account.

   Every entry has `valueLimit: 0`. The session key gets no on-chain
   `withdraw`, `createOrder` or `cancelAllOrders`; those are the owner's
   (recover). Grants without the marker are byte-identical to today's, so
   `WALL_CHANGED_AT` and the bare-wall fingerprint do not move. Marker, sealed
   key and permission are minted from one value in every signer; the hosted
   canonical check allowlists the marker and rebuilds the policy byte for byte;
   `perpFits` keeps an over-large wall from being signed and, when the previous
   grant carried perps, **refuses** rather than silently dropping them.

4. **What the wall does not bound is said out loud.** Anyone holding the Lighter
   API key can lose, or hand to a counterparty, everything on Lighter: by
   trading against an account they control, parking collateral in
   sub-accounts, or minting shares of a public pool. Anyone holding the agent's
   grant holds both keys, and can first move the account's whole USDG balance
   onto Lighter — the per-trade cap limits each call, not each operation or
   day, and the Settings collateral cap is software an attacker does not run.
   That does not exceed what the same grant can already lose through swaps
   today. The key cannot transfer to another owner, fast-withdraw, register
   keys off-chain or approve an integrator. Order size, leverage, market and
   rate are enforced by worker code alone — the posture `policy.ts` already
   takes on the broker rail. This paragraph, in plain words, is on the consent
   and in the README.

5. **Signers only ever see the public key; the private key has the session
   key's custody or better.** `POST /api/perps/keygen` (owner-authenticated,
   POST-only, `Cache-Control: no-store`, rate-limited, never logged) generates
   the pair with the official signer. Self-hosted it writes
   `$MERRYMEN_HOME/perp-keys/<pubkey>.json` (0600) and returns the public key;
   hosted it returns the public key plus `AES-256-GCM(DEK, privateKey, AAD =
   tenant|smartAccount|pubkey|keyIndex)`. The grant carries only
   `perp = { route, apiKeyIndex, apiPublicKey, apiKeySealed? }`. No HTTP
   response built from a grant, no log line, chat message or tool output ever
   carries the private key: `GET /api/grants` is built from an **allowlist**
   (`publicGrantView`), not a denylist, and is `no-store`. Hosted, the
   orchestrator decrypts the key and writes `perp-key.json` (0600) into the
   tenant's child home beside `grant.json`; the child never holds the DEK. The
   key is redacted by value (0x, bare, either case) and by shape (80 hex) in
   every redactor. A re-sign **carries the same public key forward**; the
   server re-attaches the sealed key from the stored grant with an equal
   public key. A registered key stays valid at the venue whatever the grant
   says, so **no path may leave a non-flat venue account without its key**:
   dropping the perp block from a grant, or re-signing for another account, is
   refused (signers, and a server-side 409 that also catches old app builds)
   unless every account under our L1 address is provably flat (no positions,
   orders, collateral, pool shares or pending balance; unreadable is not
   flat). Turning perps off in Settings only stops opens (rule 8a).

6. **Caps judge exposure, not margin; leverage is venue state.** An opening
   order's notional (size × worst price) must be `≤ min(perTradeUsdg,
   perpsPerTradeUsdg)` and counts against the signed `dailyUsdg`; so does each
   margin deposit (money that can be lost, like a vault deposit). Total open
   notional `≤ perpsMaxOpenNotionalUsdg`; USDG committed at the venue (cross
   collateral + isolated margin + in transit) `≤ perpsMaxCollateralUsdg`; the
   market must be in `perpsMarkets` and active; the breaker, the energy gate
   and `perpsMaxOpensPerDay` block opens; no opens within 24 h of grant expiry
   or while any close on that market is unresolved; an open never adds to an
   existing position. Leverage per market is `L_m = min(perpsMaxLeverage,
   venue max, 10)`, applied by an L2 `UpdateLeverage` (isolated) **only while
   the market is flat**, and an open is refused unless the venue reads that
   market isolated at exactly `IMF_m`. No model ever chooses leverage. Nothing
   relaxes a sealed cap to reach the venue minimum: such an open is refused
   (`perp-below-min`) and the dashboard says which markets the signed cap can
   reach.

7. **Every open carries its own stop, at the venue, for as long as the position
   lives.** An open is one grouped transaction: OTO `[IOC entry, SL]`, or
   OTOCO with a take-profit. The SL child is a reduce-only STOP_LOSS (type 2,
   IOC, BaseAmount 0) with `TriggerPrice = entry reference × (1 ∓
   perpsStopLossPct)`, execution `Price = trigger × (1 ∓ perpsStopSlipBps)`,
   and `OrderExpiry = now + 28 days`. The open is refused unless the stop's
   worst price beats the estimated isolated liquidation price (entry at the IOC
   worst price) by `perpsLiqBufferPct`. An open is not "protected" until the
   stop is seen resting. `protect.ts` re-places a stop that is missing, wrong,
   ended without closing the position, or within 7 days of expiry. A venue stop
   is a bounded-price IOC: a gap through its worst price leaves the position
   open, and a worker down for longer than the stop's life leaves none — the
   protective loop and the venue's liquidation are the backstops, and the
   README says so.

8. **An exit is always attemptable.** A `perp-order` is a discriminated union on
   `effect`: `open` has `reduceOnly: false` and a required stop; `reduce` and
   `close` have `reduceOnly: true`, name the side **held**, and never carry a
   stop. `isExitIntent` is exactly `reduceOnly && effect ∈ {reduce, close}`, plus
   margin withdrawals and claims. The breaker, daily, per-trade and ops caps,
   the energy gate, pause and grant expiry never refuse an exit. An exit is
   **clamped, never refused, for size**: a reduce is cut to the venue-read
   position, a remainder under the market minimum becomes a close, and a
   close is always the full venue-read size. Reduce-only at the venue means a
   duplicate close can never flip into a new position.

8a. **Venue state, not the spot rail, decides whether perp exits run.** Whenever
   the live venue account (or the ledger, when the venue is unreadable) shows
   positions, orders, collateral or withdrawals in transit, the exits-only lane
   — reconcile, `protect.ts`, owner closes, stand-down, withdrawal and claim —
   runs with the live key, whatever `execMode`, account cash or ETH,
   `liveTradingEnabled`, `perpsLiveEnabled`, `perpsEnabled`, pause, the
   Robinhood Chain market read or grant expiry say. It never opens, deposits,
   raises leverage or adds margin. Turning any perps or live switch off is
   never refused; it puts live perps into exits-only, cancels non-reduce-only
   orders, and brings collateral home once flat. `canTradeForReal` counts
   known venue collateral, so posting the last USDG as margin does not flip
   the whole agent to paper.

9. **Persist before send; one nonce per intent.** Every Lighter transaction —
   order, grouped order, cancel, cancel-all, leverage, withdraw — is written as
   a `submitted` row **before** `sendTx`, holding the exact signed `tx_info`,
   its hash and type, the account and key index, the nonce, the `ExpiredAt`
   parsed from `tx_info`, and every client order index inside it. A failed
   write sends nothing. Nonces come from a per-(account, key) high-water
   committed before signing: `max(now_ms, venue nextNonce at arm, high-water +
   1)`. Client order indexes are `nonce × 8 + leg` (0 entry, 1 stop, 2 take,
   3 close/standalone), so they never repeat across restarts or a wiped ledger.
   Only persisted bytes are re-sent, and never after `ExpiredAt`. A row is
   resolved by tx hash (`status` 0 → rejected, final; 1 → still submitted; 2–5
   (executed, packed, committed, verified) → executed, ingest fills — unless
   `event_info.ae` carries an app error, which is a final refusal); `/tx` HTTP 400 code 21500 is `not-found`, any
   other failure is `unknown`, never not-found. A `not-found` row becomes
   `expired` only after `ExpiredAt + 120 s` with a measured clock skew under
   5 s. No new nonce is signed for an intent while its row is ambiguous —
   except a reduce-only close or protective exit, which may always be signed
   anew (reduce-only cannot flip; once the new one executes the old one is
   dead), and no open on that market is signed until every close is final.
   On-chain legs (deposit, key registration, claim) ride the existing UserOp
   rail, which already works this way.

10. **The venue is authoritative for what happened; the ledger records it
    once.** Fills (partials, internal claim fills, self-trades as two rows,
    liquidation, deleverage and market-settlement fills), funding payments,
    fees and transfers are ingested by venue identity, each written in one
    transaction with its hash-chained journal entry (`perp-fill`, `funding`,
    `margin`), idempotent under re-reads. A forced fill no intent produced is
    booked with provenance `venue-forced`, alerted and fed to the breaker. At
    arm and every reconcile, venue orders and trades with no ledger row are
    adopted (`orphan-order` if signed with our key index, never fed to the
    breaker as liquidations). Every tick asserts that the change in venue money
    equals ingested fills, fees, funding and transfers; a mismatch is a book
    gap.

11. **Unknown is never zero.** An unreadable Lighter account, mark, funding or
    order state is a book gap: no equity row, no ratchet, no fee, and **no
    non-exit intent of any kind** (spot included) while the last known venue
    money is non-zero — exits are still attempted. For an agent with no perps
    marker and `addressToAccountIndex(self) == 0`, the perp term is a known 0
    and Lighter is never read. Perp markets live in their own map keyed
    `BTC-PERP` (never bare `TSLA`), never in `lastPrices`, `holdings`,
    `positions` or `cost_basis`. Parsers are fail-closed: documented 6-dp
    amounts must match `^-?\d+(\.\d{1,6})?$` and become exact integer
    micro-USDG; anything else is unread. Fields Lighter omits when zero are an
    explicit allowlist.

12. **Equity counts the venue; every peak ratchets only on what is real.**
    `composeEquityUsdg` gains `perpAccountUsdg = C + ΣM_iso + ΣU + T_in +
    T_out`, where C (cross collateral), M_iso (each isolated position's
    `allocated_margin`) and U (each position's `unrealized_pnl`) come from **one**
    `/api/v1/account` response identified by its `transaction_time`, and
    `total_asset_value` is only a cross-check. T_in/T_out are our deposits
    landed but not credited and our withdrawals executed but not yet paid,
    judged against a block-pinned cash read. The breaker sees full equity.
    Every **peak** — lifetime HWM and fee, risk period, paper peak, held-look
    lift — ratchets on `peakBasis = equity − Σ max(0, U_i)`, per position,
    never net. While any transfer is in transit, ratchets hold. Margin moving
    between the account and Lighter is never capital: the classifier's
    `venue-margin` arm reads the proxy's `Deposit`/`WithdrawPending` events in
    the same receipt, and payouts (which arrive in Lighter's relayer
    transactions) are recognised from `WithdrawPending(owner = self, 3)` logs
    between block-pinned reads, never from an in-memory registration.

13. **Kill and expiry stand the perps down, with the Lighter key only, and never
    remove a stop from an open position.** Order: close each position with a
    reduce-only IOC within `perpsMaxSlippageBps` of mark (up to three
    attempts); only once a market reads flat, cancel that market's remaining
    orders; then a secure withdrawal of free collateral; then one
    authenticated ingest so the stand-down's own fills and funding are booked.
    Self-hosted, every kill path writes `standdown-request.json` before
    archiving the grant; the worker runs it with the key it holds and writes
    `standdown-result.json`; the CLI waits up to 120 s and prints it. Hosted,
    the kill removes the grant (and session key) as today and, in the same
    store transaction, writes a sealed `perp_standdown` row (key, account,
    key index, 15-minute TTL); the orchestrator runs a **stand-down-only**
    child (no strategy, no session key, no UserOp rail) until the result is
    written or the TTL passes, mirrors its ledger, then wipes the home. Grant
    expiry runs the same stand-down; opens stop 24 h before expiry. Every
    kill/expiry message is built from the result by `custodySentence()` and
    never says "your funds stay in your smart account" while anything remains
    on Lighter; it names what is left, that its stops are still resting, and the
    recover path for the owner's platform.

14. **Paper first, at live prices, with the venue's own rules.** Paper perps
    walk Lighter's live order book, use the venue's decimals, minimums, margin
    fractions, fees and hourly funding, keep per-market isolated `{imf, mode}`
    state, liquidate at maintenance margin with the liquidation fee, draw
    collateral from the paper book's cash, and are checkpointed and restored
    with it. A live account never runs a paper perps book beside its live book:
    perps ride the account's rail (`perpsModeOf`), and a live account whose
    perps are not enabled for real says why — never "paper".

15. **The model proposes, deterministic code disposes.** Models name a market
    key, an effect (open/reduce/close), the side, a notional and a stop
    distance — never leverage, a market id, a price integer, a key or an
    address. `proposalsToPerpIntents` resolves, checks and refuses opens
    (never repairs them) and clamps exits. A short is never spelled "sell".
    Brain does not propose perps in v1; brain-live refuses any `-PERP` symbol.

16. **Anything the venue shows that we did not sign is an incident.** A nonce on
    our key we did not record, a different public key at our index, any other
    key index or sub-account under our L1 address, an order or non-forced fill
    matching no row of ours, or venue money the ledger cannot explain, sets a
    durable `perp-venue-incident` flag: every open is refused, the stand-down
    runs on every account under our L1 address (withdrawals repeated as margin
    frees), foreign fills are still booked (`venue-unknown`), and the owner is
    told the key may be compromised and exactly how to rotate it with the owner
    key. The flag clears only from the dashboard, after the key at our index is
    no longer the sealed one. Detection is after the fact.

17. **Perps are never published in v1.** Perp decisions file under their own
    sources (`perp-route`, `perp:strategist`), which are withheld in
    `thesis-policy.ts`; every `perp-*` reject rule is withheld; no perp
    decision, order, fill, position, leverage or liquidation reaches the feed,
    theses, the group chat, X, the leaderboard's trade lists or `publicBook`.
    Leaderboard equity includes perps per rule 12 and the profile shows a
    "uses leverage" marker. The venue publishes the account anyway, and the
    consent says so.

## How it is built

### Core (`packages/core`)

- `perps.ts`
  - `LIGHTER_ROUTE_V1` (frozen): chain 4663, proxy, API and WS base, L2 chain id
    466324, asset 3, route 0, tick size 1, `apiKeyIndex` 16 (outside Lighter's
    reserved `{0,1,2,3,157}`), topic hashes for `Deposit` and
    `WithdrawPending`. `GRANT_PERP_LIGHTER = "perp-lighter-v1"`;
    `grantPerp(grant)` requires the marker, chain 4663 and a canonical key.
  - `LIGHTER_MARKETS_V1` (frozen at ship time): `key` (`BTC-PERP`) ↔ market id
    ↔ venue symbol ↔ class (`crypto` | `equity` | `etf` | `metal` | `pre-ipo`
    | `meme`). Decimals, minimums and margin fractions are read live.
  - `validatePerpPubKey` (40 bytes, five little-endian Goldilocks limbs each
    `< p`, not all zero) and `pubKeyWords(pk) → [w4, w5]`, used by both the wall
    and the final fence.
  - Pure integer math: price/size encoding and rounding direction, notional,
    isolated margin, liquidation price, PnL, funding, stop trigger and price,
    `L_m`/`IMF_m`, effective minimum notional, `peakBasis`.
  - `PerpBlocker` (separate from `RefuseRule`, so a working spot agent is never
    shown as blocked) with `perpsBlockerText`; `custodySentence(exposure)`;
    the `agents.perps` report shape with a whitelist parser (null = unread);
    `PERP_TRADE_FEE_BPS = 0`.
- `abis.ts` — one-function constants `LIGHTER_DEPOSIT_ABI`,
  `LIGHTER_CHANGE_PUBKEY_ABI`, `LIGHTER_WITHDRAW_PENDING_ABI`; a never-granted
  read ABI (`addressToAccountIndex`, `getPendingBalance`, `assetConfigs`); the
  owner-only recover ABI (`withdraw`, `cancelAllOrders`, `createOrder`); event
  ABIs.
- `wall.ts` / `grant.ts` — `WallOptions.perpLighter?: { apiKeyIndex,
  apiPublicKey }` closed by default; the four permissions of rule 3; explicit
  forwarding in `buildWallPolicies`; `grantWallOptions` rebuild; `perpFits`;
  `StoredGrant.perp`; `publicGrantView` (allowlist).
- `capital-classify.ts` — the `venue-margin` arm, fed the same receipt's proxy
  logs; absent inputs keep today's behaviour byte for byte.
- `portfolio-snapshot.ts` — `perpAccountUsdg` in the identity Brain sees.
- `settings.ts` — the fields below; `explain.ts` — grounded concepts for
  leverage, liquidation price, funding, mark vs index, isolated margin,
  reduce-only, "at the venue".

### Worker (`worker/src/perps/`)

- `signer.ts` — the official lighter-go **v1.0.9 `lighter-signer.wasm`**
  (sha256 `781ba28b5e7fca1ea816f516f28fe2adbe704b734828e0c941025f8133bd7b4b`,
  reproducible from commit `8854554` with go1.25.6) and go1.25.6
  `wasm_exec.js` (sha256
  `0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14`),
  vendored under `worker/vendor/lighter/` and hash-checked before
  instantiation. Loaded lazily, only where live perps or a stand-down need it;
  paper never loads it. A known-answer test against live mainnet transactions
  must pass at load, or live perps stay unarmed. It owns every argument: typed
  wrappers only, each argument a safe integer within bounds (no floats, no
  wraparound, key index never 255, nonce never −1), chain id 466324, and it
  re-parses each returned `tx_info` and compares every field to what was asked.
  The WASM cannot reach the network in Node; it is never given the chance.
- `api.ts` — bounded, time-limited REST client: `readBoundedJson`, abort
  timeouts, `redirect: "error"`, 429/405 publish a fleet cooldown file, failed
  ≠ empty, a typed error taxonomy (retryable or not, per market). Every account
  read is authenticated so it counts per L1 address. It keeps a per-address
  request budget with at least 20/min reserved for exits.
- `feed.ts` — the one public market-data feed: a single WebSocket
  (`market_stats/all` plus `order_book/{id}` for the markets in use) with a
  paced REST fallback, writing `lighter-feed.json` atomically. Hosted, the
  orchestrator runs it and children only read the file; self-hosted it runs
  in-process. Data older than 30 s is unread for opens; paper fills need a book
  ≤ 10 s old.
- `markets.ts` — fail-closed parsers for market details, depth, funding and
  mark candles; the `PerpMarketView`.
- `keystore.ts` — loads the private key for the sealed public key (self-hosted
  `perp-keys/`, hosted `perp-key.json`), never from settings or env.
- `policy` — the perp branch of `checkPolicy` (run on proposed and reviewed
  terms), with rule slugs `perp-not-enabled`, `perp-live-not-enabled`,
  `perp-not-granted`, `perp-market-not-allowed`, `perp-market-inactive`,
  `perp-per-trade-cap`, `perp-open-notional-cap`, `perp-collateral-cap`,
  `perp-max-opens`, `perp-below-min`, `perp-stop-required`,
  `perp-stop-inside-liquidation`, `perp-leverage-unset`,
  `perp-leverage-mismatch`, `perp-add-to-position`, `perp-close-in-flight`,
  `perp-side-mismatch`, `perp-grant-expiring`, `perp-unpriced`,
  `perp-venue-incident`, `perp-entries-halted` — all withheld from
  publication, all with owner-facing labels and remedies.
- `executor.ts` — `PerpExecutor { review, place, resolve, account }`, a sibling
  of `OrderExecutor` and never a widening of the EVM executor, with a live
  Lighter implementation and a pure paper one.
- `paper.ts` — the engine of rule 14.
- `reconcile.ts` — resolve submitted rows, ingest fills/funding/transfers by
  venue identity, adopt orphans, rebuild the day's opening notional from the
  venue after a wipe, the venue-delta identity check, and incident detection
  (rule 16).
- `payouts.ts` — block-pinned payout recognition for flow inference (rule 12).
- `onboard.ts` — the on-chain legs through the UserOp rail, each with its own
  final-fence lane: deposit, read the account index, register the sealed key
  (only if the slot is empty, holds a key this agent registered, or holds an
  owner-rotated key that is not retired — anything else is an incident), and
  claim payouts; plus lazy per-market `UpdateLeverage` while flat.
- `protect.ts` — the protective lane on its own ≤15 s clock, never called from
  `tick()`, never behind the EVM intent chain; priority P1 liquidation
  proximity, P2 stop breached (two reads 15 s apart), P3 stop missing, wrong or
  expiring, P4 funding bleed, P5 market status, P6 authority changes, P7 venue
  unread (alerts, never closes on unread state). At most one reduce-only close
  per market per pass; sends share one lock and nonce allocator with the lane.
- `standdown.ts` — rule 13, used by kill, expiry, incidents and `/flatten`.
- `route.ts` — the perps route (below).

### Intents

- `perp-order` — `{ venue: "lighter", market: "BTC-PERP", marketId, effect,
  side (the held side for reduce/close), reduceOnly, baseAmount, worstPrice,
  notionalUsdg, imfBp, stopTrigger?, stopPrice?, takeTrigger?, takePrice? }`.
  **No `target`.** Leverage is shown as `floor(1_000_000 / imfBp) / 100`.
- `perp-margin` — `{ direction: "deposit" | "withdraw" | "claim", amountUsdg }`;
  deposit and claim are EVM legs through the wall (trade kinds `perp-deposit`,
  `perp-claim`, and `perp-key` for key registration — never `transfer`), a
  withdraw is an L2 request.

### Ledger (`worker/src/store.ts`)

**The trades boundary.** L2 activity never writes a `trades` row, never passes
through `recordTrade` and never bumps `ledgerWrites`. Only the on-chain legs
(`perp-deposit`, `perp-key`, `perp-claim`) are `trades` rows, settled by the
UserOp rail. Every consumer of `trades` (tape, feed, decision outcomes, realized
P&L, scoreboard, notifier) unions the perp tables explicitly and labels them by
market key.

All perp money is TEXT integer micro-USDG (aggregated in application BigInt or
`CAST(x AS BIGINT)`, never `AS INTEGER`); every row carries `mode` and `epoch`;
`agent_id` is lowercased on write.

- `perp_orders` — one row per signed venue tx: `tx_hash`, `tx_type`, `tx_info`,
  `account_index`, `api_key_index`, `nonce` (UNIQUE per agent+account+key),
  `expired_at`, `status` (`submitted|executed|filled|partial|cancelled|rejected|expired`),
  `effect`, `reduce_only`, `market_id`, `worst_notional_micro`,
  `filled_base`, `filled_quote_micro`, `decision_id`, `created_at`.
- `perp_order_legs` — `(order row, role entry|sl|tp|close, client_order_index
  UNIQUE per agent+mode, venue order index, status)`.
- `perp_fills` — PK `(agent, mode, venue trade id, side_role)`; market, side,
  size, price, fee, realized PnL, `trade_type`, attribution.
- `perp_funding` — PK `(agent, mode, market, funding id)` plus UNIQUE on the
  funding hour.
- `perp_transfers` — deposits and withdrawals with their chain or venue
  identity, state (`submitted → landed → credited`, `submitted → executed →
  paid`, `failed`, `refunded`), initiator (`agent|owner|standdown`).
- `perp_positions` — the venue-authoritative cache (live) and the book (paper),
  with per-market `imf_bp` and margin mode.
- `perp_accounts` — account index, registered and retired public keys, nonce
  high-water, paper cross collateral, incident flag, last venue read.
- Journal kinds `perp-fill`, `funding`, `margin`, `perp-carry` (an open position
  carried across an epoch boundary at mark). Equity rows and the mark payload
  gain `perp_collateral`, `perp_isolated_margin`, `perp_unrealized`,
  `perp_unrealized_gain`, `perp_in_transit`, `perp_snapshot_time`,
  `cash_read_block`.
- **Budgets.** `refreshBudget` adds, per rail and over the trailing 24 h, the
  opening notional from `perp_orders` (`submitted` counts
  `worst_notional_micro`, anything else counts `filled_quote_micro`) and
  counts perp orders and withdraw requests as ops (an allowlist of statuses).
  `perp-deposit` counts as spend like `vault-deposit`; `perp-claim` does not.
  Reservations follow `recordTrade`'s order; after a hosted wipe the day's
  opens are rebuilt from the venue before any open.
- **Hosted.** A child's ledger is disposable. Every `perp_*` table is mirrored
  (append-only tables `ON CONFLICT DO NOTHING`; updated tables as rank-guarded
  upserts). Live positions and orders are re-read from the venue at arm, never
  seeded from shared storage; pending transfers are seeded and checked against
  `getPendingBalance`. Paper perp state rides `paper_checkpoints.perp_json`.
- **Verify.** Export format `merrymen-journal-v2` with the venue identity
  (venue, L2 chain id, proxy, account index). `reconstruct` knows every kind
  and refuses an unknown one (never skips it); perp fills and funding are
  a separate **venue-attested** evidence class — never chain-verified, never
  failed; margin transfers are checked against Robinhood Chain receipts; the
  equity identity includes the perp terms.

### The perps route

Perps are a **route beside the owner's spot strategy**, not a strategy that
replaces it. `perpsDriver` chooses the one autonomous producer:

- `perp-trend` (default) — a deterministic producer with frozen
  `PERP_TREND_DEFAULTS` and a "what this is not" header (it is not alpha; its
  backtest numbers are printed honestly). Universe: `perpsMarkets ∩ {BTC, ETH,
  SOL}`. Signal: closed 4 h mark-price candles (≥ 100 contiguous, the one in
  progress ignored), EMA24 and Wilder ATR14. Enter long when close > the 12-bar
  high and > EMA24 (short: mirror), with no position or unresolved order in the
  market, cooldowns clear (8 h after a strategy exit, 24 h after a stop, risk
  exit or forced fill), at most 2 positions, the breaker idle, energy and ops
  headroom left, the grant good for another 168 h, and 8 h mean funding against
  the side ≤ 0.005%/h. Stop = max(1.5%, 3 × ATR / close); if that exceeds
  `perpsStopLossPct` it idles `perp-too-volatile` rather than widening. Size =
  min(caps, headroom, 0.95 × L × usable collateral, 1% of equity / stop). No
  take-profit. Exit (any): close through the 6-bar low/high or EMA24, or held
  168 h. One open per tick.
- `strategist` — the LLM strategist's `perpActions` (schema and prompt present
  only while perps are enabled and read; otherwise byte-identical to today),
  through `proposalsToPerpIntents`.
- `manual` — owner orders only.

Each tick, after the strategy loop and the class route: perp exits first, then
at most one entry. Each goes through `countsAsEntry` → energy claim →
`ensureDecision(intent, "perp-route", …)` → `processIntentReporting` → refund
if nothing was placed. Margin deposits are produced only to fund a pending
open (margin + 10%, within caps), never to rescue a loser; free collateral goes
home after 24 h flat and on perps-off, kill and expiry.

### Surfaces

- **Settings** — a "Perpetuals" section with the consent and attestation of
  rule 1, the fields below, each market's reachability under the signed cap,
  and the grant status; dashboard-only (`DASHBOARD_ONLY.perps`).
- **Desk** — a perps panel (market, side, size, entry, mark, leverage, margin,
  liquidation price and distance, funding, stop, unread state), an "At Lighter"
  equity row, a per-row Close and a Close-all button. `/api/feed` carries a
  separate `perps` array; `agents.perps` is the worker's status report the web
  only reads.
- **Telegram** — `/perps` (read), `/close <MKT-PERP>` (a typed command runs
  like `/sell`; from free text it waits for `/confirm`), `/flatten` (always
  `/confirm`; also halts entries until cleared on the dashboard). There is no
  `/long` or `/short`. Notifier: fills, venue-stop and forced fills,
  liquidation-proximity alerts (once per episode), venue-unread alerts at 2 and
  10 min, incidents, and a funding line in the daily report. `/positions` and
  `/pnl` include perps, or say Lighter could not be read.
- **Web chat cards** — `close-perp` and `flatten-perps`, routed by a fixed
  `purpose` marker through the owner-order queue.
- **MCP** — read-only `get_perp_positions` (portfolio.read); no perp tool moves
  funds or opens.
- **CLI** — `status` and `doctor` show perps (signer hash, venue reachability,
  key registration, account index, exposure); `kill` writes the stand-down
  request and waits; `recover` has a venue leg.
- **Recover** — every platform shows a read-only venue disclosure (fetch and
  `eth_call` only, each field unreadable-not-zero). The owner-key unwind is L1
  priority requests in one sudo UserOp: `cancelAllOrders`, `changePubKey` to a
  fresh throwaway key (revoking the agent's), `withdraw` of free collateral;
  then `withdrawPendingBalance` after the delay. Closing positions on-chain
  (`createOrder`) is enabled only once the mainnet checklist proves its
  semantics on this instance.
- **Mobile** — both apps show a banner that cannot be dismissed whenever
  `agents.perps` is not `none` ("Leveraged positions on Lighter…" or "Lighter
  could not be read…"), never "No positions" in that state, and a Close-all
  button; kill copy uses `custodySentence`. Perps go live hosted only after both
  apps ship this.
- **Docs** — README (what you can do, ownership and enforcement, never a
  position you can't exit, Telegram commands), the privacy policy's
  third-party row for Lighter (and that positions are public), this contract,
  the mainnet checklist and the hosted runbook.

## Settings

| key | default | bounds | notes |
|---|---|---|---|
| `perpsEnabled` | false | — | paper perps; dashboard-only; no env term |
| `perpsLiveEnabled` | false | — | real perps; stored with `perpsLiveConsentVersion`, `perpsLiveConsentAt`, `perpsRegionAttested` |
| `perpsDriver` | `perp-trend` | `perp-trend` \| `strategist` \| `manual` | the one autonomous producer |
| `perpsMarkets` | `["BTC-PERP","ETH-PERP"]` | 1–8 keys of `LIGHTER_MARKETS_V1` | unknown key refused, never ignored |
| `perpsMaxLeverage` | 2 | integer 1–10 | also ≤ venue max |
| `perpsPerTradeUsdg` | 25 | 10–100000 | effective `min(sealed per-trade, this)` |
| `perpsMaxOpenNotionalUsdg` | 50 | 10–100000 | ≥ `perpsPerTradeUsdg` |
| `perpsMaxCollateralUsdg` | 30 | 5–100000 | "the most you can lose on Lighter", in software |
| `perpsMaxOpensPerDay` | 4 | 1–50 | |
| `perpsStopLossPct` | 5 | 1–25 | price move; the UI also shows it as % of margin |
| `perpsStopSlipBps` | 200 | 50–450 | stop worst price vs trigger; inside the venue's 5% band |
| `perpsTakeProfitPct` | 0 (off) | 0–500 | owner and strategist opens only |
| `perpsLiqBufferPct` | 2 | 1–50 | stop must beat liquidation by this |
| `perpsMaxSlippageBps` | 50 | 5–300 | IOC worst price vs mark; stand-down uses max(this, 150) |

Every key is in the worker's clamps, the web `PUT` allowlist with identical
bounds (`perpsMarkets` and `perpsDriver` with their own branches), a rebuild
fingerprint, and `spec-coverage.test.ts`.

## Rollout

- **Phase 0 — mainnet checklist** (`docs/perps-mainnet-checklist.md`), on an
  operator account with dust: WASM memory and latency in a hosted child;
  deposit → account index → on-chain key registration → time to usable; a
  minimum BTC open as OTO and OTOCO; stop placement, sizing, expiry bounds and
  the fat-finger band; a standalone position-tied stop; secure withdrawal and
  claim latencies; the 21126 ordering; whether IP or L1 limits apply to
  `sendTx` from the hosted egress; a kill drill and a recover drill; on-chain
  `createOrder` semantics.
- **Phase 1** — the canonical-wall allowlist and the fleet feed ship; paper perps
  behind `MERRYMEN_PERPS=paper`; signers do not offer the opt-in.
- **Phase 2** — signers offer the opt-in; live only for tenants named in
  `MERRYMEN_PERPS_LIVE_TENANTS` (self-hosted: the owner), after the mobile
  banners ship.
- **Phase 3** — general availability, after a written decision on operating
  Lighter orders from the hosted egress for tenants.

## Decisions that need Milla

- Holding a venue key on the hosted server that the wall does not bound, and
  the privacy policy's custody wording that follows from it.
- Operating Lighter orders on tenants' behalf from the hosted egress, given
  Lighter's regional exclusions.
- Whether Privy-owned accounts may enable live perps before a browser/phone
  owner-key recover path for the venue exists.
- Any future turnover fee on perps (v1 charges none; the performance fee applies
  through rule 12).

## Honest limits

- The session-key wall bounds how much USDG can go into Lighter per call; it
  cannot bound what an API key does once it is there (rule 4). A cumulative
  on-chain deposit cap would need a rate-limit policy, which has no code on
  4663.
- Venue fills, funding and positions are attested by Lighter's API, not
  re-derivable from Robinhood Chain receipts; `verify` says so rather than
  passing them.
- Withdrawals take the venue's current `withdrawalDelay` plus a claim; money at
  the venue is not instantly available to spot strategies or to a kill.
- A venue stop can be gapped through, and expires after at most 28 days; a
  worker down longer than that leaves a position without one.
- Lighter's contracts are upgradeable with no effective notice.
- Hosted children share an OS user, so a code-execution bug in any child could
  read another tenant's venue key; per-child isolation is a prerequisite for
  hosted general availability.
- Unknown-activity detection is after the fact: what a stolen API key does
  between its first transaction and the next reconcile is not bounded, and a
  compromised worker will not report itself.
- There is no testnet venue; the first live deposit, key registration and
  withdrawal happen on mainnet with a small amount.
