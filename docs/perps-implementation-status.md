# Perpetuals implementation handoff

Status recorded 2026-09-30. This describes the local implementation and its
verification. Live rollout remains subject to the gates below. The governing
behavior is in [perps.md](perps.md); operational procedures are in the
[hosted runbook](hosted-deploy.md#perpetual-futures-paper-by-default-hosted-live-only-by-allowlist)
and [mainnet checklist](perps-mainnet-checklist.md).

## Open implementation blocker

**Re-enabling perps after owner key recovery is not wired.** `merrymen recover`
records the replacement and retired keys in `perp-owner-rotations.json`, but
the worker does not consume that journal. Both onboarding calls omit the verified
owner replacement key set; `clearIncident` has no production caller, and Resume
correctly refuses incidents. A fresh signed grant therefore still sees the
recovery throwaway key as foreign. Recovery of funds and revocation are separate
from re-enabling trading.

Before live release, implement an authenticated owner recovery acknowledgement
bound to the exact account, frozen route and verified on-chain rotation receipt.
It must durably retire the old keys, authorize replacement of only the verified
recovery key by a fresh non-retired signed key, and clear the incident only as
part of that verified transition. File existence, an arbitrary key mismatch,
or an ordinary Resume request must never provide that authority.

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

The owner recovery re-enablement gap above remains a release blocker. No incident
or authority check was bypassed to make recovery appear complete.

## Verification evidence

These are executed checks from this implementation session. Focused runs overlap;
their counts must not be added into a repository total. Earlier passes do not
replace the final run after all edits settle.

| Check | Evidence available |
|---|---|
| Second crosscheck: stop renewal and owner deadlines | 178 focused tests passed across the real lane with a fake venue, live executor, send guard, stand-down, API and mirror. Includes delayed owner decisions, expiry during durable writes, failed rejection writes, crash/restart replay refusal, queued Flatten budget, lease waits and final HTTP boundary checks. |
| Second crosscheck: accounting boundary | 105 focused tests passed, including same-second deposits/withdrawals, cold startup in epoch 3, an older database upgraded after anchor capture, replaced ledgers and complete final mirroring. Independent source review found no remaining issue in this correction. |
| Second crosscheck: recovery deadlines | 33 focused tests passed across current/legacy restores, streamed merge, warm supervisor recovery and cursor compatibility. Independent source review verified that later or absent deadlines cannot erase an earlier known cutoff. |
| Full repository tests | Final second-crosscheck run: **15,718 passed, zero failed, three skipped** (15,721 tests; 191 seconds), after all production edits settled. The skips are the existing optional PostgreSQL energy/holder, partner-store and energy-release checks; perps PostgreSQL was exercised separately below. |
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
| iOS | Earlier simulator build succeeded and 34 policy tests passed. After this crosscheck's shared wording correction, regenerated bundles passed source/copy consistency, signing TypeScript, standard/Trencher/legacy signing and read-only recovery fixtures, feed and crypto checks. Branding passed in the earlier autonomy verification. |
| Android | Debug unit test task succeeded: 676 tests across 69 suites, zero failures, errors or skips. |
| PostgreSQL | Disposable local PostgreSQL 17 lifecycle passed: cold recovery, grant revocation, shutdown checkpointing, expiry scrubbing and terminal accounting merge. The latest crosscheck separately verified the nullable deadline-column upgrade, conservative mirror minimum, current/legacy restores, flow cursor invalidation, warm/cold recovery, and full/narrow shutdown checkpoint → expiry → terminal merge with replay bytes removed. This used local fixtures, not live venue execution; the cluster was stopped afterward. |

Final repository checks, from the worktree root:

```sh
node --import tsx --test --test-concurrency=4 --test-reporter=tap 'worker/src/**/*.test.ts' 'web/src/**/*.test.ts' 'packages/*/src/**/*.test.ts' 'sdk/*.test.ts'
npm run typecheck
./node_modules/.bin/tsc --noEmit -p site
npm run build
node ios-native/Signing/build.mjs --check
git diff --check
```

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
   Result entries remain **not run**. There is no Robinhood Lighter testnet.
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
