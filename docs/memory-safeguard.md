# Preserving memory and original accounting through renewal and deployment

This is a reviewed operator procedure, not an automatic deployment step. It
requires Milla's approval of the change and temporary production access. The
tools below have been prepared and tested locally; preparing them does not
authorize a production halt, database write, SSH-key registration or deployment.

Permission renewal stops the old signing permission and retains the agent's
roster, identity, history and memory. Explicit agent deletion still forgets
personal/group memory and invalidates any staged import generation. Cleanup
waits for the writer to exit; it retains the original financial book and removes
obsolete signing-key/bot configuration copies. A failed or incomplete final
accounting copy retains its lease and source rather than discarding them.

**Do not stage production changes before the final encrypted source backup is
verified and downloaded.** Staged changes are shared across the environment;
another dashboard operation can commit the entire patch. Coordinate with other
active tasks first. Never use global keyboard shortcuts in the Railway SQL
editor while deployment changes are pending. Use the connector/read-only CLI or
a precisely scoped SQL Run button. Preparing a local configuration file is safe;
creating a staged environment patch exposes an actionable production change.

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
   it while this procedure runs. Build and test the revision locally and in CI;
   leave the live service configuration unchanged. Keep the old container until the final checkpoint
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
7. Complete the original-book handover below before deploying. Partial paper
   book, cost-basis or chat restoration cannot restore original accounting
   source IDs. The memory-only backup does not authorize bypassing that check.

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

## One-shot original-book handover to persistent storage

Ordinary deployments must reuse a verified Railway volume. The fleet's
`MERRYMEN_HOME` must exactly equal `RAILWAY_VOLUME_MOUNT_PATH`, with
`MERRYMEN_PERSISTENT_HOME_REQUIRED=1` and an operator-pinned provider UUID in
`MERRYMEN_HOME_VOLUME_ID`. The code verifies the actual writable kernel mount,
private plain directories, no nested mounts and a durable volume manifest.
Provider UUID and inode identity persist across starts; device numbers are
checked within each current mount namespace. No container-overlay fallback is
accepted when this feature is required.

A first **empty** volume additionally requires `MERRYMEN_INITIAL_HANDOVER`.
Before any ordinary writer, the orchestrator creates and syncs its own
`FLEET_HALT` and manifest. It never clears that hold automatically. Existing
data without a manifest, a different volume, a replaced halt or a partial first
initialization requires reviewed recovery; startup refuses and retains data.

`worker/src/ledger-handover-cli.ts` is an explicit operator tool, separate from
the normal worker and memory-only capture:

| Mode | Required state | Effect |
| --- | --- | --- |
| `preflight` | Exact current deployment/commit/PID and one replica | Read-only public coverage: existing books, never-created books, historical missing books and present-but-unverified sources; never declares release eligible |
| `capture` | Original source halted, all writers exited, final verified memory artifact, final mirror complete | New encrypted fleet artifact containing allowlisted original books, memory, exact grant incarnations and target identity; actual fresh-SQLite round-trip verification |
| `verify` | Same halted original source and artifact | Rechecks original source, rows, allocation high-water, shared accounting and memory; no staging |
| `stage` | Same verified original source under healthy tenant leases | Insert-only personal-memory seeding and tenant-bound one-shot ledger imports; no execution or accounting reset |
| `restore` | Exact reviewed target on its verified mounted volume and own unchanged halt | Original books restored before memory; imported generations consumed transactionally; absent historical books remain explicitly blocked |
| `complete` | All target books, consumed generations, memory and privacy content verified, no writers | Syncs the completed manifest, then removes only this handover's unchanged halt; never removes tenant accounting barriers |

The financial artifact is **not a raw SQLite export or a recurring snapshot**.
It transfers only compiled columns from the original agent, events, posts,
trades, equity, flows, fee accruals, journal, decisions, positions, paper book,
cost basis, position/trench floors, class positions, risk periods, energy days,
flow quarantine, Brain trigger state, completed command audit and pool metadata.
Original row IDs, stamps, journal payload bytes/hashes, nonces, settlement state,
allocation sequences, spend/review counters and deduplication records are retained.
It excludes signing keys, authorization, settings, bot/link files and DM rows;
memory is carried through its existing authenticated privacy boundary.

Each book is limited to 64 MiB and 250,000 rows; the encrypted fleet file is
limited to 384 MiB (256 MiB plaintext envelope). Oversized or unknown financial
schema refuses rather than truncates. Pending trades or unfinished commands,
changed grants, differing shared accounting, missing original cursor witnesses
or an unhealthy lease also refuse. These export limits do not restrict a healthy
book growing on its persistent volume during normal use.

Publication is no-clobber and crash-safe: the target records the pending
generation, syncs a fresh SQLite stage, links it without overwriting an existing
book, then consumes the shared import transaction. A lost commit acknowledgement
can finish only that exact generation. Consumption clears the staged encrypted
payload while retaining a nonpayload receipt bound to the provider volume,
account, chain, original file inode and an in-book random identity. A missing,
truncated or replaced book cannot mint another identity or replay the import,
even when its shared cursors were still zero. Explicit deletion permanently
fences the old generation; a re-grant may reattach only the exact retained
original source with its identity and accounting proof.

An absent historical original book is never treated as an empty/new agent.
`preflight` reports it. After explicit review of those gaps, capture may use
`--acknowledge-historical-ledger-gaps` to bind their current grant and full shared
financial digest in the encrypted manifest. Restore writes a durable tenant
accounting block before restoring memory. Completion checks that block and the
unchanged accounting; the tenant remains unable to bootstrap, mirror or trade
until separate reviewed financial recovery. An existing rebuilt book with
missing witnesses does **not** qualify as an absent-book gap.

Run the one-shot tool with explicit `MERRYMEN_HOME` on the source, even when the
old service normally derives its home from the OS. All mutating/verification
modes require `--quiescent --single-replica-confirmed`, the current
`--expected-deployment`, `--expected-commit` and `--orchestrator-pid`.
Capture additionally takes `--memory-artifact`, `--output`,
`--target-volume-id`, `--target-mount-path`, `--target-commit` and
`--operation-token`. Other modes take `--artifact`. Target modes also require
the original `--expected-source-deployment`, `--expected-source-commit`,
`--source-orchestrator-pid` and `--source-orchestrator-start` from the artifact.
Build its unique repository-root bundle with the same reviewed hash procedure
used for the memory-only CLI; the DEK remains inside the container.

Only after source capture, fresh restore verification, downloaded ciphertext
hash verification and stage succeed should the approved volume, variables and
**exact reviewed CI-green commit** be applied together. Check the entire pending
environment patch for unrelated changes immediately before committing it. Keep
the target held until restore and completion pass, then verify one bot listener,
original book identities/history and unchanged trading limits before reconnecting
the source to `main`.

If the old deployment was already removed, **stop this handover**. A redeployed
old image is not evidence that its ephemeral disk returned. A live memory-only
backup cannot seed a final financial handover. Preserve the current volume,
encrypted artifacts and shared accounting for separate reviewed recovery; never
substitute shared database IDs for original source IDs, reset cursors or clear
accounting blocks to make deployment pass. The old-halt rollback above is valid
only while the exact old source remains active. After replacement, keep the
target's hold and seek reviewed recovery instead of claiming that rollback will
recover the removed filesystem.

During live trading-worker mirroring and final accounting copies, `ledger-source-blocked.json`
in a tenant's home records an interrupted copy or unexpected source rewind. It
prevents restarting over a book whose copy is uncertain. A cold startup proves
the ledger's original shared cursors again after restoring or creating its local
book and before trading starts; an unconfirmed or rebuilt accounting book holds
trading until reviewed recovery. Retain that home and its
lease, then verify source continuity and the protected shared positions before
an explicitly reviewed recovery removes the marker. Ordinary continuity-read
failures leave the cursor untouched and may retry. Do not reset accounting or
clear the marker automatically to make a renewal pass.

Positive legacy cursors without a saved creation-time witness (`last_stamp`),
and cursors whose original source row is absent or different, also hold trading.
They require reviewed recovery that proves the original book and protects its
shared accounting; the guard does not hydrate a witness from an unverified new
row, clear a cursor or grant a fresh accounting allowance.

A missing financial witness alone does not disable the held privacy bot, which
does not read or write financial tables. Its existing personal/group-memory
restore gates and durable-source-marker rules still apply. If a missing live
source's marker cannot be persisted, the supervisor also holds that home in
memory: preserve that deployment for reviewed recovery; do not restart it to
bypass the failed durable fence.

After an unconfirmed live or final trading-source copy, full private/group
snapshots are held too: missing SQLite must not replace saved DM history with an
empty transcript. Valid forget journals still remove the requested memory from
the existing sealed snapshot under the retained healthy tenant lease.
