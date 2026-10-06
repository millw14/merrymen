# Booking chain activity that Postgres lacks

Attested-gap admission ([fleet-resume.md](fleet-resume.md), step 5) reads the
chain for each live tenant before it registers a new book. It refuses a tenant
when the account sent an operation, or moved USDG, that Postgres has no row
for:

```
[alert] 0x…: resume approval REFUSED — the chain holds operations or USDG
transfers for the account that Postgres lacks: operation 0x… in tx 0x… at
block N; USDG in 4.965021 in tx 0x… log 11 at block N. …
```

The tenant stays held until those rows exist. This page covers booking them
with `worker/src/chain-gap-booking-cli.ts`, one tenant at a time. Every step
is preview first, and nothing is written until the owner of the books has
reviewed the exact rows and a backup exists.

The order is: **preview → the owner reviews → backup → apply → preview the
tenant again → approve → rollout.**

**The tool books only a tenant that refusal holds.** It checks this in
Postgres, not on trust (see [Which tenants it books](#which-tenants-it-books)).
A tenant still running on its own book is refused. Booking it would race its
mirror for the same operation, and the mirror skips any trade whose hash is
already in Postgres.

## What it books, and what it refuses

The tool runs admission's own chain check, from the same block admission
starts at, against one read of Postgres. Then it reads each named
transaction's receipt and block, and classifies every fact. For each token a
trade moved, it also reads the book's balance at a pinned block (see below):

| Class | What it is | What it writes |
|---|---|---|
| `session-trade` | The session key's swap: USDG one way, one token the other, read across the account and its custody vault | A `trades` row, as the in-flight reconciler writes a landed operation the book lost: `kind 'swap'`, `status 'landed'`, `basis_source 'receipt'`, the two legs, the fill (side, quantity and cash from the Transfer logs), gas from the EntryPoint's own event (sponsored or owner-paid), `created_at` at the block time. **Only when the cost-basis snapshot already holds what the chain does in that token** (see below) |
| `session-no-movement` | A session-key operation that moved nothing across the book's edge (an approval, a key install, a probe) | The reconciler's notional-0 row, so the operation is counted |
| `session-reverted` | A session-key operation that the EntryPoint recorded as failed | A resolved revert's row: `status 'reverted'`, its gas, notional 0 |
| `operation-leg` | A USDG transfer inside one of those operations | Nothing extra: the operation's row carries its transaction hash, which answers it |
| `deposit` | USDG in from outside the system, with no operation of the account and nothing paired | A `flows` row, as the chain-capital reconstruction writes one: `source 'chain-log'`, its `tx#log`, the block time |
| `owner-operation` | An operation signed by the owner's own key (the root validator) | **Nothing. It blocks.** The agent's book has no writer for an owner's operation, and booking it as the agent's trade would misattribute it |
| `unresolved` | Anything else, with the reason in words | **Nothing. It blocks.** |

The `unresolved` class covers these cases:

- A session key moved USDG with nothing coming back. A transfer home or an
  energy purchase books a flow beside its row, and that is two writers' work.
- The operation moved several tokens.
- USDG left the account in a transaction with no operation of the account.
- USDG arrived from another hosted account or from the account's own vault.
- A USDG transfer of the account sits outside its operation's execution.
- The fact is not yet 64 blocks deep, or it landed before the current
  accounting epoch opened. The current epoch has no trade, flow or equity
  row yet, so its opening cannot be dated.
- The fact landed after admission's chain refusal of the tenant, or within a
  minute before it. Admission never found it missing from the book a worker
  would run on. Let admission refuse the tenant again, then preview again.
- A trade whose token the cost-basis snapshot does not hold as the chain does
  (next section).
- A receipt or a balance could not be read.

**One unresolved fact blocks the whole tenant.** Escalate it to Milla and
Codex with the preview file.

### A trade books only if the cost-basis snapshot holds what the chain does

When a tenant is admitted, the new book takes its cost basis from Postgres's
`cost_basis` table, for each symbol that Postgres's `positions` table shows
held. Both tables are the lost book's last mirrored snapshot. The in-flight
reconciler books the basis beside every row it writes. This tool writes
neither table, so a booked trade that the snapshot leaves out would cause one
of two faults:

- **After a buy:** the new book holds the token with no basis, or with a
  basis for less than it holds, and the stop-loss and take-profit measure
  from the wrong cost.
- **After a sell:** the new book restores a basis for more than it holds.

**When the rows were written is never enough.** A missed buy followed by an
ordinary buy rewrites both rows after the missed one, and the basis can still
leave the missed buy out. So the tool compares what the rows **contain** with
the chain.

It reads the token's balance with `balanceOf` for each address of the book
(the account and its custody vault, as the fill was read) at a **pinned
block**: admission's chain head less 64. Every booked fact is at least 64
blocks deep under that head, so the balance includes all of them and is as
final as they are. A balance read at `latest` could include later activity,
so the transport refuses one.

A `session-trade` is booked only if one of these holds, judged over every
booked trade in that token together:

- **The snapshot holds the token.** Its `positions` row's raw balance **and**
  its live `cost_basis` row's quantity each equal the book's balance at the
  pinned block. Both rows were also written at or after the last booked trade
  in the token. That check is necessary but never enough alone.
- **The snapshot holds none of it.** The book holds none at the pinned block,
  and no live `cost_basis` row under any name the token has gone by still
  covers a quantity.

Then, either way, the tool walks the token's fills back from the balance:
every fill Postgres records in the token, and every trade the plan books,
newest first. Before each fill the book held what it holds after, less what
was bought or plus what was sold. The walk ends when it has passed every
booked trade and stands at zero: that is where the basis last opened, and the
fills since then reproduce the chain's quantity exactly.

- If the walk goes **below zero**, the fills are more than the chain holds.
  Something moved the token that neither Postgres nor the plan records, and
  the trade is refused.
- If the records **do not allow** the walk, the plan says why in a `note:`
  and in `evidence.holding.fills`, and the contents checks above decide alone.
  This happens when a row in the token is still `submitted`, carries no fill,
  or has a fill from a quote rather than its receipt, or when the records run
  out with the book still holding some.

Recorded rows are dated by when the worker wrote them, and booked trades by
their block. If a recorded row was written after a missed fill that landed
later, the walk reads them out of order. That can only refuse, never book.

In any other case the trade and its USDG leg are `unresolved`, and so is the
tenant. A balance that cannot be read proves nothing, so it also leaves the
trade `unresolved`. Each trade's `evidence.holding` shows the position, the
basis, the balances read, the fill walk, and `refusal`, which names the check
that refused:

| `refusal` | What it found |
|---|---|
| `balance-unread` | The book's balance at the pinned block could not be read for every address |
| `position-differs` | The position's raw balance is not the chain's |
| `basis-missing` | A held position has no live cost basis |
| `basis-differs` | The basis quantity is not the chain's: for example, a fill the lost book never booked to it |
| `position-stale`, `basis-stale` | A row was written before the last booked trade in the token |
| `held-unrecorded` | The chain holds the token and the snapshot holds none |
| `basis-without-position` | The chain and the positions hold none, but a basis still covers a quantity |
| `fills-exceed-chain` | The fill walk went below zero |
| `positions-ambiguous`, `position-unreadable`, `basis-unreadable` | The snapshot cannot be read as one answer |

Resolving any of these needs a reviewed basis decision.

The tool never does any of the following:

- invent a figure it cannot prove: realised P&L stays `NULL`, and gas is not
  priced in USDG;
- move `agents.hwm_usdg`, `hwm_withdrawn_usdg` or a risk period;
- touch `cost_basis`, `positions`, `position_floors` or decisions.

A fill's price is the ratio of the two amounts the logs moved, scaled by the
token's `decimals()`. If `decimals()` cannot be read, the price stays `NULL`
and the rest of the row is still booked.

Two consequences need a reviewer's eye:

- **A deposit after the last equity mark** shows as drift at the worker's
  first look. The worker marks contributions unknown and suppresses the fee
  rather than guess. This is existing fail-closed behaviour.
- **A booked trade does not move the cost basis.** It is booked only when
  the snapshot's position and basis already hold what the chain does, as
  described above. The basis's cost is not checked against the fills, only
  its quantity. Still check the positions, basis and floors on the dashboard
  at `exits-only`, before `trade`.

## The three tenants held on 2026-10-06

| Tenant | Line | Shape | Expected |
|---|---|---|---|
| `0x8e93bad5a60a266b4283855ceffa0979720aed72` (Shogun, account `0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487`) | 1 op + 1 USDG transfer | A Trencher trade whose row is missing: the operation, and its USDG leg between the vault and the account | `session-trade` + `operation-leg` → one `trades` row, if Postgres's position and cost basis in the token hold what the chain does. Otherwise `unresolved`: escalate for a basis decision |
| `0x4b6dcd559c82ea897c34dacfb785fb0c8f85d4c5` | 1 op, 0 transfers | An operation with no USDG leg | `session-no-movement` books the reconciler's row. A root-key `owner-operation` blocks: escalate |
| `0x0e1ca00202df6e686ac2317e10ed8ee8ae5e320d` | 0 ops, 1 transfer | A lone USDG transfer | `deposit` → one `flows` row. Outbound, or from a hosted account or vault, blocks |

The preview settles which shape each tenant is in. These are expectations, not
results.

## Which tenants it books

Postgres does not record which tenants a deploy's `MERRYMEN_FLEET_ROLLOUT`
runs. So the tool proves from Postgres that the tenant is held, and refuses
the preview (`refused:`, exit code `2`) unless all of the following are true:

- **Admission's newest decision for the tenant is a chain refusal.** This is
  its newest `ledger_resume_approvals` row that was not revoked, in state
  `refused`, with a reason starting "the chain holds operations or USDG
  transfers for the account that Postgres lacks". A revoked approval is
  skipped because it decided nothing. Admission drains the old book's tail
  into Postgres before reading the chain, so this refusal shows that the old
  book lacked those facts too.
- **Nothing has written for the tenant since that refusal.** Its heartbeat
  (`agents.beat_at`) and its newest mirror cursor (`mirror_state.updated_at`)
  are no later than the refusal. All three times come from the orchestrator's
  clock.
- **Its book has been quiet for 10 minutes**, by the same two timestamps.

On top of that, only facts that landed at least a minute before the refusal
are booked. A later fact is `unresolved`, which covers a worker running under
a stuck mirror. The apply checks the heartbeat, the mirror cursor, the mode,
the approvals, the attestations and the snapshot again, inside its
transaction. If any of them moved since the preview, it refuses.

If the tenant has no chain refusal, the preview says so. Run admission for it
as [fleet-resume.md](fleet-resume.md) describes, so that admission refuses it
and names what is missing. Then preview here again.

## Before you start

- **Keep the tenant held.** Leave it out of `MERRYMEN_FLEET_ROLLOUT`. The
  tool also refuses a tenant that has run since its refusal (above).
- **No approval may be open.** If one is, the preview refuses and prints the
  exact `MERRYMEN_RESUME_REVOKE=0x<tenant>:<digest>` to set. Set it, deploy,
  and start again. A booking changes the evidence that approval was given on.
  The revoked approval is passed over, so the chain refusal before it still
  holds the tenant.
- **Where to run it.** Use a shell that can reach the shared Postgres. A
  container in this project can, and the hosted image already installs the
  `pg` driver and `tsx`. `DATABASE_URL` comes from the existing private
  credential mechanism. Never paste it, or the RPC URL, into a command, a PR,
  a report or a chat. The tool prints neither. A driver or network error is
  printed as a fixed code.
- **The RPC.** The default is the public Robinhood Chain mainnet RPC.
  `MERRYMEN_CHAIN_GAP_RPC` selects another. The transport admits only
  `eth_chainId`, `eth_blockNumber`, `eth_getLogs`, `eth_getTransactionReceipt`,
  `eth_getBlockByNumber`, and `eth_call` for exactly two view calls:
  `decimals()` at `latest`, and `balanceOf` of one address at a block number
  (never a tag). The node must still serve state 64 blocks back. The public
  RPC does. If a node cannot, the balance reads as unread and the trade is
  `unresolved`.

## 1. Preview

```sh
node --import tsx worker/src/chain-gap-booking-cli.ts \
  --tenant 0x<tenant> --output /absolute/private-dir/<tenant>-preview.json
```

`--dry-run` is the default and may be given explicitly. The preview does the
following:

1. It reads Postgres in one `REPEATABLE READ READ ONLY` snapshot on a
   connection that the server holds read-only. Every statement must be a
   `SELECT`, and the snapshot is rolled back.
2. It closes that connection and reads the chain.
3. It writes the plan to `--output`. The file is created once, with mode
   `0600`, and is never written over an existing file or through a link.

The console prints one line per fact with its class, then the reason for
anything not booked, any notes, and:

```
chain-gap booking READY — tenant 0x…, account 0x…, epoch 2: 2 fact(s) on chain that Postgres lacks, 1 row(s) proposed
  operation-leg: USDG in 4.965021 in tx 0x… log 11 at block 79494846 → covered by op:0x…
  session-trade: operation 0x… in tx 0x… at block 79494846 → trades row
  note: a trade is booked without touching cost_basis, positions or position_floors, because the snapshot … already holds what the chain does in its token at block …
previewDigest 3f…
PREVIEW ONLY — 0 database writes. The plan is in /…/preview.json.
```

The verdict is one of:

- `READY`: every fact is classified and proposed. Exit code `0`.
- `NOTHING-MISSING`: admission's check is already clean for this tenant.
  Exit code `0`.
- `BLOCKED`: see `refused:` and `why:`. Exit code `2`. Nothing can be applied.

## 2. The owner of the books reviews it

Send the preview file to Milla. For each item, check:

- the transaction on the explorer, as printed;
- the class and its `why`;
- the proposed row, column by column;
- the `evidence`: block hash, validator, payer, the book's net movement and
  the fill amounts, and for a trade its `holding`: the position and basis
  rows and their times, the balances read at the pinned block
  (`capture.balanceBlock`), the fill walk, and the `refusal`, if any;
- the `remaining` list, which must be empty;
- the `warnings`.

The `previewDigest` is what the review approves. It covers:

- the code that produced the preview, by file digest;
- the database, by host, port and name;
- every Postgres fact the plan depends on, including the tenant's approvals,
  heartbeat, mirror cursor, positions and cost basis, and its recorded fills
  (by digest);
- the balances read;
- every proposed row.

It does not cover the time of the preview, the chain head or the pinned
block.

## 3. Backup

Take a backup immediately before applying:

- a manual backup of the Postgres service, or
- a noted PITR restore point (UTC), per [backups.md](backups.md).

Write down its name, for example `railway-backup-2026-10-06T09:00Z` or
`pitr-2026-10-06T09:00:00Z`. That name is `--backup-ref`. It must be a name
(letters, digits, `.`, `_`, `:`, `-`), not a URL. It is recorded with every
row the apply writes.

## 4. Apply

```sh
node --import tsx worker/src/chain-gap-booking-cli.ts \
  --tenant 0x<tenant> --apply --confirm <previewDigest> --backup-ref <backup name> \
  --output /absolute/private-dir/<tenant>-apply.json
```

Apply first recomputes the whole preview. It refuses, writing nothing, unless
the new preview is `READY` with exactly the confirmed digest. If the books,
the chain or the code moved since the review, preview again and review that
one.

Then, in **one transaction**, the apply:

1. locks the agent row;
2. compares every Postgres fact again (compare-and-set), refusing if any
   changed. This includes the tenant's heartbeat, mirror cursor, mode,
   approvals, attestations, positions, cost basis and recorded fills, so a
   tenant that woke up after the preview is refused;
3. inserts exactly the proposed rows and reads each one back;
4. proves the flows are still distinct and that admission's chain-fact rule
   is now answered for every fact;
5. records one receipt per row in `chain_gap_bookings`. Each receipt also
   records the tenant's admission state at that moment (`admission_json`):
   its approvals, attestations, heartbeat and mirror cursor. The revert is
   decided against this.

Receipts are unique per (account, epoch, `op:<userOpHash>` or
`log:<tx>#<log>`) while applied. Any failure rolls the whole transaction back.

On success the console prints
`APPLIED booking <id> — N row(s) for tenant 0x… under backup <name>`, and
`--output` holds the **apply report**: the booking id and every row as
written. Keep it with the runbook evidence, because it is what `--revert`
takes. The receipts table holds the same rows if the file is lost.

The first apply creates `chain_gap_bookings`. This is additive DDL, like the
resume tables.

Applying again finds nothing missing and writes nothing
(`refused (nothing-missing)`).

## 5. Preview the tenant again (admission's preview)

Set `MERRYMEN_RESUME_PREVIEW=0x<tenant>` and deploy, as in fleet-resume.md
step 2. The tenant's `[resume-preview]` line should show:

- `pass: true`;
- a **new** `digest`, because the booked rows are now in the evidence;
- `lastRefusal`, still the old chain refusal. This is information only, and
  it stays until a newer approval supersedes it.

## 6. Approve

Set `MERRYMEN_RESUME_APPROVE=0x<tenant>:<the new digest>` and deploy.
Approve per tenant, never with a `run:` that was taken before the booking.

## 7. Rollout

Add `0x<tenant>:exits-only` to `MERRYMEN_FLEET_ROLLOUT` and deploy, as in
fleet-resume.md step 5. Watch for this line:
`resume chain check clean — … all in Postgres`.

If the chain check refuses again, the new refusal names what is still
missing. That is something that landed after the booking: start again at
step 1.

At `exits-only`, check the positions, cost basis and floors on the dashboard
before moving the tenant to `trade` (step 7 of fleet-resume.md).

## Rollback

Before the tenant is admitted on the rows, run:

```sh
node --import tsx worker/src/chain-gap-booking-cli.ts \
  --revert /absolute/private-dir/<tenant>-apply.json --output /absolute/private-dir/<tenant>-revert.json
```

In one transaction, the revert:

- verifies the report against its own digest and against the receipts. The
  report's apply time and admission state must be the ones the receipts
  hold;
- refuses if any row is no longer exactly as written;
- refuses if anything has relied on the rows since the apply. It compares
  what the database records now with the receipts' `admission_json`, and
  never compares one machine's clock with another's. It refuses for any of
  the following:
  - an attested book is in use for the tenant;
  - an attestation was recorded after the apply;
  - an approval created after the apply is still `approved`. Revoke it first;
  - an approval created after the apply reached `archiving`, `archived`,
    `registered` or `applied`, or minted a generation or archived a home on
    its way to `refused` or `revoked`;
  - an approval that existed at the apply has changed;
  - the tenant's heartbeat or mirror cursor moved, which means a worker
    wrote its book;
- removes the rows and marks each receipt `reverted`, keeping the row in full.

An approval created after the apply that was refused or revoked before it
minted anything did not rely on the rows, so it does not block a revert.

Running it a second time prints `ALREADY REVERTED` and changes nothing.

After admission, there is no revert. Narrow `MERRYMEN_FLEET_ROLLOUT` and
escalate. The last resort is the backup named in the receipts.

## Restore drills

Booked rows carry their block time, not the apply time. A restore drill whose
restore point falls before the apply will report `trades` or `flows`
`missing-in-fork` for them. `chain_gap_bookings` names each one, with the time
it was applied.

## Verification

```sh
node --import tsx --test worker/src/chain-gap-booking.test.ts worker/src/chain-gap-booking-cli.test.ts \
  worker/src/ledger-resume.test.ts worker/src/orchestrator-ledger-resume.integration.test.ts
```

These tests are in the ordinary `npm test` glob. The fixtures are Shogun's
own public receipts (the Trencher sell and the enable-mode buy of
2026-10-04, and a root-key operation of 2026-10-03), plus synthetic
operations and deposits.

The opt-in real-Postgres test needs two things: a disposable **loopback**
server in `MERRYMEN_TEST_PG_URL`, and the `pg` driver resolvable. `NODE_PATH`
works, because the test loads the driver with `require`. The test creates its
own database and drops it, and never reads `DATABASE_URL`:

```sh
MERRYMEN_TEST_PG_URL=postgres://postgres@127.0.0.1:<port>/postgres \
  node --import tsx --test worker/src/chain-gap-booking.postgres.test.ts
```
