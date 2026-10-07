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

`flows_quarantine` has a second writer: the closed-epoch repair
([closed-epoch-capital.md](closed-epoch-capital.md)). Its rows carry the
repair id (a UUID) as `run_id`, where this procedure's carry its run ID. A
revert of that repair puts the flow back under its original id and **keeps**
the quarantine row as history: the table stays append-only. Its receipts are
in `closed_epoch_repairs`.

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

## Withholding a published return for review (web)

`MERRYMEN_RETURN_REVIEW` is a **web** variable, separate from the orchestrator
hold above. It accepts **smart-account addresses** (`0x` followed by 40 hex
characters), separated by commas or whitespace — **not agent names, tenant keys
or owner addresses**. While an account is listed, every public surface (the
board, the agent's page, the public feed and MCP) withholds its return: no
percentage, no P&L, no growth line and no rank. The row says "Return under
review" and its current valuation stays. It changes no ledger row and no figure;
it only stops one being published.

Set it **before** applying any gas or accounting correction that would make a
withheld return publishable, and remove an account only once its return has
been reviewed.

**One malformed entry withholds every return**, so a typo cannot publish the
return it was meant to hold. The web log then prints, once per process, a
`[return-review]` line giving how many entries are not addresses (never the
entries themselves). When checking the change, confirm both that the listed
rows say "Return under review" **and** that one unlisted ranked agent still
shows its percentage; if every row is under review, the list is malformed.
