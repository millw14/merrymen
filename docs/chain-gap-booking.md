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

## What it books, and what it refuses

The tool runs admission's own chain check, from the same block admission
starts at, against one read of Postgres. Then it reads each named
transaction's receipt and block, and classifies every fact:

| Class | What it is | What it writes |
|---|---|---|
| `session-trade` | The session key's swap: USDG one way, one token the other, read across the account and its custody vault | A `trades` row, as the in-flight reconciler writes a landed operation the book lost: `kind 'swap'`, `status 'landed'`, `basis_source 'receipt'`, the two legs, the fill (side, quantity and cash from the Transfer logs), gas from the EntryPoint's own event (sponsored or owner-paid), `created_at` at the block time |
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
  accounting epoch opened.
- A receipt could not be read.

**One unresolved fact blocks the whole tenant.** Escalate it to Milla and
Codex with the preview file.

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
- **A booked trade does not move the cost basis.** The attested book is seeded
  from the lost book's last mirrored snapshot. If that snapshot was taken
  before the trade, the basis is stale by that trade. Check it on the
  dashboard at `exits-only`, before `trade`.

## The three tenants held on 2026-10-06

| Tenant | Line | Shape | Expected |
|---|---|---|---|
| `0x8e93bad5a60a266b4283855ceffa0979720aed72` (Shogun, account `0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487`) | 1 op + 1 USDG transfer | A Trencher trade whose row is missing: the operation, and its USDG leg between the vault and the account | `session-trade` + `operation-leg` → one `trades` row |
| `0x4b6dcd559c82ea897c34dacfb785fb0c8f85d4c5` | 1 op, 0 transfers | An operation with no USDG leg | `session-no-movement` books the reconciler's row. A root-key `owner-operation` blocks: escalate |
| `0x0e1ca00202df6e686ac2317e10ed8ee8ae5e320d` | 0 ops, 1 transfer | A lone USDG transfer | `deposit` → one `flows` row. Outbound, or from a hosted account or vault, blocks |

The preview settles which shape each tenant is in. These are expectations, not
results.

## Before you start

- **The tenant must stay held.** Leave it out of `MERRYMEN_FLEET_ROLLOUT`.
- **No approval may be open.** If one is, the preview refuses and prints the
  exact `MERRYMEN_RESUME_REVOKE=0x<tenant>:<digest>` to set. Set it, deploy,
  and start again. A booking changes the evidence that approval was given on.
- **Where to run it.** Use a shell that can reach the shared Postgres. A
  container in this project can, and the hosted image already installs the
  `pg` driver and `tsx`. `DATABASE_URL` comes from the existing private
  credential mechanism. Never paste it, or the RPC URL, into a command, a PR,
  a report or a chat. The tool prints neither. A driver or network error is
  printed as a fixed code.
- **The RPC.** The default is the public Robinhood Chain mainnet RPC.
  `MERRYMEN_CHAIN_GAP_RPC` selects another. The transport admits only
  `eth_chainId`, `eth_blockNumber`, `eth_getLogs`, `eth_getTransactionReceipt`,
  `eth_getBlockByNumber`, and `eth_call` for `decimals()` at `latest`.

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
  note: a trade is booked without touching cost_basis, …
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
  the fill amounts;
- the `remaining` list, which must be empty;
- the `warnings`.

The `previewDigest` is what the review approves. It covers the code that
produced the preview (by file digest), the database (by host, port and name),
every Postgres fact the plan depends on, and every proposed row. It does not
cover the time of the preview or the chain head.

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
   changed;
3. inserts exactly the proposed rows and reads each one back;
4. proves the flows are still distinct and that admission's chain-fact rule
   is now answered for every fact;
5. records one receipt per row in `chain_gap_bookings`.

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

- verifies the report against its own digest and against the receipts;
- refuses if any row is no longer exactly as written;
- refuses if an approval of the tenant moved to `archiving`, `archived`,
  `registered` or `applied` after the apply. The attested book counts those
  rows, and removing them would leave it short of its attestation;
- removes the rows and marks each receipt `reverted`, keeping the row in full.

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
