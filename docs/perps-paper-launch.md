# Paper Perps pilot launch evidence

The pilot is hosted web first, with a dedicated Perps wallet and simulated
trading only. This checklist is an operator release record: code and local
tests do not establish that a hosted deployment, phone release, Privy tenant
or backup system is ready. No production enablement is recorded here.
Funding, live execution and the Brain driver remain outside the paper launch.

## Admission and capacity policy

- Set `MERRYMEN_PERPS=paper` only for the reviewed release. An unset value,
  `off`, or `live` offers no paper creation or live capability.
- Admission lives in the shared PostgreSQL pilot store, capped at **100 active
  owners**. `/perps/join` accepts an invitation, then uses the normal protected
  sign-in to capture the verified login owner in a **pending approval request**.
  The user does not need to locate or paste their wallet address. A valid
  invitation submits the request; it does not grant whitelist membership.
  Until an administrator approves the captured owner, creation, renewal and
  entry enablement remain unavailable. Approval neither signs a grant nor
  enables entries; those remain explicit owner operations.
- `/admin/perps` lets configured administrators create/revoke invitations and
  review the pending queue, approve or reject requests, and allow/revoke
  individual login owners. `MERRYMEN_PERPS_PILOT_ADMINS` is an
  explicit comma-separated list of up to 20 nonzero owner addresses. Configure
  it consistently on the web replicas. Empty or malformed configuration grants
  nobody administrative access; membership and invitation codes never confer
  the role. The signed-in page shows the public owner address for operator
  setup; use that login address, not the separate Perps account address.
- Invitations are random 256-bit codes, stored only as hashes and shown once
  at creation. Defaults are one use and seven days; maxima are 100 uses and
  30 days. Submission is transactional and rate-limited per authenticated
  owner across replicas. The separate review queue holds at most **1,000
  pending owners**; pending requests do not consume active whitelist places.
  An invitation use is consumed when a request is recorded, with a durable
  receipt so a retry cannot consume it twice. Approval still checks the
  100-owner active limit. Rejection leaves an explicit revocation, which
  another code cannot bypass. A fresh administrator decision is required to
  approve that owner later.
- Approval clears the old entries switch and rotates its control nonce before
  access is restored; submitting a request changes neither grants nor entry
  settings. Admin decisions use the current list revision so a stale approval
  cannot undo a newer rejection or revocation. Revoking an invitation prevents
  new submissions; review existing requests and revoke approved wallets
  separately.
- `MERRYMEN_PERPS_PAPER_TENANTS` is now only a one-time bootstrap: the first
  store initialization imports its strict owner list under a shared lock.
  Missing/empty means an empty cohort; malformed or oversized input fails
  initialization. After initialization, changes to this variable are ignored,
  including on a new replica. Use the admin page for subsequent membership
  changes. A missing or unreadable database never falls back to this list.
- **Upgrade or stand down every old web/orchestrator replica before relying on
  admin approval or revocation.** Old env-only versions cannot observe database
  changes, and the earlier invite-redemption implementation could whitelist an
  owner without review. Keep the global paper flag off while replacing those
  writers; mixed-version operation does not provide the new approval boundary.
  Confirm common database configuration and the intended initial bootstrap
  before first use. Admission and admin pages can collect requests and approve
  the internal cohort before paper is enabled.
- Existing active admissions whose source is the earlier automatic invite
  flow are changed to **revoked** during store initialization, with a cohort
  revision change and audit evidence. They require a fresh explicit admin
  approval; their prior invite receipt is not approval. Admin-approved and
  bootstrap admissions are preserved. Authorization also permanently excludes
  invite-sourced admissions, including any written after initialization by an
  old process. This protects upgraded readers, not old writers or readers:
  do not roll back to a version that automatically admits invite holders.
- Admission is required for creation, renewal and explicit entry enablement.
  Final authority writes serialize against revocation, after authentication and
  RPC checks. Workers refresh shared admission every three seconds with a
  two-second read timeout and a maximum 15-second positive-proof lifetime.
  An independent timer invalidates expired/unavailable admission even while
  roster/settings reads hang; each worker observes the delivered restriction
  on its next settings tick. Admission revision changes invalidate enabled
  child settings, including a revoke/re-admit between polls. An existing paper
  worker continues its exits and protective rules;
  removal does not silently freeze a held book while exits appear queued.
  Existing owner reads, kill, recovery and exit controls remain available.
  If local storage cannot accept the mandatory entries-off configuration,
  stop the worker through the accounting drain and keep it held until the
  restriction can be delivered. In that storage-failure case, paper positions
  freeze; exits and stops cannot continue on stale enabled settings.
- The shared local process ceiling is **48 children**, with Spot priority.
  Perps and any login bot seat consume real slots; an owner with two wallets
  does not count as one child. Measure actual process/thread and memory
  headroom under the deployment's limits before increasing the cohort.
  A Perps slot yield is a stand-down and final accounting pass, not a second
  worker running the same book on another replica.
  The 100-owner admission ceiling does not raise this 48-child process cap.
- Use the existing single public feed. Capture reads its atomic file; it
  creates no extra Lighter connection or request budget.

## Persistent-home policy for this pilot

Keep the original persistent fleet volume and each `children-perps/<owner>`
home. **No volume replacement, handover, destructive redeploy, home deletion
or lost-home restart is allowed while a Perps book exists in this pilot.**
An ordinary restart must reuse the original home and the existing lease and
accounting fences. If the home is missing or ownership cannot be established,
keep that wallet held, retain the grant/recovery records and investigate.
Do not start a fresh empty book, treat the public read mirror as authoritative
recovery, or reset accounting to make the worker appear healthy.

The mirror and paper checkpoint are useful evidence, but the separate
lost-home/volume-handover restore drill remains a release blocker for removing
this restriction. Backups do not count as recovery proof until an isolated
restore shows the same account, epoch, positions, stops, fees, funding,
command outcomes and authority state without duplicate execution. A practice
reset is an explicit owner operation for a readable, current paper book;
it is not permission to bypass an accounting hold.

## Evidence to attach before enabling internal owners

Review the stack in order: [authority and security (#368)](https://github.com/millw14/merrymen/pull/368),
[private reads and recovery (#369)](https://github.com/millw14/merrymen/pull/369),
[paper desk (#370)](https://github.com/millw14/merrymen/pull/370),
[pilot controls and this release record (#371)](https://github.com/millw14/merrymen/pull/371), then
[invite signup and wallet administration (#372)](https://github.com/millw14/merrymen/pull/372).
Their current CI checks and validation notes are the code evidence; a successful
code check does not fill the deployment and owner-drill gates below.

Record the exact commit, build/deployment identifier, configuration review,
operator and UTC time with each result. Keep authentication tokens, private
keys, serialized grants and customer ledger rows out of the release note.

| Gate | Required evidence | Current evidence in this work |
|---|---|---|
| Reviewed release | Final tests, typechecks, build and review on the exact deployed commit; preserve any unresolved failures | The complete CI run for `1d10b403666ec3bea3354ba91b552110235f2e7c` passed. Additional native stop fixes require their own review and checks. No paper release is deployed |
| Dependency security | Review outstanding dependency advisories and their reachability; require compatible remediation or a documented mitigation decision | October 31 exact-lock audit still reports 16 high package findings from one transitive Zod advisory, zero critical. Direct Zod is patched; five nested Zod 3 installations remain flagged. The existing exception expires November 8; see the assessment below |
| Owner lifecycle | Real hosted Privy sign-in; separate account index 1; creation; renewal of an empty paper wall; stale login and closed-screen refusal; retained recovery after interrupted renewal | Real Privy sign-in and pending-request/admin-approval flow passed on the isolated local preview with paper off. Owner signing, account creation/renewal and deployed worker round trip remain outstanding |
| Paper desk | Current tenant/account report, unread/stale states, exact fills and candle gaps; Close, Close all and explicit reset show the correct worker result; a lost POST response is never automatically retried | Component and route tests; deployed end-to-end worker round trip outstanding |
| Kill and exits | Kill names and stops all supported wallets; entries remain off after delayed settings writes; removing pilot admission disables new entries while exits/stops remain usable | Regression tests in this change; hosted operator drill outstanding |
| Phone compatibility | Released iOS and Android builds carrying the current login-wide kill request; verify installed-client behavior against the intended backend | Additional iOS Perps-only stop visibility and Android lost-reply/session-fence fixes are under review. Unsigned builds and local tests are code evidence; signed distribution and installed-device stop evidence remain outstanding |
| Privy capacity | Confirm configured production app, enabled login and embedded signing, expected internal-owner count and current plan/rate capacity | Production app, email/X login and Free plan verified in the dashboard October 31. Organization usage was 155/500 MAUs and 758/50,000 signatures. The 100-owner admission ceiling fits that observed monthly headroom; request-rate capacity and real signing remain unmeasured |
| Fleet capacity | Under the 48-child cap, demonstrate Spot priority, Perps-only bot-seat behavior, shutdown/final mirror and headroom with the proposed cohort | Code/test evidence is separate from deployment resource measurements, which remain outstanding |
| Database backup | Current backup policy, recent successful backup, isolated restore and reconciliation evidence; preserve the original volume during pilot | New home and PostgreSQL snapshots are listed on October 31; DAILY schedules were added on the original volumes. PITR remains disabled. Provider snapshot inventory alone does not prove content or recovery; isolated logical restore evidence is recorded separately below |
| Persistent home | Verify mount identity, lease exclusivity and restart on the original home; document held-wallet response if the home is missing | Existing authority/hold tests and the restrictive pilot policy above; lost-home/handover proof outstanding |
| Public feed | Bounded recording from the deployed single public feed, exact timestamps, gap accounting and deterministic offline replay | Capture/replay synthetic tests passed. The existing production orchestrator still has no feed file or Perps homes on October 31, with paper off. No observed recording exists; no second publisher was started |
| Other surfaces | Owner-scoped Telegram, MCP and partner routes; no Perps public identity or Spot fallback; recovery remains reachable when paper is off | Tests must be included in final combined verification; deployed owner exercise outstanding |

### Launch preparation: 2026-10-31

These actions advance the release gates without enabling production paper
trading. The historical October 30 audit below is retained as a dated record.

- **Exact dependency verification:** the complete [CI run for the invite and
  approval head](https://github.com/millw14/merrymen/actions/runs/41198880031)
  passed at `1d10b403666ec3bea3354ba91b552110235f2e7c`. An independent
  clean `npm ci` installation matched all 836 installed locked package versions;
  55 absent optional/platform packages were accounted for. Focused authority,
  invitation, admin, UI, grant and settings checks passed 142/142 with no skips.
  The earlier local preview's `npm install --package-lock=false` had changed
  physical SDK versions despite leaving the lockfile unchanged. That preview
  was rebuilt with `npm ci`, then `npm install --no-save --ignore-scripts
  pg@8.23.1`, and all 836 locked versions were rechecked with zero mismatches.
  CI and the Docker install did not use that incorrect preview command.
- **Real sign-in and explicit approval:** at 16:47 UTC the isolated loopback
  preview on port 3217 had one real Privy identity, one one-use invitation,
  one explicitly admin-approved owner and zero grant rows. Before approval,
  the browser showed the pending request and the admin page showed zero
  admissions. After a separate review and confirmation, the browser showed
  approval with paper unavailable. Database audit actions independently
  confirmed request submission and admission approval, with zero
  invite-sourced admissions. Paper remained `off` throughout. The verified
  login owner was configured as an administrator only in the local preview;
  no production admin or membership was changed. No grant was signed.
- **Privy configuration and quota:** the existing production app matches the
  configured public app ID. Its allowed origins include the two existing
  production origins and the explicitly added `http://127.0.0.1:3217` preview
  origin. Email and X login are enabled. The application requests Ethereum
  embedded-wallet creation through its SDK configuration and handles restored
  sessions without an embedded wallet; the dashboard-wide automatic creation
  toggle remains off. At about 16:50 UTC the organization dashboard showed
  155 monthly active users of 500 and 758 signatures of 50,000. These are
  shared organization quotas, not reserved Perps capacity or request-per-second
  measurements. No plan upgrade or billing change was made. Existing Privy
  HttpOnly-cookie isolation is not enabled; changing that shared setting needs
  a compatible web/native migration and verification, not an untested toggle.
- **Isolated lifecycle checks:** 180/180 additional tests passed without skips
  (121 local and 59 real PostgreSQL checks). They exercise paper accounting,
  protective exits, grant recovery, kill/rearm, reset, final mirror,
  replacement fencing, admission/revocation and Telegram control isolation.
  Those orchestrator suites substitute child spawning, so they do not prove
  an actual deployed browser-to-worker run. Fixtures used synthetic owners and
  disposable local databases; no customer sessions or customer grants were used.
- **Actual worker crash/recovery drill:** the opt-in
  `worker/src/perps-child-process.test.ts` passed with no skips and its worker
  typecheck passed. It launches the real `index.ts` with a canonical synthetic
  index-1 permission, fresh private home, SQLite and a deterministic fixture
  feed/RPC. Before launching, the OS sandbox must reject external TCP and
  permit only that loopback RPC. The test checks the Perps lane's protection
  report with entries off, durable Close all, wrong-account reset refusal,
  acknowledged reset followed by SIGKILL, restart without duplicate reset,
  normal shutdown drain, live kill, archived recovery discovery with its
  ceiling off, and restart without rearming. Final fills, trades and positions
  remain zero. An independent reviewer checked the final harness. This is a
  self-hosted local worker test, not hosted orchestrator lease proof, cohort
  load, observed-market replay or real owner signing. Run explicitly on macOS
  with `MERRYMEN_TEST_PERPS_CHILD=1 node --import tsx --test
  worker/src/perps-child-process.test.ts`; ordinary CI skips this OS-specific
  drill. Synthetic grant homes were removed after execution.
- **Phone stop fixes:** iOS now offers the login-wide stop even when the Spot
  grant is absent or unreadable. Both clients describe the Spot, Perps and
  Solana scope and bind confirmation to the current owner and session
  generation. Android sends one DELETE, requires an explicit successful reply,
  and no longer treats absence of a Spot grant as proof that Perps stopped
  after a lost response. Android passed 728 unit tests, release lint, SDK
  metadata checks and all nine release guards. Swift policy tests passed 23/23;
  all eight packaging tests, the unsigned iOS simulator build and both new
  stop UI cases passed. Packaging tests use CI's keyless ad-hoc simulator
  identity; the initial fully unsigned run's missing-keychain-entitlement
  failures were not counted as passes. Candidate Android 0.4.2/code 6 and iOS
  0.2.1/build 2 artifacts were built and their metadata verified. The Android
  debug APK and iOS device archive are unsigned, and store inventories still
  need to confirm those version numbers are unused. The
  generated iOS wallet engine was refreshed through the official generator
  after the dependency lock changed; an independent exact-lock regeneration
  reproduced all three native bundles and the 84-entry source manifest
  byte-for-byte. These are local build/test results, not signed-release or
  installed-device proof.
- **Fresh snapshots and schedule:** Railway lists new home snapshot
  `5094c313-df91-443b-bf0d-f039c3a7d77f` at 16:31:01 UTC and PostgreSQL snapshot
  `9c6a98a0-45a1-46a3-a805-1575309a9d4f` at 16:31:03 UTC. All seven previous
  snapshots remained listed. DAILY schedules were added and reread on the
  original home and database volumes, respectively 02:19 and 06:35 UTC, with
  provider-reported six-day retention. Existing schedule kinds were preserved.
  Daily snapshots incur storage usage; no paid plan or new cloud service was
  provisioned. Snapshot creation was accepted and inventory verified, but the
  workflow-status API was unavailable to this credential; do not turn that
  limitation into a claim of tested snapshot recovery. PITR is still disabled.
- **Isolated database recovery:** PostgreSQL 18 dump and restore completed
  successfully. Source and restored content fingerprints matched for all
  129 tables and 5,575,387 rows, alongside 1,130 columns, 944 constraints,
  272 indexes and 15 sequence values from the archive. The read-only source
  snapshot was held for 304 seconds and all export sessions were verified
  closed. The 154,373,800-byte dump was encrypted directly with AES-256-GCM;
  authentication was checked before restoration into a fresh, encrypted local
  image. The restore role had no superuser, role-creation, database-creation or
  replication privileges, and the local cluster had no IP listener or outbound
  IP access. The owned cluster is stopped and its encrypted image unmounted;
  archive and recovery material are retained privately. This verifies logical
  database content, not provider snapshot restore, original roles/ownership/ACLs
  or production platform equivalence: the source uses Linux `en_US.utf8` and
  the local verifier uses macOS `C`/UTF8, with explicit `C` fingerprint ordering.
  No production restore, restart or deployment occurred. The separate home
  volume and Perps books are not covered by this database-only proof.
- **Unchanged production and observed headroom:** the web and orchestrator
  remain on the older deployments recorded below. At 16:54 UTC the original
  home was present, but `children-perps` and `lighter-feed.json` were absent and
  the global paper setting was unset (off). The container reported about
  2.99 GB used of 24 GB and 199 of 1,000 process/thread slots, with a 24-vCPU
  quota. An exact command-argument inventory found 12 worker processes and
  one orchestrator. This is current baseline load, not a Perps cohort capacity
  test or permission to fill the remaining 48-child slots.

The exact release still needs Milla's review under the repository merge policy,
a controlled deployment on the original volumes, a real owner-signed paper
canary, observed feed capture/replay, and installed-phone stop verification.
The Zod exception remains an explicit release decision; passing tests does not
remove the advisory. Never substitute a synthetic replay or unsigned simulator
build for those remaining operator gates.

### Controlled deployment and canary sequence

1. Review the complete PR stack and the final commit's checks, including the
   native follow-up. Record Milla's release decision and the dependency
   exception decision. Resolve the stack in order without admin bypass. Verify
   the resulting release contains the reviewed commits and rerun required
   checks if its code differs.
2. Keep paper off on every web and orchestrator replica while replacing old
   readers/writers. Preserve the original volumes, `DATABASE_URL`, store DEK,
   session secret, grant records and worker homes. Confirm one orchestrator
   lease holder and its normal accounting drain before a restart; no second
   worker may own an existing book. Do not fall back to a pre-approval version
   after the new admission boundary has been initialized. Global paper-off
   preserves existing owner entry settings; before turning it back on, disable
   and review any retained enabled settings if an entries-off rollout is
   required. It is not equivalent to an owner kill or admin revocation.
3. On the new web release, configure the intended admin from a verified login
   owner. Start with one explicitly approved internal canary, using the normal
   code → pending → admin approval flow. Verify no other owners were admitted,
   no permission was created by signup, and all entries remain off. Local
   preview membership and admin configuration are not production setup.
4. Enable paper only for that reviewed deployment and have the canary owner
   complete the normal separate Perps permission review/signing flow. Check
   account index 1, no funding or live execution path, entries off initially,
   and correct private reads. Exercise explicit entry enablement, protective
   exits, Close/Close all, reset, kill, fresh renewal, and admin revoke/re-admit.
   Interrupt a response to confirm no automatic duplicate command; reopening
   access must not restore old entry permission. Keep real owner signing in
   the owner's wallet UI.
5. Record the deployed commit, container limits, actual child/thread/memory
   load, Spot priority and shutdown/final-mirror behavior during the canary.
   Keep the 48-child ceiling and all trading limits unchanged. Any accounting
   hold, ambiguous ownership, stale authorization or resource exhaustion stops
   expansion; investigate rather than increasing a limit to pass the drill.
6. Once the canary's single public feed exists, capture 120 samples at
   five-second spacing using the existing read-only recorder. Replay the same
   recording twice and preserve unread samples, gaps and both results. Verify
   restart on the original home and an isolated restore of the canary's actual
   Perps state before claiming persistent-book recovery. A PostgreSQL-only
   restore cannot establish recovery of the separate home volume.
7. Verify the current signed iOS and Android clients on installed devices
   against the intended backend, including a Perps-only owner and an unread
   Spot status. A stop must name all wallets, never silently retry, and leave
   recovery reachable. Expand the cohort only after these results and the
   measured capacity are recorded. Paper-off stands the fleet down and keeps
   recovery separate. Restoring paper may respawn retained authorized workers
   and resume their stored entry settings; kill and revoke/re-admit have their
   own authority-reset behavior and must not be confused with that global flag.

### Read-only release audit: 2026-10-30, 21:22 UTC

The following evidence was read from GitHub and the authenticated deployment
CLIs. No deploy, environment update, backup creation, restore, production
command, or transaction was performed. The Railway connector required
reauthentication and the Vercel deployment connector returned 403; their
existing CLI credentials supplied the scoped metadata below. Configuration
variable values, wallet records, ledger rows and filesystem contents were not
retrieved.

- **Phone fix:** [#358](https://github.com/millw14/merrymen/pull/358) merged on
  October 25 at 11:50:29 UTC as
  `8844798e104243bfe06359e50ece3810d24854e6`, which is an ancestor of this
  branch. Its [Android push run](https://github.com/millw14/merrymen/actions/runs/40190553385)
  succeeded, but has no uploaded artifacts. The repository's latest published
  Android release remains [0.4.1](https://github.com/millw14/merrymen/releases/tag/android-v0.4.1),
  published October 16, before that fix. No iOS release appears in the
  repository release inventory; the Native iOS workflow is
  `disabled_manually`, with its last listed runs on September 29. GitHub
  metadata cannot establish Play Store, TestFlight, App Store or installed
  device versions. A current signed release and device stop drill remain due.
- **Hosted application:** Railway project `d1214acf-c89f-406f-bb2a-b4ad0b778f71`,
  production environment `29e4854c-78b0-4666-84ec-38ead2410d50`, reports `web`
  deployment `c6bc2a92-5999-4627-b973-8aa8e2e89cf7` as SUCCESS with one
  RUNNING instance, created October 22, at
  `b8944e4a87d37d230252e58e05476b0cffdb005f`. It serves
  `app.merrymen.dev` and `mcp.merrymen.dev`. The orchestrator deployment
  `dc586c16-ec3b-4fb0-a337-597c6bcdd2b7` is SUCCESS with one RUNNING instance,
  created October 28, at `b74daf01747ac25019398d694560b5f6ae7fd984`.
  Both deploy in `europe-west4-drams3a`. These are older production commits,
  not evidence that the paper desk or this branch is deployed.
- **Vercel is the marketing site:** project
  `prj_FE5I0gypW3XcjzvhezqJoOwAXLAY` uses root directory `site`. Its latest
  listed production-target build is READY/STAGED at `8e5b3ab55ac02b6ec82e1801c549de16b0df1de8`;
  the project's promoted production target still names `fc6758fd11213a7b08f130726d855a24881b6350`.
  Neither its green builds nor its PR previews verify the Railway `web` desk.
- **Original persistent homes:** volume `d6481580-14af-430c-af4a-f3540dfb833d`
  (`merrymen-agent-state`) is Ready, mounted on the orchestrator at
  `/data/merrymen`, with about 2,506 MB used of 5,120 MB. PostgreSQL's volume
  `78690eed-6483-49ec-a1ed-f56adb75a411` is Ready at
  `/var/lib/postgresql/data`, with about 3,865 MB used of 50,000 MB. These are
  control-plane mount identities; no filesystem continuity or restore drill
  was performed.
- **Backup gap:** the volume backup API lists three home snapshots, newest
  `3169a52e-d41c-4774-98c8-7b0e29ab17d5` at October 8, 10:09:03 UTC, and four
  PostgreSQL snapshots, newest `5c814357-967f-4129-a937-b9544ada790a` at
  October 8, 10:09:28 UTC. Both schedule lists are empty. PostgreSQL PITR
  reports `enabled: false` and `bucketWired: false`. This does not rule out
  an external backup system, but no evidence of one was obtained. A recent
  backup plus isolated restore/reconciliation must be supplied before pilot
  enablement; the old snapshots do not satisfy that gate.
- **Capacity observation:** Railway's orchestrator metrics for
  20:20–21:20 UTC show maximum memory about 3,000 MB against a 24,576 MB
  limit, and maximum CPU 0.289 vCPU against a 24 vCPU limit. This is the
  existing deployment's load, without the new Perps cohort. Process/thread
  counts, the proposed cohort under the shared 48-child cap, and shutdown
  headroom were not measured.
- **Local browser evidence:** a disposable hosted-mode Node 22 dev server,
  with paper enabled and no production credentials, rendered `/perps`,
  `/settings?wallet=perps`, `/grant?wallet=perps`,
  `/withdraw?wallet=perps`, and `/create?for=perps`. Signed-out states,
  public mark chart, wallet-specific navigation and recovery links were
  inspected at desktop and narrow layouts. A new CSP preload violation was
  corrected without weakening CSP; an unrelated Spot read-failure banner no
  longer appears over the Perps workspace. The existing root locale script
  still produces a development hydration warning about its nonce attribute;
  dependency/extension warnings were also visible. No login, signing,
  permission creation, exit, reset or recovery transaction was attempted.
  Real Privy, deployed API-to-worker round trips and phone verification remain
  required. The disposable server, browser tab and generated build directory
  were removed after verification.

A red or missing gate remains visible in the release record. Turning the paper
flag off is an operational stand-down: hosted paper books freeze with their
recorded positions, and their stored grants remain for recovery. A login-wide
kill and owner withdrawal/recovery remain separate actions. Turning paper back
on may respawn retained authorized workers and resume stored entry settings.
After a kill or admin revoke/re-admit, renewed authority and entry enablement
remain separate explicit owner actions. Resetting a practice book is also an
explicit owner action with its own checks.

## Dependency audit assessment: October 30

`npm audit --omit=dev --json` reports no critical findings and 16 high-severity
package findings, all propagated from
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
The lockfile resolves the application's direct Zod to 4.6.7. Nested copies are
3.25.76 under `@coinbase/cdp-sdk`, `@privy-io/api-base` and `x402`, and 3.22.4
under `@reown/appkit-wallet` and `@wagmi/connectors`. The registry's latest
Zod 3 release at audit time is 3.25.76; the published fix is in Zod 4.6.6.

The [upstream fix](https://github.com/colinhacks/zod/pull/6652) rejects oversized
constrained collections before walking their elements. It does not bound an
unconstrained collection. The MCP HTTP body limit and the partner request body
limit are existing controls, not proof that every nested SDK path is protected.
Inspection of the integrity-verified locked Privy packages found server token
verification uses `@privy-io/node` and `jose`, without this Zod 3 path. The
browser `api-base` copy defines a scalar error object, not a collection schema.
The app does not invoke x402 payment hooks, wagmi, CDP or AppKit; Privy's
WalletConnect connector disables the QR modal branch that constructs AppKit.
No reachable exploit was established in the enabled paper flow. No browser
exploit test was run, and these observations do not prove every bundled SDK
path safe.

No compatible upstream Zod 3 patch was found. No forced major-version override,
`zod/v3` alias or automatic Privy downgrade was applied: those changes would
require wallet compatibility validation, and a bounded test confirmed the
v3 export inside Zod 4 also retains the affected behavior. This advisory stays
open for release review; the audit is not clean merely because the application's
direct copy is patched. The existing working directory had newer Privy packages
than its lockfile, so final verification must use a separate clean `npm ci`
installation that matches the lock exactly.

## Capture and replay procedure

Use [the bounded capture instructions](perps-replay.md#capture-the-existing-public-feed)
with an explicit public feed path and new private output directory. Record
capture and replay exit codes, unread frame count, sampled time range, maximum
sample gap, `complete`, any failure and the commit SHA. Run the same input twice
and compare the results. Keep partial or unread runs; do not remove failed
samples, substitute today's depth into old candles, raise limits to force a
trade, or describe synthetic fixtures as observed market performance.

Live trading has a separate gate in
[the mainnet checklist](perps-mainnet-checklist.md). Passing this paper checklist
does not enable funding, real-money orders, a venue key or a live permission
wall.
