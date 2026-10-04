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
and an additional mutex per bot stream. Root, grant, settings, link, roster or
lease changes stop the service. Individual provider refusals are quarantined
without inventing authorization for the affected bot.

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
privacy proof cannot mean that no forget request exists.

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
not evidence that it ran.
