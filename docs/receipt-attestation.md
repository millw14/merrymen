# Attesting one original deposit receipt

This maintenance protocol supplies verified receipt provenance for one existing
inferred USDG deposit in its original live accounting book. It refuses books
with any successful or unsettled trade, position, withdrawal, fee, later epoch,
multiple flows, missing original journal evidence, or inconsistent cash/high-water
marks. It is deliberately narrower than general accounting reconstruction.

It preserves the account, signed permission and caps, original SQLite file and
source identity, consumed generation, every existing journal entry, flow IDs,
flow amount and bookkeeping time, epoch, high-water marks, budgets, and all
mirror cursors. It changes only the flow's provenance fields in the original
SQLite file and its existing shared row. A correcting journal mark and a
permanent shared audit record retain the original flow and verified receipt.

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
