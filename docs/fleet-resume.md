# Resuming the fleet on the incident volume

No agent has traded since 2026-10-04. Every tenant's SQLite book was always
rebuilt from the Postgres mirror on a redeploy, and the deploy at 03:18 UTC
that day rebuilt every home over nothing. The continuity gate added since
(`ledgerSourceAllowsResume`, `registerLedgerSource`) refuses a new book for any
account Postgres already holds history for, so every tenant from before the
incident is refused, forever, by design. The orchestrator's volume, meanwhile,
holds an operator's hand-made `FLEET_HALT` and no persistent-home manifest, so
ordinary startup refuses the volume too.

This page is the operator runbook for getting from there to trading agents,
every step from the Railway dashboard, followed by what each mechanism does:

- [The runbook](#the-runbook-from-todays-production-to-trading-agents): steps 0 to 8, each with what to check and how to roll back.
- [Owner stop requests](#owner-stop-requests-applied-before-any-worker-arms) (`worker/src/recovery-reply-arm.ts`): every recorded `/pause` and `/kill` is applied once before a worker arms.
- [Attested-gap admission](#attested-gap-admission) (`worker/src/ledger-resume.ts`): preview, approve, archive the home, register an empty book under the approval, prove its seed, spawn through the ordinary path.
- [The volume steps](#the-volume-steps-adopt-release-re-halt) (`worker/src/persistent-home.ts`): adopt the volume under its halt, release the halt into a rollout scope, re-halt it for a rollback.

This is an application change requiring Milla's review under `AGENTS.md`.
Nothing on this page has been run against production by its author.

## The runbook: from today's production to trading agents

### Where production is (2026-10-05)

- The orchestrator service (its Railway service ID begins `227ff49a`) runs
  `codex/recovery-casual-replies` at `a7303f47` (deployment `4b4220e3`) with
  `MERRYMEN_START=start:recovery-replies`: the recovery listener. It answers
  owners' bots and trades nothing.
- Its volume (`d6481580`, mounted at `MERRYMEN_HOME`) holds every home, the
  hand-made `FLEET_HALT` (inode 15, mode 0600, 64 bytes, SHA-256
  `6fde6ce70efd0bc3e0c60538ccf57431cf76c354a617bd6c5a1f8198d4342cfa`, read by
  Codex's read-only verifier on 2026-10-04 at 23:56 UTC) and no manifest.
- About 130 agents are on the roster (74 with unexpired grants, 56 expired),
  roughly 11 on the live rail and 77 on paper. The last mirror pass, at 03:18:16
  on 10-04, covered all 44 tenants that had books; no agent UserOp has landed on
  chain since 01:36 that day.
- The service still carries the listener's variables
  (`MERRYMEN_FLEET_RECOVERY_REPORT_ONLY`, `MERRYMEN_FLEET_RECOVERY_REPLIES`),
  `MERRYMEN_INITIAL_HANDOVER`, `MERRYMEN_ACCOUNTING_HOLD_TENANTS`, and 25 one-shot
  variables left from earlier repairs (listed in step 1).

### Before you start

- Main must contain wave 1 (rollout scope, admission gate, adopt/release,
  budget seed, deploy guard, drain) and this branch (owner controls and
  attested-gap admission), each merged after review with CI green.
- Change one thing per step, and review each staged variable change before you
  deploy it. Never leave staged changes behind: deploy them or discard them
  before you use Rollback or Redeploy on any deployment.
- **Bots go silent from step 2, and some stay silent.** The listener stops
  when the orchestrator role starts (the sidecar that would keep it answering,
  B8, is not built). An admitted agent's own worker answers its bot again. A
  tenant that is never admitted — it does not pass the preview, its grant
  expired, or it is still waiting for a slot under the process cap — gets no
  replies at all until it is admitted or B8 ships. Today the listener answers
  about 9 bots; before step 4, check the step 2 preview for which of those do
  not pass, and decide with that list in hand. Steps 2 to 4 take three
  deploys; keep the gap between them short.
- **At most 48 worker and hold processes run at once** on one orchestrator
  (`MAX_LOCAL_CHILD_PROCESSES`; it protects the container's PID and thread
  limit and must not be raised to fit). A rollout naming more tenants than fit
  starts them in roster order and defers the rest, each pass logging
  `[alert] 0x…: worker deferred; local process cap 48 reached`, until a slot
  frees. With 74 unexpired grants this matters: admit live holders first, then
  paper tenants in batches (steps 5 and 6), and expect that not every tenant
  can run at once on this one service.

### Step 0: back up Postgres

Railway → the Postgres service → **Backups** → **Create backup**, named
`pre-resume-2026-10-05`. Wait until it is listed. If the orchestrator volume
has a backup schedule, take a manual volume backup too.

Rollback: nothing to undo.

### Step 1: set the orchestrator's variables (do not deploy yet)

Railway → orchestrator service → **Variables**. In one staged change:

| Variable | Value | Where the value comes from |
| --- | --- | --- |
| `MERRYMEN_START` | `start:orchestrator` | fixed |
| `MERRYMEN_FLEET_SERVICE_ID` | the service's own ID | orchestrator service → **Settings** → Service ID (begins `227ff49a`) |
| `MERRYMEN_PERSISTENT_HOME_REQUIRED` | `1` | keep as it is |
| `MERRYMEN_HOME`, `MERRYMEN_HOME_VOLUME_ID` | unchanged | keep as they are |
| `MERRYMEN_INITIAL_HANDOVER` | unchanged | keep; it is the operation token step 4 and the rollback use |
| `MERRYMEN_FLEET_ROLLOUT` | `none` | fixed: nobody is admitted yet |
| `MERRYMEN_ADOPT_HOME_HALT_SHA256` | `6fde6ce70efd0bc3e0c60538ccf57431cf76c354a617bd6c5a1f8198d4342cfa` | see below |
| `MERRYMEN_RESUME_PREVIEW` | `all` | fixed (or a comma list of tenant addresses) |
| `MERRYMEN_FLEET_RECOVERY_REPORT_ONLY` | **delete** | report-only mode starts nothing, and a tenant list beside it refuses boot |
| `MERRYMEN_FLEET_RECOVERY_REPLIES` | keep | only the listener reads it; the rollback needs it |
| `MERRYMEN_ACCOUNTING_HOLD_TENANTS` | keep | tenants named there stay held; the preview says so for each |
| `DATABASE_URL`, `MERRYMEN_STORE_DEK` | keep | |
| `MERRYMEN_RPC_MAINNET` | keep if set | the chain read at admission uses it, or the chain's public endpoint (`https://rpc.mainnet.chain.robinhood.com`) when it is unset, as every other orchestrator read does. Check in **Variables** whether it is set; a private RPC is kinder to a long read |

**Delete every one-shot variable.** The deploy guard refuses the orchestrator
while any is set and the rollout is not `all`. As of the 10-04 audit these are
set: `MERRYMEN_ACCOUNTING_DIAGNOSE`, `MERRYMEN_ACCOUNTING_RECONSTRUCT`,
`MERRYMEN_ANNOUNCE_CONFIRM`, `MERRYMEN_ANNOUNCE_ID`, `MERRYMEN_BRAIN_DATASET`,
`MERRYMEN_COHORT_VET`, `MERRYMEN_ENABLE_CLASS_FOR`,
`MERRYMEN_ENABLE_CLASS_PRESET`, `MERRYMEN_GAS_AUDIT`,
`MERRYMEN_HALT_CLASS_ENTRIES_FOR`, `MERRYMEN_IDENTITY_AUDIT`,
`MERRYMEN_INSPECT_TENANT`, `MERRYMEN_RECONCILE_SHADOW`, `MERRYMEN_REPAIR`,
`MERRYMEN_REPAIR_ACCOUNT`, `MERRYMEN_REPAIR_CLASS_CASH_ROW`,
`MERRYMEN_REPAIR_CLASS_CASH_ROW_ONLY`, `MERRYMEN_REPAIR_CLASS_PNL`,
`MERRYMEN_REPAIR_CLASS_PNL_ONLY`, `MERRYMEN_REPAIR_HWM`,
`MERRYMEN_REPAIR_HWM_ONLY`, `MERRYMEN_REPAIR_HWM_PHANTOM_PROFIT`,
`MERRYMEN_REPAIR_RUN_ID`, `MERRYMEN_RESUME_CLASS_ENTRIES_FOR`,
`MERRYMEN_TG_RECOVERY_ID`. Delete them, do not blank them: a blank variable
still counts. Anything else the guard counts is printed by name (never value)
in its `census one-shot:` line in step 2. Before deleting, copy any value you
want to keep somewhere private.

**The halt hash cannot be read from the dashboard.** There is no shell on the
container, and nothing in the running listener prints it. The value above is
the one Codex's verifier read from the volume on 2026-10-04 at 23:56 UTC
(`casual-reply-rollout-live-a7303f47-second.json`). If the halt has changed
since, adoption refuses before it writes anything, the orchestrator does not
start, and step 2's rollback applies; then the hash must be read by someone
with shell access to the volume (`sha256sum "$MERRYMEN_HOME/FLEET_HALT"`).
Never guess it.

Service settings, same visit: **Settings → Deploy → Draining seconds** `75`
(the drain finishes its copies and stops the children inside it); turn
**automatic deploys off**. A pre-deploy command
(`node --import tsx worker/src/deploy-guard.ts --phase=predeploy`) is
optional; with it set, every orchestrator deploy must come from `main`, and the
rollback to `4b4220e3` (from a `codex/*` branch) needs it cleared first.

Do **not** set `MERRYMEN_RELEASE_HOME_HALT` or `MERRYMEN_RESUME_APPROVE` yet.

Rollback: discard the staged change.

### Step 2: point the source at main and deploy

**Settings → Source → Branch** `main`, then deploy the latest `main` commit.

Read the deploy log, in order:

- `[start] role=start:orchestrator commit=<the main commit>`
- `[deploy-guard] … census one-shot: none`
- `persistent home adopted under its original halt; handover held`
- `fleet rollout: none — no tenant is admitted; …`
- the preview: first its summary —
  `[resume-preview] run <64 hex>: N of M tenant(s) pass every Postgres precondition`,
  `… approve every passing tenant of this run with MERRYMEN_RESUME_APPROVE=run:<64 hex>`,
  `… rollout for them at the plan's starting levels: 0x…:trade,0x…:exits-only,…`
  and, when more pass than fit, `… admit them in batches of at most 40 …` —
  then one `[resume-preview] {…}` line per tenant, then the same summary again.
- no `spawn requested` line anywhere.

**If the log store dropped the summary** (it has dropped the tail of a long
boot burst before), the run is also recorded in Postgres: Railway → Postgres
→ **Data** → table `ledger_resume_preview_runs`, the row with the newest
`created_at_ms`; its `run` column is the run digest, and `entries_json` holds
every line.

What this halted boot does write: the preview's run row, and the tables and
columns it creates on first use (the resume tables, the control receipts and
`tenant_telegram.paused_at`: empty, additive DDL that the orchestrator would
create on its first pass anyway). And, as every
orchestrator boot does even under `FLEET_HALT`, it carries out any owner
`/kill` request already waiting in a home (`honourPendingKills`), which
removes that owner's grant and tells them; that is the owner's own request.
No trade, lease, child or financial row.

Rollback (any time before step 4): **Deployments** → `4b4220e3` → **Rollback**.
Railway's Rollback restores that deployment's image *and its variables*, so
the listener comes back exactly as it was (`start:recovery-replies`, report-only
and replies set, the one-shots back). Clear the pre-deploy command first if
you set one. The listener accepts the adopted manifest and its canonical halt:
adoption keeps the original halt's bytes in `.fleet-halt-preadoption.json`.
To go forward again later, repeat step 1 in full (Rollback put back every
variable you changed there).

### Step 3: read the preview

Each `[resume-preview]` line is one tenant:

| Field | Meaning |
| --- | --- |
| `pass` | every precondition Postgres can answer holds (see [the preconditions](#the-preconditions)) |
| `refusals` | each reason it does not, one sentence each |
| `digest` | the evidence digest: what `0x<tenant>:<digest>` approves |
| `chain` | `required`: the account could arm live (a live operation, any flow, or the owner's settings ask for live), so admission reads the chain first; `not-required`: a paper book that could not |
| `suggestedLevel` | decision 6 of the plan: paper → `trade` once the canary has traded; live → `exits-only` |
| `holdsPositions` | Postgres shows open positions or class positions; a live holder must start `exits-only` so its stops run and nothing new opens |
| `startsPaused` | a pause is on record that the worker will start under (the home's own file, a journalled `/pause` or `/kill`, a restored pre-incident pause, or a durable pause); the owner's `/resume` lifts it |
| `grantExpiresAt` | when the owner's grant expires (unix seconds); an expired one refuses |
| `book` | the home's book as the ordinary path would meet it: `absent`, `blocked` (behind a source barrier — the usual pre-incident case), or `present` |
| `anchor`, `riskPeriod` | the accounting anchor the worker will get (`established:epoch-N` or `no-prior-accounting`), and the risk period it carries (`valid:<id>`, or `none`: the lifetime-peak drawdown breaker every agent ran on before the incident) |
| `home` | whether the volume has a home for it (it is archived at admission) |

Pick the canary: a `pass:true`, `chain:"not-required"` paper tenant (the plan
names `0x3289ed018dd5ae59b42aba8ec4d49f489645abcb`). Note the run digest. Make
three lists from the lines: the live tenants (`chain:"required"`), the paper
tenants (`chain:"not-required"`), and the tenants that do not pass.

A tenant that does not pass stays held whatever else you do; its refusals say
why. `submitted/sent/pending trade(s)` waits for #258's receipt proof (Codex);
`duplicate or conflicting` flows wait for the reviewed repair; an expired grant
waits for its owner to re-sign (then [steady state](#steady-state-re-signers-and-late-tenants));
`already admitted` means its book is registered and the ordinary path runs it:
it needs no approval, only a rollout entry.

### Step 4: the canary, at observe, then trade

One staged change:

| Variable | Value |
| --- | --- |
| `MERRYMEN_RESUME_APPROVE` | `run:<run digest from step 2>` (approves every passing tenant of that run; an approval alone admits nobody) — or `0x<canary>:<its digest>` for the canary only |
| `MERRYMEN_RELEASE_HOME_HALT` | exactly the value of `MERRYMEN_INITIAL_HANDOVER` |
| `MERRYMEN_FLEET_ROLLOUT` | `0x<canary>:observe` |

Deploy, then read the log:

- `resume approval: 0x… approved for evidence …`
- `persistent home halt released — …`
- `fleet rollout: 1 named tenant(s) — trade 0 · exits-only 0 · observe 1; …`
- `0x<canary>: resume admission — home archived to archive/0x…/<generation> (keys scrubbed); carried …`
  (or `no home on the volume: nothing to archive`)
- `0x<canary>: resume admission — new book registered as generation <generation> …`
- `0x<canary>: attested book seeded — N live cost basis row(s) and M floor(s) proved in the book before its first worker`
- `0x<canary> spawn requested …`, then `0x<canary>: resume admission applied — its first worker has started`
- in the canary's own lines: refusals are `rollout-hold` only; no `CURSOR REWOUND`, no `STALLED`.

When it looks right, set `MERRYMEN_FLEET_ROLLOUT=0x<canary>:trade` and deploy.
Watch it trade: proposals arrive, each fill is recorded once, nothing is
refused for reasons other than its own limits.

Rollback, in order of reach:

- Stop trading at once: `MERRYMEN_FLEET_ROLLOUT=none`, deploy (the drain stops
  the child cleanly).
- Back to listener-only: `MERRYMEN_REHALT_HOME=<the operation token>`, deploy
  once with `start:orchestrator` (log: `re-halted … at generation 1`), then
  **Rollback** to `4b4220e3` as in step 2. **Admitted tenants' bots stay
  silent under the listener:** it answers only tenants whose recovery status is
  held, and admission recorded the canary's as verified. Every tenant not yet
  admitted is answered as before. Releasing again later takes
  `MERRYMEN_RELEASE_HOME_HALT=<token>@1` (the re-halt's log line gives the
  number), after step 1 is repeated.
- Nothing is lost either way: the old home is in `archive/<tenant>/<generation>`
  on the volume, and the lost book's cursors and snapshot rows are in
  `mirror_state_archive` and `ledger_snapshot_archive`.

### Step 5: live tenants, exits-only, before the paper batches

Live tenants may hold real positions whose stops only a running worker
manages, so they take their process slots first. Add the preview's
`:exits-only` entries (the `chain:"required"` tenants, about 11) to
`MERRYMEN_FLEET_ROLLOUT` beside the canary, and deploy. If step 4 approved the
canary only, also set `MERRYMEN_RESUME_APPROVE=run:<step 2 run digest>` (it
leaves the canary's approval as it is).

Each is first read on chain, from the oldest financial cursor of its last
mirror pass (at least 26 hours back) to now: the log says
`resume admission — reading the chain for 0x… since …`, and the tenant waits,
held, until `resume chain check clean — …`. An RPC failure is retried a
minute later.

At `exits-only` a live agent can sell and stop out of what it holds and opens
nothing.

**If the chain shows something Postgres lacks** (`resume approval REFUSED — the
chain holds operations or USDG transfers for the account that Postgres
lacks`), most likely an owner's deposit or withdrawal during the hold, that
tenant stays held. **No code path in this tree books that movement**, and this
runbook does not invent one. Do this:

1. List the refused tenants: those `[alert]` lines, or Railway → Postgres →
   **Data** → `ledger_resume_approvals`, rows with `state` `refused` and that
   reason.
2. Tell each owner (with Milla's wording) that their agent is not managing
   their positions yet and that they can manage them from their own wallet
   meanwhile.
3. Escalate the list to Milla and Codex for a reviewed booking of the missing
   movement. Once it is booked, preview that tenant again and approve it
   per tenant.

### Step 6: paper tenants, in batches

Add paper tenants (the preview's `:trade` entries) to `MERRYMEN_FLEET_ROLLOUT`,
each at `:trade`, keeping every entry already there, and deploy. Keep the total
of named tenants at or under **40** (48 processes, less room for restarts and
holds); add the next batch once the last one is running. If step 4 approved the
canary only, set `MERRYMEN_RESUME_APPROVE=run:<step 2 run digest>` now.

Each is archived, registered, seeded and spawned in turn, a few seconds
apart. A tenant whose books changed since the preview is refused (`evidence
changed since the preview`): leave `MERRYMEN_RESUME_PREVIEW` set (as `all`, or
just those tenants), deploy, and approve the new run's digest. Either form
works: an already-admitted tenant never passes a preview, so `run:<new digest>`
approves only tenants still waiting; `0x<tenant>:<digest>` per tenant is the
more exact. The old approvals are not reopened.

A tenant past the cap logs `worker deferred; local process cap 48 reached`
and waits; its approval stays `registered` and it starts as soon as a slot
frees. To swap which tenants run, remove some from the rollout and deploy.

Rollback: remove entries from `MERRYMEN_FLEET_ROLLOUT` and deploy.

### Step 7: live tenants to trade

Once a live agent's book looks right at `exits-only` (its positions, cost
basis and floors are on the dashboard, and its stops behave), change its entry
to `:trade` and deploy. One at a time, or a few, never the whole list blind.

### Step 8: the whole fleet

`MERRYMEN_FLEET_ROLLOUT=all` admits **every** tenant at `trade` — including a
live tenant whose admission had not finished (for example a chain read still
retrying), which would then skip `exits-only`, and up to 48 processes in roster
order. So, first:

1. Railway → Postgres → **Data** → `ledger_resume_approvals`: no row may be in
   state `approved`, `archiving` or `archived`. For each that is, either wait
   for it to reach `applied`, or withdraw it with
   `MERRYMEN_RESUME_REVOKE=0x<tenant>:<its evidence_digest>` (or
   `run:<its preview_run>` for a whole run), deploy, and admit it later from an
   explicit list.
2. Count the tenants that will run: more than 48 and some wait for a slot,
   indefinitely, in roster order.

Then set `MERRYMEN_FLEET_ROLLOUT=all` and deploy. Every tenant with a
registered book trades; a tenant that was never approved is still refused by
the continuity gate, and stays held, as it is today. Then remove
`MERRYMEN_RESUME_PREVIEW`, `MERRYMEN_RESUME_APPROVE` and
`MERRYMEN_RESUME_REVOKE` (left set they change nothing, and the preview costs a
boot a few seconds). Keep `MERRYMEN_ADOPT_HOME_HALT_SHA256` and the operation
token: re-halt needs both.

### Steady state: re-signers and late tenants

An owner whose grant had expired re-signs; a tenant whose refusal was fixed
is ready; a new owner signs up with history under an old account. Each is
refused by the continuity gate until admitted:

1. `MERRYMEN_RESUME_PREVIEW=0x<tenant>,0x<tenant>…`, deploy, read their lines.
2. `MERRYMEN_RESUME_APPROVE=0x<tenant>:<digest>` per tenant, deploy.
3. Under `all`, an approved tenant is admitted at `trade` on that deploy. For
   a live tenant that holds positions, prefer to admit it while the rollout is
   an explicit list with it at `:exits-only`, or approve it only when you can
   watch its first ticks.

A tenant with no history at all (a brand-new account) needs none of this: the
ordinary empty-book path admits it.

### What cannot be honoured

A `/pause` sent to the recovery listener between 2026-10-04 21:49 UTC and the
deploy of #259's journal was answered and recorded nowhere: no journal existed
yet, and no worker was running to write the pause file or its event. Nothing
in the database says it happened, so nothing can honour it, and this code does
not guess. Pauses recorded before the incident (the `Telegram: paused by chat`
events) are restored; see below. We propose a resume notice to owners instead,
with Milla's approved wording and a confirm step, saying that trading resumed
and that `/pause` works again.

### Rollback summary

| From | To stop trading | To return to listener-only |
| --- | --- | --- |
| step 2–3 (halted, nobody admitted) | nothing trades | **Rollback** to `4b4220e3` (restores its variables); repeat step 1 before going forward again |
| step 4 onwards | `MERRYMEN_FLEET_ROLLOUT=none`, deploy | `MERRYMEN_REHALT_HOME=<token>`, deploy; then **Rollback** to `4b4220e3`. Admitted tenants' bots stay silent under the listener; the rest are answered |
| one tenant misbehaving | remove it from `MERRYMEN_FLEET_ROLLOUT`, deploy; its owner's `/pause` also works | — |

Railway has two actions on an old deployment. **Rollback** restores that
deployment's Docker image and its custom variables (Railway docs, "Deployment
Actions"); it is the one this page means. Redeploy reuses its code and build
settings with the variables as they stand now, which here would boot the
listener's code with the orchestrator's variables. Deploy or discard any
staged variable change before using either. Rollback is offered only within
the plan's image retention window; if it is missing on `4b4220e3`, point
**Source → Branch** back at `codex/recovery-casual-replies`, deploy `a7303f47`,
and put back the variables you recorded before step 1 by hand. The service's
source branch is not part of a Rollback: it stays `main`, which is harmless
with automatic deploys off.

## Owner stop requests, applied before any worker arms

`worker/src/recovery-reply-arm.ts`, called by `spawnChild` under the tenant's
lease, after the persistent-home proof, the expiry check and any attested-gap
archive, and before `grant.json` is written. It reads three sources:

- **#259's journal** (`recovery_reply_controls`), through one adapter
  (`readRecoveryControls`). #259 is not merged and the table does not exist in
  production: a missing table (Postgres `42P01`) is no controls. When #259
  lands, its rows are folded with no change here. The fold spans every bot,
  token, claim, account and chain the tenant's journal holds: a token rotation
  or a re-sign on a new account keeps a pause. A `/kill` counts once confirmed
  in its window; `/cancel` lifts nothing else; an unanswered `/kill` holds the
  tenant until its window closes. A malformed journal holds the tenant with an
  `[alert]`.
- **The events table**, for pauses a worker recorded before the incident: the
  newest `Telegram: paused by chat` / `resumed by chat` event across every
  account the owner has had, restored only if the agent did nothing past the
  pause gate afterwards (the dashboard's own rule, `inactivity.ts`), and only
  into a home never armed here — a rebuilt home, or the fresh one an archive
  leaves. In a home a worker has run in, its own `paused` file is the truth.
- **Kill-request files already in the home**: honoured every pass, as before.

Each control applied writes a receipt (`recovery_reply_control_receipts`,
keyed by the request's bot and update id), an events row ending
`(recorded during upgrade)`, and, for a pause, `tenant_telegram.paused_at`, in
one transaction with the `paused` file written before the commit. So each
applies exactly once: an owner's later `/resume` is not undone by a respawn,
and a home rebuilt underneath the pause gets it back.

A confirmed `/kill` is handed to the existing `honourKill`: a kill request is
left in the home and carried out at once, so the stored grant is removed if it
was stored at or before the confirmed kill. A grant the owner signed after the
kill is kept and paused instead (decision 7), and the owner sees the reason in
the events. The receipt is written only after `honourKill` returns; until then
the pending request blocks the spawn. Nothing here unpauses, and a killed
grant's key is never written into a home.

## Attested-gap admission

`worker/src/ledger-resume.ts` (the phases), `ledger-import.ts`
`registerAttestedGapSource` (the one transaction), and `spawnChild`.

### Preview, approve, revoke

| Variable | Grammar | Effect |
| --- | --- | --- |
| `MERRYMEN_RESUME_PREVIEW` | `all`, or `0x…,0x…` | at boot, halted or not: one line per tenant and a run digest; writes only its run row (`ledger_resume_preview_runs`) |
| `MERRYMEN_RESUME_APPROVE` | `0x<tenant>:<digest>` and/or `run:<run digest>`, comma separated | records approvals. A per-tenant digest must be one a recorded run showed passing; a run approves exactly the tenants that passed in it, less any admitted since that run was taken |
| `MERRYMEN_RESUME_REVOKE` | `0x<tenant>:<digest>` and/or `run:<run digest>`, comma separated | withdraws approvals not yet archiving or registered: that tenant's approval of that evidence, or every approval recorded from that run |

A malformed value refuses boot. Each approval is unique per tenant and
evidence digest, so a variable left set approves nothing twice and never
reopens one that was applied, refused or revoked; a tenant has at most one
open approval. A revoke names the evidence it withdraws, never a bare tenant,
so left set across a restart it never withdraws the re-approval that replaced
it. None of these is a one-shot: they are the rollout's own controls, read
every boot.

The evidence digest covers the tenant, account, chain and owner; a Postgres
summary of the books (counts, maxima, statuses, the snapshot tables' rows, the
agent's ratchets); the lost book's cursors; the home's identity (inode, the
main book's inode and size, and which barrier and control files exist — never
the device number, which a volume reattached on another host changes, nor
`-wal`, `-shm` or any mtime); the anchor kind, the risk period, the controls
fold, the unresolved count and whether the chain must be read. It never
covers the grant's incarnation, so an owner who re-signs on the same account
keeps the approval; a new account is refused.

### The phases

In `spawnChild`, under the lease, for a tenant in the rollout scope with an
open approval:

1. **Drain** a continuous old book's tail through the existing guarded mirror
   (at most 100 passes), if there is one — first, so the comparison and the
   chain read below see it in Postgres.
2. **Re-derive the evidence.** Any change refuses the approval; the tenant
   stays held and is previewed again.
3. **Check every precondition**, and read the chain where the account could
   arm live (in the background; the tenant waits held).
4. **Archive the home**: copy the owner's pause, arm record, kill-request
   files and Telegram state into a staging directory; remove `grant.json`,
   `grants/` and `settings.json` (rewritten from their stores at the next
   spawn, so no key enters the archive); rename the home to
   `archive/<tenant>/<generation>` (0700); then remove the moved Telegram
   files from the archive, write a 0600 manifest of file stats, and move the
   carry into a fresh home. Every step survives a crash or a lost lease.
5. **Read the chain again, immediately before registering**, where it was
   read in step 3: from the head that read reached to the head now, awaited
   (at most 45 seconds). Anything Postgres lacks refuses; an unanswered read
   holds. The clean read of step 3 is spent by this attempt, so a
   registration that fails, or a re-read that cannot finish, reads the whole
   window again before the next attempt.
6. **Register**, in one transaction: archive and delete the tenant's
   `mirror_state` rows; archive the positions, cost basis, floors and class
   rows; create the empty book with this generation as its identity (an
   interrupted creation is finished, never refused); bind its consumed receipt
   to `hash('attested-gap:' + approval + ':' + evidence)`; write the
   attestation, with the chain window read for it (`chain_from_block` to
   `chain_head`, the head step 5 reached; null where no chain read was
   needed); move the approval to `registered`. No financial row is written
   or changed.
7. **The ordinary path, unchanged**: the original-book gates accept the
   attested book, the anchor carries the same accounting epoch (lifetime PnL
   continues from Postgres), the seeds restore basis, floors, energy and the
   trailing day, the owner's controls are applied, then the privacy gate, the
   offset handoff and the source barrier.
8. **The seed, proved**: before the first worker, every live cost basis row
   the seed restores (a held symbol) and the floor beside it must be in the
   book. One the ordinary seed missed is written then; if that cannot be done
   the spawn is held and asked again. `attested-seed.json` records it. Then
   the worker starts at its rollout level and the approval becomes `applied`.
   `recovery-generation.json` in the home says when the gap began, for the
   Telegram and Fomo answers.

Why step 8 is not best-effort: registration removes the lost book's cursors,
and with them the mirror's rebuilt-book guard, so the first mirror pass
replaces the tenant's basis, floors and class rows in Postgres with what the
new book holds. With the seed proved, that is the seeded set; their pre-images
are in `ledger_snapshot_archive` either way. Class positions are re-derived
from the vault's own events when the worker arms; positions from the chain on
its first tick.

### The preconditions

Each refuses on its own; none fails open.

1. No `submitted`, `sent` or `pending` trade (#258's receipt helper is not in
   this tree, so any such row refuses).
2. Nothing on chain Postgres lacks, from the oldest financial cursor of the
   last mirror (trades, flows, equity; at least 26 hours back) to head: every
   EntryPoint `UserOperationEvent` the account sent and every USDG `Transfer`
   to or from it; and again, immediately before registration, from that
   read's head to the head then (phase step 5). An RPC failure retries. Only
   a paper tenant that could not arm live — no live operation, no flow, no
   live intent in its settings — skips the read.
3. Nothing settled in the last 26 hours.
4. The flows hold no duplicate or conflicting copies (`distinct-flows.ts`).
5. One `agent_id` spelling across the financial tables.
6. An established accounting anchor, or no prior accounting with no financial
   rows at all.
7. The risk period, if Postgres holds one, valid and carried under the
   grant's own spelling. None is the lifetime-peak breaker; the preview says
   which, and the approval binds it. (Decision 9 recommended holding tenants
   with no risk period; that would hold every paper tenant, since a period
   can only be started on live evidenced accounting. Milla to confirm.)
8. The owner controls readable and well formed.
9. The grant unexpired, and its tenant, account, chain and owner the ones
   approved.
10. Not already admitted: its book on the volume is not the attested
    generation registered for this account.

### Approval states

`approved` → `archiving` → `archived` → `registered` → `applied`; `refused`
(the evidence changed, a precondition failed, or a registered book's grant
moved to another account before its first worker: preview again) and
`revoked` are terminal. Every row stays: `ledger_resume_approvals`,
`ledger_resume_attestations`, `mirror_state_archive`,
`ledger_snapshot_archive`, and the archived homes on the volume.

## The volume steps: adopt, release, re-halt

These are the three reviewed steps that let the orchestrator run on
that volume without a shell on the container: **adopt** it under the halt it
already has, **release** that halt into a rollout scope, and **re-halt** it for
a rollback to listener-only mode. All three live in
`worker/src/persistent-home.ts` and run at orchestrator startup, after the
report-only branch and before `preparePersistentHomeForHandover` re-proves the
home, so before any lease, child, holder or writer.

This is an application change requiring Milla's review under `AGENTS.md`. The
release changes an existing policy: `markPersistentHomeHandoverComplete` was
never called at startup, and its contract asks the caller to verify source,
books, identities and memory first. Decision 5 of the resume plan proposes a
narrow exception, and it needs Milla's explicit sign-off before merge: an
adopted volume only, with the operation token, the pinned original-halt hash,
the standing halt generation and a rollout scope other than `none`, and with
`registerLedgerSource` refusing, per tenant at spawn, any tenant with history
that has no registered attested-gap admission (above). Nothing else calls it
at startup.

### What every step requires

- The persistent-home opt-in, unchanged: `MERRYMEN_PERSISTENT_HOME_REQUIRED=1`,
  `MERRYMEN_HOME` equal to `RAILWAY_VOLUME_MOUNT_PATH`, the pinned provider
  `MERRYMEN_HOME_VOLUME_ID`, the proven writable durable mount and the 0700
  owned root. A step asked for without the opt-in refuses.
- `MERRYMEN_ADOPT_HOME_HALT_SHA256`: the SHA-256 of the original hand-made
  halt's exact bytes, recorded privately before deployment (runbook R0.1).
  Release and re-halt need it too, and need the pre-adoption record to match
  it, so neither applies to a volume this code initialized fresh.
- Its own explicit variable. With none of them set, startup is unchanged.
  Remove a variable rather than blanking it: an empty value is malformed and
  refuses startup, as an empty `MERRYMEN_INITIAL_HANDOVER` already does.

Each step opens no book, grant, lease or ledger, and none of them removes a
halt it cannot prove it created.

### Adopt: `MERRYMEN_ADOPT_HOME_HALT_SHA256`

Also requires `MERRYMEN_INITIAL_HANDOVER` (the operation token). Adoption
refuses, before writing anything, when:

- the halt's hash does not equal the pin, or the halt is larger than 4 KiB;
- the halt is not a private (0600), owned, single-link plain file on the volume;
- the halt is absent;
- the root is empty, or holds nothing but a halt (an empty volume uses the
  ordinary explicit initialization instead);
- a manifest already exists that this adoption did not create.

Otherwise, in order, each step synced to disk before the next:

1. Write `.fleet-halt-preadoption.json` (0600): the original halt's SHA-256,
   inode, size and exact bytes (base64), bound to the volume, root and
   operation token. The original halt's content is never lost.
2. Write this volume's canonical halt beside it under a private name, then
   rename it over `FLEET_HALT` in one step. `FLEET_HALT` is never absent.
3. Write the manifest, `held`, naming that canonical halt as its own.

The record and the manifest are written whole under a private `<name>.tmp`,
then linked into place without replacing anything, so neither ever appears
torn under its real name. The next start drops any `.tmp` a crash left behind
before reading the real name.

From then on the existing verification and release paths treat the volume
like one initialized by this code. A restart with the variable still set
changes nothing, and logs `persistent home previously adopted` rather than
another adoption. A crash at any point converges on the next start with the
same variables: a record whose original is still in place continues to the
rename, and a record whose `FLEET_HALT` already is the canonical text on a new
inode continues to the manifest. A halt replaced by hand while adoption runs
is never renamed over, and the next start refuses. Until the manifest exists,
ordinary startup keeps refusing the root and the reply listener keeps standing
behind whichever halt is present.

Verify: the start logs `persistent home adopted under its original halt;
handover held`; the manifest says `held`; `.fleet-halt-preadoption.json` holds
the recorded hash and the original inode; no children start.

### Release: `MERRYMEN_RELEASE_HOME_HALT=<operation token>[@<generation>]`

Releases only a `held` adopted manifest whose operation token matches and
whose standing halt is the generation named, and only while
`MERRYMEN_FLEET_ROLLOUT` admits someone. The release itself is
`markPersistentHomeHandoverComplete`: the completed manifest is durable before
the unchanged canonical halt is removed.

- **The generation.** The adoption's own halt is generation 0, spelled with the
  bare token. Each re-halt puts back generation 1, 2, …, spelled
  `<operation token>@1`, `@2` and so on. A value naming any other generation
  (in particular the one a re-halt has since consumed) is withheld: the halt
  stays, nothing is written, and startup logs an `[alert]` naming the standing
  generation, never the token. `@0`, `@01` or a stray `@` refuse startup.
- **The scope** is read with B1's own parser (`fleetRollout`), the same one
  that refuses boot. A malformed or mis-cased value (`None`, `off`, `0`,
  `none,`, a bare address) refuses before the volume is touched, and so does
  an unset one, since a required persistent home is the Railway fleet. With
  `none`, the halt stays and startup logs an `[alert]`.

**This branch is stacked on `MERRYMEN_FLEET_ROLLOUT` scoping (work package
B1)** and cannot merge without it: the release imports B1's parser, and B1
limits which tenants a released fleet spawns. Without B1, a released halt
would run every tenant on the roster that `registerLedgerSource` admits.

Once the manifest is `complete`, the release variable removes nothing, ever.
A `FLEET_HALT` created by hand after a release still stands every child down
and releases their leases, and this variable never lifts it, whatever its
content, mode or inode. That includes a release that crashed after its
completed manifest and before removing its own halt: the env release does not
finish it (a canonical copy on a reused inode would look the same), so the
fleet stays halted and startup logs an `[alert]`; re-halt, then release the
next generation. To stop at once after a release, either set
`MERRYMEN_FLEET_ROLLOUT=none` and redeploy, or create `FLEET_HALT` by hand.

### Re-halt: `MERRYMEN_REHALT_HOME=<operation token>`

Returns a released adopted volume to `held`, so the deployment can go back to
listener-only mode without a shell:

1. Write the canonical halt under a private name.
2. Replace `.fleet-halt-rehalt.json` (0600) with a receipt naming that file's
   inode, before it is published.
3. Link it to `FLEET_HALT` without replacing anything (exclusive create at
   the real name), then drop the private name.
4. Replace the manifest with one in state `held` naming the new halt, at the
   next halt generation. The manifest changes only here, so a re-halt resumed
   after a crash lands on the same generation.

If `FLEET_HALT` is the released manifest's own halt (a release that stopped
before removing it), the manifest is held on that file as it stands, at the
next generation, and nothing is written in its place. If `FLEET_HALT` is
anything else not provably this re-halt's own (by its private name's inode, or
by the receipt and the canonical text), it was made by hand: it stays, the
manifest stays `complete`, and startup logs an `[alert]`. The fleet is halted
either way. Every crash point converges on the next start with the variable
still set.

The re-halt consumes the release before it. When both variables are set, the
re-halt wins and the release variable is not read at all, whatever it says, so
a rollback never fails because it was left behind. Once the re-halt variable
is removed, that old release value names a consumed generation and lifts
nothing; releasing again takes the new value the re-halt's log line gives,
`MERRYMEN_RELEASE_HOME_HALT=<operation token>@<n>`.

Rollback to listener-only: set `MERRYMEN_REHALT_HOME`, deploy the orchestrator
role once and confirm the manifest is `held` (the log says `re-halted … at
generation <n>` or `already held at halt generation <n>`), then switch to
`start:recovery-replies` with `MERRYMEN_FLEET_RECOVERY_REPORT_ONLY=1` and
`MERRYMEN_FLEET_RECOVERY_REPLIES=1`. The report-only and listener entries
never run these steps.

### The reply listener

The current recovery-reply proof (`worker/src/recovery-reply-proof.ts`)
accepts the adopted `held` manifest with its canonical halt, and the
re-halted manifest; this is tested against the proof unchanged. It refuses a
released volume, because it requires a present `FLEET_HALT`. Running the
listener beside a released fleet is the sidecar work package (B8).

### Files on the volume root

| File | Written by | Purpose |
| --- | --- | --- |
| `FLEET_HALT` | operator, adoption, re-halt | Present: stop every child and spawn none |
| `.merrymen-persistent-home.json` | adoption, release, re-halt | Manifest: volume identity, `held` or `complete`, and the halt generation after a re-halt |
| `.fleet-halt-preadoption.json` | adoption | The original halt's hash, inode and exact bytes |
| `.fleet-halt-rehalt.json` | re-halt | Which canonical halt the latest re-halt created |

Keep all of them. None holds a signing key or a grant. A `*.tmp` beside them
is a private name a crash left mid-step; the next start with the same
variables removes or replaces it.
