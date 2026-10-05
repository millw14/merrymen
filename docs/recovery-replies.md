# Public Telegram replies during accounting recovery

`npm run start:recovery-replies` starts a separate Telegram process for fresh
Robinhood Chain public charts, market reads and attributed project descriptions. It does not
start the orchestrator, trading workers or hold workers. Trading commands and
old action buttons cannot execute an order. Historical conversation is not
used, and new conversation payloads are not retained.

This is an application change requiring Milla's review under `AGENTS.md`.
Passing CI or the metadata coverage check does not authorize deployment or
financial resumption.

## Prerequisites

- Preserve the existing volume and its verified encrypted backups. Keep
  `FLEET_HALT`, the original source/import barriers, grant authority and all
  accounting holds unchanged. Do not initialize or adopt a source manifest.
- Run the reviewed recovery reporter first so exact current tenant, smart
  account and chain scopes have durable negative recovery statuses.
- Verify the old orchestrator and all trading/hold worker deployments are
  stopped and removed. Replace the reporter with this entry; never run both
  at once. A local environment flag cannot prove another deployment is absent.
- Keep the current private mounted home, its volume identifier, hosted
  PostgreSQL connection and existing encryption key. This entry checks the
  actual mount and unchanged owned halt without repairing either.
- Each candidate needs a current enabled sealed bot token, a positively read
  bot claim, the current linked owner in its allowlist, and a held recovery
  status. Telegram must independently confirm the expected bot identity.
  Group replies also require the current room approval and enabled group
  settings. Unavailable or ambiguous authority never becomes a new link.
  An operator group-off setting suppresses public group answers while
  authenticated forget requests remain available.

The entry holds the existing tenant leases for the complete current roster
and an additional mutex per bot stream. Individual provider refusals are
quarantined without inventing authorization for the affected bot.

## One tenant's problem stops one tenant

On 2026-10-05 the listener exited ten times in a working day and Railway then
marked it crashed. Every actor compared the whole roster before every
operation, so any tenant signing a grant stopped every bot; one statement
timeout on one tenant's settings read, one bot's 409, one lost lease or one
error in one actor did the same. The entry is now a supervisor with one actor
per serving tenant:

- **The supervisor** re-reads the roster every 30 seconds, row by row, and
  sooner when a waiting tenant's back-off ends or a lease is lost. It holds
  the tenant lease of every roster tenant whose tenant column is an address
  in any letter case (under its lowercase form), malformed grant or not (the
  fence), and admits an actor for each tenant whose stored public scope is
  available: tenant lease, bot stream lease, then a fresh snapshot. It stops
  the actor of a tenant that left the roster (and then releases its leases)
  or whose own row changed, and re-admits it on a later pass when it is
  still eligible. A malformed row, a mixed-case tenant column, or two rows
  claiming one smart account, is skipped with a redacted `[alert]`; that
  tenant stays fenced and is never served on a guess.
- **Each actor** re-proves only its own scope before every step: the fleet
  root proof, its own tenant lease and bot lease, its own grant row against
  the receipt it was admitted with (and that no other row claims its smart
  account), then its settings, claim, link, held status and room approvals.
  An unrelated tenant's write never reaches it; its own change, or another
  row taking its smart account, stops only it (`roster-changed`,
  `snapshot-invalid`).
- **Admission window.** A tenant whose grant row first appears while the
  listener runs is fenced on the next pass: for up to 30 seconds plus its
  lease acquisition that brand-new tenant is not leased by this process. The
  rollout prerequisite below (no ordinary orchestrator or worker deployment
  running beside this one) is what covers that window, as it always has.
- **Telegram.** A 409 marks that bot (`tenant_telegram.poll_err` as
  `conflict: …`, the format the dashboard already reads, with
  `poll_ok_at` cleared; a webhook and another poller each get their own
  wording) and backs it off 60 seconds doubling to 10 minutes. Any other
  failed or thrown transport call backs that bot off 2 seconds doubling to
  60 seconds, or Telegram's `retry_after`. 401/404 and a wrong bot identity
  keep the existing quarantine, which now lasts until the stored scope
  changes (a new token or claim) or the process restarts; a quarantined bot
  keeps its bot stream lease.
- **Database weather.** A statement timeout (57014), `NOWAIT` meeting the web's
  write to the same row (55P03), a pool timeout, or a connection that is
  terminated or reset (a failover, a reaper, `pg_terminate_backend`) even
  while a transaction holds it, retries that actor in place after 2 seconds
  doubling to 60 seconds; it keeps its leases and re-proves its whole scope.
  The doubling counts from the last COMMITTED drain, so a drain that fails
  every time waits longer each time. Statement timeouts are 2.5 seconds on
  the server and 3 seconds on the client (they were 1 and 1.5 seconds);
  transaction deadlines (8 seconds), the thirty-second reply deadline and the
  500ms lock timeout are unchanged. The deadline is checked between
  statements, so a statement that starts just before it can keep that
  tenant's share locks up to 2.5 seconds past it (about 1.5 seconds longer
  than before); that can delay the web's write to that one tenant's rows by
  as much, never another tenant's.
- **Lost leases.** One tenant lease session carries one eighth of the fleet;
  when it drops, only those actors stop (`lease-lost`). The supervisor
  releases and re-acquires each lease after 5 seconds doubling to 5 minutes.
  A lost bot stream session stops every actor holding one of its leases at
  once, including one waiting out a long 409 or `retry_after` back-off, and
  is replaced as soon as they have ended; until then admission waits as
  `bot-session-renewing`, with no back-off. A lease this process is itself
  still acquiring or releasing is `lease-settling`, never `lease-busy`.

**Fleet-wide refusal** (exit 1, so Railway's restart policy applies) remains
only for conditions about the whole process, where a restart cannot help:
the root proof (`FLEET_HALT`, the mount, the frozen environment), an invalid
encryption key, a roster with more than 256 rows or one that cannot be read
at startup for a reason other than database weather (a missing table, say),
and a fault in the supervisor itself. Database weather at startup (a
restarting or overloaded database) is waited out in place, 2 seconds
doubling to 60, with nothing fenced or served until the roster reads.
SIGTERM is a clean stop: the entry releases every lease, prints
`[recovery-replies] stopped on signal; leases released. …` and exits 0.

**The multi-bot 409 pause** (no exit). A lease-less ordinary poller fleet
running beside this listener would make most of its bots answer 409 at about
the same moment. When at least three bots have a conflict that first
appeared within two minutes, and they are a majority of the bots being
served, every actor stops polling for 10 minutes, one
`[alert] fleet-pause reason=telegram-409-fleet` line is printed, and every
tenant and bot lease is kept. It never exits: an exit would release the
fence to that other fleet, spend a restart and not stop the other poller.
Webhook 409s (the owner's own setting on their own bot) are never counted; a
conflict merely seen again after its back-off keeps its first time; and the
conflicts that tripped a pause cannot trip another while they stand. The
tenant-lease fence already keeps out every lease-respecting ordinary worker,
so this is only the backstop for a lease-less one.

**Coexistence tripwires are now per-tenant waits: a policy change for
Milla's approval.** Before this change the listener refused fleet-wide when
any tenant or bot lease was held elsewhere at startup, when any lease was
lost, and on any 409. Now `lease-busy` and `bot-busy` are `[alert]
admit-wait` lines and the listener keeps serving every other tenant beside
whatever holds that lease. No tenant is ever served without both of its
leases. What is given up: a lease-less legacy worker serving a `lease-busy`
tenant could still poll a bot whose claim moved to a tenant this listener
serves, which the fleet-wide refusal used to rule out. The rollout
prerequisite (no ordinary orchestrator or worker deployment beside this one)
is what covers that, as it covers the 30-second admission window above. A
persistent `lease-busy` on several tenants should be treated as a second
deployment and investigated.

**Logs.** Every actor start, stop and back-off, each admission wait and each
fatal refusal is one line with a fixed reason code and at most an
eight-character tenant prefix (`tenant=0x1a2b3c`); a counts-only `stats` line
follows the first pass and then every five minutes. No line carries a token,
owner or chat id, address, message or provider text. The codes:

| Line | Reasons |
|---|---|
| `actor-stop` | `roster-changed`, `roster-removed`, `snapshot-invalid`, `lease-lost`, `telegram-refused`, `db-transient`, `actor-error` |
| `admit-wait` | `lease-busy` (another process holds it), `lease-settling` (this process's own acquisition or release is still in flight), `bot-busy`, `bot-session-renewing` (no back-off), `lease-lost`, `snapshot-invalid`, `db-transient` |
| `backoff` | `telegram-409`, `telegram-network`, `db-transient`, `deadline` (also `scope=roster` and `scope=pool`) |
| `fleet-pause` | `telegram-409-fleet` (no exit; leases kept) |
| `refused reason=` (last line, exit 1) | `root-proof`, `dek-invalid`, `roster-unreadable`, `roster-cap`, `supervisor-error`, `startup` |

**Restart policy.** `railway.json` is unchanged: `ON_FAILURE`, at most 10
restarts. It is shared by every service built from this repository (web,
orchestrator, browser and brain) and Railway applies it over the dashboard
setting, so raising it would also give a crash-looping trading orchestrator
that many more boots. The listener no longer needs a higher cap: on
2026-10-05 it spent its ten restarts on per-tenant events (a grant write, one
statement timeout), and it now exits non-zero only on the fleet-wide refusals
above, where a restart cannot fix the cause and a quick, visible crashed
deploy is the right outcome. Railway's documentation says existing `railway.json` files
keep working until 2026-12-01; the restart policy has to be carried into
whatever replaces the file. A higher cap for the listener alone (for
instance a separate config file selected on that service) is a separate
decision.

## Controlled rollout

After review and all required CI checks, pin the orchestrator service to the
reviewed commit and set these service variables together:

```text
MERRYMEN_START=start:recovery-replies
MERRYMEN_FLEET_RECOVERY_REPORT_ONLY=1
MERRYMEN_FLEET_RECOVERY_REPLIES=1
MERRYMEN_FLEET_SERVICE_ID=<this service's RAILWAY_SERVICE_ID>
MERRYMEN_PERSISTENT_HOME_REQUIRED=1
```

The image's deploy guard (`scripts/container-start.sh`, then
`worker/src/deploy-guard.ts`) refuses every fleet role, this one included,
with exit 78 before node starts unless `MERRYMEN_FLEET_SERVICE_ID` equals
the Railway-injected `RAILWAY_SERVICE_ID` of this service and
`MERRYMEN_PERSISTENT_HOME_REQUIRED` is exactly `1` (the listener's root proof
requires it too). `MERRYMEN_IMAGE` comes from the Dockerfile; do not set it
as a service variable. The service's Start Command must be empty, so the
image's own start path (tini, the start script, then node) runs and delivers
SIGTERM to node. Expect these first lines, in order:

```text
[start] role=start:recovery-replies commit=<sha>
[deploy-guard] census one-shot: <names or none>
[deploy-guard] ok role=start:recovery-replies
[recovery-replies] actor-start tenant=0x…   (one per serving tenant)
[recovery-replies] stats roster=R fenced=F actors=A …
```

The census only prints one-shot variable names for this role; it refuses only
`start:orchestrator`. A brief `admit-wait … reason=lease-busy` while the
previous deployment of this same listener is still draining is expected; one
that persists means another process holds that tenant.

Keep the existing home, mount, PostgreSQL, encryption and accounting variables
unchanged. Inspect the complete staged provider patch before applying it.
Retain the web deployment's existing recovery presentation; it needs the new
reviewed presentation helper to identify measured public polling separately
from trading. This rollout does not release any financial source hold.

Verify the served commit and single running reply process; confirm no trading
or hold workers, unchanged halt and financial files, and current claim-bound
poll progress: `tenant_telegram.poll_ok_at` is written on every clean poll,
whereas `recovery_reply_offsets` moves only when a bot actually receives
updates, so a quiet bot's offset row standing still is not a stall. The owner dashboard may say **Listening for public questions**
only after a fresh measured poll. A valid token or preserved memory alone
cannot prove replies. Do not send a live Telegram test message without the
owner's authorization.

The optional `recoveryReplyCoverage` helper accepts only a caller-held
read-only repeatable-read transaction and returns counts and booleans. It
does not confirm live tokens, exclusive leases, delivery or financial safety.

## Reply and privacy behavior

Public lookups and chart rendering have a shared ten-second budget. The
original thirty-second deadline includes polling, authority checks, queuing
and delivery; stale or late results are discarded. The fleet admits at most
eight public read/render jobs and thirty-two response jobs at once, without an
unbounded queue. Each bot batch admits at most sixteen responses. Overload may
discard a public request after durable message progress; it cannot postpone
that request indefinitely. The service uses bounded
public reads without account state, local financial caches or model keys.
Published descriptions are attributed claims, not verified coin history.

Allowlisted direct messages and explicitly addressed messages in approved rooms
also accept short greetings, acknowledgments and status questions. These use
fixed conversational replies without a public lookup or earlier chat context.
The public notice explains that an agent upgrade is underway and automated
trading is temporarily paused; it does not promise a completion time or resumed
trading. Greetings also explain that coin and chart questions remain available.
Ordinary room chatter stays quiet. Explicit coin requests such as `chart HI`
still use the public research path; trading commands remain held.

Durable message progress is keyed by the bot stream. Restarts, token changes
and claim changes preserve its high-water mark. The ordinary worker handoff
reads that progress only after its existing source, grant and lease gates.
No nonce, risk counter, fee, trading cursor or financial record is rebased.

Authenticated forget requests atomically advance message progress, record an
encrypted privacy receipt and erase the applicable retained shared memory,
even when response capacity is exhausted. The journal retains scoped Telegram
identifiers and erasure cutoffs for future retained-home reconciliation.
Future personal/group restores and publication honor those receipts. Existing
local memory that cannot prove the erasure stays held. An unavailable current
privacy proof cannot mean that no forget request exists. A forget whose
erasure cannot commit (for example corrupt retained memory) stops only that
tenant's actor (`actor-error`, re-admitted after 1 minute doubling to 10): its
update stays unacknowledged and is met again on each retry, never acknowledged
without the durable erasure. Other bots keep answering meanwhile.

For rollback, stop the reply deployment and verify its removal, then use the
approved **report-only** entry with all original holds intact. Preserve the
new message progress and privacy journal. Never return to an older ordinary
worker that ignores those records, and never clear the halt to make rollback
or a test pass.

## Local verification

Entry tests require an explicitly supplied disposable loopback PostgreSQL
database. They create and remove isolated schemas; never supply production
credentials. For example:

```sh
MERRYMEN_TEST_PG_URL=postgresql://mmreply@127.0.0.1:55491/postgres \
  node --import tsx --test worker/src/recovery-replies.test.ts
npm run typecheck
npm test
npm run build
```

The PostgreSQL entry test is skipped when the opt-in URL is absent. Record
actual opted-in results separately from ordinary CI; inspecting a test is
not evidence that it ran. Its isolation block runs the entry continuously
(mostly with a 50ms supervisor period): another tenant's grant write, a new
roster tenant, a 409 or a transport exception on one bot, a 57014 on one
tenant, a lost tenant lease, a changed root proof, three conflicted bots
(the pause, leases kept, no exit), webhook 409s on three of five bots, a
backend terminated under an open transaction (injected and entry-owned
pools), a lost bot stream session while another bot waits out a 409 (at the
production 30-second period), a drain that fails every time, database
weather at startup, an unsettled release of our own, another row claiming a
tenant's smart account, a checksummed tenant column and SIGTERM.
`worker/src/recovery-reply-isolation.test.ts` covers the reason codes,
back-off schedules, the 409 alarm, the exit line and the row-by-row roster
without a database, and runs in ordinary CI.
