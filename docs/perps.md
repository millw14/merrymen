# Perpetuals (Lighter on Robinhood Chain)

An owner can let their Merryman trade perpetual futures — long or short, with
leverage — on the markets Lighter lists on Robinhood Chain (BTC, ETH, SOL, large
US stocks, SPY/QQQ, gold…). Collateral is USDG, posted from the login's **Perps
wallet** into Lighter's settlement contract on chain 4663, and every withdrawal
can only ever come back to that same wallet. The Perps wallet is a second
Kernel account of the owner key that holds the Spot wallet, with a grant of its
own (see "One login, two wallets"). The Spot wallet never holds a Lighter
account.

This file is the contract that `packages/core/src/perps.ts`, the wall entry in
`packages/core/src/wall.ts`, the modules under `worker/src/perps/`, the perp
lane in `worker/src/index.ts`, the perp tables in `worker/src/store.ts`, the
keygen and grant routes, the Settings section, the Telegram, MCP and CLI
surfaces and the docs are built against. Where a rule and the code disagree,
the code is wrong. `docs/perps-mainnet-checklist.md` lists what must be proven
with a small amount on mainnet before live perps are switched on for anyone.

## What is on main, and what is not

Perps is landing on main in six slices, each its own pull request, in the order
of the plan "Perps: remaining work to 100%" (Phase 2). The rules below describe
the finished product; this table says how much of it main carries.

| slice | what it lands | on main |
|---|---|---|
| 1. Core and permission wall | the Lighter route, market and ABI constants, the `perp-lighter-v1` wall option, the canonical-wall marker, the signers' carry-forward. `POST /api/grants` refuses every perps grant (`perp-not-offered`) | merged (#359) |
| 2. Two wallets per login | wallet purpose and the Kernel index 1 derivation, the Perps grant and settings stores, wallet-aware revocation and renewal, and **the Perps half of every kill**. No route creates, renews, funds or shows a Perps wallet (`perps-wallet-not-offered`) | merged (#361) |
| 3. Worker engine, paper only | `worker/src/perps`, the vendored signer, the perp ledger and budgets, the paper venue and the paper lane, run only by a Perps wallet's worker; the kill also stands paper books down. `MERRYMEN_PERPS=live` is off in this build | merged (#362) |
| 4. Orchestrator and hosted operation, paper only | a Perps worker per login (`0x<owner>:perps`, home `children-perps/<owner>`) run only at `MERRYMEN_PERPS=paper`; the paper perp book in the mirror, the checkpoint and the handover specs; one public Lighter feed per orchestrator; the kill and `/pause` reaching both wallets' workers. The **live** stand-down is not in it (see below) | merged (#365) |
| 5. Web API, desk and CLI | making a Perps wallet, the desk, onboarding, `status` and `recover` for the Perps wallet; funding is its own PR after it. First, 5a: the inert foundation; then 5b: the Perps wallet's intake and status; then 5c: its settings, exits and practice reset, and the worker's paper exits (below) | 5a, 5b and 5c in review |
| 6. Other surfaces | Telegram, MCP, the partner API, then the phone clients | not yet |

Until slice 5b, nothing on main can make a Perps wallet, and from 5b only a
deployment at `MERRYMEN_PERPS=paper` can, so none exists in production; every
kill path already reaches one (rule 13), so that from the day
one can exist it is stopped by every kill. Perps stays off in production while
the slices land: an unset `MERRYMEN_PERPS` means off (rule 1), and each slice
is safe to deploy alone with perps off.

**What slice 3 carries, and what it does not.** The engine is the perps
branch's paper engine (codex/perps-mode-samples at c7071662, before its live
executor), reconciled with main. A worker serves one wallet: whatever starts a
Perps wallet's worker sets `MERRYMEN_WALLET_PURPOSE=perps` (slices 4 and 5;
unset is Spot), and the worker refuses a grant whose signed `purpose` is the
other wallet's. Only a Perps worker arms the perp lane, and it runs no spot
producer (`perps-only`). A Spot worker never starts the lane or its feed and
shows its strategist no perps; its budget readers and paper reset touch the
perp tables, which hold nothing for it, so they add nothing. Nothing on main
starts a Perps worker yet. There is no live executor, reconciler or on-chain leg in this build:
`MERRYMEN_PERPS=live` is off, and a live account with perps on is refused
`perp-live-not-yet`. The signer is vendored and hash-checked but loaded only by
its own tests. The hosted checkpoint of paper perp state and the mirror of the
perp ledger are slice 4's (below). The style profiles (`perpsStyle`) and the Brain
driver came later on the branch and are not in this build: `perpsDriver` is
`perp-trend`, `strategist` or `manual`, and `perp-trend` trades the 4 h
`swing-trend` signal. A Perps worker builds no LLM strategist (its strategy is
`perps-only`), so `strategist` resolves to `manual` there, never to
`perp-trend`.

**What slice 4 carries, and what it does not.** Hosted operation of **paper**
Perps workers, and nothing live:

- *A worker per wallet.* The orchestrator keeps each login's Perps worker under
  the key `0x<owner>:perps` (`worker-key.ts`) with its home at
  `children-perps/<owner>`, so no Spot path moves. It reads the Perps grant and
  settings stores by owner, hands the child `MERRYMEN_WALLET_PURPOSE=perps`,
  its own pinned grant and settings files and no venue key, and gives it no
  Telegram, groups, DM memory, Fomo or flow broker, IPC channel, public id or
  public roster (rule 17). Its holder status is the owner's, read-only. It is
  held as its owner is (accounting hold, rollout, chain check), never through
  the new-tenant route, and spawned after every Spot worker. While the owner
  has an unexpired Spot grant, it runs only on the replica holding that Spot
  lease, so a login is never split across replicas. That is checked at every
  start and restart, on every pass and the moment the Spot lease drops. One
  that loses the lease is stood down, final-passed and released.
- *Only at `MERRYMEN_PERPS=paper`.* The Perps roster is read whatever the flag
  says (being listed is what keeps a Perps book, lease and home from every
  cleanup), but a Perps worker is started only at `paper`. Turned off, a
  running one is stood down as a kill stands one down, its last rows mirrored
  and its lease given back; its paper positions are frozen until `paper`
  returns. A Perps worker also gives its process slot back, the same way, when
  a Spot worker is waiting for one (Spot first). An unreadable Perps roster
  changes nothing for any Perps worker: none is started, stood down, yielded,
  wiped or released on that pass. There are two exceptions, both read from
  outside the Perps roster. A worker whose last-read grant has expired is
  retired as on any pass (stood down, final-passed, its lease released),
  because expired authority goes either way. One whose owner's Spot lease left
  this replica is stood down; its final pass and release wait for a pass that
  reads.
- *Durable books.* The perp ledger mirrors to Postgres (own account only, inert
  for a Spot book with no perp rows), the paper checkpoint carries the perp
  book (`perp_json`, recorded stops included), and the ledger-import specs carry
  the perp tables. Every way a Perps worker stops (kill, removal, expiry, the
  flag leaving `paper`, a yielded slot, the drain) ends in a final mirror pass
  under the Perps account: the one its spawn read from the grant, or after a
  restart the `perps_wallets` record, used only when the book is that
  account's. With neither, or a book that is not that one account's, nothing
  is copied and the lease and home are kept; and a running Perps worker is
  never handed a grant for another account (an `[alert]` instead: a re-sign
  names the same, derived account). While the `perp_json` column
  cannot be added, Spot books are written without it, and paper perp books
  are not written at all (the log names the SQLSTATE; anything but a lock wait
  is an `[alert]`). The add is tried at most once a minute, and only that one
  attempt, with any checkpoint beside it, waits its bounded lock wait (about
  14 s). The fleet handover refuses while a Perps book exists, until it covers
  them.
- *Off every public read (rule 17).* The orchestrator records each Perps
  wallet in `perps_wallets` before its worker first starts (no record, no
  worker), and the directory, leaderboard, theses and decision pages leave
  those accounts out; one that cannot read the record says so rather than
  listing both wallets. A Perps worker publishes no market review.
- *One feed.* `perps/fleet-feed.ts` publishes the public Lighter feed every
  hosted Perps worker reads, over what this replica's own Perps workers want
  and the markets their books hold. It runs only at `paper`, is paused under
  FLEET_HALT and is stopped before the drain. A book that will not read keeps
  the markets it last read, because its positions still need prices to close
  at their stops; one never read keeps the feed as it was.
- *The kill and the pause.* A kill from the owner's bot, or one sitting in a
  Perps worker's home, is the owner's whole kill (both wallets, Solana, paper
  off), and every worker it revokes is stood down before the ✅. `/pause` is the
  login's: the Spot home's pause is mirrored into the Perps home. A kill in the
  owner's recovery journal, not yet carried out, holds the Perps worker: it does
  not start. A recorded pause not yet applied, or a durable pause, starts it
  paused instead (its protective loop still closes at stops), and it stays
  paused until the owner's Spot home is armed and says otherwise.

**Not in slice 4.** The live hosted stand-down (closing at Lighter, bringing
money home, Lighter's 1 USDG withdrawal minimum), the venue key's hand-over,
the live checkpoint and `custodySentence` come with the live executor, after
the paper slices. **A Perps worker runs no bot in this build**: the bot seat a
Perps-only login needs (the Perps worker running the owner's bot when there is
no Spot grant, and a Perps-aware bot) is slice 6a's. Until then a Perps-only
owner stops from the web and the phones.

**Known limitation: a lost Perps home.** A Perps worker whose persistent home
is lost (the volume replaced, not handed over) does not start again. Its
import receipt (`tenant_ledger_import`, key `0x<owner>:perps`) is never
released by any automatic path, the attested-gap registration refuses a Perps
key, and the Perps smart account is fixed per owner, so a re-sign does not
help. It fails closed: the orchestrator logs that the persistent original
book is unconfirmed on every pass, and nothing is lost, because the mirrored
perp rows and `paper_checkpoints.perp_json` stay in Postgres. An operator
recovery path (admitting a fresh Perps book and restoring `perp_json` into
it) is not built yet. Until it is, never replace a volume while Perps books
are on it; the handover already refuses.

**What 5a carries: the foundation, inert.** Nothing a Spot owner or a caller
who names no wallet can do changes, and no Perps capability is added, with
`MERRYMEN_PERPS` set or not. It lands the pieces the rest of slice 5 stands on:

- the core wall's `perpsOnly` option (`WallOptions.perpsOnly`), set only from
  a grant's signed `purpose` (`grantWallOptions`): a Perps wall carries no Spot
  spender, token, adapter, vault, class, Pons or Trencher permission, only the
  perp route when a perp block is sealed and the energy buy when asked for. A
  paper Perps grant seals neither, so its wall is empty. Spot walls rebuild
  byte for byte as before. No signer makes a Perps grant yet;
- one perps gate: `MERRYMEN_PERPS`'s parser moved to
  `packages/core/src/perps-ceiling.ts` (the worker re-exports it), read by the
  web as `perpsOffered` (not off) and `perpsCreationAllowed` (paper)
  (`web/src/lib/perps-enabled.ts`), which no route asks yet;
- `walletUrl`, the one client builder for `?wallet=`;
- the wallet named, with no default, on the web's shared server helpers
  (`hostedAgentFor`, `diskAgent`, `withReadDb`, `archiveCurrentGrant`,
  `removeSelfHostedGrant`, `queuePaperReset`). Every caller passes `spot`;
  `perps` resolves only the Perps wallet (its store hosted, `accounts/perps`
  self-hosted) and never the Spot one;
- the route guard (`web/src/lib/route-guard.ts`): every API route that is not
  wallet-aware refuses a `?wallet=` other than Spot with 400
  `wallet-not-supported` before it reads or writes anything, and a test walks
  every route file to hold it. Only `/api/grants` reads the wallet itself
  (from 5c also `/api/settings`, `/api/orders` and `/api/paper-reset`).

**What 5b carries: the Perps wallet's intake and status, and the browser
signer that makes one.** No screen calls the signer for Perps yet: the desk
and `/create?for=perps` are PR 3.

- `POST /api/grants?wallet=perps` makes or renews a Perps wallet only at
  `MERRYMEN_PERPS=paper` (`perpsCreationAllowed`); otherwise 403
  `perps-wallet-not-offered` with nothing read or written. A renewal's first
  step, `DELETE /api/grants?wallet=perps` with `purpose:
  "permission-replacement"`, is refused the same way before the store or the
  Perps home's `grant.json` is touched, so a renewal that cannot finish never
  stops the wallet; the kill names no wallet and is never gated. Robinhood Chain
  mainnet only (400 `perps-chain`). Hosted, its owner must be the login (403
  `perps-owner`, before the nonce: only `privy-did-owner-v1` logins have one in
  v1); its binding is verified against the text that names the wallet, so a
  Spot binding replayed as Perps, or the reverse, is refused 403; its account
  must derive from the owner at Kernel index 1 (403 on a mismatch, 503 when the
  derivation cannot be made, never a pass); it is stored with
  `getGrantStore("perps")`, whose conflicts answer 409 with their code and any
  other failure a fixed 503. Self-hosted, the same wall and index-1 derivation
  (a live eth_call that fails closed with 503), the Spot `grant.json` held to
  the store's same-owner, other-account rules, then the Perps home's
  `grant.json` archived and replaced whole. No public identity or name (D2).
- The canonical wall rebuilds a Perps grant as the Perps wall
  (`grantWallOptions` from its signed purpose). In this build that wall is
  empty (D5): a Perps grant declaring any marker, token, sealed address, perp
  block or the energy buy is refused `invalid_wall`.
- `GET /api/grants?wallet=perps` answers from the Perps store, home, ledger,
  heartbeat and settings tick, through core's `publicGrantView` (Spot keeps
  its denylist view, D3), with the worker's `agents.perps` report and no
  energy; every GET answer is `private, no-store`. It is answered whatever
  `MERRYMEN_PERPS` says (D1).
- `renewalSkipsRevocation` (`web/src/lib/perps-renewal.ts`): the one rule by
  which a renewal may skip the on-chain revocation, true only for a Perps grant
  whose wall rebuilds empty (D6). The server's retired-key fence still applies.
  It has no caller yet. The dashboard renewal (`Wallet.tsx renewKey`) renews
  Spot only and refuses any other grant before anything is read, stopped or
  signed: its account read is Spot's `GET /api/grants` and its revocation
  derives the Kernel account at index 0. The Perps renewal (PR 3) needs more
  than loading the Perps grant: its account read through
  `walletUrl("/api/grants", "perps")`; a revocation, when one is made, at
  `accountIndexForPurpose("perps")`, or refused before the stop; D6 decided
  from the page's own copy when the server holds none (an interrupted renewal),
  as well as from the server's view when it holds one; and a decline before
  the stop when `MERRYMEN_PERPS` is not paper (the stop is refused 403 then).
- The browser signer (`web/src/lib/session.ts`): `MintOptions.purpose` (absent
  is Spot) picks the Kernel index (`accountIndexForPurpose`, at both
  derivations), the wall (`perpsOnly`, no Spot spender, no energy buy, no
  scoped-spenders marker, no `tradeable-v2`: the empty wall the server
  expects), the grant's own `purpose`, the claim it signs (`bindingMessage`
  with the purpose), the storage slot (`merrymen.grant.perps.v1`; Spot's stays
  `merrymen.grant.v1`) and the handoff URL (`walletUrl`, so
  `/api/grants?wallet=perps`). A Perps signature refuses, before the owner
  signs anything, every Spot opt-in, any Lighter key (new, carried, dropped or
  recovered), and any network but mainnet. The storage helpers
  (`loadGrant`, `clearGrant`, `listSavedWallets`, `localGrantsSnapshot`,
  `previewOwnerAccount`) take the wallet with no default, as do
  `loadRecoveryGrants` (whose snapshots now keep the purpose) and
  `stopAgentForReplacement`; a kill still names no wallet.
- `priorPerpFor` fails closed when the server's view is absent: this
  browser's copy may say an account claims perps (`unknown`, refused) but never
  supplies the key. A renewal takes one snapshot (the server's view at the
  click and `localGrantsSnapshot(wallet)`) and hands the same objects to its
  preflight and its mint.

**What 5c carries in the worker: the owner's paper exits (D11).** An owner's
Close and Close all on the Perps wallet are executed; nothing new opens, and
nothing reaches a venue, a key or real money.

- Two order shapes, both kind `trade`, both reduce-only, checked by the one
  browser-safe parser the web route and the worker share
  (`worker/src/perps/owner-order.ts readPerpExitOrder`): `close-perp`
  `{side: "sell", symbol: "<MARKET>-PERP", usdgAmount: 0, purpose:
  "close-perp", book: "paper"}` and `flatten-perps` `{side: "sell", symbol:
  "ALL-PERPS", usdgAmount: 0, purpose: "flatten-perps"}`, whose `book:
  "paper"` is optional: Close all from a desk that could not read its book
  omits it, which means every book (D11), here the practice one. `book:
  "live"` is refused by name. The row is bound to the Perps smart account, so
  the ferry hands it to the Perps worker (`0x<owner>:perps`) and never the
  Spot one; self-hosted, the file goes in `accounts/perps/commands`.
- The worker judges the wallet first (`order-gate.ts walletOrderRefusal`): a
  Perps worker takes these two and nothing else (no Spot order, no energy
  buy); a Spot worker never takes one. An exit is not stopped by a Spot read,
  the pause or the typed-order ceiling (rule 8a). The lane closes what the
  practice book holds now (`lane.ts close`, `flatten`), under its lock, with
  the protective close's slippage, filed under source `chat` (provenance
  owner-command) before anything is placed, and booked by the paper engine as
  its own exits are. A close whose decision cannot be written is not sent.
  While the account is not on paper, its practice book is frozen (rule 14) and
  neither touches it.
- Close all writes `perp_accounts.entries_halted` before it closes anything,
  and holds the halt in the worker if that write fails. **The owner's practice
  reset lifts it** (`POST /api/paper-reset?wallet=perps`): the reset closes
  every practice position into the old epoch, so the halt has nothing left to
  guard, and the ledger's halt is cleared in the reset's own transaction
  (`store.ts resetPaperLedger`, `clearEntriesHalt`). Only a reset asked for
  after that Close all: the lane remembers when the Close all was asked for
  and decides (`lane.ts resetPaper`), because hosted an exit rides the ferry's
  short loop and a reset its reconcile pass, so a reset asked for first can
  reach the worker second. A halt stored by an earlier worker process (no
  memory of when) is lifted by the next reset; a reset asked for before a Close
  all that ran in a process since restarted is the one order this cannot tell.
  A Perps reset expires with the Perps order window, so a reset can never lift
  a halt days later. Nothing else clears it: Resume needs the owner-controls
  history (a hash-chained halt log, so a stale resume or an older checkpoint
  cannot clear a newer halt), which is built on the live recovery records and
  hosted checkpoint formats that are not on main, so the desk must not offer
  Resume. The owner's pause stops entries as before: the login's pause is
  mirrored onto the Perps worker, and its tick returns before the perps route.
- An owner's exit carries no receipt, run or expired: the drain's expiry at the
  claim, the worker's own check and the orchestrator's never-ran sweep all ask
  `order-receipt.ts expiredOrderReceipt`, which answers none for an exit, as
  the run path's `orderOutcome` does. A receipt templates a Spot fill, and a
  Close of a short is not a sell.
- Self-hosted, an exit or a reset filed in `accounts/perps/commands` names the
  account it was asked for (`FileCommand.account`), and the drain answers it,
  claimed and never run, on any other (`command-files.ts notForThisAccount`):
  the Perps home outlives the account in it, and a Perps wallet made again
  under another owner key is another account there. Hosted, the row's
  `agent_id` and the ferry's join already bind it.
- At most once: the drain's claim is the unlink (`command-files.ts`), and the
  ferry claims a row before it writes the file, so a crash between a close and
  its answer leaves the command claimed and unanswered, never run again (the
  sweep later says it may have run). A close is built from what is held, so a
  second run would find nothing and book nothing.
- A Perps worker under any `MERRYMEN_PERPS` but paper claims no command
  (`settings.ts perpsWorkerStoodDown`, D19); hosted, it is not running at all.
  Its rows wait unclaimed, and are answered when a worker next drains under
  paper: run inside their window, expired with nothing sent after it.
- A Perps worker's energy report never says a buy is `ready` (`energy.ts
  energyBuyOf`).

**What 5c carries on the web: the Perps wallet's settings, exits and practice
reset.** `/api/settings`, `/api/orders` and `/api/paper-reset` read
`?wallet=` themselves (`readWalletParam`; absent is Spot). A value that names
no wallet, or two, is 400 `wallet-unknown` with nothing read or written. The
Spot wallet's answers are what they were; no screen calls the Perps ones yet
(the desk and `/create?for=perps` are PR 3).

- `GET /api/settings?wallet=perps` answers from the Perps store (hosted) or
  `accounts/perps/settings.json` (self-hosted), whatever `MERRYMEN_PERPS` says
  (D1), with `strategy` `perps-only`, `private, no-store` and `Vary: Cookie`.
  A store or file that cannot be read is 503 `settings-unreadable`, never the
  defaults.
- `PUT /api/settings?wallet=perps` is an allowlist, not Spot's handler: the
  perps keys (bounds and grid from core, as the worker checks them), `strategy`
  (always stored `perps-only`) and `liveTradingEnabled` false only (D5). Every
  other key is reported in `ignored` and never stored: no secret, URL, Telegram
  or holder field reaches the Perps blob. Refused by name: the strategist and
  Brain drivers and any `perpsStyle` (D9), and switching real-money perps on in
  any form, "not available on this server yet" (D10); the consent's withdrawal
  is never refused. Offs (practice perps off, the live rail off, the consent
  withdrawn) are written even beside an error, over what was stored. Hosted,
  the save holds the login's save lock and never calls `botClaimForSave`, so
  a Perps save can neither take nor release the Spot wallet's bot. Reads are
  strict (a broken file is 409, never rewritten); writes are whole (atomic,
  0600) and **only over the blob that save read**: the kill turns
  `perpsEnabled` off in the same blob without the save lock (nothing may hold
  a kill up), so every Perps write is a compare and swap
  (`settings-store.ts putSettingsIfUnchanged`: `UPDATE … WHERE sealed = <read>`
  on Postgres, a synchronous look-and-write on the file store and
  `settings.ts writeSettingsFileIfUnchanged` self-hosted), and on a miss the
  body is judged again from a fresh read, at most three times (then 503, with
  nothing written). A save that never names the switch keeps the kill's off; a
  save that switches practice perps on over an off that landed while it was on
  its way is refused. Self-hosted, a `merrymen kill` or Telegram `/kill` in
  another process can still land between the look and the rename (no lock
  across processes, D7). Where Perps are not offered (D1), self-hosted as
  hosted (D19), a save may only turn things off: anything else is 403
  `perps-wallet-not-offered` with only its offs written, and an off with
  nothing on to turn off writes nothing, so no Perps settings are made on a
  server that offers none.
- `POST /api/orders?wallet=perps` queues the worker's two exits and nothing
  else (`readPerpsWalletOrder`, the worker's own parser): an entry, a Spot
  order or an energy buy is refused 400, and the Spot wallet refuses an exit
  with 400. The order must name the Perps account the owner reviewed
  (`expectedAccount`; 409 `account-changed` on a mismatch, 400 when missing),
  which is checked and never queued in the args; only the exit's own fields
  are. The order is bound to the account the route resolved: hosted, the row's
  `agent_id`; self-hosted, `FileCommand.account` on the file, which the worker
  refuses on any other account. The account, ceiling, order window (the Perps
  worker's tick), one-at-a-time slot and queue are each the Perps wallet's
  (self-hosted, `accounts/perps/commands`).
  Close all with no `book` is queued without one (D11). The fleet recovery hold
  refuses an exit as it refuses any order (D11). Where no Perps worker runs
  (`perpsWorkersRun`: `MERRYMEN_PERPS` is not paper), `POST` and `GET` are 403
  `perps-wallet-not-offered` with nothing queued or read: the worker is stood
  down and its practice positions frozen, and an exit queued then would run
  whenever perps came back. `/api/orders/ceiling` stays Spot's: an exit has no
  amount to offer chips for.
- `POST /api/paper-reset?wallet=perps` (D12) queues a reset of the Perps
  wallet's practice book through `queuePaperReset(hosted, account, "perps",
  { expiresAt })`, with the account resolved in the same wallet
  (`hostedAgentFor(req, "perps")`, `diskAgent("perps")`), and is 403 where no
  Perps worker runs. A Perps reset carries a deadline, the Perps worker's order
  window (`order-ceiling.ts orderTtlFor`, the window its exits wait), on the
  self-hosted file and in the hosted row's `args`, which the ferry lifts onto
  the child's file: one queued at paper and still waiting when perps are stood
  down is answered expired, the book untouched, when they return. It also
  lifts the Close-all halt (above). Start over (`/api/grants/discard`) stays
  Spot's; it already stops the Perps wallet as every kill does, and Spot's
  reset is queued as it always was.
- Not in 5c: Resume after Close all (see the worker paragraph above), the
  Perps read routes and recover (PR 2), the desk, chat cards and onboarding
  (PR 3).

## One login, two wallets

A login holds two wallets, derived from **one owner key**:

- **Spot**: Kernel index 0, Kernel's default. Every agent account made before
  Perps existed is a Spot wallet, and none of them moves.
- **Perps**: Kernel index 1 (`accountIndexForPurpose`), a different address.
  It holds the Lighter account and nothing else.

Each wallet has its own grant, session key, settings, ledger rows and worker
(hosted from slice 4). A grant says which wallet it is for in `purpose`: absent is
Spot, `"perps"` is Perps, and anything else is refused, never read as Spot
(`grantPurpose`). A Perps claim names its wallet in the signed binding text
(`Account purpose: perps`), so a signature over a Spot claim cannot be replayed
as one; the Spot text is unchanged, byte for byte.

**Where each lives.** Hosted: Spot in `grants` and `tenant_settings`, as
always; Perps in `perps_grants` and `perps_tenant_settings`. The file backend
(tests and the single-service deploy): `tenants/` and `tenant-settings/` for
Spot, `tenants-perps/` and `tenant-settings-perps/` for Perps. Self-hosted, the
Perps wallet is a complete home of its own at `$MERRYMEN_HOME/accounts/perps`
(`purposeHome`): its `grant.json`, its archive under `grants/`, its pause
marker, and later its settings and ledger. Nothing creates a Perps table or
directory until the first Perps write: until then every Perps read answers
empty and every kill finds nothing, by a catalog look (`to_regclass`) or a
`stat`, with no lock. Nothing ever rewrites a Spot row for Perps. Holder claims
are the login's, not a wallet's: both settings stores share them. The public
profile is the Spot agent's alone: the Perps account never joins the login's
public identity (decision D2). `POST /api/grants?wallet=perps` mints and names
nothing, as the orchestrator adds nothing for a Perps worker, so no slug,
profile, board, search or follow can resolve to it. The profile, summary and
own-book reads (`read-agent.ts`) and the MCP public board and profile
(`public-feed.ts`) also leave out every account in `perps_wallets`, as a
backstop; the first-name count is Spot's alone.

**One owner, two separate authorities.** Decided where both are written, under
one lock for the tenant across both wallets (the file store's shared writer
lock; on Postgres a transaction on its own connection taking the tenant's, then
the account's advisory lock), so two writers racing cannot both pass:

- both wallets use the same owner key;
- the two wallets are different accounts, and neither is an account another
  login holds;
- a Perps wallet never sits beside a Spot grant that still carries the
  perpetuals permission (legacy Perps authority, retired first);
- a Perps wallet is owned by the login's own wallet: the embedded wallet
  (`privy-did-owner-v1` binds owner to tenant) or an external wallet that
  signs in and owns. Never a key generated in a browser.

**Naming the wallet.** `getGrantStore`, `getSettingsStore`, the store
constructors, `purposeHome` and `deriveKernelAccountAddress` take the wallet
with no default, so every call site says which it means. A default of Spot is
how the perps branch's kill, exits and profile reads came to miss the Perps
wallet. Requests name it with `?wallet=spot|perps` (absent is Spot); the body's
`purpose` on `DELETE /api/grants` is what a stop is for (`delete-agent`,
`permission-replacement`), a different thing. A permission replacement stops
exactly the wallet it names; a kill names none, because it stops every one.

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
   `MERRYMEN_PERPS=off|paper|live` (**unset is off, hosted and self-hosted**,
   as `MERRYMEN_SOLANA` is; an operator sets `paper` or `live` explicitly),
   `MERRYMEN_PERPS_LIVE_TENANTS` (hosted allowlist of Perps wallets), and
   `MERRYMEN_HALT_PERP_ENTRIES=1` (entries off, exits and protection on). These
   limit trading, never a kill: every kill reaches the Perps wallet whatever
   they say (rule 13).

2. **The Perps wallet owns its venue account; money only ever comes back home.**
   The Lighter account's L1 address is the login's Perps wallet. Nothing here
   creates, funds or trades a Lighter account keyed on any other address: not
   the Spot wallet, not the sign-in wallet. Moving USDG from Spot to Perps is
   the owner's own transfer, booked on the Spot book as an owner outflow and
   never as a trading loss. The
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
   grant carried perps, **refuses** rather than silently dropping them. The
   marker is sealed into a **Perps wallet's** grant, whose wall carries the
   Lighter permissions and no Spot approvals, swaps or vaults; a Spot grant that
   carries it is legacy authority, and no separate Perps wallet is made beside
   it until it is retired.

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
    A partial payout's allocation and remainder are durable in `perp_payouts`,
    committed in the same transaction as paid transfers and their margin
    journal entries. Restarting after the cash cursor passed that payout must
    preserve the remainder deducted from T_out. A missing legacy allocation
    is unread transit, never a guessed zero remainder.

13. **Every kill reaches the Perps wallet; kill and expiry stand the perps down,
    with the Lighter key only, and never remove a stop from an open position.**

    *The Perps half of the kill* (`worker/src/perps-kill.ts`, on main from slice
    2) is called beside the Solana half of every kill path: "Kill all agents"
    (`DELETE /api/grants`, `delete-agent`, hosted and self-hosted, which the
    phone apps' Stop sends too), the orchestrator's `honourKill` for a hosted
    Telegram /kill or a recorded one, the self-hosted Telegram /kill, and
    `merrymen kill` (through `perps-kill-cli.ts`). Start over
    (`/api/grants/discard`) calls it too, because owners are told it is the
    kill switch (the MCP control list, the hosted Telegram kill's fallback); it
    still does not stop Solana, which it never did. A self-hosted Spot
    permission replacement does not: neither wallet's renewal touches the
    other wallet. Hosted it is a stop by
    tenant; self-hosted it stops every local Perps wallet, and Telegram gets a
    three-way answer (stopped, none, not stopped). Its guarantees are Solana's:
    a half that fails is reported incomplete, never done, and the kill stays
    pending; a retry is safe; an owner with no Perps wallet costs the kill a
    read-only look, so it takes no lock and writes no schema, and its answer is
    what it always was; it runs whatever `MERRYMEN_PERPS` says. A Telegram kill
    carried out later revokes only a Perps grant stored at or before it, as the
    Spot half does: one signed after the kill is the owner's later decision.
    The half revokes the Perps grant (slice 2; self-hosted, archived first so
    its owner key survives; an archive it cannot write keeps the grant and
    pauses that wallet's home). From slice 3 it also stands the **paper** book
    down: the Perps wallet's paper strategy is turned off (`perpsEnabled`
    false in that wallet's own settings, every other setting kept; hosted by a
    compare-and-swap on the sealed row, with no schema made for an owner who
    has no Perps wallet), and its paper positions are frozen where they are.
    With the grant gone no worker arms on that wallet, so nothing opens,
    trades, protects or values them. Nothing is closed at a price, because a
    paper close needs a fresh mark the kill does not have. Signed again, the
    lane finds them held with perps off: nothing new opens, and what is held
    keeps its stops and closes on its own rules. A grant signed after a
    Telegram kill keeps its settings too. A paper strategy that could not be
    turned off makes the kill incomplete, said as that and never as a grant
    that may still sign. From slice 4, hosted, the running Perps worker is
    stood down before the ✅ (its restart cancelled, its process signalled, its
    grant copy removed; a copy that will not go keeps the kill pending), and a
    kill sitting in a Perps worker's home is carried out as the owner's whole
    kill, the Perps grant judged first. The live stand-down below arrives with
    the live executor, after the paper slices, and the kill answer gains a
    third state then, `closing`, because closing positions takes up to 15
    minutes hosted and can end with money left at Lighter; Telegram and
    `get_attention` report how it ended.

    *The stand-down.* Order: close each position with a
    reduce-only IOC within `perpsMaxSlippageBps` of mark (up to three
    attempts); only once a market reads flat, cancel that market's remaining
    orders; then a secure withdrawal of free collateral; then one
    authenticated ingest so the stand-down's own fills and funding are booked.
    Self-hosted, every kill path writes `standdown-request.json` into the
    Perps home before archiving its grant; the Perps worker runs it with the
    key it holds and writes `standdown-result.json`; the CLI waits up to 120 s
    and prints it. Hosted, the kill removes the Perps grant (and session key)
    and, in the same store transaction, writes a sealed `perp_standdown` row
    (key, account, key index, 15-minute TTL); the orchestrator runs a **stand-down-only**
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
    key. The required re-enablement design is an explicit owner acknowledgement
    with verified rotation evidence, durable retirement of the old keys, and
    replacement authority for the exact observed recovery key. This transition
    is not wired into the dashboard or worker yet: recovery remains halted and
    re-signing alone does not clear it. This is a live-release blocker. Detection
    is after the fact.

17. **Perps are never published in v1.** Perp decisions file under their own
    sources (`perp-route`, `perp:strategist`), which are withheld in
    `thesis-policy.ts`; every `perp-*` reject rule is withheld; no perp
    decision, order, fill, position, leverage or liquidation reaches the feed,
    theses, the group chat, X, the leaderboard's trade lists or `publicBook`.
    With two wallets per login, the Perps wallet is absent from every public
    read: it never joins the public identity (D2), the leaderboard and profile
    are the Spot agent's and their equity is the Spot wallet's, and no "uses
    leverage" marker is shown (one would publish that a login runs perps). The
    venue publishes the account anyway, and the consent says so.

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
- `payout-ledger.ts` — atomic payout identities and partial allocations, carried
  through hosted checkpoints and mirrors so a restart cannot overstate transit.
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

- `perp-trend` (default) — a deterministic producer with named profiles and frozen
  `PERP_TREND_DEFAULTS` and a "what this is not" header (it is not alpha; its
  backtest numbers are printed honestly). Universe: `perpsMarkets ∩ {BTC, ETH,
  SOL}`. The default `swing-trend` signal uses closed 4 h mark-price candles (≥ 100 contiguous, the one in
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


#### Deterministic style profiles

*Not in this build (decision D9): `perp-trend` trades the 4 h `swing-trend`
signal only, and the Perps wallet's settings `PUT` refuses a `perpsStyle`. What follows is
the branch's design, kept for when profiles land.*

`perpsStyle` selects a real native candle stream and a channel length; it does
not rename four-hour signals. Every profile requires at least 100 contiguous,
closed mark candles at its own cadence. Missing, stale or wrong-resolution
history produces no entry, with no fallback to another timeframe.

| Profile | Native bars | Entry channel | Holding deadline |
| --- | --- | --- | --- |
| `scalp-breakout` | 5 min | 12 bars | 30 min |
| `scalp-confirmed` | 15 min | 24 bars | 1 h |
| `scalp-selective` | 15 min | 36 bars | 1 h |
| `day-breakout` | 1 h | 12 bars | 8 h |
| `day-patient` | 1 h | 24 bars | 12 h |
| `day-selective` | 1 h | 36 bars | 12 h |
| `swing-trend` (unchanged default) | 4 h | 12 bars | 168 h |
| `swing-patient` | 4 h | 24 bars | 168 h |
| `swing-selective` | 4 h | 36 bars | 168 h |

EMA24 confirmation, ATR14, the six-bar exit channel, the stop floor of 1.5%,
the three-ATR stop, funding checks, at-most-1%-equity stop risk, all signed and
owner caps, and the 10x maximum leverage remain unchanged. So do the existing
8 h strategy-exit and 24 h risk-exit cooldowns: scalp refers to its signal and
holding horizon, not frequent trading or high-frequency execution. A narrow
owner stop or venue minimum can leave any profile idle. No performance claim
or backtest result is established for these profiles.

Profiles run under `perp-trend`. Brain still reviews only the original
four-hour `swing-trend` candidate; nondefault profiles cannot open through
Brain or the strategist. Manual may retain a dormant profile. Choosing a
profile never enables paper or live trading, creates consent or changes caps.
The live grant must cover the profile's holding horizon, in addition to the
existing independent expiry safeguards.

The decision records its profile and exact signal candle before execution;
the order binds that decision to durable fills. The worker reconstructs each
current position's lifecycle from signed `position_before` and fill deltas,
resetting at flat/reversal boundaries and refusing to carry a profile across
unknown or discontinuous fills. The reconstructed side and size must match
the position. This survives a crash before the cached `opened_at` was written.
Unrelated/manual decision evidence cannot create an entry profile.

A recorded entry's profile governs its strategic exits even after a settings
change. Its holding deadline also runs on the independent protective clock,
including while the driver is manual or the trading tick is paused. Reaching
the deadline **requests** a full reduce-only close: fresh readable position
and mark evidence, executable liquidity and the existing retry spacing are
still required, so this is not a guaranteed fill time. Existing stops remain
in force. Legacy positions without style provenance keep the original
strategy behavior; the worker never invents their entry profile.

The deterministic route binds each new entry to the owner/agent configuration
used to produce it. A driver, profile, authority or cap change during an
awaited decision or executor review refuses that pending entry before paper
settlement or live submission. Signal freshness also becomes a persisted
`send_not_after_ms` bound on live orders, so recovery cannot re-send a signal
after its own candle evidence has expired. This adds restrictions; it never
widens signed permissions or the existing risk limits.

Prepared live opening orders persist an immutable `entry_context` fingerprint of
the active owner/grant, execution rail, trading settings and Brain configuration.
Recovery compares that fingerprint before every replay, after an awaited hosted
lease check and immediately before HTTP. Switching profiles, selecting manual or
withdrawing live authority prevents old prepared entries from being broadcast.
Legacy opening rows without a binding are reconciled but never replayed; existing
reduce-only exits retain their signed-expiry and owner-deadline behavior.

Worker position reports include optional `entryStyle`, `styleOpenedAtSec`
and `holdDeadlineSec` from the durable entry lifecycle, not from the owner's
currently selected profile. Older reports retain their existing shape;
unknown optional profile metadata cannot hide an actual position.

Operational verification uses real worker/feed parsing, route, sizing,
policy, paper settlement, durable ledger and report code with synthetic
market fixtures for all nine profiles. Each fixture opens an eligible measured
breakout, reads back its entry profile and deadline, switches to manual,
closes on the protective deadline and checks that another pass cannot replay
the settlement. Separate fake-venue live tests verify persisted signal expiry,
profile restoration and report propagation. These are integration simulations,
not historical profitability tests or evidence that a production account is
funded, authorized or receiving a healthy live feed.



### Autonomous operation after setup

The owner enables perpetuals and chooses an automatic producer in **Settings →
Perpetuals**. The default trend rule needs no model provider. The `strategist`
producer needs the LLM strategist and a configured model; `manual` produces no
automatic entries. Real-money use additionally needs the owner's live consent,
regional attestation, funding/gas and a signed permission that carries the
Lighter key. Hosted rollout restrictions still apply.

Settings shows the saved producer, current setup progress, observed order
minimums and signed permission expiry. The trend rule requires more than seven
days remaining before an entry because it can hold for seven days. A market
whose minimum exceeds the owner's effective cap stays unavailable; selecting
eligible markets never changes that cap. A valid setup may wait for a signal.

After setup, eligible signals drive funding, key registration, leverage setup
and protected entry automatically. The worker reconciles fills/funding, maintains
stops, exits positions and handles withdrawal/claim progress. Temporary failures
before admission do not consume a signal. Failed spot proposal generation leaves
the independent perp route available, with all of its normal checks; a failed
strategist window discards its incomplete handoff. Execution/accounting failures
retain their existing durable recovery rules.

Automatic on-chain claims require a still-valid signed permission. After kill or
expiry, the restricted shutdown worker can request a venue withdrawal but cannot
sign an on-chain claim. Lighter's relayer or the owner's recovery flow completes
any remaining claim; a completed shutdown never means the funds have arrived.

Owner-requested pauses, Close-all halts, expired permissions and incidents that
require key rotation remain explicit owner actions. Automatic recovery never
widens a limit, supplies consent, extends a permission or guesses missing
financial history. The [mainnet checklist](perps-mainnet-checklist.md) is still
required before claiming the live venue lifecycle has been verified.

### Surfaces

- **Spot / Perps switch** — Spot returns to the original feed at `/`; its
  Perps toggle opens `/perps`. The entrance animation is claimed once per
  authenticated owner by `POST /api/perps/intro`, using an atomic database
  insert (hosted) or exclusive file creation (local). The owner comes from the
  verified session; another account cannot consume its claim. Claims survive
  restarts and are shared across devices. Reduced-motion users skip the
  animation, and unavailable preference storage never blocks navigation.
  `/perps-lab/radar?intro=1` explicitly previews it with fictional data without
  changing the account's claim.
- **Small-screen desk** — a floating Radar / Positions / Playbook dock shows
  one panel at a time. Switching panels preserves the chart selection and
  entry history; the Positions badge distinguishes unknown, stale and alert
  states. The original site's navigation returns with Spot.
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
  `purpose` marker through the owner-order queue. Both carry an explicit
  `book` (`paper` or `live`) that the confirmation names and the worker
  checks. The native `/agent?perps=flatten&book=live` (or
  `perps=close&market=BTC-PERP&book=live`) handoff only opens that review;
  an omitted book requires a choice before confirmation. Dashboard Settings
  clears the flatten halt through a separate owner-bound `resume-perps`
  request, never through chat; an incident still requires key rotation. (Not
  in this build: there is no `resume-perps`, and an owner's practice reset is
  what lifts the paper halt; see slice 5c above.)
- **MCP** — read-only `get_perp_positions` (portfolio.read); no perp tool moves
  funds or opens.
- **CLI** — `status` and `doctor` show perps (signer hash, venue reachability,
  key registration, account index, exposure); `kill` reaches the Perps wallet
  (slice 2: it archives and revokes `accounts/perps/grant.json`, asking first
  even when there is no Spot grant; slice 3: it also turns that home's paper
  strategy off, and says each part; with the live stand-down it will write the
  stand-down request and wait); `recover` has a venue leg, selected with
  `MERRYMEN_HOME="$HOME/.merrymen/accounts/perps" MERRYMEN_WALLET_PURPOSE=perps`.
- **Recover** — every platform shows a read-only venue disclosure (fetch and
  `eth_call` only, each field unreadable-not-zero). The owner-key unwind is L1
  priority requests in one sudo UserOp: `cancelAllOrders`, `changePubKey` to a
  fresh throwaway key (revoking the agent's), `withdraw` of free collateral;
  then `withdrawPendingBalance` after the delay. Closing positions on-chain
  (`createOrder`) is enabled only once the mainnet checklist proves its
  semantics on this instance.
- **Mobile** — both apps show a banner that cannot be dismissed whenever the
  Perps wallet's `agents.perps` is not `none` ("Leveraged positions on
  Lighter…" or "Lighter could not be read…"), never "No positions" in that
  state, and a Close-all button; kill copy uses `custodySentence`. A phone's
  Stop reaches the Perps wallet through the server's kill (`DELETE
  /api/grants`), so it needs no phone change of its own; the phone signers
  derive the Perps wallet at index 1 with its purpose (slice 6). Perps go live
  hosted only after both apps ship this.
- **Docs** — README (what you can do, ownership and enforcement, never a
  position you can't exit, Telegram commands), the privacy policy's
  third-party row for Lighter (and that positions are public), this contract,
  the mainnet checklist and the hosted runbook.

## Settings

These live in the **Perps wallet's** settings (`perps_tenant_settings`,
`tenant-settings-perps/`, or the Perps home's `settings.json`), never in the
Spot wallet's: one wallet's strategy and risk budget never become the other's.

| key | default | bounds | notes |
|---|---|---|---|
| `perpsEnabled` | false | — | paper perps; dashboard-only; no env term |
| `perpsLiveEnabled` | false | — | real perps; stored with `perpsLiveConsentVersion`, `perpsLiveConsentAt`, `perpsRegionAttested` |
| `perpsDriver` | `perp-trend` | `perp-trend` \| `strategist` \| `manual` in core; the Perps wallet's `PUT` takes `perp-trend` \| `manual` (D9) | the one autonomous producer; Brain is in no list in this build |
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

Every key is in the worker's clamps, the Perps wallet's `PUT` allowlist
(`/api/settings?wallet=perps`) with identical bounds (`perpsMarkets`,
`perpsDriver` and the consent record with their own branches), a rebuild
fingerprint, and `spec-coverage.test.ts`. `perpsStyle` (the profiles below) is
not in this build: core has no such key, and the Perps wallet's `PUT` refuses one (D9).

## Rollout

The six slices of "What is on main" come first; none of the phases below starts
before all six are merged and deployed with perps off.

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
- Whether Start over (`/api/grants/discard`) should stop the Solana strategy
  too. It revokes the Perps grant, because owners are told it is the kill
  switch, but it never stopped Solana.
- Whether the Perps desk gets a stop of its own that leaves the Spot wallet
  running (slice 5). The kill stops every wallet, so such a stop would be a
  new control with its own name.
- Whether a kill that names a wallet (`?wallet=`) should run anyway. Today it
  is refused with nothing deleted, as main refuses a stop whose intent is
  ambiguous, so no client comes to depend on a meaning it never had. The
  alternative is to fail open and stop every wallet: a kill should never be
  the thing that is refused. No client sends one yet.

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
- Paper perps run only while the worker does. A paper stop, take-profit or
  liquidation line the mark crossed and recovered from while the worker was
  down is not replayed — the practice position survives where the venue would
  have closed it. Missed paper funding is charged hour by hour from the feed's
  hourly history (every held market, plus BTC, ETH and SOL for the route —
  about the last 12 hours); an owed hour the feed does not carry stops that
  position's funding there, and the owner is told and shown it as unread
  rather than as zero.
- Lighter's contracts are upgradeable with no effective notice.
- Hosted children share an OS user, so a code-execution bug in any child could
  read another tenant's venue key; per-child isolation is a prerequisite for
  hosted general availability.
- Unknown-activity detection is after the fact: what a stolen API key does
  between its first transaction and the next reconcile is not bounded, and a
  compromised worker will not report itself.
- There is no testnet venue; the first live deposit, key registration and
  withdrawal happen on mainnet with a small amount.
- Hosted, a Telegram /kill reaches the Perps wallet only through a process
  answering the owner's bot, and until the bot seat lands (slice 6a) that is
  the Spot agent's: a Perps worker runs no bot. A Perps-only owner's kill paths
  are the web and the phones until then.
- Start over (`/api/grants/discard`) revokes both wallets' grants and resets
  the Spot paper book, but does not stop the Solana strategy. "Kill all agents"
  is the control that stops everything.
