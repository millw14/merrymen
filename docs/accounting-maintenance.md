# Scoped hosted accounting maintenance

`MERRYMEN_ACCOUNTING_HOLD_TENANTS` accepts a comma-separated list of complete
grant-store tenant keys (**not smart-account addresses or an assumed owner address**).
An invalid entry rejects startup rather than silently applying a partial list.
The named tenants retain their grants, settings and ledger, but this orchestrator
starts no worker or Telegram hold process for them. Other tenants continue.

This is an operator maintenance control. It does not sign a grant, change a cap,
reset a high-water mark, transfer funds or place a trade. The affected tenant's
worker and bot are temporarily unavailable while held.

## Required deployment order

1. Confirm the exact smart-account → tenant mapping. Set
   `MERRYMEN_ACCOUNTING_HOLD_TENANTS` to the intended tenant IDs and set
   `MERRYMEN_ACCOUNTING_RECONSTRUCT=0`. Keep repair commit disabled. Deploy a
   fresh container with this hold on **every orchestrator replica**.
2. Verify Railway reports every preceding deployment **REMOVED**, and that no
   affected child or holder is running. A new deployment being healthy or
   successful does **not** establish that the old deployment has stopped.
   Do not commit while an older deployment or another writer can still mirror
   the target ledger. This environment control is not a cross-deployment lock.
3. With the same hold still set, run the scoped reconstruction dry run. Review
   the complete receipt evidence, account, epoch, row identities and proposed
   contribution total. A partial scan or ambiguous classification must block
   repair. Never increase caps or reset the peak to make a repair pass.
4. Deploy another **fresh container**, retaining the hold, with
   `MERRYMEN_ACCOUNTING_RECONSTRUCT=1`, `MERRYMEN_REPAIR=commit`, the exact
   `MERRYMEN_REPAIR_ACCOUNT` smart-account list and a descriptive repair run ID.
   Commit refuses a missing/ambiguous account mapping, a selected tenant not
   explicitly held, local processes or retained local tenant state. These local
   checks do not replace step 2. Compare the freshly printed commit preview with
   the reviewed dry run and verify the committed receipts and quarantine rows.
5. Verify contribution evidence, unchanged HWM and signed caps, and absence of
   duplicate capital. Disable reconstruction/repair flags. Only after those
   checks, remove the maintenance hold and deploy a fresh container. Its normal
   bootstrap must recover the repaired contributions and the preserved HWM.
   Confirm the target child returns with the expected accounting state.

Never erase a retained tenant home merely to bypass the fresh-state refusal.
Investigate why it exists and preserve its evidence. The safe path above uses
fresh deployment containers and leaves the durable database intact.

With a validated nonempty maintenance hold, the reconstruction runs in the
background so its historical chain scan does not delay other tenants starting.
Commit rechecks the target hold and fresh local state, and refuses once shutdown
or `FLEET_HALT` has begun. Read-only diagnostics without a hold retain their
existing startup ordering.

The orchestrator exposes no HTTP readiness endpoint, and the repository's
Railway configuration has no path healthcheck. Maintenance does not wait for a
lease or block startup: held tenants are skipped while other tenants reconcile.
