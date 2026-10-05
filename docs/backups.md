# Backups and the restore drill

A backup counts only after it has been restored and checked. This page covers
what protects the hosted deployment's state, and the drill that proves the
shared Postgres can be restored.

## What protects what

| State | Protection | How it is restored |
|---|---|---|
| Shared Postgres: the ledger, grants, settings, recovery state | Point-in-time recovery (PITR), plus the Postgres volume's daily, weekly and monthly backup schedule | A point-in-time fork into a **new** Postgres service |
| Orchestrator volume: tenant homes, `FLEET_HALT`, archives | The volume's daily and weekly backup schedule | A snapshot into a **new** volume |
| Off-provider encrypted dump | Not built yet. Off-provider dumps come later (decision 18) | — |

Rules:

- Never restore over a live volume or into the live Postgres service. A
  restore always goes into a new service or volume, which nothing live mounts
  or connects to.
- Keep the previous manual backup until a restore drill on the new
  arrangement has passed.
- A restored fork holds the same sealed secrets, grants and owner data as
  production. Delete it when the drill ends.

## The restore drill

Run it when the runbook asks for it (after PITR is enabled, and before a pilot
resume), and after any change to backup settings.

1. **Choose a restore point** at least an hour old, during a quiet period, and
   write it down in UTC. While trading is held, the ledger is quiet at any hour.
2. **Create a point-in-time restore** of the Postgres service at that time,
   into a new service. Point no application service at it. If you need a TCP
   proxy to reach it, remove the proxy when you delete the fork.
3. **Run the verifier** from a shell that can reach both databases. A
   container in this project can reach both private hosts, and the hosted
   image already installs `pg`, the driver the verifier needs:

   ```sh
   # bash: paste the fork's connection URL; it is not echoed or kept in history
   read -rs MERRYMEN_RESTORE_FORK_URL && export MERRYMEN_RESTORE_FORK_URL
   MERRYMEN_RESTORE_SOURCE_URL="$DATABASE_URL" \
     node scripts/pg-backup/verify-restore.mjs --restore-point 2026-10-05T02:00:00Z
   ```

   The URLs are read from the environment only. The verifier reads the fork
   first, then the source. Every read is made in a short
   `REPEATABLE READ READ ONLY` transaction that ends in `ROLLBACK`: one for
   the catalog, then one per table. It never writes to either.
4. **Record the JSON** with the runbook evidence. It contains the restore point,
   row counts, each table's kind and verdict, and the fixed reasons in
   `contentUnverified`. It contains no row values, stamps, host names or URLs,
   and errors are reported by code.
5. **Delete the fork** service, and any proxy you added.

The exit code is `0` when the drill passes, `1` when it fails or cannot
finish, and `64` when the arguments or URLs are refused (`usage`,
`fork-is-source`, `fork-is-live`).

## Reading the result

The verifier compares only rows that the source had written by the restore
point. For each allowlisted table it counts the rows whose write stamp falls at
or before the **cutoff**: the restore point minus a settle margin
(`--settle-sec`, default 900). The margin allows for a commit that lands a
moment after its stamp. It also reads the newest such stamp, which it compares
but never prints.

The margin is also a blind spot. Rows stamped within it of the restore point
are compared by neither side, so a fork restored up to that many seconds
before or after the restore point still passes. Keep the default. The
verifier refuses more than 3600. If you run it with any other value, record
the value and the reason with the evidence. A wider margin is never the fix
for `fork-behind`.

Counts and a newest stamp prove that the fork holds the rows. Whether it holds
their contents as they were at the restore point depends on how the table is
written, so each table in the report has a `kind`:

| Kind | Written how | What an equal comparison proves |
|---|---|---|
| `append` | Inserted, never changed, at most deleted | The rows and their contents: `match` |
| `last-write` | Every writer sets the stamp to the time of its write | The rows and their contents: `match` |
| `presence-only` | Some writer changes a row without moving its stamp, copies the stamp from a child ledger, or writes back an older one | The rows only: `present-content-unverified` |

A presence-only table never reads `match`. A fork that kept an older version
of one of its rows (an `agents` row whose caps or high-water mark changed,
say) reads exactly like a fork with the current version, and the verifier
cannot tell them apart.

- **`ok: true, exact: true`**: every allowlisted table that exists held the
  same rows as the source by the cutoff, by count and newest stamp: `match`,
  or `present-content-unverified` for a presence-only table. Expect this
  while trading is held. It is not a statement about the contents of the
  tables in `contentUnverified`.
- **`ok: true, exact: false`**: some tables read `source-changed`. After the
  restore point the source deleted rows stamped before the cutoff, or rewrote
  them with newer stamps. Either way the fork holds more than the source,
  which is consistent with a good restore. Check that it fits known activity,
  such as a re-signed grant or an accounting repair.
- **`present-content-unverified`**: a presence-only table held the same rows
  on both sides. This passes. Its contents were not checked.
- **`contentUnverified`**: every presence-only table the verifier compared,
  each with a fixed `why` naming the write that keeps its contents out of
  reach. It does not fail the drill. Record it with the evidence as it is,
  and never summarise the drill as having verified those tables' contents.
- **`absent`**: neither database has the table yet. This passes.

These verdicts fail the drill, whatever the table's kind:

| Verdict | Meaning | What to do |
|---|---|---|
| `fork-behind` | The fork has fewer rows stamped before the cutoff than the source, or an older newest stamp | Suspect the restore first: a wrong point, or an incomplete restore. A mirror catching up a backlog after a restart also writes rows with old stamps after the restore point. Check the orchestrator's mirror log lines around that time. Only once they show such a backlog, repeat with a new fork at a restore point outside it. Do not widen `--settle-sec` to make it pass. Never record it as a pass without the explanation. |
| `fork-after-restore-point` | The fork holds rows stamped after the restore point plus the margin | The restore point given is wrong, the fork URL is not the fork, or something wrote to the fork |
| `missing-in-fork` / `missing-in-source` | Only one database has the table | Investigate the restore, or the URLs |
| `bad-stamp` | The table's allowlisted stamp column is missing or not an integer | Fix the allowlist |

`error.code` explains a drill that stopped:

| Code | Meaning |
|---|---|
| `usage` | A missing or invalid argument or URL. The restore point needs an explicit zone, such as `Z`. |
| `fork-is-source` | Both URLs name the same database, or both connections reached the same server and database |
| `fork-is-live` | The fork URL is this shell's own `DATABASE_URL` |
| `connect-failed` | No connection could be made. `side` and `cause` (an errno code) are given. |
| `not-read-only` | The transaction did not report read-only, so nothing was read |
| `query-failed` | A read failed. `side`, `table` and `cause` (a SQLSTATE) are given. `57014` is the 60-second statement timeout; `55P03` is the 5-second lock timeout. |
| `no-driver` | `pg` is not installed where the verifier ran |
| `nothing-to-compare` | No source row was stamped before the cutoff, so the drill proved nothing |

## What the drill reads

The verifier reads only the allowlist `DRILL_TABLES` in
`scripts/pg-backup/verify-restore.mjs`: the ledger, book state, the mirror's
cursors, wallet authority and owner configuration, the apps owners connected
over MCP with their tokens and order proposals, recovery state, and send and
reply receipts. Every entry names an integer write stamp. It is in epoch
seconds or milliseconds, written with the row. Each value is normalised to
seconds on its own, because both units are in use.

Every entry also names its kind, decided by reading every writer of the table
(each `INSERT`, `UPDATE`, `DELETE` and upsert that reaches the shared
database), with the evidence beside the entry. One writer is enough to make a
table presence-only.

To add a table, give it an integer stamp and a kind, and cite its writers. A
table without such a stamp, such as `energy_days`, which keys on a text day,
can only be compared whole, which fails every drill taken while the source is
still being written. A new writer of an allowlisted table means reading its
kind again.

A presence-only table can become last-write only once it has a stamp that
every writer sets to the time of its write: an `updated_at` added by a
migration and maintained by each writer, with the entry switched to it. That
is a schema change and a change to every writer, and is reviewed as such.

On the source, the cost is one counting scan per allowlisted table, each in
its own read-only transaction. A scan holds an ordinary read lock on its one
table until that scan ends, and no longer, so a schema change the services
run on connect waits for at most one count (60 seconds at worst). Even so, do
not run it during a deploy or a schema change.

## What it does not prove

- It does not read row contents. It compares counts and newest stamps. For
  append and last-write tables that is also evidence about contents, because
  a row there either never changes or moves its stamp when it does. For
  presence-only tables it is not, and the report lists them in
  `contentUnverified`.
- It does not check rows the source deleted, or re-stamped past the cutoff,
  after the restore point. The fork may hold more than the source, never
  less.
- It does not check tables outside the allowlist.
- It does not check orchestrator volume snapshots. Restore one into a new
  volume, mounted by no live service, and inspect it separately.

The verifier's tests are in `cli/pg-backup-verify.test.mjs`. Their opt-in case
runs the real SQL against a disposable local Postgres:

```sh
MERRYMEN_TEST_PG_URL=postgres://merrymen@127.0.0.1:55432/postgres \
  NODE_PATH=<a directory holding pg@8> npx tsx --test cli/pg-backup-verify.test.mjs
```
