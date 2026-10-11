# The multi-quote class route

**Status: design, 2026-09-16. Nothing here is built. The owner's ruling that produced it: research every Pons quote asset in shadow now; execute none of the new ones until a deterministic route has taken one non-USDG quote through BUY→SELL on a canary; no PonsSelfTrade, no arbitrary intermediate token, no Brain-generated calldata.**

**RECONCILIATION WITH MAIN, SAME DAY (commits `5b7205b` "vault: bound what an unpinnable curve can take" and `0a11614` "adapter: bound the same drain in PonsSelfTrade", on `main` at `46c852d`, written after this design was drafted).** The vault contract now carries a rolling spend ceiling: `spendCapPerWindow` (default `DEFAULT_SPEND_CAP = 250_000_000`, i.e. 250 USDG at 6dp), `SPEND_WINDOW = 1 days`, `_chargeSpend(quoteIn)` charged before the pull on every `buy`, `setSpendCap` owner-only, sells never capped, `error SpendCapExceeded(uint256 wanted, uint256 remaining)`. Two consequences for this design, both hard:

1. **The repetition residual in §5.2 is now bounded on chain for the USDG route** — `K × calls × ops-until-expiry` becomes `min(that, spendCapPerWindow per day)`. That is strictly better than this document assumed, and the threat-model row for the hostile curve should cite it.
2. **The cap is charged in the quote asset's RAW units, whatever the quote is.** A 5 USD entry into an NVDA-quoted curve hands `vault.buy` a `quoteIn` of roughly `2.3 × 10^16` raw NVDA, which exceeds a `250_000_000` cap by eight orders of magnitude: **as deployed by that commit, every non-USDG `buy` reverts `SpendCapExceeded` before the wall is even consulted.** So the multi-quote route now requires a CONTRACT change in addition to the wall change in §5 — a cap keyed by quote asset (`setSpendCap(asset, capRaw)`, charged per asset in its own raw units, with the USDG default preserved) or an equivalent — and a vault is CREATE2 per account and owner-immutable, so a revised vault means a new factory, new vault addresses, a re-sign for every agent that wants the route, and a migration of any open class position out of the old vault by the owner's `recover`. The build order in §15 gains a step 0: the vault revision, its factory, and the same 99-line commit's tests extended to a stock-quoted `buy` at 5 USD-equivalent. `SpendCapExceeded` also needs a classification in `worker/src/revert.ts` — `revert.test.ts` "EVERY error declared in PonsSelfTrade.sol is classified" fails on `main` at `46c852d` for exactly this reason, which is why PR #111's `app` job is red at the same test.

Nothing else in this document changes; the wall's word2 cap is still the per-call bound and the contract's window is the per-day bound, and both are needed.

This document is the spine of the "sealed-quote, proven backwards from one round trip" design with the grafts the two full judgements asked for. Where the judges disagreed, §9 and §7 say which was followed and why. Every claim about what the code does today carries a `file:line`; every claim about what it will do is a rule, and the reason comes before the rule.

---

## 1. What this is, and what stays impossible

**NATIVE ETH STAYS UNREACHABLE, BY CONSTRUCTION, AND THIS DESIGN DOES NOT DESIGN AROUND IT.** 53.6% of launches are native-quoted and none of them is reachable through the vault: the contract has no `receive()` (`contracts/contracts/PonsClassVault.sol:87-90` says so in its header and the body has none), `buy`/`sell`/`deploy` are `nonpayable` (`packages/core/src/abis.ts:211`, `:224`, `:259`), every class permission carries `valueLimit: 0n` (`packages/core/src/wall.ts:776`, `:801`, `:828`), `_checkCurve` reverts `NativeQuoteNotSupported` on a zero `pairToken` (`PonsClassVault.sol:250`), the builder refuses the zero address before encoding (`worker/src/venues/pons-class.ts:96-102`), and a native curve demands `msg.value == quoteIn` exactly (`contracts/contracts/interfaces/IPonsCurve.sol:53-56`), which no permission in the wall can send. A ONE_OF list can never hold the zero address either. **No WETH wrapper is introduced.** WETH is in neither `adapterAssets` (`wall.ts:448-454`) nor `TRADEABLE_SYMBOLS` (`packages/core/src/tokens.ts:208-211`), so it has no approve permission, no `exactInputSingle` leg, and `WETH.deposit` is not a pinned target. It cannot be sealed as a quote, and `classifyQuote` keeps it `executable: false` with its reason (`worker/src/venues/quote-assets.ts:87-95`).

**WHAT THIS IS.** One additional route shape for the class vault: a class entry funded by a *sealed* stock token that the account first buys from USDG in the same Kernel batch, and a class exit whose stock proceeds are sold back to USDG in the same batch. Amounts are fixed at build time; the vault leg is sized to the hop's *floor* so no call ever needs a prior call's return. The wall gains exactly two rule changes on the one existing `vault.buy` permission. Everything else is worker-side and stated as such.

**WHAT ELSE STAYS IMPOSSIBLE.**

- Multi-hop `exactInput`: not granted and not constrainable at CallPolicy V0_0_4 (`wall.ts:629-646`); `GRANT_MULTIHOP` is no longer minted (`web/src/lib/session.ts:593-599`). The only hop is USDG↔Q through `exactInputSingle` with both legs ONE_OF `adapterAssets` and recipient EQUAL self (`wall.ts:620-623`).
- PonsSelfTrade: the adapter arm is the branch a class trade can never take (`worker/src/index.ts:7118-7121`); its `curveAssets` exclude stocks (`wall.ts:488-491`).
- Brain calldata, amounts, addresses, fee tiers, floors, deadlines or a quote choice: the decision object carries a `candidateId` or a hold and nothing else (§11).
- A non-USDG live selection before the quote's BUY→SELL canary is committed to code (§11, §12).
- Any payout to an address other than the account: router recipient EQUAL self (`wall.ts:623`); the vault pays only `owner` (`PonsClassVault.sol:214`, `:235`).
- Session-key sweep of the vault (`wall.ts:768-771`) and selling a graduated curve through the vault (`PonsClassVault.sol:252`): the owner's `merrymen recover` stays the only path (`worker/src/recover.ts:914-926`).
- Threading a prior call's return inside a batch (`index.ts:7085-7087`; `worker/src/class-recovery.ts:259-260`): every hop consumes its floor; residue exists by design and is *tracked and swept*, never threaded.
- Widening any grant without a re-sign: a grant without the new marker keeps today's byte-identical wall and the worker never builds a hop for it (`wall.ts:34-35`).

---

## 2. The invariant today, in one word

**THE VAULT IS QUOTE-AGNOSTIC ON CHAIN.** `_checkCurve` accepts any ERC-20 equal to the curve's `pairToken` (`PonsClassVault.sol:249-254`); `buy` pulls exactly `quoteIn` of the caller-named `quoteAsset` from the owner (`:171`), approves the curve for it (`:172`), calls the curve (`:173`), zeroes the approve (`:174`), pushes any residue back to the owner in the same call (`:179-180`) and measures `tokensOut` as its own balance delta (`:182-184`). `sell` takes no quote argument, derives it from the curve (`:205`) and pays the owner directly (`:214`, `:217`). The events carry amounts but never the quote address (`:128-130`). No decimals are assumed anywhere in the contract.

**THE USDG-ONLY INVARIANT LIVES IN ONE SIGNED WORD** — `wall.ts:793`, `{ condition: ParamCondition.ONE_OF, value: [CASH.USDG] }` on word1 of `vault.buy`, with word2 `quoteIn` left `null` "bounded by the capped USDG approve" (`:794`). The comment at `wall.ts:759` ("ONE_OF the same `adapterAssets`") is stale; the code wins. `wall.test.ts:806-821` pins only that word1 is ONE_OF, not its value (`:813-817`).

That word has two shadows, and non-negotiable (2) asks exactly which of the three change:

| Layer | Where | Change kind |
|---|---|---|
| Chain word | `wall.ts:793` word1 ONE_OF `[USDG]`; `:794` word2 `null` | **code + re-sign**, opt-in per grant (§5). Grants signed without the option are byte-identical to today. |
| Worker filters | `worker/src/venues/class-legs.ts:86-92` ("not quoted in USDG, so entering it would need a second hop", pinned by `class-legs.test.ts:63-74`); `index.ts:1133` (`usdg: CASH.USDG`); chat buy `index.ts:10281-10287`; scout classifier `worker/src/class-side.ts:56-60` (equality with `cash`); Brain seam `worker/src/brain-trending.ts:544-548` (`kind !== "usdg"` refuses an intent); `quote-assets.ts:104` (`executable: false` for every stock) | **code only** |
| Accounting unit | `worker/src/venues/class-log.ts:56` ("buy: USDG in. sell: USDG out"), `:166` (`costRaw` "Actual USDG spent"), `:184`; `worker/src/store.ts:792-795` (`cost_usdg`/`proceeds_usdg` "Raw units: USDG at 6dp"); `index.ts:7168-7174` (`cashUsdg: ev.quoteRaw`, `priceUsd` with hardcoded `1e6`/`1e18`); `class-legs.ts:112-114` (`{ quote: 6 }`) | **code only**: the columns keep their unit; the source of the number changes (§9) |

A fourth shadow is the mirror being *looser* than the chain for this one word: `policy.ts:359-401` lets a class trade leave exactly one leg un-enumerated and does not require the funding leg to be USDG, so a stock-funded class buy already passes `checkPolicy` and fails only at the wall. §10 closes that with a named rule before any widening.

---

## 3. The route

### 3.1 Why the vault leg is sized to the hop's floor

A Kernel batch has no branching and no call can read a prior call's return (`index.ts:7085-7087`; `class-recovery.ts:259-260`). The SDK encodes a batch as a plain `tuple[]` of `(target, value, callData)` (`node_modules/@zerodev/sdk/_esm/accounts/kernel/utils/ep0_7/encodeExecuteBatchCall.js:5-31`). So the amount `vault.buy` pulls must be a number known before hop 1 runs. Size it to the quoted output and a fill one wei under quote makes `transferFrom` fail, `_pull` reverts `TransferFailed` (`PonsClassVault.sol:259-261`), and the op burns gas for nothing. Size it to the hop's **floor** and, if hop 1 landed at all, the account holds at least that much: the vault leg is coverable by construction. The difference between the actual fill and the floor — at most `slippageBps` of the spend, cents at 5 USDG — stays in the account as Q and is tracked (§8, §9), never orphaned.

### 3.2 ENTRY — one UserOp, four calls (five when the vault has no code)

Inputs fixed from one tick's reads, in this order:

- `U` = `usdgIn` (6dp) = `classSpendFor(...)` (`worker/src/venues/class-entry.ts:162-167`; `index.ts:1177-1184`) — 5.000000 USDG for the canary — then reduced if needed so that `F1 ≤ K` (§5).
- `tier`, `qQuoted` = `bestQuote(USDG→Q, U)` across `FEE_TIERS`, direct tiers only (`worker/src/venues/uniswap.ts:163-169`, `quoteTier` `:110-131`); `via` is never passed.
- `F1` = `qQuoted × (10_000 − slippageBps) / 10_000` (the arithmetic at `uniswap.ts:106`).
- `R` = `readCurveReserves(curve, {quote: quoteDecimalsOf(Q), token: leg.decimals})` (`worker/src/venues/pons.ts:280-294`, decimals read at `:241-256`, never the `6` hardcoded at `class-legs.ts:112-114`), no older than `CURVE_GUARD_DEFAULTS.maxReadAgeSec` = 30s (`worker/src/venues/pons-price.ts:474`).
- `tokensQuoted` = `curveBuyOut(R, F1)` (`pons-price.ts:238-249`, fee on input at `:243`); `M1` = `curveMinOut(tokensQuoted, slippageBps)`; refused when ≤ 0 (`pons-class.ts:95`).
- `deadline` = now + `CURVE_DEADLINE_SEC` = 60 (`index.ts:231`).

The batch:

| # | Call | Permission |
|---|---|---|
| 0 | `factory.deploy(self)` — only when a FRESH `getCode(vault)` is `undefined`/`"0x"` (`index.ts:7040-7056`; prepend rule `:7093-7094`; builder `pons-class.ts:169-182`) | `wall.ts:827-832` |
| 1 | `USDG.approve(SwapRouter02, U)` | `wall.ts:500-509` (router is a spender, `:138`; amount LESS_THAN_OR_EQUAL `usdgUnits(perTradeUsdg)`, `:508` — **chain-enforced**) |
| 2 | `SwapRouter02.exactInputSingle({tokenIn: USDG, tokenOut: Q, fee: tier, recipient: self, amountIn: U, amountOutMinimum: F1, sqrtPriceLimitX96: 0})` (encoder `uniswap.ts:426-445`; no deadline word on SwapRouter02, `abis.ts:3-4`) | `wall.ts:615-627` |
| 3 | `Q.approve(vault, F1)` — EXACTLY `F1`, for `pons-class.ts:77-83`'s reason | `wall.ts:511-523` (vault is a spender, `:171-177`; no amount condition, `:512-513`) |
| 4 | `vault.buy(curve, Q, F1, M1, deadline)` via `buildClassBuyCalls` with `quoteAsset = Q` (`pons-class.ts:85-129`, already parameterised) | `wall.ts:772-798` as changed in §5 |

Built by a NEW `buildClassHopBuyCalls(t)` beside `buildClassBuyCalls`; the USDG-direct route keeps `buildClassBuyCalls` unchanged. `EXEC_TYPE` is the SDK default: `executor.ts:480` calls `account.encodeCalls(calls)` with no execType, and the ep0.7 encoder defaults `execType = EXEC_TYPE.DEFAULT` (`node_modules/@zerodev/sdk/_esm/accounts/kernel/utils/account/ep0_7/encodeCallData.js:5`), `0x00` (`_esm/constants.js:91-94`), with `CALL_TYPE.BATCH` `0x01` (`:86-89`).

### 3.3 EXIT — one UserOp, three calls

- `T` = the vault's whole class-token balance, all-or-nothing (`index.ts:1961-1963`, balance from `lastClassBalances` at `:2002`).
- `F2` = `curveMinOut(curveSellOut(R_now, T), slippageBps)` (`pons-price.ts:258-266`).
- `U2` = `quoteTier(Q→USDG, F2).amountOut × (1 − slippageBps)`.

| # | Call | Permission |
|---|---|---|
| 1 | `vault.sell(curve, T, F2, deadline)` via `buildClassSellCalls` (`pons-class.ts:143-157`); the vault derives Q from the curve (`PonsClassVault.sol:205`) and the curve pays the ACCOUNT in Q (`:214`) | `wall.ts:799-810`, unchanged |
| 2 | `Q.approve(SwapRouter02, F2)` | `wall.ts:511-523` |
| 3 | `SwapRouter02.exactInputSingle({tokenIn: Q, tokenOut: USDG, fee: tier2, recipient: self, amountIn: F2, amountOutMinimum: U2, ...})` | `wall.ts:615-627` |

**HOP 2 SELLS EXACTLY `F2`, NEVER `F2` PLUS THE ACCOUNT'S Q BALANCE.** This is the mandatory graft both judges named. Selling the whole balance would liquidate any Q the owner holds outside the route and fold its USDG into `proceeds_usdg` — an unmandated sale and a corrupted realised P&L. `F2` is the only amount the batch can guarantee is present after call 1 (the vault reverts `InsufficientOutput` below it, `PonsClassVault.sol:219`). The exit residue `ClassSell.quoteOut − F2` stays in the account and is tracked (§8, §9).

**FALLBACK, op-A-only.** When the sell rehearses but hop 2 will not (pool drained, Q→USDG unquotable): send call 1 alone — today's `buildClassSellCalls` — so the position still closes and the proceeds sit in the account as an ordinary priced stock holding under the existing wall. An exit must always be attemptable (`policy.ts:681-697`). The whole `quoteOut` is then tracked residue and the sweeper (§3.5) owns it. A paused Q blocks BOTH the curve's payout and hop 2, so there is no fallback for a pause: the position waits, bounded by `classMaxHoldSec`, and the class token stays sweepable by the owner (`recover.ts:914-926`).

### 3.4 Atomicity — the probe and the fallback

The safety argument for one-op entry is all-or-nothing execution: hop 1 bounded by the capped USDG approve, no stranded intermediate. The repo only knows the batch has no branching (`index.ts:7085-7087`) and that Kernel checks `success` without decoding on a codeless CALL (`packages/core/src/protocols.ts:106-109`). Verified in this repo's SDK on 2026-09-16: `@zerodev/sdk` 5.5.10 encodes a multi-call batch as `CALL_TYPE.BATCH` (`0x01`) with `EXEC_TYPE.DEFAULT` (`0x00`) because `executor.ts:480` passes no execType. ERC-7579 defines execType `0x00` as revert-on-failure, but Kernel v3.3's behaviour on this chain is **UNVERIFIED** and carried as probe P1 (§14), in two steps: a gas-free `eth_simulateV1` from the EntryPoint, then one paid two-call op under today's wall.

**FALLBACK: REFUSE THE ROUTE OUTRIGHT.** If P1 shows a partial batch can land, every non-USDG entry is refused with rule `route-not-atomic` and nothing is built. No two-op variant ships for the canary. Both judges preferred this to a state machine built under time pressure; the `class_routes` states (`hop1-landed`, `sold-unswapped`, `unwound`) are reserved in the schema (§9) so a two-op variant can be designed *later*, behind an explicit owner flag, once P1 has an answer either way.

### 3.5 RESIDUE SWEEP — its own op, sized to the tracked figure

Each tick, for each sealed quote Q with `trackedResidue(Q) > 0` (§9): `r = min(trackedResidue(Q), balanceOf(account, Q))`; when `usd6(r) ≥ CLASS_RESIDUE_DUST_USD6` (0.50 USD, a constant beside `CLASS_MAX_ROUND_TRIP_BPS`, not a setting: below it the hop's gas exceeds the residue), emit a `class-route` intent with `side: "residue"` and calls `[Q.approve(router, r), exactInputSingle(Q→USDG, r, floor)]`, judged as an exempt exit (§10). **Never the whole balance**: the tracked figure is what the route left behind; anything else in the account is the owner's.

### 3.6 The route fence

Today the class arm sends directly (`index.ts:7093-7111`); `checkV3SwapCalls` is called only in the swap arm (`index.ts:6587`) and demands exactly two calls (`worker/src/final-fence.ts:97-99`). A NEW `checkClassRouteCalls(calls, expect)` in `final-fence.ts` decodes every call and demands **EQUALITY** with the judged intent (`final-fence.ts:27-29`'s rule, `:127-131` for the allowance, `:157-164` for the floor): approve spenders and amounts (`router:U`, `vault:F1`; `router:F2`), `tokenIn`/`tokenOut`/`recipient`/`amountIn`/`amountOutMinimum` on each swap, `curve`/`quoteAsset`/`quoteIn`/`minTokensOut`/`deadline` on the buy, `curve`/`tokensIn`/`minQuoteOut`/`deadline` on the sell, `owner_ == self` on a deploy, `value == 0` everywhere. It accepts exactly the 4-call and 5-call entry shapes (5 only when the fresh `getCode` said no code), the 3-call and 1-call exit shapes, and the 2-call residue shape. The **one-leg rule** is structural: a non-USDG `vault.buy` must be preceded in the SAME list by a USDG→Q swap whose `amountOutMinimum` equals the buy's `quoteIn`. Unrecognised shape is a refusal, never a pass (`final-fence.ts:31-37`).

---

## 4. The quote allowlist

### 4.1 Which assets can ever qualify

A class quote must already satisfy every existing permission a hop needs: it must be in `adapterAssets` (`wall.ts:448-454`) so `exactInputSingle` may name it on either leg (`:620-621`), and it must have a per-token approve (`:515-523`). That set is exactly `STOCK_TOKENS` filtered to `TRADEABLE_SYMBOLS` (`tokens.ts:157-183`, `:208-211`): 14 names, all with a Chainlink feed (BE has none and is not tradeable). `CLASS_QUOTE_CANDIDATES` in a new `packages/core/src/class-quotes.ts` is that intersection and nothing else. Owner extras are excluded (no feed, no both-direction proof). Anything else classifies `unknown` (`quote-assets.ts:108-115`) and stays research-only.

### 4.2 Sign-time qualification, and who decides

**THE OWNER DECIDES, AT SIGNING, FROM A LIST THE SIGNER HAS ALREADY NARROWED.** A NEW pure `resolveClassQuotes(publicClient, caps, requested)` beside `resolveClassVault` (`packages/core/src/classvault.ts:86`; used at `session.ts:458-466`) refuses to seal a quote unless, at that moment: (a) it is in `CLASS_QUOTE_CANDIDATES`; (b) `latestRoundData` answers with `answer > 0` and `updatedAt` within `FEED_STALE_AFTER_SEC` (`quote-assets.ts:68`) — so the owner signs during US market hours, and a weekend signing cannot size a cap on a dead price; (c) `uiMultiplier()` reads and is > 0 (`tokens.ts:240`); (d) `tokenPaused()` reads `false` (`tokens.ts:247`); (e) `decimals()` is 18; (f) QuoterV2 quotes USDG→Q at 5 USDG and Q→USDG at the resulting output (the both-directions rule of `tokens.ts:186-189`); (g) Q is not in the owner's `basketSymbols`. By default the signer offers only quotes present in `CLASS_QUOTE_PROVEN[chainId]` (§4.4); the canary needs a quote before any proof exists, so the signer takes an explicit, logged `--canary-quote NVDA` override. **Phase 1 seals exactly one quote.**

### 4.3 Where it is sealed — three places that must agree, none of them settings

1. **The wall itself** — `wall.ts:793` word1 value list and `:794` word2 cap (§5). The only copy the chain reads.
2. **The grant** — new `StoredGrant` fields `ponsClassQuoteAssets: string[]` (lowercased) and `ponsClassQuoteCapRaw: string` beside `ponsClassVaultAddress` (`packages/core/src/grant.ts:427`), plus a new marker `GRANT_PONS_CLASS_QUOTES = "pons-class-quotes"` beside `GRANT_PONS_CLASS` (`grant.ts:149`). `session.ts` mints the marker ONLY when the same array was handed to `buildCallPermissions` — the lockstep rule it already applies at `:613-624`. Accessor `grantClassQuoteAssets(grant)` returns `[]` unless `GRANT_PONS_CLASS`, the new marker, a non-empty array and a positive cap are all present ("a marker alone is a claim, not evidence", `grant.ts:151-155`). `limits.ts` exposes them as `limits.classQuoteAssets` / `limits.classQuoteCapRaw`, grant-sourced, never from `allowedAssets` (`policy.ts:327-334` is the lesson).
3. **Code** — `CLASS_QUOTE_PROVEN[chainId]` (§4.4).

A grant without the marker yields `[USDG]` and no cap: today's behaviour byte-for-byte.

### 4.4 The proof registry lives in code, not in a row

`CLASS_QUOTE_PROVEN: Record<chainId, Record<address, { buyTx, sellTx, provedAt, capRaw, residueBps, loopBps, gasUsd6 }>>` in `packages/core/src/class-quotes.ts`, beside `PONS_CLASS_VAULT_FACTORY` (`protocols.ts:98-116`) in spirit. A quote is live-selectable only if it is in the grant AND in this constant AND healthy this tick. **Judge 1 preferred a DB row written by an operator command; judges 2 and 3 required a commit.** A commit was followed: a row in the child's sqlite is exactly what a compromised worker can forge and exactly what a redeploy wipes (`class-log.ts:3-9`). The operator command `merrymen class-proof record` (§12) still exists — it re-derives every figure from the chain and emits the evidence JSON that the commit carries. Removing a quote (issuer pause epidemic, drained pool) is a commit deleting the entry: no re-sign to STOP, only to START.

### 4.5 Per-tick exclusion (worker, fail closed)

A sealed quote is dropped from the *entry* set for the tick when: `readMarketSafety().pausedTokens` contains it, **or the pause read is `unread`** (`worker/src/snapshot.ts:141-150` — an unread pause is not an unpaused token; both judges grafted this); its feed is older than 2h (`snapshot.ts:166-170`; every weekend for a 24/5 feed, `tokens.ts:17-19`); `uiMultiplier` will not read (`quote-assets.ts:198-200`, `:217-221` leave it unpriced); `quoteDecimalsOf` returns anything but 18; QuoterV2 fails either direction at the entry size; or Q is a configured basket leg of THIS agent (steady-basket, even-keel and weekend-gap all size sells from `snap.holdings`, so two producers would size against one balance). Each exclusion is a sentence carried as `executableWhy`; a candidate is reported, never silently dropped.

**EXITS ARE NEVER REFUSED FOR FEED STALENESS.** Their floors come from the curve and QuoterV2, and their USD figure is the hop-2 USDG receipt (§9), not the feed. A paused Q makes the exit wait, not fail.

---

## 5. Permissions

### 5.1 The exact wall change

`packages/core/src/wall.ts`:

**(a)** `WallOptions.classQuoteAssets?: readonly { address: Address; capRaw: bigint }[]`. Validated in `buildCallPermissions` at the `:429-435` position, throwing at signing: every address ∈ `adapterAssets` AND ∈ the TRADEABLE stock set; never USDG, WETH, the zero address or an extra; every `capRaw > 0`.

**(b)** `K = min(capRaw)` over the list. Assert `K ≥ usdgUnits(caps.perTradeUsdg)` so the new word2 rule can never narrow the USDG route (a 6dp USDG amount is ~10¹⁰ below any 18dp share count for a stock worth more than a dollar; the assertion makes that a pinned fact, not an observation).

**(c)** word1 (`:793`): `{ condition: ParamCondition.ONE_OF, value: [CASH.USDG, ...classQuoteAssets.map(q => q.address)] }` — with an absent list this is exactly today's `[USDG]`.

**(d)** word2 (`:794`): `classQuoteAssets.length ? { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: K } : null` — with an absent list this is exactly today's `null`. **A grant signed without the option is byte-identical to today.**

**(e)** `sell` (`:799-810`), `deploy` (`:811-832`), the stock approves (`:511-523`) and `exactInputSingle` (`:615-627`) are unchanged. The stock approves stay uncapped because narrowing the CALL is what closes the exposure (`:477-481`), and a cap there would also cap router sells of the equity book. The `:759` comment is corrected; the `:483-486` "what this gives up" paragraph is rewritten to say the stock-funded class buy is now *bounded by word2* rather than excluded.

**(f)** `wall.test.ts:806-821` is extended to pin VALUES: with the option, `args[1].value` deep-equals `[USDG, Q]` and `args[2]` deep-equals `{LESS_THAN_OR_EQUAL, K}`; without it, `args[1].value` is `[USDG]` and `args[2]` is `null`; and an encoder proof in the `:753-849` pattern that the absent option yields today's bytes.

**WHY THIS SHAPE IS SAFE TO SIGN.** ONE_OF on one word plus LESS_THAN_OR_EQUAL on the next, in ONE permission, is already live in this wall: the USDG approve at `wall.ts:506-508` is exactly that shape. `vault.buy`'s arguments are all static, so the rules encode at offsets 32 and 64 (`@zerodev/permissions/_esm/policies/callPolicyUtils.js:72`, `:119`, `offset: i * 32`; `abis.ts:253-254` "all-static … positional offsets and the ABI agree by construction"). The CallPolicy V0_0_4 duplicate-selector question (probe P2) is **off the critical path**: one permission, one K.

### 5.2 The per-quote chain-side bound, and why K is a minimum

`capRaw_Q = spendInQuoteRaw(usdgUnits(perTradeUsdg), 18, price8_Q, uiMultiplier_Q)` at signing (`quote-assets.ts:143-152`), **no headroom**, derived not typed. Because `vault.buy` pulls EXACTLY `quoteIn` (`PonsClassVault.sol:171`) and the policy refuses `quoteIn > K` for ANY word1 value, at most `K` raw of any sealed quote can be handed to an unpinnable curve per call — whether that Q came from the hop in the same batch or from the account's standing balance. The wall no longer needs to tell the two apart; that is what closes the brief's "already-held stock" gap on chain. `K = min_i capRaw_i` means the most expensive sealed stock's share count bounds every sealed quote: cheaper quotes are capped *stricter* in USD, every sealed quote's per-call exposure is ≤ `perTradeUsdg` in USD at signing, and several quotes work under one permission. The worker downsizes `U` so that `F1 ≤ K` (a cheaper quote gets a smaller effective entry, never an over-permission). Phase 1 seals one quote so `K` is exact.

**SPLITS.** Raw units never rebase; a split changes `uiMultiplier` (`tokens.ts:13-15`). After a 2:1 split the multiplier doubles and the feed halves, so USD per raw unit is unchanged: `K` is split-invariant *when the multiplier is honoured*, which is exactly what `positions.ts:43-49` exists for. Design 2's claim that the cap is "worth half after a split" is the error that comment prevents; design 1's statement is the right one.

**THE HONEST CEILING, PER CALL, NOT PER OP.** Both caps — USDG's `:508` and the new word2 — bind one call's argument. A batch may repeat `vault.buy`; ops are unbounded on chain (RateLimitPolicy is codeless on 4663, `wall.ts:922-945`); the 3,000,000 gas ceiling (`worker/src/gas-limits.ts:194`) is the *worker's*. So the chain-side ceiling is `K × calls-per-op × ops-until-expiry` — the same class the USDG route already carries, not worse, and the most the wall can promise until a rate-limit policy exists on this chain. In USD-now terms a price rise makes `K` worth `perTradeUsdg × price_now / price_sign`, bounded by grant expiry.

### 5.3 What re-signs

Only an agent that is to enter a non-USDG quote. USDG-only agents need nothing and their walls do not change. The wall's mixed-fleet problem (`wall.ts:34-35`) is opt-in only.

---

## 6. Simulation — three rehearsals and what each proves

**TODAY THE LIVE CLASS ARM HAS NO REHEARSAL AND NO FENCE.** `index.ts:7093` sends directly; `simulateClassBuy` is imported only by the shadow tool (`tools/brain-trending-shadow.mts:46`, `:478`); the only pre-flight is the executor's two bundler estimates (`worker/src/executor.ts:670-673`). (The task named `worker/src/simulate.ts`; it does not exist — the harnesses are `worker/src/venues/pons-class-simulate.ts` and `pons-simulate.ts`.)

A NEW `simulateClassRoute` generalises `simulateClassBuy` (`pons-class-simulate.ts:33-86`: `from: account` per call, one `blockStateCalls` block so state carries call to call, `validation: false`, `"latest"`, `:44-63`) from "exactly 2 calls" (`:40-42`) to the route shapes, and **appends view calls inside the same simulated block** — before and after the route — so custody is proven in the rehearsal, not inferred: `Q.balanceOf(vault)`, `classToken.balanceOf(vault)`, `Q.balanceOf(account)`, `USDG.balanceOf(account)`.

### 6.1 Entry rehearsal (one request)

Block 0 = `[pre-views, entry calls, post-views]`. PROVES, at the simulated block: the deploy (if any) succeeds; the approve lands; the router delivers `amountOut ≥ F1` (decoded from call 2's return); the vault's `transferFrom` of Q from the account succeeds — which also proves Q is not paused at that block and that the BeaconProxy's return shape passes `_pull` (`PonsClassVault.sol:258-261`); `vault.buy` returns `tokensOut ≥ M1` (decode against `PONS_CLASS_VAULT_ABI`, `:77-81`); the `ClassBuy` log carries `quoteIn == F1` (`class-log.ts:41-42`, `:92-109`); `Q.balanceOf(vault) == 0` after (the residue push at `:179-180` worked); `classToken.balanceOf(vault)` delta `== tokensOut`; `USDG.balanceOf(account)` delta `== −U`; `Q.balanceOf(account)` delta `== amountOut − F1` (the residue). Refusals: any status ≠ `0x1` → the reverting call's selector (`:70-76` pattern); `tokensOut` differing from `tokensQuoted` by more than `slippageBps` → `curve-moved` (p99 1,546 bps over four minutes, `pons-price.ts:471-473`); summed `gasUsed` over 3,000,000 → `gas` before the bundler is asked.

### 6.2 Reverse rehearsal at entry (a second request)

A `blockStateCall` cannot read a prior block's return, so the exit cannot be sized to the *decoded* `tokensOut` inside one request. Judge 3 grafted design 1's "sell the decoded size" over design 3's "sell only the floor `M1`", which under-tests the exit; the only way to do that with fixed amounts is a **second request**: block 0 = the entry again (its decoded `tokensOut` must equal the first request's, else `curve-moved`); block 1 = `[vault.sell(curve, tokensOut, 1, deadline), Q.approve(router, qBackFloor), exactInputSingle(Q→USDG, qBackFloor, 1, self), post-views]` with `qBackFloor = curveMinOut(curveSellOut(R_after, tokensOut), slippageBps)` and `R_after = {quoteRaw + F1 × 9901/10000, tokenRaw − tokensOut}` (the `:243-247` arithmetic on post-buy reserves — stricter than `class-entry.ts:129`, which sells back against pre-buy reserves). The hop-2 floor is `1` ONLY here, to MEASURE `usdgBackSim` rather than enforce it; the real exit carries `U2`. PROVES the loop closes at this block: the vault can sell what it just bought, the Q→USDG pool absorbs the sell side at this size, `classToken.balanceOf(vault) == 0` after, and `usdgBackSim` — the figure §7 judges. A failure here refuses the ENTRY (`no-exit-simulated`): never enter a position whose exit does not rehearse (`policy.ts:469-479`'s rule).

### 6.3 Pre-exit rehearsal (every tick the exit fires, and on any resume)

Block 0 = `[pre-views, exit calls as built with the LIVE T, post-views]`. Must show `ClassSell.quoteOut ≥ F2`, hop-2 `amountOut ≥ U2`, `classToken.balanceOf(vault) == 0` after, `Q.balanceOf(vault) == 0`, account Q delta `== quoteOut − F2`. A failing sell → refuse with the selector and retry next tick, never sell blind (`index.ts:2040-2052` keeps its sentence). A passing sell with a failing hop → the op-A-only fallback (§3.3).

### 6.4 What only the bundler can prove

`eth_simulateV1` runs with `validation: false`: the session key's CallPolicy is never exercised. **The executor's two `estimateUserOperationGas` calls (`executor.ts:496-499`, `:670-673`) are the ONLY pre-send check that judges the wall's new word1/word2 and the gas ceiling** (`gas-limits.ts:194`; the AA21 balance override at `:505-519` makes the estimate reach execution). A permission mismatch surfaces there as a validation failure — no money moved. What nothing can prove: the curve's state at inclusion (deadline 60s and floors are the defence), a pause landing between rehearsal and inclusion, curve provenance (a hostile curve simulates as happily as a real one; `knownCurves` at `policy.ts:408-437` stays the only vouch), and that the worker's RPC supports `eth_simulateV1` at all — a missing method is a refusal, never a pass (`pons-class-simulate.ts:21-22`; probe P9).

Every verdict — simulate, reverse, fence, both `checkPolicy` verdicts, both estimates — is written to the trades row (the `sim_*` columns exist, `store.ts:304-307`; a `verdicts` JSON column is added) so §12 can require that each one RAN.

---

## 7. Round-trip impact

All figures USD at 6dp (`quote-assets.ts:119-122`). `usd6(x) = quoteRawToUsd6(x, 18, usd8_Q, uiMultiplier_Q)` (`:155-157`, one division, multiplier applied as `positions.ts:43-49` requires) with the tick's Chainlink price. USDG amounts are already 6dp.

```
U            = usdgIn
qQuoted      = QuoterV2(USDG→Q, U)
F1           = qQuoted × (10000 − slip) / 10000
tokensOut    = curveBuyOut(R, F1)                              pons-price.ts:238-249
qBack        = curveSellOut(R_after, tokensOut)                post-buy reserves
usdgBack     = usdgBackSim from §6.2 (arithmetic twin: QuoterV2(Q→USDG, curveMinOut(qBack, slip)))
loopBps      = (U − usdgBack) × 10000 / U
hop1Bps      = (U − usd6(qQuoted)) × 10000 / U                 pool-vs-feed, fee + impact
curveBps     = curveBuyImpactBps(R, F1)                        class-entry.ts:99
hop2Bps      = (usd6(qBackFloor) − usdgBack) × 10000 / usd6(qBackFloor)
residue6     = usd6(qActualSim − F1)                           NOT a cost; reported separately
gasUsd6      = priceGas(estimated entry + exit gas, ethPrice8)  reported (trades.gas_usdg, store.ts:458), not thresholded
```

**THRESHOLDS — existing numbers only, judged on the whole loop:**

1. `loopBps ≤ CLASS_MAX_ROUND_TRIP_BPS = 600` (`class-entry.ts:39`; `index.ts:249`) — now on the WHOLE loop, both v3 hops and both curve legs. Today `class-entry.ts:131` compares `roundTrip` to `spend` in raw quote units, which is a USDG figure only by accident.
2. `curveBps ≤ cfg.maxImpactBps` (`worker/src/settings.ts:405`; `class-entry.ts:101`).
3. `hop1Bps` and `hop2Bps` each `≤ cfg.maxPriceDivergenceBps` (`settings.ts:108`, `:417`) — the spot-vs-reference band the WETH pool already lives under (`index.ts:3620-3623`). A USDG/Q pool whose fill diverges from Chainlink by more than the band is a manipulated or dead pool: refused as `hop-divergence`.
4. `usd6(realQuoteRaw) ≥ cfg.classMinDepthUsdg` (`index.ts:1134`) with the multiplier folded in.

**Judge 1 asked for a new per-hop ceiling (`classHopMaxCostBps`); judge 3 said keep "no new setting" unless measurement shows the pool legs need one. Judge 3 was followed**: 600 bps already has to cover 2 × 99 bps curve fee (`pons-price.ts:211`) plus two v3 fee tiers plus impact, and the guard commentary at `pons-price.ts:456-475` was measured on ETH-seeded curves and says nothing about a thin USDG/stock pool — which is an argument for *measuring first*, not for a knob picked from taste. The shadow records `loopBps`, `hop1Bps`, `curveBps`, `hop2Bps`, `residue6` and `usdgBackSim` for EVERY candidate (probe P7); a per-hop ceiling is added only if the tape says the pool legs hide cost the 600 does not see. If 600 never clears at 5 USDG for stock quotes, the canary is deferred, not the threshold loosened.

Every refusal is a sentence in the owner's vocabulary (`class-entry.ts:77-84`); the messages at `:103` and `:133-134` stop saying "USDG" for the curve leg.

---

## 8. Custody and restart survival

**WHERE EVERY ASSET SITS.** Before: USDG in the account; vault holds only class tokens (`PonsClassVault.sol:98-100`). Inside the entry batch: call 1 grants an allowance (no movement); call 2 moves `U` USDG account→pool and `qActual` Q pool→account (recipient pinned self, `wall.ts:623`); call 3 grants; call 4 pulls `F1` Q account→vault (`:171`), the curve takes it, residue (if any) is pushed back (`:179-180`), `tokensOut` lands in the VAULT (`:182`). After: class token in the vault; `qActual − F1` of Q in the account as tracked residue; no Q in the vault by construction. Exit: the curve pays `quoteOut` of Q straight to the ACCOUNT (`:214`); `F2` Q leaves to the pool; `usdgOut` USDG arrives. After: `quoteOut − F2` of Q in the account as tracked residue; class token gone (or dust).

**CRASH BETWEEN STEPS.** With one atomic op per direction there are no inter-call states to survive (§3.4). The states that CAN be found after a crash: (a) op submitted, receipt unseen — the orphan-receipt reconciler writes the execution row (`index.ts:7129-7135`) and `reconcileClassFromChain` re-folds the vault's own tape (`index.ts:7228-7230`; `class-log.ts:204-258`), and the NEW receipt join (§9) rebuilds the route row from the same tx; (b) Q residue in the account — rebuilt from receipts, not from memory, and swept by §3.5; (c) a fill booked but the class row missing — `restoreClassCostBasis` rebuilds the basis from the folded tape and refuses to invent one (`index.ts:1854-1857`).

**ONE PREDICATE FOR "IS THIS A QUOTE ASSET".** Today five sites test USDG by address: `isCash` (`index.ts:1687`), `isCashRow` (`store.ts:3859-3863`, called without `quoteToken` at `:3892`), `isQuoteTokenRow` (`worker/src/class-active.ts:71-76`), the custody read set (`index.ts:8352-8357`, class rows + USDG only) and `classCashUsdg` (`index.ts:8445`); `class-side.ts:56-60` tests equality with `cash`. They all move to ONE exported `isClassQuoteAsset(addr, grantClassQuoteAssets)` = `{USDG} ∪ sealed`. The custody read asks the vault for class rows + USDG + every sealed quote; a sealed-quote balance found AT THE VAULT (which `:179-180` makes impossible, but Shogun's measured 5.785344 USDG residue, `class-recovery.ts:184-185`, says must still be handled — probe P8) is reported as an anomaly and valued into equity through the multiplier-aware stock path (`positions.ts:43-49`), never booked as a `recovered` position.

**REHYDRATE.** `index.ts:1583-1591` already reads `pairToken` from the curve, so `quote_token` is quote-aware; a null is refused, never guessed. `class_positions` rows stay custody `'vault'` for the class token; Q residue is an ACCOUNT holding, never a class row.

**SWEEP.** Session keys still cannot sweep (`wall.ts:768-771`). `merrymen recover` already enumerates every `STOCK_TOKENS` entry for the vault (`recover.ts:166-170`; `class-recovery.ts:197-221`), so a stock residue in the vault is discoverable today; a sweep of Q books as a withdrawal, not a sale (`store.ts:805-821`).

---

## 9. The accounting unit contract

**EVERY `*_usdg` / `cashUsdg` / `notionalUsdg` / `spendUsdg` COLUMN AND FIELD STAYS MICRO-USDG.** That is the reading every consumer makes: `class-log.ts:56/:166/:184`, `store.ts:792-795`, `index.ts:7168-7174`, `scoutCostOf` (`worker/src/class-reconcile.ts:217-241`), `scoutAllows` (`worker/src/quarantine.ts:104-115`), `bookFill`/`applyFill` (`index.ts:5595-5608`), the trade fee (`index.ts:7605-7610`), the P&L card. **A raw quote amount never enters one of those**: a 5 USDG NVDA-quoted fill booked raw would be ~2.3×10¹⁶ read as micro-USDG — the 10¹² error — and it would poison the shared scout budget for USDG entries too. Raw quote units get their own columns.

### 9.1 Columns

`class_positions` (all bigints as TEXT, the `store.ts:3916-3917` precision rule): `route TEXT ('usdg'|'hop')`, `quote_in_raw` (`ClassBuy.quoteIn`), `quote_out_raw` (`ClassSell.quoteOut`), `quote_decimals INTEGER`, `entry_usdg_in` (the USDG Transfer out of the account in the entry tx), `exit_usdg_out` (the USDG Transfer into the account in the exit tx), `cost_source TEXT ('usdg-leg'|'linked-hop'|NULL)`, `proceeds_source TEXT` (same vocabulary), `route_id TEXT`. `trades` gains `route_id TEXT` and `verdicts TEXT` (JSON).

NEW TABLE `class_routes` (`agent_id, route_id, class_token, quote_token, state ∈ {entry-sent, open, exit-sent, closed, hop1-landed, sold-unswapped, unwound}, entry_tx, entry_swap_log_index, entry_usdg_in_raw, entry_quote_out_raw, vault_buy_log_index, vault_quote_in_raw, tokens_out_raw, entry_residue_raw, exit_tx, vault_sell_log_index, vault_quote_out_raw, tokens_in_raw, exit_swap_log_index, exit_quote_in_raw, exit_usdg_out_raw, exit_residue_raw, residue_swept_raw, created_at, updated_at`), `UNIQUE (agent_id, entry_tx, vault_buy_log_index)` so a replay converges (the `class-log.ts:30-36` identity rule). The three two-op states are reserved, unused until §3.4's flag exists.

### 9.2 USD-at-fill, deterministic and replayable from receipts only

Entry tx: `usdgIn` = the ERC-20 `Transfer` on `CASH.USDG` with `from == account` (exactly one: the router pulls it; the approve emits `Approval`, not `Transfer`); `qActual` = the `Transfer` on Q with `to == account` and `from != vault` (the vault's residue push is excluded); `F1` = the `Transfer` on Q with `from == account, to == vault`, which must equal `ClassBuy.quoteIn`. Exit tx: `quoteOut` = `ClassSell.quoteOut`; `usdgOut` = the USDG `Transfer` with `to == account`.

**PRO-RATA COST, WITH THE RESIDUE GIVEN A BASIS.** Judge 1 grafted design 1's pro-rata booking over design 3's "whole USDG Transfer as cost"; judge 3 valued design 3's by-eye verifiability. **Judge 1 was followed**, because whole-Transfer-as-cost counts the residue's USDG twice during the hold (once inside `cost_usdg` at cost, once as Q in the account at feed value), moves the HWM by the wrong amount, and lets a prior position's dust inflate the next exit's proceeds. By-eye verifiability is kept: `entry_usdg_in` and `exit_usdg_out` are stored raw off the receipts, and the split is a pair whose sum equals the Transfer.

```
cost_usdg            = floor(usdgIn × F1 / qActual)                 cost_source 'linked-hop'
residue_basis_usdg   = usdgIn − cost_usdg                            → bookFill({side:'buy', symbol: Q, qtyRaw: qActual − F1, cashUsdg: residue_basis_usdg})
IDENTITY             : cost_usdg + residue_basis_usdg == usdgIn      (exact, a §12 pass criterion)

proceeds_usdg        = usdgOut                                        proceeds_source 'linked-hop'
residue_out_basis    = floor(usdgOut × (quoteOut − F2) / F2)          → bookFill({side:'buy', symbol: Q, qtyRaw: quoteOut − F2, cashUsdg: residue_out_basis})
realized_pnl_usdg    = proceeds_usdg + residue_out_basis − cost_usdg
```

The residue sweep books its own small P&L on Q against the basis it was given; summed across entry, exit and sweep, realised P&L is exactly total USDG out minus total USDG in. `liveFill` for the class token (`index.ts:7168-7174`) becomes `{qtyRaw: tokensOut, cashUsdg: cost_usdg, priceUsd: cost_usdg/1e6 / (tokensOut/10^dec)}` — for `route 'usdg'`, `usdgIn == F1 == qActual` and this reduces exactly to today's numbers. **A non-USDG fill with no linkable USDG Transfer in the same tx is NOT booked**: `cost_usdg = NULL`, `cost_source NULL`, and `scoutCostOf` reports it as unknown and counts nothing (`class-reconcile.ts:235-238`, "unknown, not zero"); the warn at `index.ts:7177-7186` is extended to say so.

### 9.3 The fold

`foldClassEvents` (`class-log.ts:204-258`) keeps its single choke point but `costRaw`/`proceedsRaw` (`:239`, `:244`) are renamed `quoteInRaw`/`quoteOutRaw` and labelled honestly. A second pass `linkClassRoutes(events, receipts)` in `reconcileClassFromChain` fetches the receipt of each `ClassBuy`/`ClassSell` tx, pairs it with the USDG and Q Transfers in the SAME tx (linkage by `txHash`, which the one-op shape guarantees), and produces `cost_usdg`/`proceeds_usdg` with their sources. When the quote is USDG the join is skipped and `cost_usdg = quoteInRaw`, source `'usdg-leg'`. A wiped sqlite rebuilds identical rows from block 0 of the vault. Nothing else may write `cost_usdg`.

### 9.4 Tracked residue

`trackedResidue(Q)` = Σ over this agent's routes in Q of `entry_residue_raw + exit_residue_raw + (state == sold-unswapped ? vault_quote_out_raw : 0) − residue_swept_raw`, rebuilt by the same join. The sweep (§3.5) sells `min(trackedResidue, balance)`.

### 9.5 What the scout budget sees

`spendUsdg = intent.notionalUsdg` (`policy.ts:527-535`), which for a class-route entry is `usdgIn` — 6dp, exact by construction. `existingCostUsdg`/`quarantinedUsdg` come from `scoutCostOf` over `cost_usdg` (6dp). So a 5 USDG NVDA-quoted entry accrues 5.000000, never 2.3×10¹⁶, and releases on close. A unit test books a synthetic NVDA fill with `F1 ≈ 2.3e16` raw and asserts `cost_usdg < 10^9`, `cost_usdg + residue_basis_usdg == usdgIn`, and that `notionalUsdg` is independent of `quoteInRaw` — the tripwire.

---

## 10. Policy mirror changes

**NEW INTENT KIND `class-route`**, its own kind for the reason `curve-trade` is one (`policy.ts:196-203`): `{ kind: "class-route", side: "entry"|"exit"|"residue", target: vault, router: SwapRouter02, curve, classToken, quoteToken, hop: { tokenIn, tokenOut, fee, amountInRaw, minOutRaw }, vaultLeg: { quoteInRaw, minTokensOutRaw } | { tokensInRaw, minQuoteOutRaw }, notionalUsdg }`. `curve-trade` against the vault keeps its USDG-only meaning and the op-A-only exit, so USDG agents are untouched.

**ENTRY rules (none exempt):** positivity on every amount (`:335-345` shape); `target-allowlist` needs BOTH vault and router in `allowedTargets` (`limits.ts:55`, `:95-98`); `class-quote-allowlist`: `quoteToken ∈ limits.classQuoteAssets` (grant-sourced; a non-USDG quote on a grant without the field is refused here, which is what the chain would do); the one-un-enumerated-leg rule tightened to "exactly the class token" (`:376-401` today allows any single leg); `curve-provenance` unchanged, fail closed (`:408-437`); **`hop-required`**: a `curve-trade` whose `assetIn` is a sealed non-USDG quote is refused with a sentence before the chain's word2 refuses it with an AA23 — the worker never builds a stock-funded direct buy; **`class-route-unfunded`**: an entry with `quoteToken != USDG` must carry `hop.tokenIn == USDG` and `hop.minOutRaw == vaultLeg.quoteInRaw`; **`class-quote-cap`**: `vaultLeg.quoteInRaw ≤ limits.classQuoteCapRaw`, mirroring word2, plus a stricter USD re-valuation `usd6(quoteInRaw) ≤ perTradeUsdg` at the tick's feed (stricter than chain, the safe direction); **`quote-health`**: the §4.5 exclusions as a named refusal; `per-trade-cap` on `notionalUsdg = usdgIn` (`:637-657`); `daily-cap` (`:662`); `ops-cap` (`:620`); `scout-budget` (`:527-536`) with `spendUsdg = usdgIn`; `drawdown-breaker` (`:732-738`) — an entry is never an exit.

**EXIT and RESIDUE rules:** legs confirmed against `class_positions` (curve AND `quote_token`; the `index.ts:6988-7013` check moves into the mirror); `isUnsizedExit` (`:606-612`) and `isExit` (`:698-730`) gain `intent.kind === "class-route" && intent.side !== "entry"`, so ops/per-trade/daily caps and the breaker are exempt exactly as a curve trade into a quote asset is today (`:610-612`, `:728-730`; `quoteAssets` = `builtinGrantTargets`, `limits.ts:104`). The hop-2 swap is PART of the intent, so `policy.ts:463-467`'s settings-derived `allowedAssets` (`limits.ts:100`) is never consulted for it — closing the gap where a tradeable stock outside `basketSymbols` failed `asset-allowlist`. Provenance still applies to the sell's curve. Floors must be positive; no round-trip threshold on exits.

**`notionalUsdg` SEMANTICS, enforced:** always the USDG the ACCOUNT moves, 6dp — entry `usdgIn`; exit `U2` (the floor, so expected proceeds are never overstated; the fee at `index.ts:7605-7610` charges on it); residue the feed-valued USD of `r`. `class-entry.ts:148`'s `notionalUsdg: spend` stays correct on this route because `spend` is USDG by construction; `index.ts:2084`'s `notionalUsdg: quoted` (raw quote units) is replaced for non-USDG positions. `class-side.ts:56-60` reads `side` from the intent for this kind; `index.ts:1133` and `:10281-10287` pass the sealed set.

---

## 11. The Brain boundary, and how executability widens per quote

**WHAT THE BRAIN MAY DO.** Rank and research every candidate across every quote (`trending-snapshot.ts:209-211` already classifies all launches; `brain-trending.ts:474-479` researches survivors "every quote, since research is wider than execution"); return at most ONE `candidateId` plus confidence and thesis; say the best opportunity is unexecutable and why (`brain-trending.ts:683-690`, `:736-737` already write that sentence). It sees symbols, signals and per-quote USD figures — depth, `costBps`, the §7 parts, `executable`, `executableWhy` — and nothing address-shaped (`assertNoAddresses`, `:436-453`, extended to the new fields).

**WHAT IT MAY NEVER EMIT:** an address, a curve, a quote asset, a fee tier, an amount in any unit, a floor, a deadline, calldata, a route shape, or a change to the allowlist. The deterministic layer maps `candidateId` → (token, curve, quoteToken, reserves) from ITS snapshot and builds the route with its own sizes; a Brain pick and a deterministic pick go through the identical refuse chain (`class-entry.ts:20-22`: "the Brain is nowhere in this file"). A buy naming a candidate that is not executable is a forced HOLD with the reason recorded; `brain-trending.ts:466-467`'s filter and `:544-548`'s re-check become assertions.

**EXECUTABLE IS COMPUTED PER (AGENT, QUOTE), EACH TICK:** `kind usdg → true`; `kind stock → address ∈ grantClassQuoteAssets(agent.grant) AND ∈ CLASS_QUOTE_PROVEN[chainId] AND quoteHealth(Q).ok this tick AND not a basket leg of this agent`; native-eth / weth / unknown → `false` with `quote-assets.ts:80-114`'s sentences. `classifyQuote` stays pure and gains a `(grant, proven, safety)` argument; `executableWhy` names which fact is missing ("not sealed in this agent's grant", "no canary proof for SPY yet", "SPY feed stale (weekend)"). `brain-trending.ts:286-292` keeps re-deriving from the curve's own `pairToken`, never from the record.

**HOW IT WIDENS.** One quote at a time, and two things must both hold: the grant seals it (owner re-sign) and the proof commit exists (§4.4). The ONE exception, stated so it cannot be quiet: the canary worker runs with `MERRYMEN_CLASS_CANARY_QUOTE=<address>`, which makes that quote executable for that agent only, for the deterministic producer only (the Brain is not consulted for the canary op), logged on every tick, and removed the moment the proof commit lands. Until a proof exists, every other agent's Brain keeps ranking Q-quoted candidates in shadow and says so when they win — the owner's ruling, verbatim.

---

## 12. The canary proof

**THE AGENT AND THE QUOTE, NAMED.** Shogun — per the operator judge (2026-09-16): tenant `0x8e93bad5…`, vault `0x3fcdde6e…`, 23.67 USDG cash, zero open positions, and the one completed USDG-rail BUY→SELL this repo has (`index.ts:7126-7127`: "5.000000 USDG in, 3.226758 back"). Those figures are re-read at T0, not trusted from this document. The precedent the canary extends, verified on chain on 2026-09-16 with the vault as the trader on curve `0xc7c85958…c2ba`: SirSendIt bought 5.000000 USDG at block 64070260 and sold for 3.613002 at block 64425553 (tx `0xb4e70e5b…`); Shogun bought 5.000000 at 64070702 and sold for 3.595457 at 64425625 (tx `0x8297a1dd…`). Both round trips ran unaided on the USDG-direct route; the multi-quote canary is the same shape with one hop on each side. Quote: **NVDA** (`tokens.ts:171`, TRADEABLE) — the tape's dominant stock quote (35 curves / 705 trades in the measured hour, `scratchpad/mq-live1/report.md`), with **SPY** (`tokens.ts:181`) as the measured alternate. Chosen on the day by measurement: the shadow's `quoteBreakdown` (`trending-snapshot.ts:209`) plus `scripts/probe-tradability.mts`; the quote must quote both directions at 5 USDG with hop divergence under the band, feed fresh, `uiMultiplier == 1e18` recorded, not a basket leg. **One warning stands regardless**: the existing prefilter refused all four NVDA-quoted candidates in the live snapshot (activity 23/25, depth 88–170 USDG); the canary waits for a qualifying curve. Defer; never loosen a threshold to manufacture one.

**PRECONDITIONS.** P1 (atomicity) answered atomic; P6 (gas fit) answered; P9 (`eth_simulateV1` on the live RPC) answered; Shogun's grant re-signed with `classQuoteAssets = [NVDA]` during US market hours, `K` printed on the grant screen and recorded; factory sealed (`wall.ts:429-435`); `perTradeUsdg ≥ 5`; `classPerEntryUsdg = 5` (the probe size, `class-entry.ts:163`); account USDG ≥ 3 × size; a weekday inside feed hours; `MERRYMEN_CLASS_CANARY_QUOTE` set on Shogun's worker only; the Brain in shadow only.

**SIZE.** `usdgIn = 5.000000` USDG, never more; chain-side exposure `K` of NVDA ≈ $5 at the signing price; worst honest loss 600 bps + gas.

**PROCEDURE.**
- T0: the shadow report shows the NVDA-quoted pick executable for Shogun only, with its §7 parts.
- T1: the tick builds the 4/5-call entry; fence passes; entry rehearsal and reverse rehearsal pass with their appended balance reads; `checkPolicy` passes; the two bundler estimates pass — **this is the moment the wall first judges word1 = NVDA and word2 ≤ K**; a refusal here is a validation failure and the canary stops with "wall refused word1/word2", nothing moved.
- T2: the op lands. Receipt decoded: v3 `Swap` USDG→NVDA, `Transfer` NVDA account→vault of exactly `F1`, `ClassBuy(quoteIn == F1)`, no NVDA `Transfer` vault→account (or one, recorded as residue if the curve under-pulled — probe P8).
- T3: the reconciler re-folds; the receipt join books `cost_usdg` (`'linked-hop'`), `entry_usdg_in == 5_000_000`, `entry_residue_raw == qActual − F1`; the residue basis row for NVDA exists; the scout budget shows +5.000000.
- T3½: **A DELIBERATE WORKER RESTART DURING THE HOLD.** Kill the worker; rehydrate (`index.ts:1581-1625`) + reconcile must rebuild the same `class_positions` row, same `cost_source`, no `recovered`, no phantom NVDA row; `merrymen recover --dry-run` lists only the class token in the vault and nothing stranded.
- T4: the exit fires (`classMaxHoldSec`, or an operator-forced exit); pre-exit rehearsal passes; the 3-call exit lands: `ClassSell(quoteOut ≥ F2)`, v3 `Swap` NVDA→USDG with `amountIn == F2`, USDG `Transfer` to the account.
- T5: the residue sweep fires if `trackedResidue` clears dust; the residue row reaches 0.
- T6: `merrymen class-proof record` re-derives every figure from the chain, runs `reconcileClassFromChain` twice and asserts byte-identical rows, and emits the evidence JSON. A PR adds NVDA to `CLASS_QUOTE_PROVEN[4663]` carrying that JSON.

**EVIDENCE CAPTURED** (persisted on the trades rows and in the JSON): UserOp and tx hashes for entry, exit, sweep; every decoded log amount above; the entry and reverse rehearsal results (per-call status, `amountOut`, `tokensOut`, `Q.balanceOf(vault) == 0`, `usdgBackSim`); the fence verdict; both `checkPolicy` verdicts; estimate1/estimate2/signed/actual gas per op (`executor.ts:691-697`'s line) against 3,000,000; balances of USDG and NVDA at account and vault before and after each op; sim-vs-actual deltas in bps; the ledger rows (`route 'hop'`, `cost_usdg`, `quote_in_raw`, `proceeds_usdg`, residues, `realized_pnl_usdg`); scout budget before/after; HWM before/after.

**PASS CRITERIA — ALL OF THEM.** Both batches landed as single UserOps with no inner failure (P1 confirmed in anger); `ClassBuy.quoteIn == F1`; hop-2 `amountIn == F2`; `Q.balanceOf(vault) == 0` and `classToken.balanceOf(vault) == 0` after the exit; every actual within `slippageBps` of its rehearsal; `cost_usdg + residue_basis_usdg == entry_usdg_in` exactly; `proceeds_usdg + residue_out_basis − cost_usdg == realized_pnl_usdg` exactly; `|realized_pnl_usdg| ≤ 600 bps of 5 USDG + gas_usdg`; every USDG-denominated figure for a 5 USDG entry is < 10⁹ (the tripwire); account NVDA delta over the whole round trip equals the two residues minus the sweep, and 0 after it; `cost_source`/`proceeds_source` both `'linked-hop'`; the restart reproduced the book byte-for-byte; two consecutive reconciles byte-identical; `scoutCostOf` back to its pre-entry value; HWM moved by the realised amount plus gas only; no `warn` about an unreadable event, unknown basis or recovered row; **and every check RAN** — simulate, reverse, fence, both `checkPolicy` verdicts and both estimates present and ok on the rows. A canary that passed only because a check did not run fails. A FAIL unlocks nothing and the evidence becomes the bug report.

**WHAT UNLOCKS.** The commit adding NVDA to `CLASS_QUOTE_PROVEN[4663]`. From that deploy, `executable` is true for NVDA on any agent whose grant seals it and passes quote-health, and the Brain may select NVDA-quoted candidates for live execution on those agents. Each further quote repeats the whole plan; nothing is inherited between quotes. A proof is per quote, per chain, never per route.

---

## 13. Threat model

| Attack | Control | Chain or worker |
|---|---|---|
| Compromised session key names a hostile contract as `curve` with `quoteAsset = Q` — the `wall.ts:462-474` attack, now reachable in a stock | word2 LESS_THAN_OR_EQUAL `K` bounds Q handed per CALL (vault pulls exactly `quoteIn`, `PonsClassVault.sol:171`); vault pays nobody but owner (`:105`, `:214`, `:235`); `valueLimit 0` | **Chain.** Residual: `K × calls × ops-until-expiry` (`wall.ts:922-945`), stated on the grant screen as USDG's is (`:943-945`). Worker adds `curve-provenance` and `maxOpsPerDay`. |
| Key funds a class buy from stock the account ALREADY holds, skipping the USDG hop (brief missing #3) | word2 binds identically whether Q came from the hop or the balance; `hop-required` and `class-route-unfunded` refuse it as a sentence | **Chain** for the bound; **worker** for the refusal |
| Kernel batch not atomic: hop 1 lands, `vault.buy` reverts, Q stranded | `route-not-atomic`: the route is refused outright under that finding (§3.4); approves are sized exactly so a stranded allowance is one trade's worth | Worker; the chain gives no help |
| Hop 1 fills above the floor; residue accumulates | Bounded by `slippageBps × spend` per entry; tracked in `class_routes`; given a basis; swept at the tracked figure (§3.5, §9.4) | Worker |
| Curve moves between read and inclusion (p99 1,546 bps / 240s) | `M1`/`F2` enforced by the vault (`:184`, `:219`) → whole op reverts, gas lost, nothing moves; 30s read validity (`pons-price.ts:474`); `curve-moved` refusal on sim delta | Chain for the floor; worker for the read age |
| Sandwich / thin-pool pricing on either hop | `amountOutMinimum` enforced by the router, fixed at build (`F1`, `U2`); QuoterV2 quote, `slippageBps`, `hop-divergence ≤ maxPriceDivergenceBps`, fence equality on the floor (`final-fence.ts:157-164`'s incident) | Chain for the floor; worker for the judgement |
| Issuer pauses Q (`tokens.ts:8-11`) | Entry: `quote-health` refuses on paused OR unread; a pause between rehearsal and inclusion reverts the whole batch (gas only). Hold: both the curve's payout and hop 2 are blocked; the position waits, the class token stays owner-sweepable (`recover.ts:914-926`). Accepted as issuer-trust risk, stated. | Worker; chain reverts |
| Weekend / stale feed (`tokens.ts:17-19`) | Entries refused when `updatedAt` > 2h; exits allowed (floors from curve + QuoterV2, USD from the receipt); reporting flagged stale (`snapshot.ts:166-170`); `K` fixed at signing so the chain does not care | Worker |
| ERC-8056 `uiMultiplier ≠ 1e18` or unreadable | `K` is raw and split-invariant with the multiplier honoured; `readQuotePrices` leaves a stock unpriced without it (`quote-assets.ts:198-200`) so depth, spend and loop are refused rather than wrong | Worker |
| Graduated curve | Vault reverts `CurveGraduated` on buy and sell (`:252`); entry ceiling = exit − 1,000 bps (`class-entry.ts:109-127`); owner sweep is the way out | Chain; worker |
| The 10¹² accounting error | `cost_usdg`/`proceeds_usdg` written only by `linkClassRoutes` from a USDG Transfer, else NULL; raw amounts in their own columns; `notionalUsdg` is `usdgIn`/`U2` by construction; the tripwire test | Worker |
| Mirror looser than chain via settings (`policy.ts:327-334`) | Quote set and cap come from the grant only; hop-2 is inside the intent so `allowedAssets` is never consulted; the wall and the grant fields are minted from ONE array; encoder proof pins the bytes | Worker (re-sign to widen) |
| Wrong calldata signed (builder regression) | `checkClassRouteCalls` decodes every call, equality on every amount and floor, unrecognised shape refused | Worker |
| Hop-2 pool drained after entry | Reverse rehearsal at entry proves it today; before exit, op-A-only fallback sells to Q; Q held as a priced, feed-valued asset until the pool returns or the owner moves it (`recover.ts:166-170`). Never trapped in the vault. | Worker |
| Hostile curve returns one wei (delta satisfied) | `K` bounds the loss per call; `M1` derived from factory-filtered reserves refuses it before build | Chain; worker |
| Class token symbol spoofing | Every predicate is address-keyed (`index.ts:1607-1610`; `class-active.ts:68-69`); the allowlist is addresses | Worker |
| Codeless vault CALL succeeds silently (`protocols.ts:106-109`) | Fresh `getCode` + prepended deploy (`index.ts:7040-7094`); the fence accepts the 5-call shape only when `getCode` said no code; the sim decodes `vault.buy`'s return so empty returndata is a refusal | Worker |
| Brain steered into naming an address or an unexecutable quote | `assertNoAddresses` on every field sent (`brain-trending.ts:436-453`); the parser accepts only a `candidateId` from the executable set; anything else is a hold with the sentence | Worker |
| 5-call batch over the gas ceiling | Executor refuses over 3,000,000 (`executor.ts:670-673`; `gas-limits.ts:194`); the sim's summed `gasUsed` refuses earlier; P6 measures | Worker |
| Reentrancy through a hostile curve into the vault | `inTrade` guard (`PonsClassVault.sol:139-142`) | Chain |
| Router output or vault payout redirected | `recipient` EQUAL self (`wall.ts:623`); vault pays owner only (`:214`) | Chain |
| Curve provenance (a contract self-reporting `pairToken == Q`) | Nothing on chain (`PonsClassVault.sol:91-97`); `knownCurves` fail-closed (`policy.ts:408-437`); per-call loss bounded by `K` | Worker; chain for the bound |

---

## 14. Open probes

Two the judges close with evidence already on disk, recorded here rather than re-run: (i) `eth_simulateV1` has been used against a live 4663 curve before — the 99 bps fee was measured "by replaying the compiled adapter against a live USDG-quoted curve through eth_simulateV1" (`pons-price.ts:196-199`); (ii) `CASH_FEEDS.ETH_USD` (`tokens.ts:152`) answered in the live shadow run (ETH 2383.18 USD, reported by the operator judge from `scratchpad/mq-live1/run-shogun.json`), contradicting `gas-price.ts:4-5` — attach that JSON to the design record and confirm once with P4; it affects research pricing only, never execution.

**P1 — Kernel batch atomicity (blocking).** (a) Gas-free first: `eth_simulateV1` with `from` = EntryPoint 0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032`, `to` = the canary account, calling `execute(execMode, executionCalldata)` with `execMode = 0x01 ‖ 0x00 ‖ 0x00000000 ‖ 0x00000000 ‖ 22 zero bytes` (CALL_TYPE.BATCH, EXEC_TYPE.DEFAULT) and `executionCalldata` = `encodeExecuteBatchCall([USDG.approve(router, 1), vault.buy(knownCurve, USDG, 1, 2^255, deadline)])`, followed in the same block by `USDG.allowance(account, router)`. PASS = the `execute` call reverts AND the allowance read is unchanged. (b) Then paid, definitive, under TODAY's wall, no re-sign: one real op with the same two calls (the buy reverts `InsufficientOutput` or `NoOutput`); afterwards `cast call $USDG "allowance(address,address)" $ACCOUNT $ROUTER` must be unchanged and the `UserOperationEvent.success` must be `false`. ~0.5 USDG of gas. FAIL → `route-not-atomic`, no route.

**P2 — CallPolicy V0_0_4 duplicate-selector semantics (not blocking).** Read the contract at `0x9a52283276A0ec8740DF50bF01B28A80D880eaf2` (`wall.ts:114`): whether `checkUserOpPolicy` keys `(target, selector)` to one `Permission` or iterates. Decides only whether phase 2 may carry per-quote caps as separate permissions; phase 1 needs one.

**P3 — The new shape validates on chain.** On the canary's re-signed grant, `estimateUserOperationGas` a `vault.buy` with `quoteIn = K` (expect pass), `K + 1` (expect validation failure), and `word1` = an unsealed stock (expect failure). Plus the `wall.test.ts` encoder proof for offsets 32/64.

**P4 — ETH/USD feed.** `cast call 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9 "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url <4663>` on both live RPCs; compare to `ethPrice8()` (`index.ts:3611-3635`).

**P5 — `uiMultiplier()` and `tokenPaused()` for every TRADEABLE stock**, one multicall (`tokens.ts:240`, `:247`); record values in `class-quotes.ts`. Any multiplier ≠ 1e18 is a live check of the split-invariance claim before a cap is sealed on it.

**P6 — Gas fit.** Bundler `estimateUserOperationGas` for the 4-call and 5-call entry and the 3-call exit on the canary (with the AA21 override, `executor.ts:505-519`) against 3,000,000 with `callHeadroomBps` 2× (`gas-limits.ts:183`); also the `eth_simulateV1` `gasUsed` sum.

**P7 — Stock-quoted curve economics.** For three live NVDA-quoted curves: `getReserves`, `graduationThreshold`, and an `eth_call` of the curve's `buy` at `F1` compared to `curveBuyOut` (`pons-price.ts:238-249`) to confirm the 99 bps fee and constant-product shape off ETH-seeded curves; the §7 parts across one week of the shadow tape to see where 600 binds at 5 USDG. FALLBACK: defer the canary, never loosen.

**P8 — `_pull`/`_push` against the stock BeaconProxy, and the Shogun residue.** `eth_simulateV1` of `[Q.approve(vault, x), vault.buy(...)]` on a real NVDA-quoted curve asserting `Q.balanceOf(vault) == 0` after (`:179-180`); and an explanation of Shogun's 5.785344 USDG in the vault (`class-recovery.ts:184-185`), which contradicts `:179-180`, before any stock is trusted to the same path.

**P9 — `eth_simulateV1` on the worker's live RPC.** One request in the `pons-class-simulate.ts:44-63` shape; a missing method refuses every non-USDG entry (`no-simulation`) and decides whether the RPC must change.

**P10 — Receipt-join determinism on the existing fills.** For Shogun's USDG round trip (`index.ts:7126-7127`), confirm the USDG `Transfer` with `from == account` equals `ClassBuy.quoteIn` exactly, so the join reproduces today's `cost_usdg` byte-for-byte before it is trusted for NVDA.

**P11 — Stock `Transfer` topics.** Confirm from one landed stock swap's receipt that the BeaconProxy emits standard `Transfer(address,address,uint256)` (`tokens.ts:250`), which the join depends on.

**P12 — Two-way liveness today.** `npx tsx scripts/probe-tradability.mts` for NVDA and SPY at 5 USDG across the 500/3000/10000 tiers (`tokens.ts:186-189` is dated 2026-07-27), plus hop divergence vs the feed. Picks the canary quote on the day.

---

## 15. Files touched, in build order, with the test that pins each invariant

All paths under `C:\Users\1\Documents\milla projects\merrymen\.wt\brain-trending\`.

1. `packages/core/src/class-quotes.ts` (NEW): `CLASS_QUOTE_CANDIDATES`, `CLASS_QUOTE_PROVEN`, `resolveClassQuotes`, `capRaw` formula. Test: every proven entry has both tx hashes and is a candidate; `resolveClassQuotes` refuses a stale feed, an unreadable multiplier, a paused token, a non-18 decimals, a basket leg.
2. `packages/core/src/wall.ts`: `WallOptions.classQuoteAssets`; validation; `K`; `:793` word1 list; `:794` word2 cap; comments at `:759` and `:483-486`. Test (`worker/src/wall.test.ts:806-821` extended): values pinned both ways; absent option → today's bytes; `K ≥ usdgUnits(perTradeUsdg)` asserted; encoder proof for offsets 32/64.
3. `packages/core/src/grant.ts`: `GRANT_PONS_CLASS_QUOTES`, `ponsClassQuoteAssets`, `ponsClassQuoteCapRaw`, `grantClassQuoteAssets`. Test: marker alone → `[]`; field alone → `[]`; both without `GRANT_PONS_CLASS` → `[]`.
4. `web/src/lib/session.ts` (`:468-472`, `:613-624`): one array → wall AND grant fields; marker minted in lockstep; `--canary-quote` override logged. Test: marker present iff the array was non-empty.
5. `worker/src/limits.ts` (`:100-105`): `classQuoteAssets`, `classQuoteCapRaw` from the grant. Test: never from settings.
6. `worker/src/policy.ts`: `class-route` kind; `class-quote-allowlist`, `class-route-unfunded`, `class-quote-cap`, `quote-health`, `hop-required`; `isUnsizedExit`/`isExit` arms. Tests: a stock-funded `curve-trade` is refused `hop-required`; an entry without the USDG hop refused; `quoteInRaw > K` refused; an 18dp `quoteInRaw` leaves `notionalUsdg` unchanged; exit and residue exempt from caps and breaker; entry never exempt.
7. `worker/src/venues/pons-class.ts`: `buildClassHopBuyCalls`, `buildClassHopSellCalls`, `buildResidueSweepCalls`. Test: vault leg equals hop floor; hop-2 `amountIn` equals `F2`, never a balance.
8. `worker/src/final-fence.ts`: `checkClassRouteCalls`. Test: each accepted shape; one-wei difference on any amount refused; 5-call shape refused when `getCode` said deployed; unrecognised shape refused.
9. `worker/src/venues/pons-class-simulate.ts`: `simulateClassRoute` (N-call shapes, appended views, two-request reverse). Test against recorded `eth_simulateV1` fixtures: refuses on any status ≠ `0x1`, on `Q.balanceOf(vault) ≠ 0`, on `tokensOut` outside `slippageBps` of quote.
10. `worker/src/venues/class-entry.ts`: hop-aware sizing (`U → F1` via QuoterV2, `F1 ≤ K`), loop on post-buy reserves, `hop-divergence`, messages without "USDG" on the curve leg. Test: loop judged on the whole route; `notionalUsdg == usdgIn`.
11. `worker/src/venues/class-legs.ts` (`:86-92`, `:112-114`) and `class-legs.test.ts:63-74`: sealed-set membership instead of USDG equality; decimals read. Test becomes "a launch quoted outside the sealed allowlist is refused".
12. `worker/src/venues/quote-assets.ts`: `executable` = f(grant, proven, safety); `classifyQuote` stays pure. Test: each of the three facts missing yields its own `executableWhy`.
13. `worker/src/store.ts`: `class_positions` columns; `class_routes`; `trades.route_id`, `trades.verdicts`; `isCashRow` → `isClassQuoteAsset`. Test: replay of the same receipts converges on `UNIQUE (agent_id, entry_tx, vault_buy_log_index)`.
14. `worker/src/venues/class-log.ts` (`:56`, `:166`, `:184`, `:204-258`): honest labels; `quoteInRaw`/`quoteOutRaw`; `linkClassRoutes`. Test: the tripwire — a 2.3e16-raw NVDA fill books `cost_usdg < 10^9`, `cost_usdg + residue_basis == usdgIn`; a fill with no USDG Transfer books NULL; a USDG fill reproduces today's numbers byte-for-byte (P10 fixture).
15. `worker/src/class-reconcile.ts` (`:217-241`): `scoutCostOf` over `cost_usdg`; residue fold. Test: NULL cost is `unknown`, never zero.
16. `worker/src/class-active.ts` (`:71-76`), `worker/src/class-side.ts` (`:56-60`): the one predicate; side from the intent. Test: a sealed-quote row is custody, not a position.
17. `worker/src/index.ts`: class-route executor arm beside `:6894-7230` (fence → rehearsals → estimates → send → receipt-join booking at `:7143-7187`); exits producer `:1965-2085` (3-call exit, op-A fallback, residue sweep); custody set `:8352-8357`, `:8368-8377`, `:8445`; `isCash` `:1687`; entries producer `:1130-1135` passes the sealed set; chat `:10281-10287`; scout cash arg `:5747-5750`. Test: the arm refuses when any verdict is absent.
18. `worker/src/snapshot.ts`: unread pause consumed by the class path. Test: `unread` → `quote-health` refusal.
19. `worker/src/brain-trending.ts`: executable per (agent, quote); assertions at `:466-467`, `:544-548`; §7 fields through `assertNoAddresses`. Test: a buy naming an unexecutable candidate is a hold with the reason.
20. `tools/brain-trending-shadow.mts`: proven/sealed status and the §7 parts per quote in the report.
21. `tools/class-canary.mts` (NEW) and `worker/src/recover.ts` command `class-proof record`: drives T0–T6, forces the restart, re-derives from the chain, runs two reconciles, emits the JSON. Test: the JSON's identities are recomputed from receipts, not copied.
22. `scripts/probe-kernel-batch-atomicity.mts`, `scripts/probe-class-quotes.mts` (NEW): P1, P5, P8, P12.
23. `worker/src/recover.ts:166-170` — no behaviour change; verified that `sweepList` already covers every `STOCK_TOKENS` entry.

Build order is the order above: the wall and grant first, so every worker change is judged against a signature that can carry it; the fence and rehearsals before the executor arm, so the arm cannot ship without them; the accounting before the canary, so the canary's evidence is written in the unit the book keeps.