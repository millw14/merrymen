# Perpetuals implementation handoff

Status recorded 2026-10-01. This describes the local implementation and its
verification. Live rollout remains subject to the gates below. The governing
behavior is in [perps.md](perps.md); operational procedures are in the
[hosted runbook](hosted-deploy.md#perpetual-futures-paper-by-default-hosted-live-only-by-allowlist)
and [mainnet checklist](perps-mainnet-checklist.md).

## Brain research and owner recovery follow-up

The optional [MerrymenBrain driver](perps-brain.md) is implemented in both repos.
Its numerical module comes from the MerrymenBrain repository with a pinned
source commit, file hashes and license. It measures market regime, trend,
volatility, funding, executable depth and costs, then compares causally observed
historical outcomes. Three grounded model reviews may veto a qualifying trend
candidate. They cannot increase risk or override a numerical refusal.

The driver is explicit opt-in. Research runs outside the protective loop, with
bounded calls, expiring approvals and execution-time checks. Exact source frames,
requests, holds and responses are recorded for [replay and evaluation](perps-replay.md).
Forecast probabilities are uncalibrated historical frequencies, not established
trade win rates. No real forward dataset or evidence of improved returns exists
in this handoff; live promotion is never automatic.

The previous owner recovery implementation gap is addressed by a dashboard
preparation and re-sign flow. Grant intake and the worker independently verify
the exact account, incident, evidence digest, chain, canonical receipt, successful
owner operation and current recovery slot. The ledger transition retires old
keys and acknowledges only exact previously recorded unknown fills. Only the
verified throwaway key can be replaced by the fresh signed key. Unresolved venue
orders, on-chain operations and transfers block the transition. Ordinary Resume
does not clear incidents. An interrupted, expired handoff requires an explicit
owner re-proof; expiry is never extended automatically.

Owner entry controls now carry a durable history. Mirroring and checkpoint
recovery preserve a newer Resume without allowing an older request to clear a
later halt. Divergent histories and contradictory legacy writers refuse opens.
These local changes do not complete the mainnet or device acceptance gates below.

## Delivered work

| Stage | Local implementation |
|---|---|
| 1–3: foundation, authority and paper trading | Frozen Lighter route/market definitions, integer risk math, opt-in wall permissions, owner consent, sealed key custody, grant compatibility, public market feed and readers, ledger/equity accounting, paper execution, protection and strategy producers. |
| 4: live execution | Account/key binding, durable nonce and signed-order records before sends, reconciliation and incident handling, deposits/key registration/withdrawal claims, protective exits, shared operation/spend caps, and separate paper/live accounting. Hosted financial recovery uses authenticated streamed checkpoints and generation fences. |
| 5: hosted operation, shutdown and recovery | One shared fleet market-data feed; self-hosted shutdown requests; hosted grant revocation with a bounded exits-only worker; durable checkpoint/reclaim, a three-close-attempt budget per market across restarts, and final accounting merge; owner recovery/disclosure paths; explicit residual and unknown custody. On-chain position closing remains gated by the mainnet checklist. |
| 6: owner surfaces | Dashboard consent/settings and positions; reviewed Close/Close-all cards with explicit paper/live book binding; Telegram `/perps`, `/close`, `/flatten` and notifications; dashboard-only resume; read-only MCP positions; CLI status/doctor/recover. Both native apps preserve custody warnings and hand exit actions to web owner confirmation. |
| 7: replay | Offline replay of the shipped trend defaults, including funding, fees, stops, marked open tails, missing-data refusal and protection against future-data leakage. |
| 8: independent review and fixes | Authority, privacy, accounting, recovery, owner controls, replay and IPC reviews performed. Fixes include owner-switch consent reset, leverage operation accounting, paper/live value isolation, partial-fill reporting, durable partial-payout allocation, snapshot descriptor/cleanup races and restart-safe shutdown budgets. The final checks are recorded below. |

The shared fleet feed and durable shutdown attempt budget are implemented and
independently reviewed. The hosted deployment exercise below remains unrun.

## Autonomous operation follow-up

The unattended flow received an additional implementation and recovery review:

- Setup polls owner-bound progress, shows the saved entry producer, and explains
  grant lifetime and observed venue minimums before the advanced settings.
  The normal waiting state does not show an unnecessary Resume action.
- A temporary admission or decision-journal failure leaves an unsent trend
  signal available for the next tick. A failed spot proposal does not interrupt
  the independent perps route; partially produced strategist signals are cleared.
- A repaired, exactly matching venue key is retried after the existing backoff.
  Hosted infrastructure failures retry only after the previous worker exits and
  its financial history is completely mirrored. Authority/history contradictions
  still refuse trading.
- The 24-hour idle return clock is durable and bound to the account and authority
  epoch. Opening a position retires the old interval before broadcast. Fresh
  funding starts a new interval; pending deposits and temporary venue setup waits
  cannot immediately sweep that funding back out before entry. Historical rereads
  do not keep restarting the clock.
- Hosted shutdown retries temporary reads, cancellations, closes and withdrawals
  within the original deadline and durable three-close-attempt budget. Earlier
  confirmed results survive later retries; a request still does not prove arrival.

These changes preserve owner consent, deliberate entry halts, signed limits,
incident handling and the operational gates below. The standard trend producer
does not require an AI provider; manual mode does not open positions autonomously.

## Second crosscheck

The fresh review reproduced and corrected these issues:

- Renewing a stop could keep the old expiring order and cancel its replacement.
  The lane now tracks the exact replacement and waits for a fresh venue read to
  confirm it before retiring the old stop. Equal-price stops select the longest
  expiry, including adopted positions.
- A hosted restart could count an already mirrored deposit or withdrawal twice
  when it shared the anchor's second. The anchor now identifies the exact copied
  flow prefix, bound to the local ledger and accounting epoch. Rebuilt or restored
  ledgers cannot silently reuse an obsolete boundary; older unproven anchors
  leave contributions unknown.
- Close and Flatten could send after their owner confirmation expired if a read
  or durable write stalled. The original deadline now reaches the final send
  boundary and is persisted with signed orders for replay checks. Recovery must
  preserve the earliest known cutoff.
- Telegram could report no open positions when the current venue book was
  unreadable or contained unlisted holdings. It now reports that uncertainty and
  avoids presenting dashboard Resume as a remedy for an operator halt.

The subsequent recovery work described above closes that implementation gap;
mainnet acceptance remains unrun. No incident or authority check is bypassed.

## Verification evidence

These are executed checks from this implementation session. Focused runs overlap;
their counts must not be added into a repository total. Earlier passes do not
replace the final run after all edits settle.

| Check | Evidence available |
|---|---|
| MerrymenBrain numerical module | 25 Python tests and Ruff passed in the MerrymenBrain repo. The committed export matches source commit `8a48ca0faf96`; the service build verifies its manifest and hashes. These are invariant tests, not performance evidence. |
| Brain service | Full service Python suite: 99 passed, two skipped. Numerical holds avoid model calls; three valid model acceptances are required for a qualified candidate. No paid provider calls were made. |
| Brain recording and evaluation | 31 tests passed across Brain, baseline replay, exact archived-request replay, source-frame recording, completed trade metrics, causal forecast scoring and the CLI. Missing real forward observations produce insufficient evidence; reports cannot authorize promotion. |
| Recovered autonomous lane | Six real-lane integration tests passed with a localhost fake venue and fake chain reads, using the real signer, receipt verifier, store and policy. Covers recovery → registration → isolated leverage → persisted protected entry under a tightened cap, below-minimum refusal, failed/expired proof, revocation during a final await and a foreign replacement key. |
| Recovery receipt boundary | 63 focused proof/on-chain-leg tests passed. Checks include own-operation bundle boundaries, canonical receipt, removed/foreign logs, exact account/slot/key/incident/evidence binding and expiry. |
| Recovery controls and handoff | Focused runs passed: 42 checkpoint/history tests, 60 atomic-store/intake/Resume/ledger tests, 24 authentication/control/surface tests and five intake/carry-forward tests. Covers pending L1/L2 operations, transfers, rollback, fresh incidents, expired retry, same-key renewal, newer halt identity and preserving protective reads with corrupt owner controls. |
| Second crosscheck: stop renewal and owner deadlines | 178 focused tests passed across the real lane with a fake venue, live executor, send guard, stand-down, API and mirror. Includes delayed owner decisions, expiry during durable writes, failed rejection writes, crash/restart replay refusal, queued Flatten budget, lease waits and final HTTP boundary checks. |
| Second crosscheck: accounting boundary | 105 focused tests passed, including same-second deposits/withdrawals, cold startup in epoch 3, an older database upgraded after anchor capture, replaced ledgers and complete final mirroring. Independent source review found no remaining issue in this correction. |
| Second crosscheck: recovery deadlines | 33 focused tests passed across current/legacy restores, streamed merge, warm supervisor recovery and cursor compatibility. Independent source review verified that later or absent deadlines cannot erase an earlier known cutoff. |
| Full repository tests | Final Brain/recovery run: **15,817 passed, zero failed, three skipped** (15,820 tests; 199 seconds), after production and test edits settled. The skips are the existing optional PostgreSQL energy/holder, partner-store and energy-release checks; perps PostgreSQL was exercised separately below. |
| Lane and live accounting regressions | 66 passed, including cap enforcement, failed-checkpoint accounting, retained real exposure, and paper/live last-known value isolation. |
| Autonomous lane follow-up | 179 passed, including transient admission/key recovery, a durable idle interval across restarts, and withdrawal → payout → new deposit → temporary setup wait → protected entry. These use the real lane/store with a fake venue. |
| Setup and readiness follow-up | 294 passed in the UI/core/view integration run, including owner-bound refresh, hung response recovery, saved automatic producers, grant lifetime, market minimums and owner versus operator halts. |
| Hosted retry follow-up | Independent recovery run: 45 passed; final anchor rerun: 7 passed. Includes complete mirroring beyond 10,000 financial records, typed transient failures, shutdown retry budgets and prior outcome preservation. |
| Proposal failure isolation | 46 focused checks passed. Independent perps decisions continue after a failed spot proposal; stale or partial strategist handoffs are cleared and existing entry gates remain active. |
| Authority and owner status | 105 authority tests and 14 recovery/status tests passed in focused runs. |
| Offline replay | 7 passed: shipped defaults, funding exactly once, missing funding, fees/stops, future-data refusal, binding caps and unread depth. These use fixtures. |
| Streamed financial recovery | 13 focused stream/normal-supervisor tests passed. The shutdown/IPC implementation run passed 19 tests. |
| Independent IPC recheck | 4 passed: cancelled-commit descriptor ownership, symlink replacement, bounded stream cleanup, and orphan sender-spool removal when the supervisor stops a child. |
| Independent final integration recheck | 23 shutdown/send-boundary tests and 41 fleet-feed lifecycle tests passed. No outstanding findings in those reviewed changes. |
| Durable payout allocation | 95 payout/on-chain-leg/accounting tests passed, including restart after partial allocation, duplicate logs, changed chain evidence, and transaction rollback. |
| TypeScript | Final `npm run typecheck` passed for worker, web, browser and SDK; the site TypeScript check passed separately. |
| Production build | `npm run build` completed successfully for the SDK and production Next.js app. |
| iOS | Earlier simulator build succeeded and 34 policy tests passed. After the Brain/recovery shared changes, regenerated bundles passed source/copy consistency across 11 languages, signing TypeScript, standard/Trencher/legacy signing fixtures, feed and crypto checks. Signing fixtures made zero real writes. Branding passed in the earlier autonomy verification; device acceptance remains unrun. |
| Android | Earlier debug unit test task succeeded: 676 tests across 69 suites, zero failures, errors or skips. No Kotlin changes were made in the Brain/recovery follow-up. |
| PostgreSQL | Disposable PostgreSQL 17 checks passed for schema upgrade, concurrent Halt versus queued Resume, exact recovery commit/replay refusal, retained owner halt and retired keys. A real SQLite child plus PostgreSQL checkpoints preserved newer control/recovery histories through stale mirrors, current/legacy restores, warm/cold startup and stale narrow shutdown checkpoint → expiry → full terminal merge. Earlier execution deadlines and replay-byte scrubbing also remained intact. These used local fixtures, not live venue execution. |

Final repository checks, from the worktree root:

```sh
node --import tsx --test --test-concurrency=4 --test-reporter=tap 'worker/src/**/*.test.ts' 'web/src/**/*.test.ts' 'packages/*/src/**/*.test.ts' 'sdk/*.test.ts'
npm run typecheck
./node_modules/.bin/tsc --noEmit -p site
npm run build
node ios-native/Signing/build.mjs --check
git diff --check
```

The disposable PostgreSQL cluster was stopped after verification. No mainnet
or paid model calls were made during these tests.

## Defaults, authority and custody

- Owner settings `perpsEnabled` and `perpsLiveEnabled` default to `false`.
  Live use additionally requires the account's live rail, versioned owner
  consent and regional attestation, and a re-signed grant containing the perps
  permission. Chat, Telegram, MCP and partner calls cannot provide that consent.
- `MERRYMEN_PERPS` is restriction-only: hosted defaults to `paper`, self-hosted
  defaults to `live`, and an unrecognized value means `off`. Hosted live also
  requires the smart account in `MERRYMEN_PERPS_LIVE_TENANTS` on both web and
  orchestrator; an empty list admits nobody. Journal continuity is required.
- `MERRYMEN_HALT_PERP_ENTRIES` stops entries while preserving exits and protection.
  `/flatten` also records an entry halt; only the dashboard clears it. A venue
  incident has a separate key-rotation requirement.
- The wall pins the venue, collateral, destination and registered public key,
  and caps each deposit call. Venue order size, leverage, cumulative collateral
  and rate limits are enforced by worker software. A stolen venue key can lose
  all collateral held at Lighter; it has no per-key trading scope.
- Hosted kill/expiry removes the stored trading grant. The exits-only shutdown
  worker can use the retained venue key for at most 15 minutes; terminal/expiry
  cleanup scrubs the stored key and replay bytes when the supervisor runs.
  Resting stops are retained until positions read flat. Partial fills, inaccessible
  subaccounts, failed reads or expired shutdowns remain residual/unknown.
  A completed worker or queued withdrawal does not prove funds arrived home.
- Lighter publishes account activity. Merrymen's public feeds exclude perps
  details in v1, while aggregate equity can include them. Venue fills/funding are
  API-attested, withdrawals have a delay and claim, and stops can gap or expire.
  Hosted children currently share an OS user; per-child isolation is a general
  availability prerequisite.

## Remaining operational gates

1. Run and record every [mainnet checklist](perps-mainnet-checklist.md) item on an
   explicitly authorized operator account with a small amount. All checklist
   Result entries remain **not run**. No equivalent venue route on Robinhood
   testnet 46630 has been verified (the documented RH API testnet currently
   reports a different underlying development chain; see the research below).
2. Verify the hosted paper phase, including the fleet feed, canonical wall and
   fail-closed behavior, before allowlisting live accounts. Keep web and
   orchestrator restrictions aligned.
3. Complete signed-in iOS/Android acceptance on devices, covering consent,
   paper/live choice, exit confirmation, kill/recovery and missing-custody
   warnings. Local compilation and unit tests do not establish this; both
   native custody surfaces must ship before hosted live admission.
4. Supply a real historical replay dataset with the required candles, depth and
   hourly funding. No such replay or strategy-performance claim has been made.
5. Obtain the operating/custody decisions listed in [perps.md](perps.md#decisions-that-need-milla),
   including the hosted venue service, regional restrictions and owner recovery
   posture. General availability also requires per-child isolation.

No push, deployment, live allowlist activation or live trades were performed as
part of this implementation handoff.


## Product backend verification, 2026-10-08

The worker has a real autonomous lane: shared native candle feed, deterministic
profile evaluation, policy/sizing, paper settlement or durable live submission,
reconciliation, protection and owner-scoped accounting. It is not a UI demo.
The new `perps-only` builtin emits no spot purchases or vault deposits; the
independent perpetuals lane remains responsible for its own entries and exits.
It is intended for new perps accounts, not a silent replacement for an existing
spot strategy's own exit rules.

Worker reports now carry optional `automation` observations: the completed
review's Unix-second timestamp, effective driver, selected style, outcome and
reason. A candidate is explicitly not a fill. Owner/configuration changes clear
that observation, and consumers must still check worker heartbeat freshness.

Replay previously dropped `perpsStyle` and silently evaluated the original
four-hour rule. It now validates and retains the selected profile, consumes its
native bars, and carries entry style through the simulated ledger so protective
deadlines work even when later signal candles are absent. Synthetic tests cover
all nine profile cadences and deadlines; these are not return forecasts.

### Current official-source cross-check

Read-only research on 2026-10-08 confirmed:

- [Robinhood network configuration](https://docs.robinhood.com/chain/connecting/)
  specifies mainnet 4663 and testnet 46630. Production RPC should use a provider;
  the public endpoint is rate-limited.
- [Robinhood Lighter Domains](https://docs.robinhood.com/chain/lighter-domains/)
  confirms the independent venue, current proxy and API base, USDG asset index 3,
  route 0 and six-decimal deposit amounts. These match the frozen v1 route.
- [Lighter RH integration differences](https://apidocs.lighter.xyz/docs/lighter-rh)
  and [RH getting started](https://apidocs.rh.lighter.xyz/docs/get-started)
  confirm signing chain 466324, separate account/key/nonce state, reserved key
  indexes 0–3 and 157 (our index remains 16), and Standard REST 60 requests/minute.
  The generic Ethereum Lighter deployment must not replace these route literals.
- Public `api.rh.lighter.xyz/api/v1/layer1BasicInfo` returned underlying chain 4663,
  the pinned proxy and collateral address. `orderBookDetails?filter=perp` returned
  BTC 1 / ETH 0 / SOL 3 active with price/size precisions 1/5, 2/4, 3/3 and 10 USDG minimum
  quote. Minimum base amounts were 0.00020 BTC, 0.0050 ETH and 0.100 SOL; the worker
  reads these dynamic limits instead of assuming the quote minimum alone.
- RH docs expose `api.rh-testnet.lighter.xyz` with signing chain 300. Its public
  layer1BasicInfo currently reports underlying chain 123456, not 46630. This is
  not evidence that Merrymen's frozen 4663 grant can be tested on 46630, and no
  route, permission or signer literal was changed.

No private credentials, wallet writes, deposits or venue orders were used for
this research. Mainnet stop/withdrawal acceptance, deployment health and real
historical performance remain separate uncompleted evidence requirements.


Executed backend checks for this follow-up: 169 passed in the combined core
report parser, paper lane, profile replay/evaluation and perps-only registry run.
After adding fresh-lane restarts to each profile lifecycle, the focused
paper/replay/registry run passed 50 tests. The final paper-lane rerun passed 34,
including explicit manual/waiting/unreported-after-restart observations. These
runs overlap and are not additive. Worker TypeScript checking and diff whitespace
validation passed. No build, server start, deployment or real-money operation was
performed by this backend audit.


Independent review also found that publishing automation diagnostics from a
retained strategy snapshot could overwrite a newer protective position report.
Publication now reads the current book and persists it under the lane lock.
The regression reproduced a closed position reappearing before the correction;
the corrected paper/live integration run passed 79 tests, including all 34 paper
lane tests. Root's repository-wide typecheck is the final compilation check.

### Product connection and onboarding

`/perps` now serves the owner-connected Tactical Radar product. Both former lab
routes redirect there. Public prices come from a bounded Lighter mark-candle
endpoint; private chart entries, open positions, fills and funding records stay
behind the current owner's grant and never enter the public cache.

The Control room reads saved settings, shows the actual worker heartbeat and
completed evaluation, changes profiles through the existing owner-bound settings
path, and pauses new entries without cancelling protective exits. Close and
flatten actions open the existing owner-confirmed order flow. Mobile keeps Trade,
Positions, Feed and Account behind the floating dock. Radar, Playbook and Control
are secondary views within Trade.

New-account onboarding is available at `/create?for=perps`. It saves an explicit
paper-only configuration, the selected native-cadence profile and BTC/ETH/SOL
universe before minting the account. The initial per-trade cap is 25 USDG, total
open notional 50 USDG, leverage 2x, collateral 30 USDG, and opens four per day;
venue minimums can still block a trade. Its displayed fourteen-day permission
accommodates the seven-day swing horizon. Real funds require separate venue
permission, consent and funding.

Dedicated Perps accounts now use a purpose-bound permission wall: capped USDG
approval to Lighter, the pinned venue operations and optional energy purchase.
Spot swaps, stock approvals, curve adapters and transfers are absent. Legacy
Spot grants retain their existing derivation and canonical wall. The earlier
minimal-onboarding option remains creation-only; dedicated-purpose renewals
rebuild the same Perps wall and preserve their venue authority.

Browser acceptance covered the real public BTC chart and the new name/profile/
limits form, stopping before wallet creation or signing. Private control changes,
authentication changes, journal presentation and restart-safe paper trading were
verified through integration tests. This is not a recorded real-money execution
or withdrawal acceptance run.

Final follow-up checks: repository typechecking and the production build passed.
The complete app suite ran 15,994 tests: 15,989 passed, three skipped and two
failed. The two findings were corrected: the conversational strategy allowlist
now explicitly excludes the creation-only `perps-only` strategy, and stale
profile/signal refusals have private owner explanations while staying withheld
from public feeds. Their focused reruns passed. The final UI flow regression also
verifies that an inspected profile reaches new-agent creation without writing
settings, and that switching owners clears the draft. These targeted runs overlap
with the full suite and are not additional unique-test totals.

Production HTTP checks returned 307 from each retired lab route to `/perps` and
200 with 288 real closed mark candles for each BTC/ETH/SOL 24-hour chart, with no
private entries in the public response. Responsive browser checks covered the
390px mobile dock, isolated panels and 1440px desktop layout; an observed mobile
min-content overflow was corrected without disabling chart panning. Wallet
creation, permission signing, deposits, live orders and withdrawals were not
performed during browser verification.

### Shared login, account and community integration

Perps uses the main app's existing session and sign-out flow. Account reads are
bound to that session's current grant, with no client-supplied owner or account
selector. The private account endpoint returns a whitelist of wallet/network/
USDG metadata, the existing worker report and separately labelled fill-record
counts. It does not expose signing keys or publish perpetual positions.

The Account panel shows real on-chain USDG separately from reported real venue
equity; unknown or paper venue balances are not displayed as real funds. Funding
and recovery use the existing wallet controls inside Perps. The allocation field
changes only the maximum USDG collateral ceiling through owner-bound settings,
with a readback before success. It is not an immediate transfer, and lowering the
ceiling does not withdraw existing collateral or change signed permissions.

The account model now supports two smart accounts under the same login and
root owner. Spot retains Kernel index 0; Perps uses index 1. Purpose is included
in Perps ownership signatures, canonical-wall checks, grant/settings stores and
all private controls. Existing Spot state is preserved. A legacy Spot grant
already carrying Perps authority blocks dedicated onboarding until its owner
completes the existing retirement/recovery flow; balances and positions are
never silently migrated or discarded.

Funding from Spot requires an exact USDG amount, review and explicit owner
confirmation. It uses the owner signer and the existing transfer-only,
unsponsored relay, not an agent key. A persistent operation hash is written
before broadcast, ambiguous results are reconciled without rebroadcast, and
browser locks serialize funding from the same source. Users without an
available Spot owner signer can send USDG manually to the dedicated deposit
address. No automatic funding or refill from Spot exists.

The Feed panel reuses public fleet posts and agent profiles, and adds a private
all-market execution/funding journal with separate paper/live selectors. Both
queries and rendering preserve each record's actual market and decimal strings.
Profile holdings and trade lists/counts cover spot/on-chain operations; account
growth can include perpetual equity. Private perpetual positions and entry
markers are never supplied to another agent's public profile.

This integration passed 62 focused API/UI/navigation tests, repository-wide
TypeScript checking and the production build. Browser checks covered the 390px
dock, Feed → Account → Perps onboarding, private-position gating, 1440px desktop
navigation, header funding/feed links, and the Spot/Perps round trip. Both tested
widths had no document overflow. Public-profile reads and authenticated wallet/
allocation/account-switch cases were exercised in integration tests; the local
browser has no configured funded agent or public feed ledger. No wallet was
created, signed, funded, traded or withdrawn during verification. No deployment
or real-money acceptance run is claimed.


### Separate Spot and Perps authority, 2026-10-08

Additive `perps_grants` and `perps_tenant_settings` tables preserve existing
Spot rows. The file-store equivalent uses a separate Perps directory. Both
writers serialize ownership checks across purposes and reject a reused account
address, different root owner or unretired legacy Perps authority. Revocation,
shutdown and recovery are scoped to the selected purpose. The shared public
identity retains Spot as its primary account and adds Perps as a membership.

The orchestrator runs each purpose in a separate home/process with its own
session key, venue key, settings, command files, mirror cursors and execution
lease. True login identity remains the encryption/authentication owner. A
Perps worker always uses the `perps-only` strategy, including when settings
are absent. Spot Telegram/X credentials and holder delegations are not copied
into the Perps worker. This separation does not constitute an operating-system
sandbox: hosted workers currently run under the same OS user.

The app reads a dedicated Perps account snapshot under its existing login.
Private chart markers, positions, activity, controls, recovery and balance reads
select that account explicitly; missing Perps data never falls back to the
Spot book. The profile and public community feed remain shared, while private
venue executions remain owner-only.

No user wallets were created or signed, and no live funding transfers, venue
trades or withdrawals were performed during this implementation. Live deployment and mainnet/device
acceptance remain subject to the operational gates above.


## Separate wallet execution and self-hosted operation

One login keeps the same public profile and follows across Spot and Perps. Each
mode has its own grant, settings, wallet, worker process, and accounting rows.
Perps uses Kernel index 1; existing Spot accounts remain index 0. Private chart
entries, position exits, activity, recovery, and paper resets resolve the selected
wallet. No automatic transfer from Spot funds the Perps wallet.

Hosted execution uses distinct owner and owner:perps slots for worker homes,
leases, command delivery, and restart state. Cryptographic seals and authentication
remain bound to the real owner and exact smart account. A Perps shutdown stops and
retires only that execution slot. Shared identity membership preserves Spot as
the primary account when both exist. Worker directory separation does not provide
a hostile-process sandbox: children still share a host UID. A deployment requiring
that boundary must use separate UIDs or containers without shared key volumes.

For self-hosted installs, `merrymen start` and `npm run dev:worker` run the local
worker supervisor. It starts Spot immediately and notices a newly created Perps
grant within two seconds. Perps state lives under `~/.merrymen/accounts/perps` (or
`$MERRYMEN_HOME/accounts/perps`). Independent process restart backoff preserves
the other worker. Revocation leaves the running worker time to consume its
protective stand-down request; losing the supervisor's IPC connection exits its
children so an old process cannot outlive the manager. Each local wallet also
holds a kernel-released SQLite writer lease for the lifetime of its worker; a
replacement cannot execute while the old child still holds that lease.

The browser recovery screen selects the correct wallet automatically. To use the
local CLI escape hatch for Perps, select its home and purpose explicitly:

```sh
MERRYMEN_HOME="$HOME/.merrymen/accounts/perps" MERRYMEN_WALLET_PURPOSE=perps merrymen recover
```

The CLI also retains the selected archived grant's account purpose. Recovery
reconstructs that fixed index and checks the reviewed smart-account address before
signing. Planning and signing use the same derivation. These paths were checked
with temporary files, stub RPC/bundler responses, throwaway signers, and simulated
child processes; no production funds or live orders were used for this validation.

Final verification for the separate-wallet implementation:

- Repository TypeScript checks and the production Next/SDK build passed.
- The full application run executed 16,093 tests: 16,088 passed, four skipped,
  and one stale source assertion failed because it expected the old unscoped
  Settings callback. The assertion now checks the two purpose-specific
  callbacks; its complete 67-test chat-controller group passed on rerun.
- The real PostgreSQL 17.11 integration run passed all six cases, including
  legacy-schema upgrade, concurrent initialization, independent grants/settings,
  atomic cross-purpose ownership, shared identity and isolated revocation.
  Command: `MERRYMEN_TEST_PG_URL=<disposable-local-database> node --import tsx --test --test-force-exit worker/src/dual-purpose.postgres.test.ts`.
  The temporary cluster and temporary driver installation were removed.
- Real SDK funding tests used a stub RPC and throwaway owner signer to verify
  the exact transfer and distinct purpose derivations. An owner switch after
  signing prevented both broadcast and pending-journal creation. Journal tests
  cover reloads, lost responses, storage failures and no automatic resubmission.
- Local worker lifetime leases, CLI grant-change races and purpose-specific
  recovery/kill controls passed their focused integration tests. Those runs
  overlap the full suite and must not be added to its total.
- Read-only production browser checks covered 390px and 1440px layouts, public
  candles, Spot/Perps navigation, dedicated Account/Create/Settings links,
  private-position gating and shared community navigation. Funded owner states
  were exercised with fixtures, not real assets. The local feed has no populated
  public ledger; its unavailable state was shown without invented activity.
