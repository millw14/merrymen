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
   first, then the source. It reads each one in a single
   `REPEATABLE READ READ ONLY` transaction that ends in `ROLLBACK`, and it
   never writes to either.
4. **Record the JSON** with the runbook evidence. It contains the restore point,
   row counts and verdicts. It contains no row values, stamps, host names or
   URLs, and errors are reported by code.
5. **Delete the fork** service, and any proxy you added.

The exit code is `0` when the drill passes, `1` when it fails or cannot
finish, and `64` when the verifier refuses before comparing anything.

## Reading the result

The verifier compares only rows that the source had written by the restore
point. For each allowlisted table it counts the rows whose write stamp falls at
or before the **cutoff**: the restore point minus a settle margin
(`--settle-sec`, default 900). The margin allows for a commit that lands a
moment after its stamp. It also reads the newest such stamp, which it compares
but never prints.

- **`ok: true, exact: true`**: every allowlisted table that exists matched.
  Expect this while trading is held.
- **`ok: true, exact: false`**: some tables read `source-changed`. After the
  restore point the source deleted rows stamped before the cutoff, or rewrote
  them with newer stamps. Either way the fork holds more than the source,
  which is consistent with a good restore. Check that it fits known activity,
  such as a re-signed grant or an accounting repair.
- **`absent`**: neither database has the table yet. This passes.

These verdicts fail the drill:

| Verdict | Meaning | What to do |
|---|---|---|
| `fork-behind` | The fork has fewer rows stamped before the cutoff than the source, or an older newest stamp | Suspect the restore first: a wrong point, or an incomplete restore. A mirror catching up a backlog after a restart also writes rows with old stamps after the restore point. Check the orchestrator's mirror log lines around that time, then repeat with a quieter restore point or a larger `--settle-sec`. Never record it as a pass without the explanation. |
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
cursors, wallet authority and owner configuration, recovery state, and send
and reply receipts. Every entry names an integer write stamp. It is in epoch
seconds or milliseconds, written with the row, and it never moves backwards.
Each value is normalised to seconds on its own, because both units are in use.

To add a table, give it a stamp of that kind. A table without one, such as
`energy_days`, which keys on a text day, can only be compared whole, which
fails every drill taken while the source is still being written.

On the source, the cost is one read-only transaction and one counting scan per
allowlisted table. Do not run it during a deploy or a schema change: the scans
hold ordinary read locks until the transaction ends.

## What it does not prove

- It does not compare row contents. It compares counts and newest stamps.
- It does not check tables outside the allowlist.
- It does not check orchestrator volume snapshots. Restore one into a new
  volume, mounted by no live service, and inspect it separately.

The verifier's tests are in `cli/pg-backup-verify.test.mjs`. Their opt-in case
runs the real SQL against a disposable local Postgres:

```sh
MERRYMEN_TEST_PG_URL=postgres://merrymen@127.0.0.1:55432/postgres \
  NODE_PATH=<a directory holding pg@8> npx tsx --test cli/pg-backup-verify.test.mjs
```
