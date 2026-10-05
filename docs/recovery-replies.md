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

- **The supervisor** re-reads the roster every 30 seconds, row by row. It
  holds the tenant lease of every roster tenant whose tenant column is an
  address, malformed grant or not (the fence), and admits an actor for each
  tenant whose stored public scope is available: tenant lease, bot stream
  lease, then a fresh snapshot. It stops the actor of a tenant that left the
  roster (and then releases its leases) or whose own row changed, and
  re-admits it on a later pass when it is still eligible. A malformed row,
  or two rows claiming one smart account, is skipped with a redacted
  `[alert]`; that tenant stays fenced and is never served on a guess.
- **Each actor** re-proves only its own scope before every step: the fleet
  root proof, its own tenant lease and bot lease, its own grant row against
  the receipt it was admitted with, then its settings, claim, link, held
  status and room approvals. Another tenant's write never reaches it; its own
  change stops only it (`roster-changed`, `snapshot-invalid`).
- **Admission window.** A tenant whose grant row first appears while the
  listener runs is fenced on the next pass: for up to 30 seconds plus its
  lease acquisition that brand-new tenant is not leased by this process. The
  rollout prerequisite below (no ordinary orchestrator or worker deployment
  running beside this one) is what covers that window, as it always has.
- **Telegram.** A 409 marks that bot (`tenant_telegram.poll_err` as
  `conflict: …`, the format the dashboard already reads, with
  `poll_ok_at` cleared) and backs it off 60 seconds doubling to 10 minutes.
  Any other failed or thrown transport call backs that bot off 2 seconds
  doubling to 60 seconds, or Telegram's `retry_after`. 401/404 and a wrong bot
  identity keep the existing quarantine, which now lasts until the stored
  scope changes (a new token or claim) or the process restarts.
- **Database weather.** A statement timeout (57014), `NOWAIT` meeting the web's
  write to the same row (55P03), a dropped connection or a pool timeout
  retries that actor in place after 2 seconds doubling to 60 seconds; it keeps
  its leases and re-proves its whole scope. Statement timeouts are 2.5 seconds
  on the server and 3 seconds on the client (they were 1 and 1.5 seconds);
  transaction deadlines (8 seconds), the thirty-second reply deadline and the
  500ms lock timeout are unchanged.
- **Lost leases.** One tenant lease session carries one eighth of the fleet;
  when it drops, only those actors stop (`lease-lost`). The supervisor
  releases and re-acquires each lease after 5 seconds doubling to 5 minutes.
  A lost bot stream session stops the actors on it and is replaced once they
  have ended.

**Fleet-wide refusal** (exit 1, so Railway's restart policy applies) remains
only for conditions about the whole process: the root proof (`FLEET_HALT`, the
mount, the frozen environment), an invalid encryption key, a roster that
cannot be read at startup or has more than 256 rows, three distinct bots
answering 409 within two minutes (the signature of an ordinary poller fleet
beside this one; fewer than three serving bots cannot trip it, and each 409
stays an `[alert]` for its bot), and a fault in the supervisor itself.
SIGTERM is a clean stop: the entry releases every lease, prints
`[recovery-replies] stopped on signal; leases released. …` and exits 0.

**Logs.** Every actor start, stop and back-off, each admission wait and each
fatal refusal is one line with a fixed reason code and at most an
eight-character tenant prefix (`tenant=0x1a2b3c`); a counts-only `stats` line
follows the first pass and then every five minutes. No line carries a token,
owner or chat id, address, message or provider text. The codes:

| Line | Reasons |
|---|---|
| `actor-stop` | `roster-changed`, `roster-removed`, `snapshot-invalid`, `lease-lost`, `telegram-refused`, `db-transient`, `actor-error` |
| `admit-wait` | `lease-busy`, `bot-busy`, `lease-lost`, `snapshot-invalid`, `db-transient` |
| `backoff` | `telegram-409`, `telegram-network`, `db-transient`, `deadline` |
| `refused reason=` (last line, exit 1) | `root-proof`, `dek-invalid`, `roster-unreadable`, `roster-cap`, `telegram-409-fleet`, `supervisor-error`, `startup` |

**Restart policy.** `railway.json` keeps `ON_FAILURE` and allows 100 restarts
(it was 10, Railway's default). Railway applies config-as-code over the
dashboard setting, so the cap is changed there. The file is shared by every
service built from this repository (web, orchestrator, browser and brain), so
the higher cap applies to each; a persistent refusal still ends as a crashed
deploy, with one reason line per attempt. Railway allows more than 10 restarts
only on paid plans.

## Controlled rollout

After review and all required CI checks, pin the orchestrator service to the
reviewed commit and set these service variables together:

```text
MERRYMEN_START=start:recovery-replies
MERRYMEN_FLEET_RECOVERY_REPORT_ONLY=1
MERRYMEN_FLEET_RECOVERY_REPLIES=1
```

Keep the existing home, mount, PostgreSQL, encryption and accounting variables
unchanged. Inspect the complete staged provider patch before applying it.
Retain the web deployment's existing recovery presentation; it needs the new
reviewed presentation helper to identify measured public polling separately
from trading. This rollout does not release any financial source hold.

Verify the served commit and single running reply process; confirm no trading
or hold workers, unchanged halt and financial files, and current claim-bound
poll progress. The owner dashboard may say **Listening for public questions**
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
with a 50ms supervisor period: another tenant's grant write, a new roster
tenant, a 409 or a transport exception on one bot, a 57014 on one tenant, a
lost tenant lease, a changed root proof, three conflicted bots and SIGTERM.
`worker/src/recovery-reply-isolation.test.ts` covers the reason codes,
back-off schedules, the 409 alarm, the exit line and the row-by-row roster
without a database, and runs in ordinary CI.
