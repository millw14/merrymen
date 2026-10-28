# Solana alongside Robinhood Chain

Implementation status: **2026-10-20**. This branch contains runnable **paper and
live Solana trading code**, an authenticated dashboard, bounded on-chain custody,
durable two-provider settlement, owner recovery without the server, operator
tools and an opt-in autonomous strategy. **Nothing has been deployed, funded or
traded on a public network by this work.** Production keeps Solana off: the web
surface needs `MERRYMEN_SOLANA=1`, which is unset, and live execution needs a
released immutable vault program that does not exist yet (see
[Release gates](#release-gates)).

The first live market is **USDG ↔ wrapped SOL (WSOL)**. Broader SPL-token paper
trading is supported through the local CLI. Arbitrary SPL/Token-2022 live
trading, bridging and Solana parity on X, Telegram, MCP and mobile are not built.
There is no measured claim that Solana outperforms Robinhood Chain.

Contents: [What changed since 2026-10-18](#what-changed-since-2026-10-18) ·
[Implemented paths](#implemented-paths) ·
[Wallet authority and consent](#wallet-authority-and-consent) ·
[Custody, limits and buy breakers](#custody-limits-and-buy-breakers) ·
[Independent SOL price](#independent-sol-price-pyth) ·
[RPC trust model](#rpc-trust-model) ·
[Settlement and accounting](#settlement-and-accounting) ·
[Owner transactions and recovery](#owner-transactions-and-recovery) ·
[A vault below its book](#a-vault-below-its-book) ·
[Paper use and autonomous worker](#paper-use-and-autonomous-worker) ·
[Operator runbooks](#operator-runbooks) ·
[Identity backstops on shared surfaces](#identity-backstops-on-shared-surfaces) ·
[Configuration](#configuration) ·
[Build, CI and release](#build-ci-and-release) ·
[Jupiter fork evidence](#jupiter-fork-evidence) ·
[Accepted limitations](#accepted-limitations) ·
[Decisions taken by default](#decisions-taken-by-default) ·
[Verification evidence](#verification-evidence) ·
[Release gates](#release-gates)

## What changed since 2026-10-18

The 2026-10-18 internal audit (55 confirmed findings) was followed by fix rounds
on 2026-10-19 and 2026-10-20, merged into this branch. In summary:

- **Two RPC providers for anything booked.** Live trading refuses to run without
  `MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK` on a different hostname. Fills,
  failures, expiries, owner transactions, inflows, outside withdrawals and the
  vault deployment are booked only when both providers agree. Every live trade
  reads the vault's balances, sequence, session epoch and the Pyth price from
  both providers at the prepared slot and simulates the exact signed message on
  both. A slot persisted from several providers is the **lowest** one any of
  them answered at, refused when one runs more than 150 slots ahead of
  another's fresh slot. See [RPC trust model](#rpc-trust-model).
- **Pyth through both providers, and a generation setting.** The constants were
  checked on mainnet on 2026-10-19. `MERRYMEN_SOLANA_PYTH_GENERATION` picks
  Pyth's `current` (default) or `upgraded` deployment, all three addresses
  together. A trade uses the stricter of the two providers' bounds.
- **Owner revoke slot.** A revocation can always be prepared and submitted, even
  beside a pending withdrawal, resume or permission registration. It has its
  own record (`solana_runtime_owner_revokes`), and a registration with a signed
  revocation beside it is never activated.
- **Owner priority fees.** Owner transactions carry a best-effort priority fee,
  capped at 0.001 SOL and at what the owner wallet can spare, with a
  compute-unit limit never below the runtime default. The browser decodes every
  owner transaction and shows its fee and the SOL it needs before the wallet
  opens.
- **Withdrawals made outside Merrymen** are recorded by the owner from their
  transaction signatures, read on both providers. Native SOL withdrawal
  (`withdraw-sol`) is in the app.
- **A vault below its book** is a named state with a status blocker, an
  `[alert]` line and an operator write-off tool that books a loss, never
  capital out.
- **Operator resolution CLIs.** `npm run solana:resolve` lists stuck items and
  books a stuck trade, a stuck owner transaction or a shortfall only on two
  providers' agreement, with the operator's name and reason recorded.
- **Price-moved floor and pacing.** A trade carries its previewed minimum and is
  refused, with nothing signed, when the fresh quote guarantees less. Status,
  previews, trades and owner routes are paced per tenant.
- **Hosted paper write-off** of dust lots, and local `solana-paper renew` and
  `write-off` commands.
- **Glued-id backstops.** X posts, social takes, theses, P&L cards, Brain and the
  model-facing redactors find Solana keys and signatures written against
  neighbouring letters or digits; the measured false-positive profile is below.
- **Robinhood kills without Solana DDL.** "Kill all agents" and Telegram `/kill`
  look the Solana table up read-only and touch nothing when Solana was never
  used.
- **Redaction.** Every Solana process installs the stdio guard first, and the
  Solana RPC providers' hosts are keyed hosts for URL redaction.
- **Build, CI and release.** Path-filtered vault jobs, a reproducible rebuild,
  a Linux build manifest compared in CI, release marking from `main` only, a
  release verdict job, and a script that checks `declare_id` against the deploy
  key. The Linux manifest is not committed yet (no CI run has happened).
- **Jupiter fork test.** The compiled vault ran a real Jupiter v6 route against
  mainnet program bytes, offline; compute and account headroom were measured.
  Live quotes now ask for routes of at most 40 accounts.
- **USDG mint fixture.** The mainnet USDG mint was read on 2026-10-20; the vault
  and the worker are tested against its bytes, and the worker now refuses any
  USDG mint state the vault's `check_mint` refuses.
- **Owner recovery without the server.** `merrymen solana-recover`, with the
  released-program pin, and an off-by-default owner key backup card.
- **Re-bind after a Privy identity change**, signed by the same owner key.
- **Fee payer levels and alerts**, the expired-attempt allowance setting, and
  agent alerts for stuck transactions and a vault below its book.

## Implemented paths

| Capability | Current implementation |
|---|---|
| Identity and isolation | Case-sensitive Solana identifiers and `sol:<owner>` agent IDs; a separate wallet binding, mode, policy and book per existing tenant. EVM grants and the RH executor keep their boundaries. |
| Authenticated app | `/solana` behind `MERRYMEN_SOLANA=1`: Privy embedded Solana wallet, wallet-ownership proof, per-chain consent and limits, previews, paper and live requests, pending receipts, owner controls (revoke, withdraw USDG/WSOL, withdraw native SOL, resume buys, record outside withdrawals), an optional owner key backup card and worker status. |
| Paper | Real mint reads and Jupiter quotes, conservative simulated fills, exact integer accounting, drawdown checks, durable idempotency, dust prevention and write-off. App/API and a separate local-only CLI. |
| Live custody | Anchor program with an owner-PDA vault, bounded sessions (at most 7 days on-chain), sequence and epoch checks, isolated Jupiter CPI, token and native recovery, owner revocation. Compiled and exercised locally as SBF, including against real Jupiter v6 bytes; undeployed. |
| Live execution | Versioned transactions with distinct session and fee-payer signatures, strict instruction and ALT validation, every-provider simulation, durable admission before send, two-provider rebroadcast, two-provider settlement and restart reconciliation. |
| Accounting | SQLite locally or shared PostgreSQL; atomic policy checks, one pending live request per vault, encrypted session keys, exact cost basis, owner capital flows, quarantined WSOL and explicit unknown-fee records. |
| Operations | Operator hold, resolution of stuck trades and owner transactions, shortfall write-off, fee payer and stuck-pending alerts. |
| Autonomous trading | A dedicated Solana worker runs an explicitly enabled USDG/WSOL target-allocation strategy in the account's selected paper or live mode. |

The main application boundary is
[`solana-app-runtime.ts`](../worker/src/solana-app-runtime.ts). Its dependencies
are the [market adapter](../worker/src/solana-market.ts),
[live market](../worker/src/solana-live-market.ts),
[live executor](../worker/src/solana-executor.ts),
[two-provider transport](../worker/src/solana-live-rpc.ts),
[settlement verifier](../worker/src/solana-settlement.ts),
[shared trading store](../worker/src/solana-trading-store.ts),
[reference price](../worker/src/solana-reference-price.ts) and the
[autonomous worker](../worker/src/solana-agent.ts). The
[custody source, build and release guide](../contracts/solana/README.md) and the
[shared program ABI](../packages/core/src/solana-live.ts) describe the on-chain
boundary.

## Wallet authority and consent

The existing tenant session and a verified current Privy identity are both
required by the Solana API. A one-time, expiring Ed25519 challenge binds the
Solana owner to that tenant and identity. The binding message grants no trading
or withdrawal authority. The server derives the owner from this binding; trade
requests cannot choose another tenant, owner or vault. Account changes invalidate
stale browser actions, and ambiguous embedded-wallet selection fails closed.

New bindings start in paper mode with no active strategy. Live mode requires its
own explicit consent and reviewed limits. Robinhood consent never enables
Solana. Changing mode disables the Solana strategy until it is enabled again;
settings revisions are checked under the same database lock as trade admission.
Live and paper limits are capped server-side at 1 to 96 operations per 24 hours
(the vault's maximum) and a permission ending within 168 hours (plus 5 minutes
for a browser clock that runs ahead); anything wider is an HTTP 400. The local
paper CLI keeps its wider simulation ranges.

For live setup, the browser generates a new bounded session seed. Registering
is two steps: "Register bounded trading permission" prepares the transaction
and shows a review decoded from its bytes (limits, on-chain expiry in UTC, the
priority fee the bytes carry, the SOL the owner wallet must hold); only "Sign
permission with my wallet" opens the wallet. The browser refuses to open the
wallet unless the bytes encode exactly the saved limits for that owner, vault,
program and session, plus only vault initialization and USDG/WSOL account
creation. A review not signed within 45 seconds is discarded; the server accepts
a signature for 60 seconds from prepare. The server verifies the exact prepared
message and owner signature, persists signed bytes before submission, and
activates the session only after the registration is finalized on both
providers with matching on-chain limits, and only when the vault's session
epoch is exactly one past the epoch the permission was prepared at. The owner
private key never enters the server. The session seed is encrypted at rest with
AES-256-GCM under `MERRYMEN_STORE_DEK`, bound to tenant, owner, program, vault,
session and epoch.

**A Privy identity change.** A wallet-signed sign-in under a new Privy DID
re-points the tenant at it (unchanged Robinhood behaviour), but the Solana
binding still names the old DID, so the new sign-in gets
"This account's Solana wallet was verified with a different sign-in. Sign in
with the login you used when you verified it." There are two ways back: sign in
again with the original login, or sign the distinct "Merrymen Solana wallet
re-bind v1" message with the same owner key under the new identity (it names
both identities and what moves). A re-bind bumps the binding's revision, turns
the autonomous strategy off and is recorded in `solana_wallet_binding_rebinds`.
Another owner key stays a conflict, and a binding never moves to another tenant.
With a Privy embedded wallet the new identity holds the key only if it was
exported and imported; otherwise use the original login.

The distinct house fee payer pays swap fees and temporary-account rent. It must
differ from every owner and session and receives no custody authority. Because
it pays every tenant's swaps, a live trade must be worth at least 1 USDG at the
independent reference price (`SOLANA_LIVE_MIN_TRADE_USDG_RAW`), checked at
durable admission; a sale of the whole recorded SOL position is exempt so a
position that fell below it can still be exited, and the autonomous strategy
treats a smaller live rebalance buy as in band. A smaller sale is still
planned, since the mark can undervalue it and admission values it at the
reference. When admission refuses one as below the minimum, the strategy treats
that as in band too: it waits its interval before trying again, never retrying
every tick, and the worker says `[warn] Solana autonomous rebalance below the
live minimum` (`kind: below-live-minimum`) at most every 10 minutes per
account. Each try still costs a quote, a route, a simulation and a signature on
the platform's providers, once per strategy interval.

Limits that could only make trades below the minimum are refused where they are
saved and registered, never later at a trade. The settings route and
`prepareLive` refuse live limits whose USDG per trade is under 1 USDG
(`requireSolanaLiveTradeMinimum`): no buy, and no sale but a whole small
position, could pass. The strategy route refuses an enabled live strategy whose
trade size is under 1 USDG. `prepareLive` also values the SOL sold per trade at
the lowest Pyth price either provider serves and refuses a cap worth under
1 USDG, since every sale is capped by it and a smaller sale that is not the
whole position is refused. When that price cannot be read, nothing is prepared
and the owner tries again; a misconfigured Pyth generation refuses as
configuration. The page states the minimum beside the limit and strategy
fields. A fall in the SOL price during the permission can still bring the cap
below 1 USDG. Partial sales are then refused until the owner registers a larger
SOL amount per trade; a sale of the whole position, if it fits the cap, and an
owner withdrawal still work. Admission never applies these save-time checks, so
limits already signed keep every exit they allow. Paper trades have no
minimum. The platform's spend per tenant stays bounded by `maxOpsPerDay` swaps
a day; there is no per-tenant fee budget.
Owner-signed setup and recovery transactions use the owner as payer.

## Custody, limits and buy breakers

The vault PDA uses `["vault", owner]`. The owner alone initializes it, replaces
sessions, revokes authority, clears the on-chain breaker and withdraws assets.
Session replacement increments its epoch without resetting the sequence,
rolling spend history or breaker. The program enforces a positive per-trade
USDG limit, a rolling 24-hour USDG limit, owner-signed per-trade and rolling
24-hour WSOL input limits, at most 96 operations per rolling day, an expiry no
more than 7 days (plus a 15-minute clock allowance) ahead, the expected sequence
and the expected session epoch. Buys and exits are both subject to those bounds;
exits cannot bypass caps or expiry. Sells are charged their full WSOL input as
well as their USDG proceeds, so a session or quote cannot sell the position for
dust: the worst a compromised session can do in a day is spend the signed daily
USDG on buys and the signed daily WSOL on sells.

For each swap, the program transfers exactly the authorized input to the token
account of `["swap", vault, sequence]`. Only that per-sequence authority signs the
Jupiter CPI. The route cannot receive the vault state, owner, session, fee payer,
source custody account, owner refund account or other custody-owned token
accounts. The destination custody account may receive output without receiving
a vault signature. The actual output balance delta must meet the minimum;
residual input returns to the vault and the temporary input account closes.
Tokens donated beforehand to that predictable temporary account go to the
owner's canonical input account. That refund account is optional: it is needed
only while a donation is waiting, so an owner who closes their own USDG or WSOL
account (for example by unwrapping WSOL in a wallet) does not block buys or
exits. If a donation is waiting and the owner's account is closed or unsafe, the
swap fails closed with program error 6010 (`RefundAccount`), the executor reports
`owner-refund`, and status tells the owner what to do (reopen the account or
withdraw a little of that token; revoke a delegate or close authority in the
wallet; a frozen account cannot be fixed from Merrymen). The fee payer never
creates owner accounts. Plain lamports sent to a sell's temporary WSOL address
while it is still a System account are a donation too: the swap opens the
native account over them and everything above its rent-exempt reserve becomes
WSOL. The executor and status count that excess as a waiting donation (pass the
owner's WSOL account, or refuse the exit as `owner-refund` with the status
blocker), and settlement books only the reserve as returned to the fee payer
(`custody.rs`
`lamports_prefunding_a_sells_wsol_temp_become_a_donation_refunded_to_the_owner`).

Jupiter's program is pinned. The accepted instruction is ExactIn
`shared_accounts_route`, with bound input, output and slippage, zero platform fee
and at most 100 bps slippage. Its discriminator is tested against SHA-256 of the
Anchor instruction name. The worker also validates route quantity conservation,
intermediate balances, allocation and cycles, and asks Jupiter for routes of at
most 40 accounts (`SOLANA_JUPITER_MAX_ACCOUNTS`). Unknown instruction forms,
unrelated setup or cleanup instructions and account substitutions fail closed.
Jupiter's own error codes share the vault's 6000+ range (Jupiter's
`InvalidRoutePlan` is 6010, the same number as `RefundAccount`): an
`InstructionError(2, Custom(n))` on the swap is ambiguous without the logs, where
the innermost `failed:` line names the program.

Two buy breakers have different roles:

- The **worker drawdown breaker** uses fresh executable exit quotes, cash and the
  portfolio high-water mark. A breach persists a buy pause even if prices later
  recover. An owner-signed, finalized resume action clears that worker pause;
  it preserves the limits and high-water mark, so a continuing breach pauses
  buying again. No on-chain portfolio-price oracle is claimed. SOL that Jupiter
  quotes to zero output is valued at zero at a buy only when Pyth values it
  under one cent (`SOLANA_MARK_DUST_MAX_USDG_RAW`); otherwise that buy is
  refused, and the breaker is not touched.
- The **on-chain breaker** can be set by the owner or active session and cleared
  only by the owner. Revocation also sets it. It blocks buys while leaving exits
  subject to the other on-chain checks.

Live assets are pinned to:

| Asset | Mint | Program / decimals |
|---|---|---|
| USDG | `2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH` | Token-2022 / 6 |
| WSOL | `So11111111111111111111111111111111111111112` | SPL Token / 9 |

**The USDG mint.** USDG's issuer authorities are an explicit cash-token trust
assumption. The mainnet mint was read on 2026-10-20 at slot 459,259,885
(`contracts/solana/runtime-tests/fixtures/usdg-mainnet-mint.json`). Its
extensions are MintCloseAuthority, PermanentDelegate, TransferFeeConfig (0 bps,
maximum 0), ConfidentialTransferMint, ConfidentialTransferFeeConfig,
TransferHook (no program), MetadataPointer and TokenMetadata: exactly the
vault's `check_mint` allowlist. One issuer key (`2apBGMsS…`) holds the freeze,
fee, hook and other extension authorities, and mainnet Token-2022 is upgradeable
(program v11.0.0). If the issuer schedules a nonzero fee, sets a hook program or
adds an extension, the vault refuses every USDG swap, exits included (error
6005). The worker applies the same verdict (`solanaVaultUsdgMintRefusal` in
`packages/core/src/solana-live.ts`): such a mint is `invalid-mint` for paper and
live alike, and live status shows "The USDG mint carries a fee, hook or
extension the vault refuses; trading and exits are paused." Withdrawals do not
check the mint, so they stay available. Once a hook program is set, Token-2022
calls it inside every transfer and it needs its program, its
`extra-account-metas` validation account and the extra accounts that lists:
the vault's `withdraw` forwards its remaining accounts to the transfer
(`spl_token_2022::onchain::invoke_transfer_checked`) and refuses any that
signs, so the owner's signature never reaches a hook and Token-2022 hands the
vault to the hook as a non-signer. The app's withdrawal, `solana-recover` and
the page's check all carry those accounts (`resolveSolanaTransferHookAccounts`
in `packages/core/src/solana-live.ts`, read by
`worker/src/solana-transfer-hook.ts`). A hook whose list asks for a signer,
names the owner's wallet or cannot be resolved refuses the USDG withdrawal
before signing, with its reason ("USDG cannot be withdrawn here: …"), and
`solana-recover` skips only its USDG leg (`custody.rs`
`a_usdg_transfer_hook_never_locks_owner_withdrawals_and_never_gets_a_signer`).

**Owner decision, before the program is frozen: a hook that needs the owner's
wallet holds USDG.** The owner signs every withdrawal, and a transaction's
signer is a signer in every instruction that names it. So the program refuses
the owner's wallet anywhere among the remaining accounts (`Authority`), even
where the hook's list asks for it read-only and not as a signer, for example as
a fixed key or as the owner field of the destination token account. Token-2022's
helper finds each extra account only among those remaining accounts, so leaving
the wallet out fails too (`IncorrectAccount`). Any hook whose extra accounts
include the owner's wallet, signer or not, therefore holds the vault's USDG
until the issuer changes the hook. WSOL and SOL withdrawals carry no hook
accounts and are unaffected. Accepting the wallet read-only would need the
program to read the hook's ExtraAccountMetaList itself; that is not built. The
custody case above asserts the `Authority` refusal for a read-only owner. The
worker reads
the mint in RPC `jsonParsed` form; its test runs on Agave 2.3.13's own decoder
output for the committed bytes and six variants
(`usdg-mainnet-mint.jsonparsed.json`, written offline by
`contracts/solana/scripts/usdg-jsonparsed.mjs`). The production provider's own
`jsonParsed` answer has not been read yet (release gate). Other token issuers
do not inherit the USDG exception: the paper mint screen refuses new buys with
unsafe mint authorities or extensions.

### Live rollout: who may go live, and the platform's caps

`MERRYMEN_SOLANA=1` turns Solana on for every bound tenant at once, and the
program alone lets an owner sign any limits up to 96 operations a day and 168
hours. So live trading is also rolled out tenant by tenant, as Robinhood's is
with `MERRYMEN_FLEET_ROLLOUT`, and its limits are capped by the platform as
Robinhood's vault caps spending at 25 USDG a day
([`solana-live-rollout.ts`](../worker/src/solana-live-rollout.ts),
[`solana-live-caps.ts`](../web/src/lib/solana-live-caps.ts)). The app runtime
reads both from its own env, so the web and the Solana worker decide alike.

- **`MERRYMEN_SOLANA_LIVE_TENANTS`** names the tenants that may go live: 0x
  tenant ids, comma-separated, spaces ignored, case-insensitive. Unset or empty,
  nobody may; paper stays open to every bound tenant. A tenant it does not name
  cannot save live mode, prepare, submit or activate a first permission,
  preview a live buy or place one (manual or autonomous); each is refused on the
  server before any chain read (`SOLANA_LIVE_NOT_OPEN`), and the page offers no
  live switch and says why.
- **Exits-only.** A tenant taken off the list after going live (it has a
  registered permission or a live book) can still sell back to USDG within the
  permission it signed, revoke, withdraw USDG, wrapped SOL and native SOL,
  record withdrawals made outside Merrymen, use paper and read status. Status
  says "Live trading is paused for this account: exits, revoke and withdraw
  still work." as a blocker that leaves exits open, so the worker sells but never
  buys. Exits need a current permission, though: once the one it holds has
  expired or been replaced on Solana, nothing can be sold and no new one can be
  registered off the list, and status says instead "Live trading is paused for
  this account: revoke and withdraw still work. Selling needs a current trading
  permission, and a new one cannot be registered while live trading is paused."
  (likewise for a misconfigured setting). Such an account may save live mode
  again, because live mode is how its exits are sold: each limit at most the
  larger of its cap and the limit of the permission it registered (kept when
  activateLive registered it), so its sales are never narrowed below what it
  signed and never go beyond both. A renewal it prepared and submitted while
  listed that lands after it left the list is still activated: on Solana it
  already replaced the permission before it, so without it nothing could be
  sold. It grants no buys. A first permission that lands after the tenant left
  the list is not activated (the page keeps its session key, and Revoke ends it).
- **Caps.** `MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG` and `…_MAX_DAILY_USDG`
  (default 10 and 25 USDG), `…_MAX_PER_TRADE_WSOL` and `…_MAX_DAILY_WSOL`
  (default 0.1 and 0.25 SOL). Live limits above a cap are refused where they are
  saved, where a permission is prepared and again where its signed bytes are
  submitted, naming the cap, so no permission above the caps in force when it is
  sent reaches Solana. One registered (or already sent) before a deploy lowered
  the caps is activated as signed, and may not buy: each buy, and its preview,
  is refused before any quote by the limits activateLive checked against the
  vault and kept in the session record, and again before signing by the limits
  every provider shows for that session (one provider showing them within the
  caps is not enough); status says so. Its exits keep the limits the owner
  signed: admission bounds sales by the saved limits, so such an account may
  save its live limits again (a mode switch, a new duration) up to the larger
  of each cap and the permission's limit, on the list as off it, and a re-save
  never narrows its exits below what it signed (the page leaves that save to
  the server, which alone holds the permission's limits). A new permission
  within the caps lifts it, and still needs saved limits within them. Paper
  limits are not capped.
- **Buys keep room for exits.** The vault program charges a sale's USDG
  proceeds to the session's per-trade and daily USDG limits, as it charges a
  buy's spend, and the SOL it sells to the SOL sold limits (`swap` in
  `contracts/solana/programs/merrymen-vault/src/lib.rs`); admission counts the
  same way (a sale at the higher of its quote and its reference value when it
  is admitted, raised to its actual proceeds when it lands above them, in the
  transaction that books it). So a buy is refused (`SOLANA_LIVE_EXIT_RESERVE`)
  once it would leave too little of the rolling 24-hour limits to sell the
  account's whole recorded SOL position inside them: the USDG the window
  already used, the buy, and the
  position after it valued at the independent price plus the reference
  tolerance must fit the USDG per 24 hours limit, and that position must fit
  what sales left of the SOL sold per 24 hours limit
  ([`solanaBuyKeepsExitRoom`](../worker/src/solana-trading-store.ts)). What the
  buy brings is counted at the larger of its quoted and its reference-implied
  output plus a **fill margin** of 300 bps
  (`SOLANA_EXIT_RESERVE_FILL_MARGIN_BPS`, the default reference tolerance,
  whatever tolerance is configured): a buy is an ExactIn swap, the program
  enforces only its minimum output, and settlement books whatever landed, so
  neither estimate bounds the fill. The same margin is used before signing, at
  admission and by the strategy's buy sizing. Each
  limit is the lower of the saved one and the registered permission's (as
  every provider shows the vault holding it, and as activateLive kept it): the
  vault charges the exit to its own limits, so limits saved above the
  permission since (the caps raised, say) never let a buy use room the exit
  will not get. It is checked before anything is signed, at the highest price either provider
  serves, and again at admission; it never refuses a sale and never widens a
  limit. The autonomous strategy sizes its buys below it, and a refusal waits
  the strategy interval. At the defaults (10 and 25 USDG, 0.1 and 0.25 SOL) a
  day's buys stop at about 12 USDG, and a position never grows past what one
  day's limits can sell at the price it was bought at (about 24 USDG of SOL, and
  at most 0.25 SOL) unless a fill lands further above its quote than the
  margin. A sale is still at most 10 USDG and 0.1 SOL. Operations are
  not reserved: the owner's own operations per day can still be used up by
  buys. Sales alone, or a rise in the SOL price, can still use up a day's room,
  and status then says so, pointing to Withdraw, which no limit or cap ever
  bounds. A booked position more than the window's limits can sell (a fill
  beyond the margin, booked as it landed; a rise in the SOL price; or daily
  limits lowered since, saved again lower or registered lower) holds buys,
  which the reserve would refuse anyway, with the buys-only blocker
  `SOLANA_STATUS_POSITION_ABOVE_EXIT_ROOM` and a warning naming no one cause:
  `SOLANA_STATUS_EXIT_OVER_NEXT_WINDOW` (sell what the limits allow now, the
  rest as earlier trades leave the window) or, where the position is more than
  a whole window's limits can sell, `SOLANA_STATUS_EXIT_OVER_SEVERAL_WINDOWS`
  (selling all of it takes more than one window). The SOL sold room is always judged;
  the USDG room is priced (at the highest price either provider serves) only
  while a buy made inside the window still counts, so status reads Pyth for it
  only after a buy, and a position that outgrew it by the SOL price alone is
  left to each buy's own check. It never stops a sale. Under 1 USDG left of the USDG limit stops buys and partial sales; a
  sale of the whole position, worth no more than what is left (the exception to
  the live minimum), still fits. Status prices the position then, at the
  highest price either provider serves: while it fits, or nothing is held, it
  says so as a buys-only blocker (`SOLANA_STATUS_DAILY_USDG_BUYS_USED`; the page
  still offers the sale, and the worker waits rather than try a partial one),
  and only otherwise, or when it cannot be priced, as a blocker of exits too
  (`SOLANA_STATUS_DAILY_USDG_USED`). A used SOL sold limit is a warning
  (`SOLANA_STATUS_DAILY_SOL_SOLD_USED`).
- **Malformed settings** (an empty or non-id entry, a cap that is not an exact
  positive amount or does not fit the program's u64, a per-trade cap above its
  daily cap, a USDG per-trade cap under the 1 USDG live minimum) refuse new
  permissions and buys for everyone as configuration, with
  `[alert] solana-live-rollout misconfigured: …` naming the setting (and an
  entry by position, never its value) at most once a minute per process. Exits,
  revoke and withdraw continue.

- **Web and worker must match, and are checked.** Each service reads these
  settings from its own env and applies a change only once redeployed. Each
  publishes a digest of the list and caps it runs
  (`solana_runtime_live_rollout_seen`; the worker with every heartbeat, so its
  digest is never older than its heartbeat; the web as its server starts
  (Next's `register()` in `web/src/instrumentation.ts`), every 30 s after, and
  whenever it serves Solana status, a preview or a trade: at most every 30 s
  while the stored digest is its own, at once when it is not). The web judges the
  worker's digest while it is under 90 s old, and counts a worker whose
  heartbeat is current but whose digest is missing or older (deployed from code
  that publishes none, or whose publish keeps failing) as differing. Both rows
  carry the worker's clock: one stamped ahead of the web's (the worker's clock
  running ahead) counts as current, so skew holds buys rather than skipping the
  check; the web's clock running ahead instead shortens the 90 s window by the
  skew, which NTP keeps to milliseconds. The worker judges the web's latest
  digest whatever its age and counts a missing one (a fresh deployment, before
  the web has started) as differing: only a digest equal to its own lets the
  worker's buys through. While they differ, every live buy is
  held on both (`SOLANA_LIVE_ROLLOUT_DIFFERS`, a buys-only status blocker; trade
  and preview refuse buys as configuration) with
  `[alert] solana-live-rollout differs`. Every change is deployed to the worker
  first, then the web: the worker holds its buys at once, the web holds its own
  until it runs the change too, and the redeployed web publishes its digest as
  it starts, which lets both buy again. No hold or page visit is needed, and
  sales, revoke, withdrawals and paper carry on (hosted-deploy.md, "Turning
  Solana on").
  What the check cannot see: the worker trusts the latest digest written as the
  web's. While the web cannot publish (each failure says
  `[alert] solana-live-rollout unpublished`, once a minute, and it retries every
  30 s), or for up to 30 s after an old web container still draining during a
  deploy wrote its own digest over the new one's (the new one's next publish,
  periodic or at a Solana request, replaces it), that digest is out of date.
  Where it equals the worker's settings, the worker buys under settings the
  running web may no longer run. In the runbook's order the old web's digest is
  never the new worker's settings, so that overlap holds buys rather than
  letting them through; deployed web first, the old worker may buy under its old
  settings during it.

Status carries `liveAccess` (`onList`, `misconfigured` and the caps in force),
never the list itself.

## Independent SOL price (Pyth)

Every live trade, manual or automatic, clears an **independent price floor**.
Jupiter supplies the route and quote; Pyth's SOL/USD price account, read through
both configured Solana RPC providers, supplies the reference
([`solana-reference-price.ts`](../worker/src/solana-reference-price.ts)). The
reference must be owned by the selected generation's receiver program, be the
pinned account, fully verified, the SOL/USD feed
(`ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d`), at most
120 seconds old and within 1% confidence. The signed minimum output may not be
more than `MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS` below the reference (default
300, bounded 50 to 1000, and always above the trade's own slippage). Each
provider's price is read at the prepared slot; a refusal from either refuses
the trade, and the **stricter** bound applies (a buy is held to the lower SOL
price, a sell to the higher). A sell is charged against the USDG limits at the
larger of its quoted and reference value. USDG is taken as $1: a depeg beyond
the tolerance refuses trading rather than guessing. The executor checks the
floor before signing; admission re-verifies it from the persisted submission
and refuses a bound built with any tolerance or generation other than the
configured one. Off-chain admission also enforces the per-trade and rolling
daily SOL sell limits the owner saved, which the vault enforces again on-chain.

**Generations.** Pyth's 2026-08-26 Core upgrade added a second deployment, which
Pyth recommends for new integrations. Both are pinned; the setting switches all
three addresses together and never falls back from one to the other:

| `MERRYMEN_SOLANA_PYTH_GENERATION` | Receiver | Price feed program | SOL/USD account (shard 0) |
|---|---|---|---|
| `current` (default; unset or empty) | `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` | `pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT` | `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` |
| `upgraded` | `rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp` | `pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou` | `7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE` |

Values are exact and lowercase. Any other value refuses every live trade, exits
included, before any quote, as "The independent SOL price source (Pyth
generation) is misconfigured.", shows as a full status blocker and says the
`[alert] solana-reference-price refused: reason=config generation=invalid …`
line (the value itself is never logged). An owner WSOL withdrawal still
prepares, unvalued, so the high-water mark stays put. Only the app runtime reads
the setting, from its own environment, and passes that one generation to its
reads, the executor and admission; a library caller that passes none gets
`current`. Give web and worker the same value. A retry of an already admitted
request is returned or reconciled before the tolerance and generation are
checked, so a changed setting never blocks the replay of a trade in flight.

**What was checked.** On 2026-10-19 a read-only check against a public mainnet
RPC (from slot 458,681,198) reported both generations' programs, accounts,
owners and the `PriceUpdateV2` layout: each account is its price feed program's
shard-0 PDA for the feed id, owned by its receiver, fully verified, exponent -8.
The current account posted every 52 to 53 seconds and the upgraded one every 10
to 15 seconds in that sample. Only the two `getAccountInfo` answers in
`worker/src/solana-reference-price-fixture.ts` were kept; the tests replay those
and re-derive both addresses. The rest of that output was not preserved, so the
heartbeat figures rest on an unpreserved sample. Hermes was not used, because it
has required an API key since 2026-08-26; the runtime never calls it. Re-running
the read-only check of both generations, keeping its output, and a Hermes
cross-check are release gates. If Pyth stops posting to the selected account,
every live trade is refused until the generation is switched.

## RPC trust model

Live trading needs two providers, `MERRYMEN_SOLANA_RPC_MAINNET` and
`MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK`, on different hostnames (case and a
trailing dot are ignored). Hostnames are the only independence check, so pick a
different provider company. Each provider proves mainnet-beta (genesis hash) on
every session. Paper may run on the primary alone. Without the fallback, owners
see "Live trading needs a second, independent RPC provider; an operator must
configure one."

**What needs both providers to agree** (one lying or lagging provider can refuse
or delay these, never decide them):

| Read | Rule |
|---|---|
| Vault deployment | On every provider: upgradeable loader, no upgrade authority, ProgramData region hash equals `MERRYMEN_SOLANA_VAULT_SHA256`, binary declares the configured id. A success is reused for 10 minutes per process and provider pair; failures are never reused. |
| A live trade's pre-sign reads | Vault balances, vault sequence and session epoch, and the Pyth price, from every provider at the prepared slot. Balances, sequence and epoch must be equal; the stricter price bound applies. |
| A live trade's simulation | The exact message to be signed is simulated on every provider at or after its blockhash's bank and must pass the same checks on each (sequence +1, input spent within the amount, output at least the minimum, fee payer cost within the cap). |
| Fill, failure or expiry of a trade | Booked only when both derive the same outcome; disagreement or an unavailable provider leaves it pending and the vault blocked. |
| Owner transactions | Setup, revoke, withdraw, withdraw-sol and resume-buys finish only when both agree; a successful receipt must show its vault mark (epoch for session and revoke, sequence for withdrawals). |
| Inflows | USDG deposits and quarantined WSOL are booked only from finalized balances both report. |
| Outside withdrawals | Each recorded transaction is read on both and booked only if both derive the same effect. |
| WSOL withdrawal valuation | Pyth from every provider; the lowest bound is kept. |
| Operator tools | `solana:resolve` and the shortfall write-off book only when two providers on distinct hostnames agree and no counted provider disagrees. |

**Still one provider's answer** (each can refuse or worsen a trade within the
on-chain caps, never book one): the executor's vault snapshot (cross-checked by
the per-provider sequence and epoch reads above), mint reads, lookup tables,
blockhash, fee estimates (`getRecentPrioritizationFees`, `getFeeForMessage`),
rent, the fee payer's balance, an owner transaction's priority-fee simulation,
the withdrawal cap's finalized read, and the status display (including the
below-book check). Jupiter quotes come from Jupiter.

**Commitment.** Every read is `finalized`: accounts, slots, blockhashes, rent,
simulations, fee quotes, Pyth, mints, the send's preflight, in the app, the
operator tools and `merrymen solana-recover`. Since Alpenglow (mainnet epoch
1064, 2026-10-21; Votor from slot 459,653,000) `confirmed` and `finalized` are
the same state, a block with a finalization certificate about 150 ms after it is
produced, and Agave will remove `confirmed` in a later release. A provider may
still report a signature's status as `confirmed`: the rebroadcast stops on it
as on `finalized`, and only `finalized` settles a trade or an owner
transaction. On a cluster still on TowerBFT (`getAgGenesisCert` answers null)
every read would trail the tip by about 12.8 seconds and a blockhash would have
that much less life; mainnet is past that.

**Slots.** A slot persisted from several providers (an inflow's book slot, a
first book's risk slot, a trade expiry's settlement slot, an owner transaction's
expiry proof, in the app and in `solana:resolve owner`) is the lowest context slot
any of them answered at; an owner expiry books the whole proof read at that slot,
so its slot and height come from one bank. A reading is refused when one provider's slot runs more
than 150 slots (`SOLANA_PROVIDER_SLOT_SKEW`, about 30 seconds at 200 ms slots)
past another provider's fresh finalized slot. A provider a slot or two behind
the prepared slot is asked again up to 5 times, 400 ms apart (about ten slots). The executor
reads the vault no earlier than the later of the book's slot and the latest
finalized owner transaction's slot (a finalized native SOL withdrawal also
raises the book's slot), so a lagging provider errors instead of returning a
stale sequence.

**Expiry proof.** A missing receipt alone proves nothing. Expiry needs, from one
finalized bank (`getEpochInfo`, so height and slot cannot come from two nodes),
a block height past `lastValidBlockHeight` and the vault read at or after that
bank's slot with an unchanged sequence (or, for an owner transaction, its own
unchanged mark), and both providers must show it.

**Sending.** A live swap's signed bytes go to both providers and are rebroadcast
every 2 seconds until a provider reports the signature finalized (or
`confirmed`), both report the blockhash invalid, or the signed `execute_swap`
deadline passes (at most about 30 seconds after the quote). A blockhash lives
150 blocks: about 30 seconds at 200 ms slots, so it and the deadline now end at
about the same time. Bytes are never re-signed, so a signature can
land at most once. A manual trade request or an agent tick can therefore take
up to that deadline under congestion. Owner transactions get the same
two-provider send with a 15-second window, and each status read re-sends saved
owner bytes while no provider has seen them and their blockhash is valid. The
owner's 45-second review window and the server's 60 seconds
(`expiresAtMs`) now outlast that blockhash: bytes signed after about 30
seconds cannot land and expire like any others. The 60 seconds must never be
shorter than a blockhash's life, since an unsigned prepared withdrawal counts
as lapsed once they pass.

**Swap priority fee.** The compute-unit price is the 75th percentile of recent
fees on the swap's writable accounts, clamped between
`MERRYMEN_SOLANA_COMPUTE_UNIT_PRICE_MICROLAMPORTS` (minimum, default 0) and
`MERRYMEN_SOLANA_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS` (default 1,000,000), and
paid only from what the fee payer holds beyond one swap's needs (the temporary
account's rent and two signatures), all within `MERRYMEN_SOLANA_MAX_FEE_LAMPORTS`
for fee plus rent. A low payer therefore lands exits at a lower price instead of
refusing them. The reserved fee is never below the runtime's own charge.

**Settlement with truncated logs.** Agave caps logs at 10,000 bytes and the
vault event is emitted last. A success is booked from the exact signed bytes,
`meta.err === null` and the vault token balance rows; complete logs must also
carry the matching event, and truncated or missing logs need a finalized vault
read after the receipt whose sequence has moved past the swap's. Failures never
need logs.

**Privy.** With `MERRYMEN_SOLANA=1` the web app registers Privy's
`defaultSolanaRpcsPlugin()`, so Privy's signing screen reads Solana through
Privy-hosted endpoints keyed by the public Privy app id. Merrymen's own RPC URLs
and keys never reach the browser. Privy can see those reads (owner address,
transactions under review); it already holds the wallet.

## Settlement and accounting

Amounts, limits and cost basis use integer base units. Quotes, mint observations
and risk evidence expire within 30 seconds. Evidence freshness and current
limits are rechecked after obtaining the database lock, so a slow concurrent
writer cannot turn old approval into a new trade.

A live request stores its exact signed transaction, signature, sequence,
evidence and reserved budgets before any send. Request IDs are scoped to the
bound account and reject changed intent payloads. Database uniqueness prevents
two pending submissions for the same vault. An interrupted or ambiguous send
reconciles the saved signature; it never silently creates a replacement trade.
Pending trade and owner-operation reconciliation continues after mode changes,
strategy disablement or session-key rotation; the worker reads status for every
account with a pending owner transaction in either slot, so receipts settle with
the page closed. Every send site, rebroadcasts included, is pinned to its
durable record by `worker/src/admission-invariant.test.ts`, which also checks
that the owner-run recovery tool stays unreachable from the server.

**The trade floor.** A trade intent may carry `minOutAmount`, the previewed
quote's guaranteed output. Live and paper refuse before anything is signed,
recorded or sent when the fresh quote guarantees less, with 409 "The price
moved. Preview again; nothing was sent." and `freshMinOutAmount` (what the fresh
route guarantees). The floor is not part of the request ID: a retry of a
recorded request returns it whatever floor it carries. The page drops the stale
preview and offers the fresh minimum for one explicit click within the
preview's lifetime, with the same request ID; the server never trades at the
fresh minimum on its own.

Worker shutdown cancels new admission and broadcast, including work queued
behind a database lock. If cancellation arrives after the signed request was
committed, that request stays pending for recovery; the worker reconciles its
saved signature rather than issuing a replacement.

Finalized settlement binds the saved signed bytes, signatures, loaded lookup
addresses, slot, transaction status, program-event invocation stack, token
programs, owners and mints, balance deltas and actual fee. Successful exits
allocate cost basis exactly; network fees are tracked separately in lamports.
Failed finalized transactions record their actual network fee and no fill.

An expired submission becomes terminal only on the two-provider expiry proof
above. That proves no successful swap; it does **not** prove that no failed
attempt paid a fee. Such records keep `feeLamports: null`, an unresolved-fee
count and a reserved fee allowance; the UI marks incomplete fee totals.
Contradictory or insufficient evidence leaves the request pending and holds new
exposure. A trade whose vault sequence moved for another reason (an owner
withdrawal outside Merrymen) is never booked automatically; an operator books
it with `solana:resolve` on two providers' debit-log proof
([Operator runbooks](#operator-runbooks)).

**Daily operations.** `maxOpsPerDay` counts pending, finalized and failed live
attempts, and by default proven-expired attempts too
(`MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE`, default 0). At most
`maxOpsPerDay + allowance` transactions are signed a day and at most
`maxOpsPerDay` land. Once the day's operations are used, status shows a full
blocker and trades and automated exits pause until operations leave the
window; owner withdrawals and revoke never count.

**The live book** starts with USDG only. Finalized USDG above the book, read on
both providers, is booked once as capital in, raising the high-water mark. WSOL
that reaches the vault outside recorded trades is booked once as
**quarantined** capital: zero cost basis, never traded or valued, excluded from
equity, P&L and the high-water mark. A first book on a vault that already holds
WSOL starts with it quarantined. Admission and exits size against the book, so
an excess not yet booked blocks nothing. Inflows are booked from balances,
because deposits are plain transfers: an off-book loss and a deposit that fall
between two reads net against each other (a vault-sequence anchor would fix
this; not built). A balance **below** the book is never a gift; see
[A vault below its book](#a-vault-below-its-book). A balance read from a bank
older than the book shows "Vault balances were read from before the latest
recorded trade; trading waits for a current read." instead.

## Owner transactions and recovery

The owner signs and pays for revoke, withdraw (USDG or WSOL), withdraw native
SOL and resume buys. Withdrawals return tokens to the owner's canonical account
(WSOL arrives wrapped) and remain available with expired or revoked session
authority. Finalized withdrawals advance the on-chain sequence and are booked
once as capital out; WSOL basis is removed proportionately without inventing a
sale.

- **Before the wallet opens**, the page decodes every owner transaction: a v0
  message the owner alone signs and pays for, exactly the instructions the
  runtime builds for the request, for the owner's own vault and program, with
  the amount typed, and a SyncNative only for a WSOL withdrawal. It shows what
  the transaction does, its priority fee and the SOL the wallet must hold and
  holds, with Sign and Discard; signing is offered for 45 seconds. Anything else
  is refused with nothing signed. `SolanaServerContract.test.ts` pins this check
  against the runtime's real bytes.
- **Priority fee.** Priced from a simulation (units used × 1.2 + 40,000) at the
  75th percentile of recent fees on the accounts the transaction writes, capped
  at 0.001 SOL and at what the owner wallet holds beyond the transaction's own
  needs. The compute-unit limit is never below 200,000 per non-ComputeBudget
  instruction (at most 1,400,000). With no estimate, nothing to spare or a read
  slower than 3 seconds, the transaction goes without a fee; the fee never
  causes a refusal.
- **Required SOL.** Every prepared owner transaction returns `ownerLamports` and
  `requiredLamports` (5,000-lamport signature fee, rent of accounts it opens,
  the priority fee and the wallet's own rent-exempt minimum of 890,880
  lamports). Prepare refuses with an explanation when the wallet holds less.
- **Native SOL.** `withdraw-sol` takes lamports above the vault account's rent
  reserve (`status.live.recoverable.nativeLamports`). Native SOL sent straight to
  the vault's WSOL account is synced first by a WSOL withdrawal and booked as
  quarantine, spent first.
- **WSOL withdrawals and the high-water mark.** When an in-app WSOL withdrawal
  reaches the booked position, prepare records an executable Jupiter WSOL→USDG
  quote at 50 bps and the Pyth bound for the same amount; when it lands, the
  high-water mark drops by the withdrawn share of the lower of the two, so
  withdrawing capital is not drawdown. If either cannot be read the withdrawal
  still goes ahead and the high-water mark stays, so the owner may need
  resume-buys. Quarantined WSOL leaves first and never moves the high-water mark.
- **Withdrawal cap.** An in-app withdrawal offers at most the lower of the book
  and the vault's finalized balance (plus synced SOL for WSOL), and refuses more
  with "Your vault holds less of this asset than Merrymen's records … Nothing
  was prepared."
- **One owner transaction at a time, revoke always.** While a submitted owner
  transaction is unresolved, the server prepares no other ("Refresh the pending
  owner transaction before preparing another."), and trades are held. A
  revocation can always be prepared and submitted beside a pending withdrawal,
  native withdrawal, resume or permission registration: it is stored in
  `solana_runtime_owner_revokes`, marked beside that signature, settled by its
  own signature and reported as `live.ownerTransaction.revoke`. A registration
  with a signed revocation beside it is never activated; the owner registers
  again. Activation is refused for good when a revocation or another permission
  landed after the permission was prepared ("A revocation or another permission
  landed on Solana after this permission was prepared, so it is not
  activated…"), and the page then discards its session key. Activation waits
  while a revocation prepared beside the permission can still be signed (about
  a minute). Once a
  revocation beside the pending record has landed, another one is refused
  unless a permission registered after it is live on Solana; then status shows
  "A trading permission that landed on Solana after your revocation is still
  active there until it expires. Merrymen never uses it; revoke again under
  Owner controls to end it." and Revoke works again. A finalized resume-buys
  with a revocation signed beside it leaves buying paused.
- **Unknown outcomes.** A refusal before anything was saved carries
  `notSaved: true` (400 for malformed or mismatched bytes, 409 for state
  refusals). It speaks only for that request. Failures to read or book the
  outcome of saved bytes answer 503 with a fixed unknown-outcome text. The page
  keeps signed bytes after an unknown outcome and resubmits them unchanged; it
  decides from its own sends and the server's record, never from `notSaved`
  alone. 401, 403, 404, 408 and 429 never discard bytes.

**Withdrawals made outside Merrymen.** After `solana-recover` or any wallet
holding the owner key, the owner pastes up to 8 transaction signatures under
Owner controls → "Withdrew outside Merrymen?" (`POST /api/solana/owner
{ stage: "record", action: "external-withdrawals", signatures }`). Each is read
on both providers and booked only as an owner-signed, top-level vault withdraw
for this vault, by the vault token account's net decrease, once (evidence
`external:<signature>:<mint>`), and only if it came after the book's last
absolute balances. Transactions with lookup tables, a SyncNative without a WSOL
withdraw, a vault call through another program, or anything else touching the
vault are refused, not partly booked. USDG lowers cash and the high-water mark.
WSOL leaves quarantine first, then the position at basis; the high-water mark
drops by the lower of its value when recorded and its prorated cost basis, so
owners should record promptly. A sweep that also took an unbooked deposit books
that inflow first (evidence `external-in:<signature>:<mint>`). An in-app
withdrawal the owner already recorded this way is never submitted or booked
again. Recording may lower the book while an in-app withdrawal is prepared;
the store re-checks every owner withdrawal against the book under its lock,
when prepared and again when signed, so one that the book no longer covers is
refused before it is saved or sent ("The withdrawal exceeds the recorded vault
balance…"), and a withdrawal that lands can always be booked.

**Owner recovery without Merrymen.** `merrymen solana-recover` (or `npm run
solana:recover`) reads the owner key from a file or standard input, never the
command line, and takes the RPC from `MERRYMEN_SOLANA_RECOVER_RPC` (set with
`read -rs MERRYMEN_SOLANA_RECOVER_RPC; export MERRYMEN_SOLANA_RECOVER_RPC`, then
paste); `--rpc` is only for a keyless URL, and giving both is refused. It reads
no other environment variable and does not load `.env.solana.local`.

1. Preview: `merrymen solana-recover --program PROGRAM_ID --owner OWNER_PUBKEY`.
   `--owner` must be a wallet address on the ed25519 curve; a pasted secret or a
   PDA is refused unread.
2. Send: `pbpaste | merrymen solana-recover --program PROGRAM_ID --key-file - --send`.
   Step 1 sends `revoke_all` alone and waits for finalization. Step 2 withdraws,
   from finalized balances, the vault's spare SOL, all USDG and all WSOL (it
   arrives wrapped), each in its own transaction; an asset whose owner account
   is frozen is skipped with a note. The owner pays fees plus about 0.002 SOL for
   each token account it creates.
3. If a leg reports "outcome unknown, it may still land" (with its signature),
   wait about two minutes and run again: it re-reads finalized state, and a
   duplicate can only fail. Delete the key file afterwards.

`--send` signs only for a program listed in `SOLANA_VAULT_RELEASES`
(`packages/core/src/solana-live.ts`), after checking that its immutable binary
hashes to the released value and declares its own id. For another program it
needs both `--program-sha256 HEX` and `--unlisted-program`, warns and waits 15
seconds; the help says Merrymen never asks for that flag (policy text awaiting
Milla's confirmation). The list is empty today, so `--send` refuses every
program until the first release. About 0.0165 SOL of rent stays locked, because
the program has no close instruction. Mainnet only.

The web's **"Back up your owner key"** card is off unless the web build sets
`NEXT_PUBLIC_MERRYMEN_SOLANA_OWNER_KEY_EXPORT=1`. It shows only to the bound
owner, only for a live binding whose vault the server has read, and opens
Privy's own export window for that embedded wallet; the key never reaches the
page. Step 2 names the read-only `--owner` plan for an unlisted program and the
`--send` command with the pinned hash only for a released one; the hash comes
from the pin, never from the server. Export needs the site up, so an offline
copy is the real fallback, and a leaked key cannot be revoked. Keep the flag off
until wallet export is enabled for the Privy app and the deployed program's
release entry ships in the published CLI.

## A vault below its book

**What it means.** The vault's finalized USDG or WSOL balance is below its book
(cash; position plus quarantined WSOL) while no live trade is pending and no
signed owner transaction is unresolved. Tokens left the vault outside Merrymen.
A trade or in-app withdrawal that has landed but not settled is not a shortfall.

**What you see.** Status shows the full blocker "Vault balances are below
recorded trades. If you withdrew from the vault outside Merrymen, with your owner
key in another wallet or tool, record those withdrawals under Owner controls;
until the records match the vault, trading and automated exits stay held." The
Solana worker logs, at most every 10 minutes per account:

    [alert] Solana vault below its book: … {"solana":"alert","kind":"vault-below-book","account":"<16-hex ref>"} — …

The account reference is the first 16 hex characters of
`sha256('merrymen-solana-account/v1 <tenant> <owner>')`; no tenant or owner is
logged.

**Effect.** Trading and automated exits are held and admission refuses every
trade. The owner can still revoke, and can withdraw at most what the vault holds.

**How it is reconciled.**

1. Ask the owner whether they withdrew outside Merrymen (`solana-recover`, or
   another wallet holding the owner key). If so, it is not a loss: they record
   the signatures under Owner controls ("Withdrew outside Merrymen?"), each is
   booked as capital out, and trading resumes.
2. Otherwise find what moved the tokens (an issuer's action on a token account,
   a booking error). `npm run solana:resolve -- shortfall show <account-ref|tenant>`
   shows each provider's finalized balances, read at or after the book's slot,
   beside the book, and exactly what a write-off would book. It writes nothing.
   The configured primary and fallback must report the same balances; add
   `--third-rpc` (URL from `MERRYMEN_SOLANA_RESOLVE_THIRD_RPC`) and set a dead or
   lying provider aside with `--exclude primary|fallback|third`.
3. Once the cause is known, `npm run solana:resolve -- shortfall book
   <account-ref|tenant> --operator NAME --reason "why"` writes it off as a
   **loss**, never capital out. It needs two providers on distinct hostnames to
   agree, every provider not excluded to be readable, and nothing pending (no
   trade, no owner transaction, no unexpired prepared withdrawal). Cash and the
   position fall to the vault's balances; realized P&L falls by the lost USDG
   and the lost position's cost basis (quarantine leaves first, at no P&L); the
   high-water mark stays, so the drawdown breaker sees the loss; buying pauses
   until the owner resumes it. An excess on the other asset is booked as an
   inflow. The decision (operator, reason, every provider's view by hostname
   hash) is written to `solana_operator_shortfalls` and marked booked in the
   same transaction as the write-off. `shortfall history <tenant>` lists them.

Never hand-edit `solana_runtime_live_books`. If an operator writes off what was
really an owner withdrawal, the result is conservative (P&L understated, buying
paused) and that withdrawal can no longer be recorded as capital out. No tool
lowers a book slot that is already inflated (not needed for a fresh deployment).

## Paper use and autonomous worker

In `/solana`, verify the wallet, save paper limits and create a simulated
portfolio. Previews and trades use real provider quotes; paper fills use the
quoted minimum output. Results are marked simulated and exclude network fees
and rent. Paper books cannot be refilled or reset. Repeating a committed request
returns its stored receipt, including when providers are offline or the policy
has expired. A partial sell must leave an amount that a route still buys back;
one that would leave dust is refused ("sell the whole position, or less of
it"), and a quote outage on the remainder also refuses a partial sell, while a
whole exit always works. Existing dust is valued at zero for buys and listed in
the receipt's `zeroValuedMints`.

**Hosted paper write-off.** `POST /api/solana/paper/write-off { mint }`
(authenticated and tenant-bound, paper mode only, owner-only, allowed under an
operator hold, paced with the preview bucket) writes off the whole lot only on
Jupiter's zero-output answer for it (at most 100 bps, quoted within 30 seconds).
The cost basis becomes a realized loss; cash, the peak and the rolling caps do
not move. The page offers it only after the market answered a whole-lot sale
with zero output, and asks for confirmation that it cannot be undone. A token
with no route at all (delisted) cannot be written off.

The local CLI is a separate simulation tool. Its `--owner` is only a book label,
not wallet proof or a funding address, and the CLI refuses hosted mode. Its
SQLite file is `MERRYMEN_HOME/solana-paper.sqlite` (default `~/.merrymen`):

```sh
npm run check:solana-rpc
npm run solana:paper -- --help
npm run solana:paper -- init --owner YOUR_PUBLIC_KEY
npm run solana:paper -- status --owner YOUR_PUBLIC_KEY
npm run solana:paper -- trade --owner YOUR_PUBLIC_KEY \
  --input 2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH \
  --output So11111111111111111111111111111111111111112 \
  --amount-raw 1000000 --request-id paper-buy-001
npm run solana:paper -- renew --owner YOUR_PUBLIC_KEY [--expires-days N] [--per-trade USDG] \
  [--daily USDG] [--max-ops N] [--drawdown-bps N] [--loosen]
npm run solana:paper -- write-off --owner YOUR_PUBLIC_KEY --mint MINT
```

The default local book has 1,000 simulated USDG, 25 USDG per trade, 100 USDG per
rolling day, 20 operations per day, a 10% drawdown limit and seven-day expiry.
`renew` changes only the limits named, prints what changed and appends the old
and new limits to the book's `limitsHistory`. Raising a limit needs `--loosen`;
lowering never does. Without `--expires-days`, an expired book gets 7 days from
now, a bare renew extends a running book to 7 days from now (or keeps a later
expiry), and a renew that changes a limit keeps a running book's expiry. It
never changes cash, positions, P&L or receipts, and has no `--cash`. `write-off`
keeps Jupiter's zero-output answer as evidence in the book's `writeOffs`.

The dashboard's autonomous strategy maintains a chosen USDG/WSOL allocation,
with a rebalance threshold, maximum USDG per trade and check interval. It sizes
using executable exit quotes and integer arithmetic, re-quotes partial exits,
and never raises a cap to obtain a fill. "Check every N seconds" is a durable
minimum spacing between admitted attempts (`solana_runtime_autonomous_attempts`);
after a check in band the worker waits a full interval. Autonomous request IDs
are `rebalance-<settings revision>-<attempt>`, reserved for the strategy; a
proven-expired attempt is retried at once under the next ID and never re-sent.
A live account whose day's operations are used is held before any paid read.
The worker logs `{solana:'tick', submitted, replayed, held, waiting,
unavailable}` only when a tick did more than wait.

```sh
npm run start:solana
# Equivalent CLI entry point with environment already supplied:
merrymen solana-agent
```

This is a separate worker from the RH fleet. In the container the role is
`MERRYMEN_START=start:solana`. Hosted operation uses the shared database; it
does not fall back to an ephemeral SQLite file. The hosted deploy guard requires
the matching Solana service identity, `DATABASE_URL` and the expected Docker
image marker, and rejects the RH fleet service. See
[hosted deployment](hosted-deploy.md). No service has been deployed by this work.

**Stopping `merrymen solana-agent`.** The first Ctrl+C, SIGTERM or SIGHUP stops
after the current tick. A second press more than 1.5 seconds later forces the
stop (exit 128 + the signal number), and a wedged worker is SIGKILLed 3 seconds
after that; presses within 1.5 seconds count once, because a terminal and an npm
or npx launcher deliver one Ctrl+C twice. If the command dies, the worker stops
after its tick and exits within 60 seconds; a worker whose command was already
gone when it started never opens storage or trades. A forced stop is recovered
like a crash: a paper fill is all-or-nothing and a live swap is saved before it
is sent.

**Kill switches.** "Kill all agents" on `/you` and Telegram `/kill` turn the
tenant's Solana strategy off as well as removing the RH grant, `MERRYMEN_SOLANA`
on or off. Before touching the Solana store they look `solana_wallet_bindings`
and its `strategy_json` column up read-only (`to_regclass` and `pg_attribute` on
PostgreSQL; `sqlite_master` and `pragma_table_info` on SQLite). If either is
absent, Solana was never used: nothing is created, no Solana lock is taken and
the Robinhood kill reports done. A kill never runs Solana DDL and never waits on
the binding store's schema step (which itself alters the table only when the
catalog shows the column missing). If present, the strategy is saved disabled
with a revision bump that also refuses any autonomous admission in flight.
Hosted, both paths remove the RH grant first, so a Solana fault never keeps it
stored, and the strategy is stopped even when that removal throws; if the
Solana write fails the kill is not reported done (web 503 "Kill incomplete",
retry safe; Telegram keeps the request pending and sends one ✅ once both are
done). Self-hosted, every kill (the web's, Telegram `/kill` in the worker and
`merrymen kill`, through `worker/src/solana-kill-cli.ts`) stops every strategy
in the local accounts file FIRST, whatever then happens to the RH grant: an
archive it cannot write keeps grant.json and pauses trading (web 409, which
says whether the Solana strategy stopped), and a kill with no grant still stops
the strategy. A Solana stop that fails is said (web 503 or 409 `solana:
"not-stopped"`, Telegram "Kill incomplete … /kill again", CLI exit 1). A kill
does not revoke the on-chain session; the owner's revoke does.

## Operator runbooks

Every operator command loads `.env.solana.local` if present, uses `DATABASE_URL`
for the hosted shared database (otherwise `MERRYMEN_HOME/solana-accounts.sqlite`),
never prints or records an endpoint URL (providers appear as labels and a short
hostname hash), and never signs or sends a transaction.

**Hold trading.** An operator hold stops all new Solana trades, paper or live,
manual or automatic, for one tenant or everyone, within one worker tick and
without a redeploy. Receipt recovery and owner revoke, withdraw and resume
continue.

```sh
npm run solana:hold -- set 0xTENANT --reason "incident 42"   # or: set all --reason "…"
npm run solana:hold -- list
npm run solana:hold -- release 0xTENANT                      # or: release all
```

**Turning Solana off.** Hold trading first (`npm run solana:hold -- set all
--reason "…"`): trades stop within a tick and owners keep revoke, withdraw and
strategy-off in the app. Then stop the Solana worker service (or unset its
`MERRYMEN_SOLANA`, which keeps it from starting again). Unset the web's
`MERRYMEN_SOLANA` last, and only once no owner needs the app's owner controls:
with it unset every `/api/solana` route answers 404, so an owner's only in-app
stop left would be "Kill all agents", which also deletes their Robinhood grant.

**Find what is stuck.** `npm run solana:resolve -- pending` lists every live
trade and signed owner transaction (both owner slots) pending over 3 minutes:
tenant, what, id, age, vault sequence and the command that shows its evidence.
It reads the database only.

**A stuck live trade.**

```sh
npm run solana:resolve -- show <tenant> <request-id> [--third-rpc] [--exclude primary|fallback|third]
npm run solana:resolve -- book <tenant> <request-id> --operator NAME --reason "why" [--third-rpc] [--exclude …]
npm run solana:resolve -- history <tenant> [<request-id>]
```

`book` books only when two providers on different hostnames derive the same
final outcome from finalized evidence and none reports another. An expiry is
never booked while any provider (an excluded one included) has seen the
signature, or while any provider not excluded could not be read. A trade whose
vault sequence moved for another reason is booked as expired only on each
provider's proof from the vault's debit log that no swap ran inside its signed
window ("sequence-consumed"); a debit inside the window refuses it however many
providers agree, and the operator should look for the trade's fill. `show`
explains a provider that cannot prove it (not-asked, behind, blockhash-live,
debit-in-window). `--third-rpc` is a switch: the URL comes from
`MERRYMEN_SOLANA_RESOLVE_THIRD_RPC`, never the command line (a URL argument is
refused without being echoed). `--exclude` sets aside one provider that reports
a conflicting outcome or cannot be read; its view is still shown and recorded.
Decisions go to `solana_operator_resolutions` and are marked booked in the same
transaction that books the trade; a decision the worker's automatic settlement
beat is recorded as superseded. A receipt no provider's answer can be parsed
from (a parser gap) cannot be resolved this way; it needs a code fix. If the
tool's generic error appears, run `show` first: the outcome may or may not be
booked.

**A stuck owner transaction.**

```sh
npm run solana:resolve -- owner show <tenant> [<signature>] [--third-rpc] [--exclude …]
npm run solana:resolve -- owner book <tenant> <signature> --operator NAME --reason "why" [--third-rpc] [--exclude …]
npm run solana:resolve -- owner history <tenant>
```

`owner book` finishes one only when two providers on their own hostnames agree:
on the same receipt, or on no receipt anywhere past `lastValidBlockHeight` with
the vault read at or after that bank. "Never ran" needs that no provider has seen
the signature and every counted one could be read. When the vault moved for
another reason, the proof is recorded as `operator-no-receipt` with the decision
id. Decisions go to `solana_operator_owner_resolutions`.

**A vault below its book.** See [A vault below its book](#a-vault-below-its-book)
(`shortfall show|book|history`).

**Recording withdrawals made outside Merrymen.** This is the owner's action, not
the operator's: the owner records signatures under Owner controls. An operator
helps the owner find the signatures (an explorer search on the vault address)
and never books a decrease by hand. An in-app withdrawal an operator booked as
never run (`operator-no-receipt`) can be recorded this way by its own signature.

**Alert lines and what to do.** Page on every line starting `[alert]` in the
web and Solana worker services' logs (stderr). Each repeats at most at the
interval shown while it persists.

| Line (prefix) | From | Meaning | What to do |
|---|---|---|---|
| `[alert] Solana fee payer is low` / `cannot fund buys` / `cannot fund exits: every tenant's exits are blocked` (JSON `kind: fee-payer-<level>`); recovery `{"solana":"fee-payer-ok",…}` | web and worker (status), and the worker's own check every 10 min while any live permission is registered | The shared fee payer is below the low watermark, or below one buy's or one exit's needs | Fund the fee payer. Below the exit level every tenant's exits stop. Repeats every 10 min. |
| `[alert] solana fee-payer-threshold misconfigured` | web and worker | `MERRYMEN_SOLANA_FEE_PAYER_LOW_LAMPORTS` is not a whole number above zero; the default (4 × fee cap) is used | Fix the setting. Trading continues. Every 10 min. |
| `[alert] solana-reference-price refused: reason=<…> generation=<…> …` | web and worker | A Pyth read was refused (stale, missing, foreign, layout, unverified, …); no live trade is admitted, and no live permission is prepared, until a fresh, fully verified price is read (max age 120 s). Recovery: `[solana-reference-price] read again: …` on stdout | Check Pyth posting and both providers. `reason=config generation=invalid` means `MERRYMEN_SOLANA_PYTH_GENERATION` is wrong: fix the setting, it is not an outage. First refusal and new reasons at once, then at most every 60 s. RPC transport failures go to provider failover and are not alerted here. |
| `[alert] solana-reference-tolerance misconfigured` | web and worker | `MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS` unreadable; every live trade, exits included, is refused | Fix the setting (50 to 1000). At most once a minute. |
| `[alert] solana-jupiter-key misconfigured` | web and worker | `MERRYMEN_JUPITER_API_KEY` is set but unusable; every quote and live route, exits included, is refused | Fix the key. Unset or empty is "not configured" (a status blocker, no alert). At most once a minute. |
| `[alert] solana-live-rollout differs: …` | web and worker | The web and the Solana worker run different `MERRYMEN_SOLANA_LIVE_TENANTS` or `MERRYMEN_SOLANA_LIVE_MAX_*` settings (one was redeployed without the other), and every live buy is held on both, status saying so. From the web, also: the worker is running but has not published its settings for over 90 s (the web's buys are held). From the worker, also: the web's latest digest, whatever its age, differs (`the web last published different …`: the web runs other settings, or cannot publish its own, which its `[alert] solana-live-rollout unpublished` says), or there is none yet, as on a fresh deployment before the web has started (`the web has not published …`); the worker's buys are held | Deploy both with the same values, the worker first (hosted-deploy.md, "Turning Solana on", step 4): the web publishes its settings as it starts and every 30 s after, and the worker's buys resume at its next check. If both already run the same values, look for the web's `[alert] solana-live-rollout unpublished`. Exits, revoke and withdraw continue. At most once a minute per process. |
| `[alert] solana-live-rollout unchecked: …` | web and worker | Status could not write this service's live rollout digest or read the other's (`solana_runtime_live_rollout_seen`: SQLite busy past its timeout, a PostgreSQL write error or statement timeout); it counts as differing, so live buys are held (status says so as a buys-only blocker), while status itself still answers | Check the database the line's service uses (locks, disk, connection). Exits, revoke and withdraw continue. At most once a minute per process. |
| `[alert] solana-live-rollout unpublished: …` | web and worker | From the worker: it wrote its heartbeat but could not publish its live rollout digest beside it; the web counts the worker as running settings it cannot check and holds every live buy (`[alert] solana-live-rollout differs` from the web). From the web: its publish as it started, or every 30 s after, failed; the worker judges the last digest written as the web's, which may be out of date: where that differs from the worker's settings its buys are held, and where it equals them (this web's settings before it was redeployed, say) the worker may buy under settings this web no longer runs | Check the database the line's service uses (`DATABASE_URL`, locks, disk, connection). Receipt recovery, the strategies' exits, revoke and withdraw continue. From the worker at most once every ten minutes while it persists, and at once again after it clears; from the web at most once a minute while it persists (it retries every 30 s, and at every Solana request). |
| `[alert] solana-live-rollout misconfigured: <setting and entry position>` | web and worker | `MERRYMEN_SOLANA_LIVE_TENANTS` or a `MERRYMEN_SOLANA_LIVE_MAX_*` cap cannot be read; no new live permission or live buy is admitted, for any tenant | Fix the setting the line names (the value is never printed). Exits, revoke and withdraw continue. At most once a minute. |
| `[alert] Solana transactions stuck pending` (JSON counts and oldest age) | worker | A live trade or signed owner transaction has been pending over 3 minutes; each holds its account (no new trade, no owner transaction but a revoke) | Check both providers; `npm run solana:resolve -- pending`, then `show` / `owner show` and, with evidence, `book`. Every 10 min. |
| `[alert] Solana vault below its book` (`kind: vault-below-book`, account ref) | worker | Tokens left a vault outside Merrymen | [A vault below its book](#a-vault-below-its-book). Every 10 min per account. |
| `[alert] Solana autonomous strategy refused: proven-expired attempts used up an account's daily operations` (`kind: expired-attempts-exhausted`) | worker | Automated trades and exits of that account pause until the attempts leave the 24 h window | Check provider health and congestion. Raising `MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE` is an owner decision. Every 10 min per account. |
| `[warn] Solana proven-expired attempts use more than half of an account's daily operations` (`kind: expired-attempts-high`) | worker | Early warning for the line above | Watch; same remedies. |
| `[warn] Solana autonomous rebalance below the live minimum` (`kind: below-live-minimum`, account ref, side, interval) | worker | Admission refused an account's strategy trade as worth under 1 USDG at the reference; the strategy tries again once per interval | Nothing for the operator. The owner's strategy size, USDG per trade and SOL sold per trade must each be worth at least 1 USDG; a small vault's rebalance stays below it until it grows. Every 10 min per account. |

Point the log alert that already watches the orchestrator's `[alert]` lines at
the web and Solana worker services too. Not alerted yet: a stale worker
heartbeat, both providers failing at the transport level, and verify-time
refusals.

## Identity backstops on shared surfaces

These change Robinhood-facing surfaces and apply whether or not Solana is on.

**Glued ids.** `onchainIdsIn(text, { glued: true })` (core, with Brain's Python
mirror in `services/brain/brain/onchain_ids.py` pinned to the same answers by
`services/brain/tests/data/onchain_ids.json`, run by CI's `brain` job, a
required part of `app`, with dependencies capped below their next major in
`services/brain/requirements-ci.txt`) also finds a Solana key or
signature written against neighbouring letters or digits (`CA<mint>`,
`<mint>is`, `tx<sig>done`, `0x<key>`). It reads every maximal base58 run; a run
is a hit when it, or any window of it, decodes to exactly 32 or 64 bytes. Hex-only
runs and short-period filler are never hits, and a scan past its 4,096-decode
budget counts the rest as ids unread (fail closed). Where it is used:

- withheld on a hit (fail closed): X posts and suffix re-checks, social takes,
  published theses and model posts, the room's and the X writer's coin names,
  and the coin name drawn on a P&L card;
- before a model reads content: Brain's own validator, the worker's re-checks of
  Brain's decisions and desk answers, X tags and comments, room prompts, and the
  soul's memory and notes (which refuse such a line) and journal (which redacts);
- model-facing redaction: Telegram event text (`redactAddresses`), room prompts
  and the soul's journal replace Solana ids, longest first and before any 0x
  rule, with `[address]`; a Solana signature becomes `[signature]` (a 64-byte run
  can hide a key); an exact 0x + 64-hex run becomes `[hash]` and any other 0x run
  of 20 or more hex digits `[address]`. The owner's own report, `/status`,
  alerts, trade notices and `/why` keep their hashes;
- the default scan, deliberately: name checks that must read a run inside a
  longer word as no id, and the X advice decline.

**Measured false-positive profile** (corpus run 2026-10-19, rerun 2026-10-20). Of
what the default scan leaves alone, the glued scan newly flags 0 of 18,844
markdown prose lines, 0 of 1,123 code-fence lines, 0 of 20,000 ticker or
cashtag lines, 0 of 20,003 URLs, 0 of 30,003 UUIDs, EVM ids, emails, ENS names,
DIDs and bitcoin addresses, and 0 of the real hashtags tried. It flags 2 of
40,232 product string literals and 5 test literals (IPFS CIDs). The cost is in
unbroken base58 runs of 43 or more characters: synthetic camelCase hashtags are
flagged 0% under 43 characters, about 11% at 43 to 59 and about 22% at 60 or
more; also about 1% of `commit<sha>` strings, about 1.7% of 10-to-200-digit
numbers glued to a word (0.3% of a corpus of long numbers written every way),
and about 38% of opaque tokens (by design). Positive control: 2,000 of 2,000 keys
and signatures glued to text are caught (the default scan catches 63). On X and
social takes such a post is withheld; for a model it shows as `[address]`. A
long hashtag broken by a character base58 lacks (`l`, `I`, `O`, `0`) is never
flagged.

**Secret keys.** `solanaSecretsIn` (core `ids.ts`) finds a Solana secret key
standing alone, as a 64-value JSON byte array, or glued to letters or digits
(`pk<K>`, `%22<K>%22`, `secret:<K>x`). Exact candidates are capped at 256 per
scan and fail closed past the cap (the 257th standalone signature-length run is
refused). Windows inside runs are read best effort under budgets of 256 keypair
checks, 4,096 decodes and 262,144 window starts (edges first, shortest run
first); past that budget a deeply glued key is missed and nothing is refused (a
decision awaiting Milla's sign-off). A key glued with more than 12 base58
characters on both sides is not read. A scan that throws reads the whole text as
a secret, and the Telegram agent's `send_file` refuses a file whose scan could
not finish. Fresh scans of short texts are memoized per process by SHA-256
digest (offsets only, no text). Both scans' linear-time tests measure CPU time.
The hosted grant guard (`carriesOwnerKey`, run on every POST /api/grants and
partner activation, Solana on or off) walks the grant once with a smaller
budget: 32 exact candidates for the whole grant (failing closed past them) and
windows of 32 checks, 512 decodes and 32,768 starts, reading every string and
property name once, so a 230 KB hostile body costs about 7 to 15 ms of CPU
instead of 60 to 130 ms. POST /api/grants is not paced per tenant.
The Telegram agent's secret list holds the Solana server secrets
(`SOLANA_SECRET_SETTINGS` in `worker/src/telegram/agent.ts`: the fee payer's
seed, the store DEK, the Jupiter key and the RPC URLs) from its environment and
from a `.env.solana.local` in the working tree or `MERRYMEN_HOME`; any
`MERRYMEN_…SEED/DEK/KEY/RPC…=value` line is redacted by shape, tool output
passes through `redactUrls`, and the shell refuses a dotfile glob
(`cat .e*.local`).

**Output redaction.** Every Solana process (the `start:solana` worker and the
paper, hold, resolve, recover and RPC-check CLIs) installs `guardStdio` before
anything can print. URL redaction treats `helius-rpc.com`, `helius.xyz`,
`rpcpool.com` and `syndica.io` as keyed hosts, beside Alchemy, QuickNode, Ankr
and Chainstack.

## Configuration

[`.env.solana.example`](../.env.solana.example) lists every setting with its
default, range and meaning, with placeholders only. Keep Solana RPC credentials
server-side: never in `NEXT_PUBLIC_`, the browser chain registry or Robinhood's
`MERRYMEN_RPC_MAINNET`. RPC attempts use deadlines, response bounds (256 KiB),
redacted errors and no redirects.

| Setting | Where | Default and range | Effect of a bad value |
|---|---|---|---|
| `MERRYMEN_SOLANA` | web and Solana worker | unset (off); `1` on | — |
| `NEXT_PUBLIC_MERRYMEN_SOLANA_OWNER_KEY_EXPORT` | web build ARG | empty (off); exactly `1` on | anything else is off |
| `MERRYMEN_SOLANA_RPC_MAINNET` | web, worker | required; HTTPS | refused |
| `MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK` | web, worker | required for live; HTTPS, different hostname | live refused |
| `MERRYMEN_JUPITER_API_KEY` | web, worker | required for quotes; 1 to 1024 printable ASCII, no spaces | blocker for trades and exits, `[alert]` |
| `MERRYMEN_SOLANA_VAULT_PROGRAM`, `MERRYMEN_SOLANA_VAULT_SHA256` | web, worker | unset (no live) | live refused as configuration |
| `MERRYMEN_STORE_DEK`, `MERRYMEN_SOLANA_FEE_PAYER_SEED` | web, worker | unset; base64 of 32 bytes | live refused |
| `MERRYMEN_SOLANA_MAX_FEE_LAMPORTS` | web, worker | 5,000,000; whole number > 0 | blocker for trades and exits |
| `MERRYMEN_SOLANA_COMPUTE_UNIT_PRICE_MICROLAMPORTS` | web, worker | 0 (minimum price) | blocker for trades and exits |
| `MERRYMEN_SOLANA_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS` | web, worker | max(1,000,000, minimum) | blocker (also when below the minimum) |
| `MERRYMEN_SOLANA_FEE_PAYER_LOW_LAMPORTS` | web, worker | 4 × fee cap (0.02 SOL) | warning and `[alert]`, default used |
| `MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS` | web, worker | 300; 50 to 1000 | blocker for trades and exits, `[alert]` |
| `MERRYMEN_SOLANA_PYTH_GENERATION` | web, worker | `current`; or `upgraded` | blocker for trades, exits and registering a permission, `[alert]` |
| `MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE` | web, worker | 0; 0 to 96 | blocker for trades and exits (the worker's alert counts use 0) |
| `MERRYMEN_SOLANA_LIVE_TENANTS` | web, worker | unset: nobody may go live; comma-separated 0x tenant ids | new live permissions and buys refused for everyone (exits continue), `[alert]` |
| `MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG`, `…_MAX_DAILY_USDG` | web, worker | 10 and 25 USDG; exact decimals, per trade ≤ daily, per trade ≥ 1 | as above |
| `MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_WSOL`, `…_MAX_DAILY_WSOL` | web, worker | 0.1 and 0.25 SOL; exact decimals, per trade ≤ daily | as above |
| `MERRYMEN_SOLANA_RESOLVE_THIRD_RPC` | operator machine | unset; HTTPS, its own hostname | `--third-rpc` refused |
| `MERRYMEN_SOLANA_RECOVER_RPC` | owner's computer | unset; HTTPS mainnet | `solana-recover` refused |

A full blocker from configuration still shows the vault, balances, fee payer,
owner wallet and recoverable SOL in status. The fee payer's hard levels are not
settings: below one exit's needs (rent for a 165-byte temporary account plus two
signatures, about 0.00205 SOL) every tenant's exits stop; below one buy's needs
(rent for the vault's USDG account size plus two signatures) buys stop.
`MERRYMEN_SOLANA_WORKER_IPC` is internal (`merrymen solana-agent` sets it for
its worker); never set it.

The local dashboard needs the same values in its server:

```sh
node --env-file=.env.solana.local node_modules/next/dist/bin/next dev web -H 127.0.0.1 -p 3100
```

The web surface is off unless the web server has `MERRYMEN_SOLANA=1`
([`solana-enabled.ts`](../web/src/lib/solana-enabled.ts)), and the Solana
worker (`start:solana`, `merrymen solana-agent`) refuses to start (exit 78,
before it opens any storage) unless its own service has it too
(`solanaWorkerSwitchRefusal`), so the flag means "Solana on" wherever it is
read. The operator CLIs and `solana:recover` run without it. Without it the
network switch, the `/solana` screen and Privy's Solana wallets are not
rendered, `/solana` answers 404, and every `/api/solana` route answers 404
before sign-in, body parsing or any database read. A page opened at
`http://127.0.0.1:<port>` is accepted as same-origin for `/api/solana` when
`MERRYMEN_PUBLIC_ORIGIN` is unset; production sets it. Errors about missing or
invalid Solana settings reach owners only as "Solana trading is not available."
or a named blocker that never names a setting.

`GET /api/solana/status` is paced per tenant (burst 10, then one every 3 s), and
reads the chain only for a live binding or an account with live state, so a
paper-only account costs no RPC. `POST /api/solana/intent` paces previews (10,
then one every 3 s) and trades (5, then one every 6 s) separately. The owner and
setup routes pace revoke prepares in their own bucket (5, then one every 6 s),
other prepares and outside-withdrawal recording (5, then one every 6 s), and
submits and activations (10, then one every 3 s). A paced request answers 429
before anything runs; buckets are per web process.

Storage: the app and Solana worker share `DATABASE_URL` in hosted mode. Local
storage is `MERRYMEN_HOME/solana-accounts.sqlite` (WAL, full synchronization,
owner-only permissions), separate from the paper CLI book. PostgreSQL and SQLite
enforce the same tenant, policy and admission boundaries. All Solana tables are
created idempotently at first use, on both dialects; there are no migrations to
run. Backups must keep the durable journals and encrypted session records; the
encryption key belongs in the secret environment, not the database.

**Deployment verification.** The verifier rejects an upgrade authority and
checks the executable bytes against `MERRYMEN_SOLANA_VAULT_SHA256` on both
providers. The hash covers the **entire ProgramData region after the 45-byte
loader header, including allocation padding**; an artifact's own hash equals it
only when the deployment's max-len equals the artifact's size (the CLI default),
otherwise hash the artifact followed by its zero padding. The configured program
must be the id the binary was built for (its 32 bytes in the hashed region), and
never the local test id `EUzYVniKtgNNgFweMtRA9vciTWtE8MDTRfh6ai6VvXoU`. Once
`SOLANA_VAULT_RELEASES` lists a release, any program and hash pair it does not
list refuses live trading, exits and every app owner action as configuration,
before any RPC; status still names the program and vault so the recovery card
can render, and the owner keeps `merrymen solana-recover`. Older releases stay
listed so their vaults stay usable; a new pin must keep every program owners
have funded. While the list is empty (today) only the deployment checks apply
on the server. The page applies the pin itself, never the server's status
answer: it registers a permission (initialize and create_session) and shows a
USDG deposit address (which it derives itself for the bound owner) only for a
listed program, or for the local test program in a build that is not a
production build (`pageTrustsVaultProgram` in `web/src/terminal/SolanaRecovery.tsx`).
So a production build registers nothing until a release is pinned.

## Build, CI and release

Full procedure: [contracts/solana/README.md](../contracts/solana/README.md).

- **Build.** `contracts/solana/build.sh` is the only supported build: agave
  2.3.13 `cargo-build-sbf`, platform-tools v1.48, `--tools-version v1.48 --arch
  v0 -- --locked`, physical `CARGO_HOME` and source paths, and a refusal of any
  `.cargo/config` above the program. `build.sh --record` writes
  `build-manifests/<uname -s>-<uname -m>.json` after a second build from a copy
  gives identical bytes. `test.sh` runs the native tests, the build and every
  runtime test (`--offline` without network).
- **Artifacts.** macOS and Linux artifacts differ (platform-tools embeds its
  build paths). The committed `Darwin-arm64.json` (ce7d2544…, 410,472 bytes, the
  local test id; re-recorded after `withdraw` began forwarding transfer-hook
  accounts) is for local verification only. The release artifact and
  `MERRYMEN_SOLANA_VAULT_SHA256` come from the pinned Linux CI build and its
  manifest. Earlier artifact hashes describe binaries that will never ship:
  `9bb352ad`, `53c9a7ba`, `ee04ea0e` and `dfb7617c` (before account layout
  version 2 and the `lto` removal) and `34b4fe22` (before the on-chain 7-day
  session cap).
- **CI.** `solana · paths` decides whether a pull request touches anything the
  vault build, its tests or its CI read (`scripts/ci/solana-paths.mjs`; it
  includes `.cargo/`, `rust-toolchain` and `.gitattributes` at the root and in
  `contracts/`); pushes to main and manual runs always build. `solana · test`
  installs the toolchain checked by size and SHA-256 against
  `scripts/ci/solana-toolchain.env`, runs `test.sh`, records the artifact and the
  Linux manifest, compares it with the committed one, and names the artifact.
  `solana · rebuild` rebuilds from `git archive` on another runner with a fresh
  `CARGO_HOME`. `app` requires both and equal hashes, and prints `vault
  artifact: tested X, rebuilt X` before it checks any result. `solana · release`
  runs after `app` and writes the release verdict. The CI script tests
  (`scripts/ci/*.test.mjs`) are part of `npm test`. Docs-only pull requests in
  the Kaka lane skip the vault build but still wait for `app`.
- **Release marking.** A release comes only from a CI run on `refs/heads/main` of
  `millw14/merrymen` (a push to main, or a manual run on main) whose pinned Linux
  build matched the committed `build-manifests/Linux-x86_64.json`, whose `app`
  check passed, and whose `lib.rs` does not declare the local test id. Its bytes
  are in `merrymen-vault-sbf-candidate-unconfirmed-<commit>-run<id>.<attempt>`,
  and `solana · release` uploads `merrymen-vault-release-<commit>-run<id>.<attempt>`
  naming that artifact and its SHA-256. Everything else is
  `merrymen-vault-sbf-not-a-release-…`. Until a Linux manifest is committed,
  every artifact is not a release; until `declare_id` is the production key,
  every artifact is not a release.
- **declare_id.** Before recording or deploying a release hash, run
  `node contracts/solana/scripts/check-release-id.mjs $(solana-keygen pubkey <deploy keypair>) [--so target/deploy/merrymen_vault.so]`.
  It checks that `declare_id!` equals the deploy key's public key and that the
  `.so` holds its 32 bytes, prints the `.so` SHA-256, and never echoes its
  argument. CI has no deploy keypair.
- **Fixtures.** `runtime-tests/fixtures/ts-instructions.json` (from the TS ABI;
  `MERRYMEN_WRITE_SOLANA_ABI_FIXTURE=1 npx tsx --test packages/core/src/solana-live.test.ts`)
  and `recovery-transactions.txt` (from the recovery tool;
  `MERRYMEN_WRITE_SOLANA_RECOVERY_FIXTURE=1 npx tsx --test worker/src/solana-recover.test.ts`)
  are executed byte for byte against the compiled program. Both follow
  `lib.rs`'s `declare_id`. The Jupiter fork fixtures need no refresh for a new id.

## Jupiter fork evidence

`contracts/solana/runtime-tests/tests/jupiter_fork.rs` runs the compiled vault's
`execute_swap` against the mainnet binaries of Jupiter v6, Orca Whirlpool, SPL
Token (now p-token on mainnet), Token-2022 and ATA, and a real Jupiter `/swap/v1`
`sharedAccountsRoute` (1 USDG → WSOL, one Whirlpool hop) recorded at slot
459,261,789 (2026-10-20 14:23 UTC), offline under agave 2.3.13's
solana-program-test with a 64-account lock limit. Only the three Apache-2.0 SPL
programs are in the repository; Jupiter's and Whirlpool's copies are supplied
out of band (`fixtures/jupiter/NOTICE.md`), so CI skips this target and it is a
release gate. Measured on 2026-10-20:

- compute: buy 162,314 CU (the executor signs 194,777 after simulating at
  1.4M), derived exit 154,593 CU, buy refunding a donation 149,929 CU; the vault
  and its token and ATA CPIs take about 93k CU on a buy and 84k on an exit, Jupiter
  plus Whirlpool about 69k to 70k. Each further Whirlpool leg costs 76,735 CU.
  Committed regression ceiling: 250,000 CU.
- accounts: 29 unique on a buy (30 with the refund) of 64 locks; 948 of 1,232
  wire bytes with one lookup table; 29 of the vault's 64 route accounts.
  `execute_swap` adds 8 distinct accounts (9 with the refund), so a route can
  name at most 55 distinct accounts; the vault's 64 route accounts allow at most
  3 Whirlpool legs, and a 4th is refused before Jupiter runs. Live quotes ask
  for at most 40 accounts.
- CPI depth 4 of the runtime's 5 (Token, Token-2022 and Memo under Whirlpool
  under Jupiter under the vault); trace 18 of 64 for one leg, 5 more per leg.
- Jupiter's answer for a Token-2022 USDG input puts SPL Token at account 0 and
  Token-2022 at 10, as `check_route_accounts` and `validateJupiterCpi` pin them.

Limits: one direct route at one slot. Only the buy is Jupiter's answer; the exit
and the splits are derived from it. Multi-hop routes through other pools or AMMs
are unmeasured. The vault's return of leftover input is unreachable with a real
ExactIn route and is covered only by `custody.rs`'s mock. Mainnet's runtime
(the RPC reported 4.3.2) may differ from 2.3.13. The executor's live simulation
and the canary are the authorities on mainnet cost and fills. Jupiter v6,
Whirlpool and Token-2022 are upgradeable; the fixtures pin the bytes read on
2026-10-20.

## Accepted limitations

- **Exits share the on-chain caps with buys.** Exits use the same USDG daily cap
  and 96-operation budget as buys, so after a full day of buys every sell can be
  refused for up to 24 hours.
- **Rent stays locked.** The vault has no close instruction: about 0.0165 SOL of
  vault and token-account rent per owner is locked for good once deployed
  immutable.
- **Withdraw accepts an owner token account with a delegate or close authority.**
  The owner's own wallet configuration can expose withdrawn tokens to that
  delegate; the app's remedies tell the owner to remove them.
- **A vault below its book needs an operator** when no owner withdrawal explains
  it; nothing books a decrease automatically, and inflows and an off-book loss
  between two reads net against each other.
- **Expired attempts count by default.** With the allowance at 0, a burst of
  dropped transactions can pause automated trading and exits for up to 24 hours.
- **Availability depends on both providers.** A fallback that is down or more
  than about 2 seconds behind refuses live trades and exits.
- **Single-provider reads remain** for the snapshot, fees, blockhash, mint and
  status display (they can refuse, never book).
- **Pacing is per web process**; N replicas allow N times the burst.
- **One owner transaction at a time** (beside it only a revoke), and revoke-slot
  history is capped at 8 landed revocations per pending record.
- **Recovery card and owner key.** Off by default; a Privy embedded owner who
  changes identity can re-bind only with the exported key.
- **Pyth's current generation** has no published sunset date; if it stops
  posting, live trading stops until the setting changes.
- **Paper write-off** needs Jupiter's zero-output answer; a token with no route
  cannot be written off and keeps its slot.
- **Secret scan windows** are best effort past their budget (above).
- **The fork test** covers one direct route; the production `jsonParsed` USDG
  form is unverified until the release-gate read.
- **Telegram `/kill` and the Solana table.** Once the Solana table exists, a
  Solana database fault keeps the Telegram kill pending (the RH grant is already
  removed and the child stays latched).

## Decisions taken by default

Each of these was chosen during implementation as the conservative default, so
the work could continue; none is Milla's sign-off unless it says so. "Change"
says where to change it. Superseded choices are listed under the current one.

**Live rollout (the gate before turning Solana on)**

| Decision | Default now | Alternatives | Change |
|---|---|---|---|
| Who may go live | Nobody until named in `MERRYMEN_SOLANA_LIVE_TENANTS` | Every bound tenant; Robinhood-style levels (observe, exits-only, trade) | `MERRYMEN_SOLANA_LIVE_TENANTS` |
| Off the list after going live | Exits-only: sales back to USDG, revoke, withdrawals and outside withdrawals; live mode may be saved again so exits can be sold, each limit at most the larger of its cap and the registered permission's (a departure from the brief, which refuses live mode off the list: **needs Milla's sign-off before the canary**) | Refuse saving live mode too (the literal brief); or cap it at the caps alone (rejected: it could narrow sales below the permission the owner signed) | `checkLiveSettings` in `solana-app-runtime.ts` |
| A permission that lands after the tenant left the list | A renewal of an account that already went live is activated for exits only (it replaced the old permission on Solana, so refusing it would leave nothing to sell under; buys stay refused). A first permission is not activated; the page keeps its session key, Revoke ends it. A departure from the brief, which refuses activation off the list: **needs Milla's sign-off before the canary** | Never activate off the list (rejected: a renewal landing after delisting would leave the account unable to sell until listed again) | `activateLive` (`requireLiveOpenOrWentLive`) |
| Off the list, once its permission expired or was replaced | Withdraw-only: revoke and withdrawals (USDG, wrapped SOL and native SOL, to the owner's own accounts) always work, but nothing can be sold back to USDG in the app, since no new permission is registered off the list; status says so (`SOLANA_LIVE_PAUSED_NO_PERMISSION`). **Needs Milla's decision before the canary** | A sell-only renewal: such an account may prepare and submit a renewal within the caps whose owner-signed transaction also carries `set_breaker(paused = true)`. The program keeps the breaker across `create_session` and refuses every buy while it is paused (`execute_swap` in `lib.rs`), so the renewal could only sell, on chain as off chain (trade() still refuses buys). It changes the transaction the owner signs, so the page's permission review (`readPermissionTransaction` in `SolanaPermission.tsx`) must accept and show that instruction | `prepareLive`, `submitSetup` in `solana-app-runtime.ts` |
| Live caps | 10 and 25 USDG, 0.1 and 0.25 SOL (25 USDG a day is the Robinhood vault's cap, which limits spending only) | Other values | `MERRYMEN_SOLANA_LIVE_MAX_*` |
| Exits and the caps | Buys keep room for exits: a buy is refused when, after it, the whole position could not be sold inside the rolling 24-hour limits at the independent price plus the tolerance (`SOLANA_LIVE_EXIT_RESERVE`), counting what it brings 300 bps above the larger of its quote and its reference (the fill margin: the program does not bound an ExactIn buy's output). The signed limits stay within the caps, so a day's buys stop at about half the USDG cap and a position stays within what one day can sell. A fill beyond the margin is booked as it landed; status then holds buys and says the excess is sold as earlier trades leave the window, or over more than one window. Sales are never refused by it | Let the signed limits carry exit headroom beyond the caps (a separate `MERRYMEN_SOLANA_LIVE_MAX_EXIT_*`; rejected: it widens what a session key may do on chain); let the caps bound exits (rejected: an owner must always be able to exit); also reserve operations for the exit's sales (not done: the operation limit is the owner's own setting, not a platform cap) | `solanaBuyKeepsExitRoom` in `solana-trading-store.ts`, `assessRisk` in `solana-app-runtime.ts` |
| A session registered above caps lowered since | Buys refused before any quote (the limits kept in the session record) and again before signing (the limits every provider shows); exits keep the signed limits, and its live limits may be saved again up to them (each the larger of the cap and the permission's), on the list as off it, so a re-save never narrows its exits | Cap sales too (rejected: an owner must always be able to exit); hold a re-save on the list to the caps (rejected: admission bounds sales by the saved limits, so it narrowed exits below what the owner signed) | `assessRisk`, `checkLiveSettings` in `solana-app-runtime.ts` |
| A malformed rollout setting | Configuration refusal of new permissions and buys, `[alert]` once a minute; exits continue | Refuse to start the worker | `rollout()` in `solana-app-runtime.ts` |
| Web and worker run different list or caps | Every live buy held on both while they differ (one digest of all the settings, so a deploy that adds a tenant briefly holds everyone's buys), `[alert]` once a minute; exits continue. The worker compares the web's latest digest whatever its age and holds its buys while that is missing or differs; one restarted with the web's settings is never held. The web publishes its digest as its server starts (`register()` in `web/src/instrumentation.ts`), every 30 s after, and at a Solana request at once when the stored one is not its own, so the runbook deploys the worker first, then the web, with no hold or page visit. Not covered: while the web cannot publish (`[alert] solana-live-rollout unpublished`), or for up to 30 s after an old web container still draining wrote its own digest over the new one's, the stored digest is out of date, and where it equals the worker's settings the worker buys under settings the running web may no longer run (in the runbook's order the old web's digest never equals the new worker's, so that overlap holds buys) | Compare per tenant. Hold the worker's buys while the web's digest is older than a few publish intervals (not done: every live buy would stop whenever the web is down or cannot write, and it would not close the draining overlap). Order the digests by process start, so an old container cannot write over a newer one's (not done: a schema change that trusts container clocks; the periodic publish bounds the overlap to 30 s) | `rolloutDiffers` in `solana-app-runtime.ts`, `web/src/lib/solana-rollout-publisher.ts` |
| Live buy previews off the list, while a cap cannot be read, or under a permission registered above caps lowered since | Refused before any quote, as the trade would be (the last by the limits kept in the session record when it was registered; a record from before they were kept is refused by the trade before signing) | Allowed | `preview`, `requireSessionWithinCaps` |
| The page's default limits | Paper starts at 10 and 50 USDG (as before the caps; paper is never capped). Choosing live with no limits saved or typed starts at the caps in force (status's `liveAccess`, or the default caps from a server that reports none), so a first live save fits them; the SOL sold limits start at the caps beside saved paper limits too | One set of defaults at the default caps for both (rejected: it changed paper's starting limits) | `chooseMode` in `SolanaScreen.tsx` |

**Release and infrastructure (Milla's decisions; nothing is done by default)**

| Decision | Default now | Alternatives | Change |
|---|---|---|---|
| External audit: firm, scope, timing | Not engaged | Audit now; after the program freezes | — |
| Authorize the immutable deployment: keypair, `declare_id`, deployer key holder, about 2.5 SOL of rent | Not deployed | — | `lib.rs`, `Anchor.toml`, release procedure |
| Second RPC provider | Not provisioned; live refuses without it | — | `MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK` |
| House fee payer and funding level, who refills and watches alerts | Not provisioned; low watermark 0.02 SOL | Other watermark | `MERRYMEN_SOLANA_FEE_PAYER_SEED`, `…_FEE_PAYER_LOW_LAMPORTS` |
| Production Privy Solana wallets and the dev-mode user cap; key export | Off | Enable on the production app id in place | Privy dashboard; `MERRYMEN_SOLANA`, the build ARG |
| Canary go, funding and caps | No go | — | — |
| How the work lands | One PR, merged with Solana off | Per-phase PRs | — |
| `/api/grants` body limits on Robinhood code (256 KiB POST → 413, 8 KiB kill DELETE) and the chain-id refusal | In this PR | Split into its own PR; drop | `web/src/app/api/grants/route.ts` |
| Hermes cross-check with a Pyth key | Not run | Skip; leave to the audit | — |
| `--unlisted-program` policy text ("Merrymen never asks for it") | In the tool's help | Reword | `worker/src/solana-recover-command.ts` |
| Production-RPC `jsonParsed` USDG read | Not made (needs Milla's OK) | CI regeneration of the offline fixture | `contracts/solana/scripts/usdg-rpc-jsonparsed.mjs` |

**Custody program and CI**

| Decision | Default now | Alternatives | Change |
|---|---|---|---|
| On-chain session clock allowance | 15 minutes past 7 days (server allows 5 minutes) | Shorter; confirm before freezing the program | `risk.rs` `SESSION_CLOCK_ALLOWANCE` (rebuild and re-record) |
| `check_mint` USDG allowlist | Not widened (exactly the live mint's extensions) | Widen for harmless extensions and re-record | `lib.rs` |
| Release-candidate scope | Only runs on `refs/heads/main` | Also tags proven to be on main; a tag trigger | `scripts/ci/solana-program-record.mjs` |
| Linux manifest comparison | Strict: any field difference fails | Fail only on same digest, different artifact | `scripts/ci/solana-linux-manifest.mjs` |
| Recording the manifest in CI | `build.sh --record` in `solana · test` (one more SBF build, about 4 min) | Record from the tested build; record on main only | `.github/workflows/ci.yml` |
| First Linux manifest | Milla commits it from the first green run | — | `contracts/solana/build-manifests/` |
| No committed manifest | Every artifact is not a release | Let main runs be candidates anyway | `releaseStatus` in `solana-program-record.mjs` |
| Deleting a committed manifest | Fails CI; replace, never delete | An explicit `LINUX_MANIFEST_REQUIRED` setting | `solana-linux-manifest.mjs` |
| Cargo config above the program | Any file refused (CARGO_HOME's own exempt) | Refuse only build-changing tables | `build.sh` |
| Release verdict form | A small record naming the candidate and its hash | Re-upload the bytes under a release name | `ci.yml` `solana · release` |
| `solana · release` on pull requests | Runs a notice and succeeds | Job-level `if`, which would skip and close the Kaka lane | `ci.yml` |
| CI script tests | In `npm test` and every app shard | Only in the path-gated job | `package.json` |
| Runner image | Recorded (ImageOS, ImageVersion), not digest-pinned | A digest-pinned container | `ci.yml` |
| Manifest provenance | `Vault-Linux-Manifest:` commit trailer, pasted by the owner | A sidecar file; CI enforcement | README procedure |
| Platform-tools pin | Corroborated by three Nix pins, not computed | `sha256sum` on a trusted machine; first green CI run | `scripts/ci/solana-toolchain.env` |
| Release pin while empty | Checks nothing beyond the deployment checks | Refuse all live use until a release is pinned | `solanaVaultReleaseRefusal` |
| Unlisted configured program | Refuses trading and app owner actions | Allow owner exits | `solana-app-runtime.ts` `config()` |
| Release verdict with a missing local-test id | Never a candidate | Treat as not the test id | `solana-release.mjs` |
| Jupiter fork program copies | Option (c): SPL copies committed, Jupiter and Whirlpool out of band; CI skips the fork test | (a) commit all; (b) commit none | `fixtures/jupiter/NOTICE.md` |
| Fork test lock limit and ceiling | 64 locks; 250,000 CU | 128 locks; 1M or 200k CU | `jupiter_fork.rs` |
| Live quote `maxAccounts` | 40 | 48, 50, 55; unset | `SOLANA_JUPITER_MAX_ACCOUNTS` |
| Fork exit route | Derived from the recorded buy | One more read-only quote for a Jupiter-built exit | `refresh.mjs` |

**Live execution and accounting**

| Decision | Default now | Alternatives | Change |
|---|---|---|---|
| Expired-attempt allowance | 0: every signed transaction counts | Small N; 96 (most permissive); a per-account mode | `MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE` |
| Expired-attempt alerts | Opaque account ref, 10-min repeat, warn above half | Tenant address; other threshold or repeat | `solana-agent.ts` |
| Pyth generation | `current` | `upgraded` | `MERRYMEN_SOLANA_PYTH_GENERATION` or `SOLANA_PYTH_DEFAULT_GENERATION` |
| Invalid generation | Fail closed, exits included | Fall back to the default with a warning | `solana-reference-price.ts` |
| Withdrawal valuation with a bad Pyth setting | Withdrawal prepares unvalued (HWM stays) | Refuse the withdrawal | `solana-app-runtime.ts` |
| Bad tolerance | Blocker and `[alert]` (reversed the earlier no-alert choice) | Blocker only | `solana-app-runtime.ts` |
| Stale-price alert wording | States only the 120 s limit | Per-generation post counts; a tighter limit for `upgraded` | `SOLANA_REFERENCE_MAX_AGE_MS` |
| Pyth across providers | Stricter bound, no agreement band | Refuse when prices differ by more than the confidence | `assessRisk` in `solana-app-runtime.ts` |
| Provider slot skew | 150 slots (a minute at 400 ms slots, 30 s at 200 ms) | No check; 32 slots; 300 slots to keep a minute | `SOLANA_PROVIDER_SLOT_SKEW` |
| Read commitment | `finalized` everywhere (Alpenglow made it the same state as `confirmed`, which Agave will remove) | Keep `confirmed` until it is removed | every Solana read |
| Lagging-provider catch-up | 5 attempts, 400 ms apart | No retry; longer | `SOLANA_CATCH_UP_*` |
| Pre-sign simulation | On every provider, refuse on any refusal | Accept the residual risk | `solana-executor.ts` |
| Trade snapshot sequence and epoch | Refused unless every provider agrees | Rely on the durable floor | `assessRisk` |
| Sequence-consumed expiry | Only through `solana:resolve` with an operator decision | Automatic on a two-provider quorum | `solana-trading-store.ts` |
| Default tolerance for a caller passing none | 300 (fails closed) | Any tolerance in range | `solana-executor.ts` |
| Fee payer threshold malformed | Warning and `[alert]` (was a blocker) | Blocker | `feePayerLow` |
| Alert thresholds | Stuck after 3 min; fee payer check every 10 min; repeats every 10 min | Other values | `solana-agent.ts` constants |
| Below the book | Hold trades and exits; owner records outside withdrawals; operator write-off as a loss | Generic outflow command (rejected: could hide a loss); capital out | `solana-resolve-shortfall.ts` |
| Write-off agreement | Two providers, all non-excluded readable | Primary plus one | same |
| `SOLANA_STATUS_BEHIND_BOOK` | Shown instead of below-book | Re-read at the book's slot | `status()` |
| Withdrawal when providers disagree | Proceeds from the book, capped by one finalized read, books no inflow | Refuse | `prepareOwnerAction` |
| Finalized withdrawal below `book.slot` | Booked; book slot never moves back | Operator hold | `solana-trading-store.ts` |
| Legacy setups without `finalizedSlot` | Activation reads without a floor | Re-fetch the slot | — (no legacy rows exist) |
| Recording who booked | Marked inside the booking transaction, no schema change | A `resolution_id` column | `settleResolution` |
| Mark dust | Zero only under one cent at Pyth; otherwise that buy is refused | 1 raw unit; equity-relative; a setting | `SOLANA_MARK_DUST_MAX_USDG_RAW` |
| Day's operations used | Status blocker; agent holds quietly unless expired attempts caused it | Blocker only for expired attempts | `status()`, `solana-agent.ts` |
| Jupiter key alert | Only for a set, unusable value | Also when unset | `jupiterKeyUsable` |
| Live route failure codes | `route` (409) only for clearly unsupported shapes; everything else `provider` (neutral 503); V2 instructions are `provider` | 409 for every failure | `solana-live-market.ts` |
| Zero `outAmount` on a live build | `provider` (503) | 400 too small | same |
| Paper book refusals | 409 everywhere | 409 only on write-off | `solana-api.ts` |

**Owner transactions and the web page**

| Decision | Default now | Alternatives | Change |
|---|---|---|---|
| Owner priority-fee cap | 0.001 SOL, in server and browser (a test keeps them equal) | 0.0001 SOL; an env setting; no fee | `SOLANA_OWNER_MAX_PRIORITY_FEE_LAMPORTS`, `OWNER_MAX_PRIORITY_FEE_LAMPORTS` |
| Fee-read deadline | 3 s | Shorter; longer | `SOLANA_OWNER_FEE_READ_MS` |
| Owner compute-unit limit | Floor at 200,000 per instruction | Simulate on both and take the larger; no fee | `solanaOwnerComputeUnitLimit` |
| Revoke beside a pending owner transaction | Allowed in its own slot (2026-10-20, option A); a registration with a revocation beside it is never activated | Refuse beside a registration; activate one that landed after | `solana-trading-store.ts` |
| Second revocation after one landed | Refused unless a later permission is live (then allowed, history kept) | Always allow; the reviewer's narrower condition | same |
| Activation fence | Epoch exactly prior + 1; waits for a signable revocation | Activate whenever limits match | `registerSession` |
| Resume-buys beside a revocation | Buying stays paused | Compare finalized slots | same |
| One owner transaction at a time | Yes, except a revoke | A second slot for everything | same |
| `notSaved` status split | 400 malformed, 409 state, both `notSaved: true` | One status | `solana-api.ts` |
| `notSaved` for earlier bytes | Contract narrowed to this request | Answer a finalized signature's status | same |
| Trade floor | Exact; outside the request-id fingerprint; fresh minimum offered for one click within the preview's lifetime, same request id | A tolerance; a new request id | `parseSolanaTradeRequest`, `SolanaScreen.tsx` |
| Pacing values | As in [Configuration](#configuration), in process | Shared bucket; database-backed | the `throttle.ts` files |
| Review before the wallet | Every owner transaction, revoke included (one extra click) | Sign revoke straight after the byte check | `SolanaOwnerActions.tsx` |
| Review window | 45 s inside the server's 60 s | Full 60 s; shorter | `OWNER_REVIEW_SIGN_WINDOW_MS` |
| Bytes signed after the page window | Submitted; the server decides | Discard | `SolanaPermission.tsx` |
| Stuck pending owner record | Page says so after 5 min of its own reads or the server's unavailable blocker | Server-provided age | `OWNER_PENDING_STUCK_MS` |
| Owner key card scope | Live binding only (never paper), whole card behind the flag | Show for paper with a live book; show step 2 without the flag | `SolanaScreen.tsx` `recoveryVault` |
| Card step 2 for an unlisted program | Read-only `--owner` plan only | Hide the card; name `--unlisted-program` (rejected) | `SolanaRecovery.tsx` |
| Card hash source | The pin only, never the server | Fall back to the server's hash (rejected) | same |
| Release-pin refusal and the card | Status names the program and vault; read-only plan | Command in the blocker text | `status()` |
| Browser owner-transaction check | Strict per-action instruction list | Fee only | `SolanaPermission.tsx` |
| Outside withdrawals | Owner-recorded from owner-signed evidence on both providers; no revoked session required | Operator-only; require revoked session | `recordExternalWithdrawals` |
| Outside-withdrawal parsing | Refuse anything unusual | Partial booking | `solana-external-withdrawal.ts` |
| Sweep inflow | Only what the withdrawal needs beyond the book | Book the whole excess | same |
| Inflows from balances (netting) | Kept, documented | Refuse the excess; vault-sequence anchor; deposit evidence | `solana-trading-store.ts` |
| WSOL outside withdrawal and HWM | min(valuation now, prorated basis) | Price at block time; no drop | same |
| Refusing to record a saved prepared message | Not built | Build it (would block recovery once bytes are lost) | — |
| Re-bind | Same tenant only; turns the strategy off; only the distinct re-bind message | Keep the strategy; move tenants (rejected) | `web/src/app/api/solana/bind/` |
| Another sign-in's wallet | `SOLANA_OTHER_SIGN_IN` everywhere (was POST only) | — | `solana-sign-in.ts` |
| Hosted write-off scope | Paper only, owner only, allowed under a hold, preview bucket | Live leftover books; blocked under hold; own bucket | `write-off/route.ts` |
| Write-off offer on the page | Only after a whole-lot zero-output answer, two-step confirm | A status dust marker; offer on every lot | `SolanaScreen.tsx` |
| Book shown after a write-off | Applied only if well formed and newer | Wait for the next read | same |

**CLIs, identity scans and Robinhood surfaces**

| Decision | Default now | Alternatives | Change |
|---|---|---|---|
| Paper renew loosening | `--loosen` required to raise a limit | Value flags alone; interactive | `solana-paper-command.ts` |
| Paper renew expiry | Changed limits keep a running expiry; bare renew extends to 7 days; expired gets 7 days | The old max(current, +7d) | same |
| Paper history and write-offs | In the book row, never pruned | A new table | `solana-paper-store.ts` |
| Dust prevention | Fail closed during a quote outage | Allow partial sells | same |
| Paper write-off evidence | Zero-output answer for the whole lot, context slot, at most 1% | Accept no-route over time; check slot freshness | same |
| `solana-agent` stop | 1.5 s merge window, 60 s parent-gone grace, malformed IPC refuses start | 500 ms or 2 s; no signal-forced stop | `SOLANA_WORKER_REPEAT_MS` (worker and `cli/bin.mjs`) |
| `solana-recover --owner` | On-curve ed25519 only, strict RFC 8032 | — | `solana-recover-command.ts` |
| `solana-recover` unconfirmed first send | "outcome unknown, it may still land" | Treat an RPC error as a definite refusal | same |
| `solana-recover` RPC given twice | Refused; a keyed `--rpc` warns | Refuse keyed `--rpc` | same |
| Declared id for unlisted programs | Hash only | Also warn on a missing id | `solana-recover.ts` |
| Release-id script scope | `lib.rs` and the `.so` only | Also Anchor.toml; padded hash | `check-release-id.mjs` |
| Third provider URL | From `MERRYMEN_SOLANA_RESOLVE_THIRD_RPC` only | Standard input | `solana-resolve.ts` |
| Resolve rules | Two agreeing providers on distinct hosts, none dissenting, unreadable never counts, no override, auditable `--exclude` | Majority; all providers; fills and failures only; who may run it against production (Milla) | same |
| Glued scan on X, social, theses | Glued, fail closed | Default scan (lets `CA<mint>` through) | the callers listed above |
| Telegram signature redaction | Every Solana signature → `[signature]` | Keep standalone signatures; keep only the event's own | `worker/src/telegram/reads.ts` |
| Telegram 64-hex runs | `[hash]` for the model; owner surfaces keep hashes | Keep readable; keep only code-written hashes | same |
| P&L card coin name | Refuse a glued key | Default scan | `pnl-card.ts` |
| X advice decline | Default scan | Glued scan | `orchestrator-xpost-research.ts` |
| Soul memory | Glued call kept as belt and braces | Drop it | `soul.ts` |
| Linear-time test limits | 60 s CPU per test | Wall clock; 20 s | the `ids` tests |
| Secret-scan windows past the budget | Best effort, missed rather than refused (awaiting Milla's sign-off) | Fail closed; exempt base64 tokens; larger budget | `SECRET_WINDOW_*` in `ids.ts` |
| `SECRET_GLUE` | 12 characters each side | Every window | `ids.ts` |
| Group-chat scan cost | Per-process memo; exact-only scan in `promptSafe` | Smaller budget for short texts | `SECRET_MEMO_*` |
| Telegram `/kill` order | RH grant first, then Solana (changed 2026-10-20) | — | `kill-request.ts` |
| `/why` with a failed model | Sends the unredacted evidence to the owner (fixed 2026-10-20) | Show `[hash]` | `worker/src/telegram/` |
| Brain desk confidence | Clamped to [0, 1] | Refuse out of range | `desk/brain-desk.ts` |
| Desk parity | Worker refuses what Brain refuses | Narrower re-check | same |

## Verification evidence

Everything below was run locally on Milla's Mac (Node 26, agave 2.3.13). No
command made a Solana transaction or signature, used a funded key or reached a
production service. Track runs happened on each track's branch before it was
merged into this one; they are listed by round, and the counts overlap.

**2026-10-20, final round (owner, trade, custody, Jupiter, Robinhood tracks).**

- Owner track: worker Solana suites 282 pass, 0 fail (24 PostgreSQL-gated run
  separately); web Solana suites 165 pass; on a throwaway PostgreSQL 17 cluster
  112 then 256 then 251 pass, 0 fail; both typechecks clean; every listed
  mutation killed.
- Trade track: 344 worker tests, 326 pass, 0 fail (18 PostgreSQL-gated), 78 of 78
  on PostgreSQL; later 300 pass, 23 PostgreSQL pass; 28 then 19 mutants killed.
- Custody track: `contracts/solana/test.sh` exit 0 (native lib 14, custody 27,
  recovery 2), matching `Darwin-arm64.json`; the same in a scratch copy with a
  throwaway `declare_id` after regenerating both fixtures; `scripts/ci`
  `solana-ci.test.mjs` 68 of 68; USDG mint tests 10 pass, 1 skipped (the
  production-RPC answer, until it exists).
- Jupiter track: `test.sh --offline` exit 0 with the program copies (lib 14,
  custody 25, recovery 2, jupiter_fork 4, later 8 of 8 including unit tests);
  the same with `declare_id` changed in a scratch copy, 8 of 8; an empty program
  directory fails 5 tests (fail closed).
- Robinhood track: kill-path, ledger, redaction, secret-scan, desk and Telegram
  suites (429 desk tests, 251 Telegram neighbours, 203 touched-file tests) pass;
  kill and ledger suites pass on PostgreSQL 17; a mobile `expo export` for iOS
  and Android (Hermes) built with the new core barrel.
- 2026-10-20 cold rebuild with a fresh `CARGO_HOME` at another path reproduced
  the Darwin artifact `562f0849…` (364,744 bytes), since superseded by `ce7d2544…`
  when `withdraw` began forwarding transfer-hook accounts; neither is the release hash.

**2026-10-20, integration and finishing rounds.** Worker, web, CLI, CI-script,
Pyth and identity suites per track, PostgreSQL subsets on throwaway clusters,
mutation checks for each behaviour change, and typechecks; see the round notes
in Milla's local `~/.cache/merrymen/solana-notes/`.

**On this branch's head (2026-10-20).** The full `npm test` on `5432da70` (the
code this document describes; the docs pass changed no code): 24,562 tests,
24,486 pass, 0 fail, 0 cancelled, 76 skipped (PostgreSQL-gated and optional
suites, with no `MERRYMEN_TEST_PG_URL` set), in 4 min 49 s at a load average
of about 25. PostgreSQL suites, `test.sh` and the typechecks were not rerun on
the head in this pass.

**Network reads (read-only, keyless unless stated, nothing signed or sent).**
2026-10-19: Pyth accounts of both generations on a public RPC. 2026-10-20: the
USDG mint, Token-2022 and its ProgramData on `api.mainnet-beta.solana.com`; for
the fork test, one Jupiter quote and one `swap-instructions` POST on
`lite-api.jup.ag`, one `getMultipleAccounts` for the route's 22 accounts, one
`getBlockTime` and the five programs' `getAccountInfo`. Earlier: read-only
Helius diagnostics and Jupiter quotes, and an isolated paper round trip.

**Not verified.** No CI run on GitHub (so no Linux manifest, no confirmation of
the platform-tools pin, no Node 22 run of the Solana code); no devnet or mainnet
deployment; no live fill, latency, slippage or fee measurement; no production
web build of this tree outside CI; the production provider's `jsonParsed` USDG
form; the Hermes cross-check; multi-hop Jupiter routes; mainnet behaviour of a
USDG hook program on withdraw (custody.rs runs a mock hook on program-test's
Token-2022); a real browser session with Privy's Solana
wallets.

## Release gates

Done:

- [x] Internal audit (2026-10-18) and fix rounds through 2026-10-20, merged on
      this branch. Not an external audit.
- [x] Pinned build recipe; the Darwin artifact reproduces locally (evidence only).
- [x] Two-provider requirement, release pin, `declare_id` check script, CI jobs
      and release marking written and tested locally.
- [x] Pyth constants checked on mainnet (2026-10-19), with two recorded answers.
- [x] Jupiter fork test passes locally with the owner's program copies (2026-10-20).
- [x] USDG mint bytes read and committed; worker and vault agree on them.

Remaining, in order:

- [ ] **First green CI run on GitHub** (`solana · test`, `solana · rebuild`,
      `solana · release`, `app`). It is also the first check of the platform-tools
      archive against its pin.
- [ ] **Commit the Linux manifest** from that run with its `Vault-Linux-Manifest:`
      trailer (procedure in `contracts/solana/README.md`). Until then every
      artifact is not a release. Today's manifest is the local-test-id build: a
      reproducibility baseline, not a release.
- [ ] **Production program id.** Choose the deploy keypair; set `declare_id!` and
      `Anchor.toml`; regenerate both id-bound fixtures; run `test.sh` and
      `check-release-id.mjs` with the production public key; take the new Linux
      manifest from that pull request's run (two-step); get a release record from
      a CI run on main.
- [ ] **Devnet rehearsal** of the deployment with `--final` and of the
      ProgramData region-hash check.
- [ ] **Mainnet deployment** of the release artifact with `--final`, authorized by
      Milla; check the ProgramData region hash on both providers; add
      `{ programId, sha256 }` to `SOLANA_VAULT_RELEASES`, publish the CLI, and set
      `MERRYMEN_SOLANA_VAULT_PROGRAM` and `MERRYMEN_SOLANA_VAULT_SHA256`.
- [ ] **Read-only production-RPC `jsonParsed` USDG read**
      (`node contracts/solana/scripts/usdg-rpc-jsonparsed.mjs --provider NAME --rpc URL`,
      one `getAccountInfo`, needs Milla's OK), then commit
      `usdg-mainnet-mint.rpc-jsonparsed.json` and rerun
      `worker/src/solana-usdg-mint.test.ts`.
- [ ] **Pyth re-check** of both generations, read-only, with the output kept;
      **Hermes cross-check** with Milla's key.
- [ ] **Jupiter fork test with the owner's program copies** on the release commit,
      and again whenever the executor's quote parameters change.
- [ ] **A second RPC provider** from a different company.
- [ ] **A funded fee payer** with its own seed, and log alerts on the `[alert]`
      lines of the web and Solana worker services.
- [ ] **Production Privy**: Solana embedded wallets on the production app id
      (lift the dev-mode cap in place), wallet export enabled; only then, and
      after the release entry ships in the published CLI, set
      `NEXT_PUBLIC_MERRYMEN_SOLANA_OWNER_KEY_EXPORT=1`.
- [ ] **External audit** of custody, ABI, execution, authentication and accounting.
- [ ] **Canary**: Milla's go, owner-authorized funding and the smallest caps
      (`MERRYMEN_SOLANA_LIVE_MAX_*`), one tenant named in
      `MERRYMEN_SOLANA_LIVE_TENANTS`; then restart and outage, full exit,
      withdraw and revoke, and expiry tests; then widen the list. The order of
      settings is in [`hosted-deploy.md`](hosted-deploy.md) ("Turning Solana on").
- [ ] Measured quote-to-finality latency, fill rate, slippage, fees, rent and
      recovery reliability against equivalent RH workloads before any claim it is
      better.
- [ ] Further product work: general-token live trading, discovery and Brain
      strategy integration, X, Telegram, MCP and mobile parity, owner bridging.

The adapters use Jupiter Swap v1 for its quote context slot and pinned CPI ABI.
Any provider migration must keep equivalent freshness, instruction binding and
accounting evidence; v1's continued availability is a dependency to verify, not
an assumption.
