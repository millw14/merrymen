# Preserving existing agent homes before the first memory-ferry deployment

This is a reviewed operator procedure, not an automatic deployment step. It
requires Milla's approval of the change and temporary production access. The
tools below have been prepared and tested locally; preparing them does not
authorize a production halt, database write, SSH-key registration or deployment.

The first deployment needs this extra step: the old container has owner memory
on its ephemeral disk and cannot run the new personal-memory ferry on shutdown.
The old orchestrator exits one second after SIGTERM. Do not signal that process
to obtain a final snapshot. Its existing `FLEET_HALT` marker instead stops tenant
workers and hold processes, prevents new spawns, and leaves the orchestrator and
child homes available for the checkpoint.

## Exact reads and writes

`worker/src/memory-safeguard-cli.ts` provides four explicit modes:

| Mode | Reads | Writes |
| --- | --- | --- |
| `capture` | Public grant roster (`tenant`, account, server timestamp and PostgreSQL `xmin`); plain child homes; allowlisted memory; existing sealed memory rows; public `/proc` command/start metadata | One new, fully encrypted 0600 backup; temporary verification homes, removed after verification |
| `verify` | Encrypted backup, existing in-process store DEK | Temporary verification homes, removed after verification |
| `checkpoint` | Quiescent source proof; public roster; read-only child ledger; held/unrestored markers; existing mirror cursors | Existing ledger mirror transactions/cursors; final sealed Telegram group memory/forget effects under the tenant's advisory lease |
| `seed` | Verified final encrypted backup; quiescent source proof; public roster and exact row incarnation | Personal-memory schema and **absent rows only**, inside a roster-row-locked transaction |

Personal capture reads only `soul/IDENTITY.md`, `OWNER.md`, `NOTES.md`,
`JOURNAL.md`, `ARCHIVE.md`, positive-ID `chat_turns`, and the personal forget
journal. It retains at most 64 DM chats and the most recent 40 turns per chat,
under the ferry's 1 MiB limit. Group capture reads only `tg-groups.json` and its
bounded forget journal, or its existing tenant-bound sealed row. Malformed,
torn, oversized, symlinked or unrestored sources refuse the operation.

Capture never copies `grant.json`, `settings.json`, bot/link files, credentials,
private keys, environment dumps, a raw SQLite database, or financial tables.
The complete backup, including tenant manifests, is encrypted using the existing
store DEK. Each inner snapshot is separately authenticated for its tenant.
Console output contains aggregate counts, operation status and the ciphertext
hash; it contains no memory, SQL error values, ciphertext or keys. Do not export
the production DEK to the operator laptop.

Verification uses the actual restore functions in fresh temporary homes. It
compares the restored personal content with the decrypted original canonical
payload, and Telegram text byte-for-byte. Only completion of a pending privacy
operation is normalized; the scope, operation ID, timestamp, applied IDs and
memory content must remain identical. Forget requests are applied before
encryption, and capture does not clear a live journal.

A tenant with no local home is not assigned an invented blank snapshot. Its
existing durable rows are authenticated and included in the encrypted backup;
seeding leaves those rows untouched. `rosterWithoutHome` and
`historicalMemoryGaps` report missing homes and cases with no remaining stored
memory. Those counts are historical gaps, not a claim that old lost memories
were recovered. An unreadable existing row refuses verification.

## Preparation before production access is approved

Run the focused tests and build a single bootstrap bundle from the reviewed
revision. The bundle incorporates only the new safeguard and personal-ferry
code plus the existing trusted database, lease, ledger and group-ferry APIs. It
does not import or start the orchestrator, worker, web server or trading loop.

```sh
node --import tsx --test worker/src/memory-safeguard.test.ts worker/src/ledger-safeguard.test.ts
node_modules/.bin/esbuild worker/src/memory-safeguard-cli.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/merrymen-memory-safeguard.mjs
shasum -a 256 /tmp/merrymen-memory-safeguard.mjs
```

The opt-in `memory-safeguard.postgres.test.ts` uses an explicit loopback-only
test URL and random disposable schema. It verifies real `xmin` identity,
insert-only/idempotent preseed behavior and a concurrent deletion waiting behind
the grant row's `FOR SHARE` lock. It never reads `DATABASE_URL`.

Copy only the approved bundle to a **new, unique filename in the verified
container repository root**, for example `/app/memory-safeguard-REVIEWED_SHA.mjs`,
after access approval. Do not overwrite any existing file or running source.
External ESM dependencies resolve from that location's `node_modules`; a bundle
under `/tmp` cannot find `/app/node_modules`, even with `NODE_PATH`. The old image
already provides `pg`; the bundle uses the container's existing environment and
DEK. Check its SHA-256 against the reviewed local bundle. A focused test executes
the bundled CLI in that same repository-root layout against an encrypted fixture.

## Approved production handover

1. Confirm the exact old Railway deployment ID and commit, orchestrator PID,
   and **one active replica**. Confirm no deployment is automatically replacing
   it while this procedure runs. Prepare/build the new image while the old
   deployment remains active. Keep the old container until the final checkpoint
   and preseed succeed. If there are multiple replicas, stop here: their stale
   homes cannot safely be selected by an insert-only seed without recording the
   lease-owning source first.
2. Optionally run `capture` without `--quiescent` for an encrypted live backup.
   Its bounded reads can span live writes across files; it cannot prove a
   lossless final handover and cannot be seeded. Use a unique output
   filename. The home is resolved through the normal `merrymenHome()` fallback,
   so `MERRYMEN_HOME` need not be configured.
3. Create the existing `<merrymenHome()>/FLEET_HALT` marker after approval. Record
   whether it already existed; never overwrite a pre-existing halt. Use a unique
   operation token if this procedure creates it, and record its inode and exact
   text for the approved rollback below. Let
   the old orchestrator perform its own normal stand-down. Wait until **every**
   tenant worker and `telegram-hold.ts` process has actually exited. A marker or
   SIGTERM acknowledgement alone is insufficient. The CLI checks all visible
   `/proc` commands, the live orchestrator's unchanged start identity, and the
   marker before and after each operation. Do not use SIGSTOP or kill the
   orchestrator; neither provides this guarantee.
4. Capture a **new final** backup with the common source arguments below and
   `--quiescent --single-replica-confirmed`. Capture verifies every snapshot
   before reporting `captured-and-verified`. Download only this encrypted
   artifact and compare its ciphertext SHA-256 with the reported value. Its
   production round-trip is verified inside the container, where the DEK stays.
5. Run `checkpoint` against that final artifact. It acquires the existing
   PostgreSQL advisory lease for each local tenant after all workers exit,
   checks stable plain homes and database identities, and verifies the account
   matches the exact current grant row incarnation. It refuses accounting holds,
   `restore-blocked.json`, `energy-unrestored.json`, pending held-group commands,
   and submitted/sent/pending trades. No receipt is assumed resolved merely
   because its process exited. It runs the **existing** mirror to exhaustion
   plus a verification pass, with no failure or skipped table, then publishes
   final group claims, allowances and forget effects under the same lease.
   Batches retain existing transactional watermarks, operation deduplication,
   accounting epochs and peak ratchets. Nothing signs, trades, resets a book,
   fabricates an anchor or reads a raw book into the backup.
   Before the first mirror write, every positive existing ID cursor must still
   name the same timestamped row in the stopped source. Missing rows, differing
   timestamps or an unwitnessed legacy cursor refuse without moving the cursor;
   a repeated invocation stays refused. Any unexpected `restarted` report also
   immediately stops the checkpoint, so a cold rebuilt source cannot be copied
   again after a rewind and erase protected positions or cost basis.
   Old main's failed group-restore barrier is only in process memory, so an
   existing protected group row must agree with the captured local group state
   after privacy effects. A mismatch applies forget effects conservatively but
   **refuses checkpoint completion**; an empty held-style local file is never
   published over populated durable memory. Resolve that source ambiguity with
   an ownership-aware reviewed handover before deployment, not by overwriting it.
6. Run `seed` against the same artifact. It first repeats content verification
   and all source/roster checks. It creates the personal-memory table and inserts
   absent rows only. A repeat of the **identical** encrypted artifact is
   idempotent. A different existing row is a conflict and is never overwritten.
   PostgreSQL `xmin` and `FOR SHARE` prevent a same-second delete/regrant from
   accepting the deleted incarnation's memory. No-home stored rows remain
   unchanged. The final artifact must be less than five minutes old; if needed,
   capture again while the halt remains in place **before the first seed**.
7. Deploy only after final backup verification, checkpoint and seed all succeed.
   Confirm the new deployment restores the memory rows, preserves approved
   groups and accounting, and has one listener per bot. Retain the encrypted
   artifact for approved recovery; never restore it over a later privacy
   request or current memory without another explicit review.

The common source arguments are public values verified in step 1:

```sh
node /app/memory-safeguard-REVIEWED_SHA.mjs capture --expected-deployment OLD_DEPLOYMENT_ID --expected-commit OLD_40_HEX_COMMIT --orchestrator-pid OLD_PID --quiescent --single-replica-confirmed --output /tmp/final-agent-memory.sealed
node /app/memory-safeguard-REVIEWED_SHA.mjs checkpoint --expected-deployment OLD_DEPLOYMENT_ID --expected-commit OLD_40_HEX_COMMIT --orchestrator-pid OLD_PID --quiescent --single-replica-confirmed --artifact /tmp/final-agent-memory.sealed
node /app/memory-safeguard-REVIEWED_SHA.mjs seed --expected-deployment OLD_DEPLOYMENT_ID --expected-commit OLD_40_HEX_COMMIT --orchestrator-pid OLD_PID --quiescent --single-replica-confirmed --artifact /tmp/final-agent-memory.sealed
```

Any refused step blocks deployment. Preserve the old halted container and the
encrypted backup for diagnosis. Do not delete homes, reset counters, weaken
permissions, bypass pending receipts or replace stored ciphertext to make the
procedure pass. The initial handover approval includes rollback: remove only the
halt this procedure itself created, and only if its inode and operation-token
text remain unchanged and the exact old deployment is still active. A
pre-existing or changed halt stays in place. This resumes the old fleet without
another approval question; completed mirror batches remain safe to retry.

During permission retirement, `ledger-source-blocked.json` in a tenant's home
records an interrupted final mirror or unexpected source rewind. It prevents
restarting over a book whose final copy is uncertain. Retain that home and its
lease, then verify source continuity and the protected shared positions before
an explicitly reviewed recovery removes the marker. Ordinary continuity-read
failures leave the cursor untouched and may retry. Do not reset accounting or
clear the marker automatically to make a renewal pass.
