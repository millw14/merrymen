# Fleet history recovery and continuation review

An agent can retain its public identity and shared history while its original
SQLite accounting source is unavailable. Renewing its signed permission does not
recover that source. A saved balance, an expired permission, and trading readiness
must therefore be shown as separate facts.

This change publishes an owner-scoped recovery report when the supervisor's
original-source gates refuse a stopped tenant. It also inspects stopped expired
and maintenance-held tenants without preparing their keys or books, so the
accounting blocker is visible before an owner tries renewal. The dashboard and
its chat qualify saved balances, positions and history while recovery is held;
withdrawal access remains available. These reports never grant execution authority.

Owner recovery reporting currently covers agents with a stored current grant,
including expired grants. Grantless retained agents have no new private recovery
endpoint: `/api/grants` still returns `exists: false`, and chat does not infer
recovery ownership without that grant. This change does not rebuild their access
or make universal fleet readiness claims.

## What this change does

- `fleet_recovery_health` stores a tenant/account/chain-bound source report. It
  contains no financial amounts, keys or memory. Only the supervisor writes it
  under a healthy tenant lease and the unchanged stored grant. A chat-only
  holder may publish a failure report; clearing a report requires no holder or
  worker. Missing legacy
  metadata remains compatible; unreadable metadata does not silently mean ready.
- Owner reads use the authenticated tenant's current grant. Hosted heartbeat
  reads come from that account's shared row rather than a web-container file.
  Public identities and leaderboard calculations are not reset by this report.
- Held buy/sell, energy-purchase, transaction-probe and practice-reset requests
  are refused before new shared intents are admitted. Hold publication, admission,
  delivery and held resets use one account lock across services. PostgreSQL
  transactions run on the same pinned connection that owns that lock.
- Existing queued commands and in-flight markers are preserved. Refused legacy
  rows are excluded before delivery limits, so they cannot consume every eligible
  queue slot indefinitely. Actual result files can still land as receipts.
- Legacy holders also check original root/source/import fences before retrying a
  practice restore and before a reset transaction commits. A missing health row
  cannot bypass those existing financial source protections.
- Only after the existing original-source gates pass, the stopped supervisor
  publishes a private durable command cutoff before clearing a held report or
  forking. The worker checks it before claiming/unlinking a financial command.
  Commands at or before the cutoff remain held, including practice resets and
  transaction probes. This cutoff does not attest that those commands never ran.

An absent cutoff is backward-compatible. An unreadable, mismatched or unsafe
cutoff or publication lock refuses financial commands. Publication can tighten an
owned plain old home to mode 0700 through its verified directory handle. Readers
never change permissions. An orphan publication lock is never automatically
stolen or removed: preserve it until an operator verifies the original source,
exclusive writer absence and the publication boundary.

## Preparing a continuation from retained records

`worker/src/fleet-recovery-preview.ts` is a pure review helper. It accepts a
versioned per-tenant evidence manifest and reports unresolved requirements. It
does not collect or verify evidence, restore memory, import an accounting book,
create an epoch, clear a source barrier or authorize trading. A manifest field
marked verified is an attestation supplied by a separate collector, not proof
created by this function.

A review must bind the retained and current tenant/account/chain/grant identities,
prospective source generation and accounting epoch. It must separately establish:

- original source and volume ownership; execution receipts, custody, unresolved
  operations and nonces; preserved or quarantined legacy commands;
- rolling budgets, risk period, peak/drawdown state, withdrawals and cumulative
  fee liabilities; cost basis, position floors and attributable gas;
- a verified current opening observation and complete subsequent flows; the
  preserved historical return must not silently become the new observation;
- memory-envelope authenticity, later forget requests, tombstones and conflicts
  with newer memory. A live backup is a candidate, not a lossless handover.

Unknown evidence blocks readiness for review. Every preview reports
`authorizesTrading: false`, `authorizesReads: false` and
`originalSourceRecovered: false`. History availability does not certify a complete
book or restored memory. Since-recovery returns have not started. Public lifetime
returns and rankings must not be recomputed from a partial mirror or reset epoch.

The current incident's original removed SQLite books remain unrecovered. The
retained shared history and sealed memory backup must remain preserved while the
provider's human recovery investigation and accounting reconciliation continue.
This change includes no incident-book writer or memory importer and does not
resume the affected production fleet.

## Reviewed rollout

1. Keep all existing deployment and source/accounting holds. Verify deployment
   triggers on every affected service before merging a branch that can deploy.
2. Review this application/trading change and its prerequisite memory/source
   retention change with Milla. Passing CI alone is not approval.
3. Ordinary supervisor startup still requires a verified persistent root. A
   nonempty root without its manifest refuses before recovery reporting. A held
   manifest retains `FLEET_HALT` and skips reconciliation, so it also publishes
   no new recovery reports. These changes include no separate status-only
   startup path and do not make the reported incident volume deployment-ready.
   Any incident reporting or initialization plan needs separate reviewed work;
   retain all existing holds and source proof requirements. Do not clear a halt,
   disable proof, copy a manifest or mark handover complete to obtain UI status.
4. Verify authenticated owner views show the hold and qualify saved figures.
   Check narration with stale active/energy state and model failure. Do not use a
   live financial probe as a UI verification step.
5. A later concrete continuation or memory-restore implementation needs its own
   per-tenant evidence, verification and Milla review. Never delete the incident
   home, rewrite old IDs/cursors, reset risk limits or treat empty mirrors as a
   recovered source to make a startup pass.

## Validation

Local tests exercise separate disposable PostgreSQL pools, transactional rollback
and schema-memo compatibility, admission/publication races, retained expired
intents, bounded-delivery starvation and stale source-check refusal. Filesystem
integration exercises an old 0755 home, private cutoff publication before fork,
old JSON/running-marker preservation and execution of only a later fixture
command. Held-reset tests verify a late local-boundary or lease refusal rolls back
claims, book changes and events.

UI fixtures use synthetic names, balances and times with the actual components
and CSS. Chrome verification covers desktop and a 390-pixel phone frame. They are
layout evidence, not a production recovery or current portfolio observation.
Standard CI covers the whole application suite, typechecks, build and packaging;
the opt-in PostgreSQL tests were executed locally against a disposable loopback
server and do not read production credentials.
