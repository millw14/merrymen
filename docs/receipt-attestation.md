# Attesting one original deposit receipt

This maintenance protocol supplies verified receipt provenance for one existing
inferred USDG deposit in its original live accounting book. It refuses books
with any successful or unsettled trade, position, withdrawal, fee, later epoch,
multiple flows, missing original journal evidence, or inconsistent cash/high-water
marks. It is deliberately narrower than general accounting reconstruction.

A book that **has traded** uses its sibling under the same controls, hold,
lease, audit table and source barrier: [one inferred deposit in a book that has
traded](#one-inferred-deposit-in-a-book-that-has-traded), selected by
`MERRYMEN_RECEIPT_ATTEST_FLOW`.

Deposit receipts and the matching balance must be at least 64 blocks behind
the observed chain head, matching the existing capital-booking policy. Any
USDG transfer in the unconfirmed tail makes the preview or commit wait, including
a withdrawal followed by a matching deposit. Both the confirmed snapshot and
observed head are checked again for a reorganization before accepting evidence.

Existing owner-operation records are allowed only for confirmed, successful
root-key **nonce revocations**: the exact canonical direct Kernel
`invalidateNonce(uint32)` call. They must have no USDG legs, covered logs or
token movements, and must agree between the original and shared books with a
complete mirror witness. An `acknowledged` label alone is insufficient; it can
also describe a withdrawal. Failed, unknown, unconfirmed or unrecorded operations
refuse the repair. This bounded protocol accepts at most 64 owner records.

The protocol freshly scans the account's complete EntryPoint history through
the same observed head, verifies each operation against its canonical receipt,
block and transaction, and rechecks both the confirmed and observed block
hashes. Each transaction must send zero native value to EntryPoint and contain
the proved account/nonce's exact revocation call. Any Transfer touching the
account or current grant-derived custody anywhere in that receipt refuses,
including outside the operation's own execution. Generic execute calls are
excluded even when their explicit call value is zero. Recorded self-paid native
gas is preserved; this is a USDG accounting proof, not a reconstruction of all
native-ETH transfers or a new wallet permission.

It preserves the account, signed permission and caps, original SQLite file and
source identity, consumed generation, every existing journal entry, flow IDs,
flow amount and bookkeeping time, epoch, high-water marks, budgets, and all
mirror cursors. It changes only the flow's provenance fields in the original
SQLite file and its existing shared row. A correcting journal mark and a
permanent shared audit record retain the original flow and verified receipt.
When owner revocations are present, the permanent plan also retains every
original owner row, current custody scope, receipt and transaction responses,
and a stable proof binding the operation, canonical block hash and calldata.
The approval digest includes that stable proof and excludes the changing scan
head. Retry reads the proof again; it never trusts a previous `acknowledged`
record to bypass fresh verification. No owner-operation row, gas amount,
permission, cap or cursor is changed by attestation.

## Operator workflow

The entry point is the existing `start:orchestrator` startup task. There is no
public HTTP endpoint, wallet operation, or standalone SQL repair command.
Deploy the reviewed implementation through the normal deployment controls.
Do not delete, recreate, import over, or reset the original tenant home.

1. Keep the intended fleet rollout unchanged. Add the exact tenant to
   `MERRYMEN_ACCOUNTING_HOLD_TENANTS`. Confirm previous processes have exited;
   the supervisor also proves this from its own child, holder, spawn, restart,
   exit and retirement state and acquires the real PostgreSQL tenant lease.
2. Set these controls for a preview, using complete addresses from the current
   account/tenant mapping:

   | Variable | Preview value |
   | --- | --- |
   | `MERRYMEN_RECEIPT_ATTEST_ACCOUNT` | The smart-account address |
   | `MERRYMEN_RECEIPT_ATTEST_TENANT` | Its current tenant address |
   | `MERRYMEN_RECEIPT_ATTEST_MODE` | `dry-run` |
   | `MERRYMEN_RECEIPT_ATTEST_APPROVAL` | Absent |

3. Start the normal orchestrator deployment and inspect its
   `receipt-attestation|` result. Preview does not modify the accounting file,
   create a repair schema/audit, or write a local repair marker. Other ordinary
   orchestrator startup work is unaffected. The result includes the exact
   amount, source/shared flow IDs, receipt reference, and `approvalDigest`.
   For preserved owner revocations, `ownerProofSummary` also gives their count,
   the current custody addresses and the stable digest of their complete proof.
   Review that supplemental proof summary before approving the repair. Empty
   owner histories omit the summary, including legacy pending plans.
4. Review that result. For an approved repair, keep the same account, tenant,
   hold and rollout; change mode to `commit` and set approval to the complete
   returned digest. Restart through the normal deployment path. The protocol
   rereads the original book and complete chain history before mutation.
5. Require an `applied` result, then remove all four receipt-attestation
   variables. Keep the hold until independent verification of the corrected
   source/shared row and audit is complete. Removing the hold or changing
   rollout is a separate operator decision; the repair does neither.

The deploy guard permits this precisely scoped, explicitly held protocol during
staged rollout. It still refuses other one-shots mixed with it, incomplete scope,
unknown receipt controls, invalid holds, and an unapproved commit. Service,
image, persistent-volume, branch and ancestry checks remain in force. The
runtime resolves the complete fresh grant roster and requires the declared
tenant to be the unique owner of the requested account.

## Interruption and retry

Before any financial row changes, PostgreSQL stores the immutable plan, exact
preimages, receipt responses, source identity, and journal/cursor witnesses with
state `pending`. A durable `ledger-source-blocked.json` marker follows. The
original flow amendment and correcting journal mark commit together in one
SQLite transaction with `synchronous=FULL`. The shared flow amendment and audit
completion commit together in PostgreSQL. The grant and generation remain
locked through both amendments. Only after both books agree is the matching
local marker removed and its directory synced.

A pending shared audit blocks source import, registration, resume and mirroring
even if the process crashed before writing the local marker. An interrupted
shared commit can leave the original file amended and the shared audit pending;
this is an expected retry state. Keep the original home and hold, and restart
with the same four controls and digest. Retry accepts only the exact recorded
before/after states and completes the missing step once. Changed receipts,
grants, source identity, ledger rows, journal, fees or cursors refuse and retain
the barriers. Never manually delete a marker/audit to force retry.

## Verification limits

This attests one deposit's receipt provenance. The original `inferred` journal
entry is intentionally retained. The generic historical audit reconstruction
does not yet interpret correcting receipt-attestation marks and may continue
to list that original fact as unanchored. Verify this amendment using the
original journal chain, the appended correcting mark, and the permanent
`ledger_receipt_attestations` plan together. It does not make the entire
historical journal fully receipt-anchored.

Local tests exercise every durable interruption boundary, replay, tampered
preimages, authority changes and unrelated-tenant isolation. The opt-in
`receipt-attestation.postgres.test.ts` suite uses disposable localhost PostgreSQL
with actual advisory and row locks. It never connects to the ambient
`DATABASE_URL`; only an explicitly supplied localhost test URL is used.

## One inferred deposit in a book that has traded

The untouched-book protocol proves a book's whole chain history is one deposit,
which a book that has traded can never satisfy. When a top-up to a trading book
was booked by inference (`source = 'inferred'`, no transaction), the hosted
anchor counts that row as unevidenced on every later spawn: contributions read
unknown, the fee stops and the Brain opens nothing. This sibling
(`worker/src/receipt-attestation-traded.ts`) attests that one row's receipt and
nothing else. It is chosen by naming the row: `MERRYMEN_RECEIPT_ATTEST_FLOW` is
the flow's id **in the shared database** (`flows.id`). Without that variable the
untouched-book protocol runs, as before.

### Where the receipt must be, and what must be in it

The original book's hash-chained journal records the inferred fact between two
live cash readings, and each reading (`mark`) records the block its tick read.
The deposit landed after the **baseline**, the last live reading before the
fact that was not taken while flow inference was held, and by the **booking**
reading, the first live reading after it. A tick reads its block before its cash
and endpoints' heads differ, so the window reaches 3,000 blocks (about five
minutes) past both readings. Readings more than 1,200,000 blocks apart refuse.

In that window the deposit scanner's own reader (`deposit-log.ts`
`findTransferFlows`) classifies every USDG movement of the account from its
receipt, with the book's trades and their operations, the grant's custody
contracts and every flow identity either book already holds. Every capital
transfer whose transaction any flow row of either book names (by identity or
by transaction, any source) is left out. Then all of these must hold:

- exactly **one** capital transfer remains, inbound and equal to the inferred
  amount to the micro-USDG: the live booker's own rule for a change it would
  infer (`flow-inference.ts` RULE 4, `matchInferredDelta`). A second deposit or
  an unbooked withdrawal in the window refuses: two movements that sum to the
  change cannot be told from one that is it beside one that is not;
- its block time lies between the baseline reading and the booking, with ten
  minutes' skew;
- it is at least 200,000 blocks behind the observed head, so the amended
  chain-log row can never become the deposit scan's resume point (index.ts
  `DEPOSIT_LOOKBACK_BLOCKS`), and the whole window is past the 64-block
  confirmation tail;
- no earlier repair quarantined it and no owner-operation record names its
  transaction;
- its receipt succeeded, and the receipt block and window end hash the same
  before and after the read.

The book must be one live account on this chain in both copies, the selected
row an unattested inferred deposit of the current epoch, equal in every column
but its id (and the account's letter case) to exactly one row of the original
book, booked once in each book, and
already copied by the mirror (its original id at or below the flows cursor).
The original journal must verify as each (account, epoch) chain the store
appends to, contiguous from entry 1, in one spelling of the account,
with exactly one entry for this inferred deposit within seconds of the row.
No historical `eth_call` is needed, so a non-archive endpoint can serve it.

### What changes and what is preserved

Exactly as the untouched-book protocol: only the flow's `source` (to
`chain-log`), `tx_hash`, `block_number`, `log_index` and `chain_id`, in the
original SQLite row and its shared copy. Amounts, booking time, epoch, row ids,
high-water marks, risk periods, fees, trades, valuations, positions, owner
records, grants and every mirror cursor are untouched. Every protected table of
both books is bound by digest (large tables read in key windows), so any change
between approval and amendment refuses. A correcting journal mark (version 2,
retaining the original flow, the receipt, the window and the original entry)
extends the flow's own epoch chain in the spelling the worker appends with, so
the worker's next entry chains from it. The permanent
`ledger_receipt_attestations` row holds the plan and every RPC response used.

### Operator workflow

Everything in [Operator workflow](#operator-workflow) above applies, with one
more control. Find the row's shared id with a read-only query, for example:

```sql
SELECT id, direction, amount_usdg, source, tx_hash, epoch, at
  FROM flows WHERE LOWER(agent_id) = '<smart account>' AND source = 'inferred';
```

| Variable | Preview value |
| --- | --- |
| `MERRYMEN_RECEIPT_ATTEST_ACCOUNT` | The smart-account address |
| `MERRYMEN_RECEIPT_ATTEST_TENANT` | Its current tenant address |
| `MERRYMEN_RECEIPT_ATTEST_FLOW` | The inferred row's shared `flows.id`, in decimal |
| `MERRYMEN_RECEIPT_ATTEST_MODE` | `dry-run` |
| `MERRYMEN_RECEIPT_ATTEST_APPROVAL` | Absent |

The deploy guard admits it during a staged rollout exactly as it admits the
untouched-book protocol: all its controls counted, the tenant held, a digest
for commit, no other one-shot beside it. The preview's `receipt-attestation|`
line carries `"protocol":"traded-book"`, the receipt (transaction, block, log
index, sender), the `window` (its blocks and the two readings' blocks) and
`anchor`: the `contributions`, `evidenced` and `unevidencedRows` the next
spawn's anchor will read once the row is amended, in the same micro-USDG as the
`[anchor]` line. Approve only a preview whose receipt is the expected transfer
and whose `evidenced` equals `contributions` with `unevidencedRows` 0, unless
the book has other unevidenced rows you know of. Commit and cleanup are as
above; keep `MERRYMEN_RECEIPT_ATTEST_FLOW` set through the commit and any retry.

**An expired grant is fine, and re-signing in the middle is not.** The stored
permission is bound into the plan. Expiry retirement leaves the repair's lease
alone while it runs (`retireExpiredGrants`), so a tenant whose grant lapsed can
be attested before its owner re-signs. A re-sign between the preview and
`applied` changes the bound grant: before the commit it only makes the approval
stale, but after a commit is interrupted it refuses every retry and leaves the
pending barriers in place. Re-sign after `applied`.

**One deployed commit from the preview to `applied`.** Both books are bound by
digests of whole rows, as in the untouched-book protocol, so a deploy that adds
a column to a protected table (the shared ledger migrates on the next mirror
pass) changes the evidence: before the commit it makes the approval stale, and
after an interrupted commit it refuses every retry. Between the preview and
`applied`, change only variables; the redeploys they cause keep the image.

**Reads.** Chain evidence goes through the fleet's read path (`chainReadRpc`,
as for the untouched-book protocol): a house endpoint that refuses, a spent
quota included, fails over to the chain's public RPC. A window still unread
after that refuses the preview.

### Interruption, retry and limits

The durable boundaries, barriers and retry rules are those of [Interruption and
retry](#interruption-and-retry): audit, local marker, the original amendment
with its correcting mark in one `synchronous=FULL` SQLite transaction, the
shared amendment with the audit's completion in one PostgreSQL transaction, then
the marker's removal. A resumed repair reads the window again and must find the
same receipt.

The audit table holds one attestation per tenant, of either protocol. A second
inferred row in the same book, or a tenant that already has an attestation,
refuses by name and needs a reviewed extension. As above, the generic audit
reconstruction still lists the original inferred journal entry as unanchored;
verify with the original journal, the appended correcting mark and the
permanent plan together.

Local tests cover every durable boundary, replay, the window rules, selection
and journal refusals, protocol mixing and a reconcile pass during a commit on
an expired grant. The opt-in `receipt-attestation-traded.postgres.test.ts`
suite runs against disposable localhost PostgreSQL only.
