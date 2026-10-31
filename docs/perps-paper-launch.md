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
  sign-in to register the verified login owner automatically. The user does
  not need to locate or paste their wallet address. Registration neither signs
  a grant nor enables entries; those remain explicit owner operations.
- `/admin/perps` lets configured administrators create/revoke invitations and
  allow/revoke individual login owners. `MERRYMEN_PERPS_PILOT_ADMINS` is an
  explicit comma-separated list of up to 20 nonzero owner addresses. Configure
  it consistently on the web replicas. Empty or malformed configuration grants
  nobody administrative access; membership and invitation codes never confer
  the role. The signed-in page shows the public owner address for operator
  setup; use that login address, not the separate Perps account address.
- Invitations are random 256-bit codes, stored only as hashes and shown once
  at creation. Defaults are one use and seven days; maxima are 100 uses and
  30 days. Redemption is transactional and rate-limited per authenticated
  owner across replicas. An explicit wallet revocation cannot be bypassed with
  another code. Re-admission clears the old entries switch and rotates its
  control nonce before access is restored. Revoking an invitation prevents new
  redemptions; revoke an admitted wallet separately to remove existing access.
- `MERRYMEN_PERPS_PAPER_TENANTS` is now only a one-time bootstrap: the first
  store initialization imports its strict owner list under a shared lock.
  Missing/empty means an empty cohort; malformed or oversized input fails
  initialization. After initialization, changes to this variable are ignored,
  including on a new replica. Use the admin page for subsequent membership
  changes. A missing or unreadable database never falls back to this list.
- **Upgrade or stand down every old web/orchestrator replica before relying on
  admin revocation.** Old env-only versions cannot observe database changes.
  Confirm common database configuration and the intended initial bootstrap
  before first use; keep the global paper flag off during rollout. Admission
  and admin pages can register the internal cohort before paper is enabled.
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
[paper desk (#370)](https://github.com/millw14/merrymen/pull/370), then
[pilot controls and this release record (#371)](https://github.com/millw14/merrymen/pull/371).
Their current CI checks and validation notes are the code evidence; a successful
code check does not fill the deployment and owner-drill gates below.

Record the exact commit, build/deployment identifier, configuration review,
operator and UTC time with each result. Keep authentication tokens, private
keys, serialized grants and customer ledger rows out of the release note.

| Gate | Required evidence | Current evidence in this work |
|---|---|---|
| Reviewed release | Final tests, typechecks, build and review on the exact deployed commit; preserve any unresolved failures | Focused local tests exist; final combined verification and deployed commit must be recorded by the release owner |
| Dependency security | Review outstanding dependency advisories and their reachability; require compatible remediation or a documented mitigation decision | The October 30 production dependency audit reports 16 high-severity package findings from one transitive Zod advisory. The application's direct Zod is patched; five nested Zod 3 installations remain flagged. See the assessment below |
| Owner lifecycle | Real hosted Privy sign-in; separate account index 1; creation; renewal of an empty paper wall; stale login and closed-screen refusal; retained recovery after interrupted renewal | DOM, signer, binding and API regression tests; real hosted browser/Privy exercise outstanding |
| Paper desk | Current tenant/account report, unread/stale states, exact fills and candle gaps; Close, Close all and explicit reset show the correct worker result; a lost POST response is never automatically retried | Component and route tests; deployed end-to-end worker round trip outstanding |
| Kill and exits | Kill names and stops all supported wallets; entries remain off after delayed settings writes; removing pilot admission disables new entries while exits/stops remain usable | Regression tests in this change; hosted operator drill outstanding |
| Phone compatibility | Released iOS and Android builds carrying #358's compatible kill request; verify installed-client behavior against the intended backend | #358 is merged and Android CI passed its merge commit; the latest published Android release predates the fix, and iOS CI is disabled. Release/install evidence is outstanding; the full Perps phone UI follows web launch |
| Privy capacity | Confirm configured production app, enabled login and embedded signing, expected internal-owner count and current plan/rate capacity | Account/plan/deployment evidence outstanding; no assumption from local mocks |
| Fleet capacity | Under the 48-child cap, demonstrate Spot priority, Perps-only bot-seat behavior, shutdown/final mirror and headroom with the proposed cohort | Code/test evidence is separate from deployment resource measurements, which remain outstanding |
| Database backup | Current backup policy, recent successful backup, isolated restore and reconciliation evidence; preserve the original volume during pilot | Railway metadata shows no scheduled snapshots and PITR disabled; newest listed snapshots are October 8. Current backup and isolated restore remain blockers. No database rows or credentials were read |
| Persistent home | Verify mount identity, lease exclusivity and restart on the original home; document held-wallet response if the home is missing | Existing authority/hold tests and the restrictive pilot policy above; lost-home/handover proof outstanding |
| Public feed | Bounded recording from the deployed single public feed, exact timestamps, gap accounting and deterministic offline replay | Capture/replay synthetic tests passed. A read-only stat of `/data/merrymen/lighter-feed.json` on the existing production orchestrator returned ENOENT on October 30; no recording was made and no feed was started |
| Other surfaces | Owner-scoped Telegram, MCP and partner routes; no Perps public identity or Spot fallback; recovery remains reachable when paper is off | Tests must be included in final combined verification; deployed owner exercise outstanding |

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
kill and owner withdrawal/recovery remain separate actions. The pilot offers
no automatic resume; reopening entry permission and resetting a practice book
are explicit owner actions with their own checks.

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
