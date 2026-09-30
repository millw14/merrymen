# Perpetuals implementation handoff

Status recorded 2026-09-30. This describes the local implementation and its
verification. Live rollout remains subject to the gates below. The governing
behavior is in [perps.md](perps.md); operational procedures are in the
[hosted runbook](hosted-deploy.md#perpetual-futures-paper-by-default-hosted-live-only-by-allowlist)
and [mainnet checklist](perps-mainnet-checklist.md).

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

## Verification evidence

These are executed checks from this implementation session. Focused runs overlap;
their counts must not be added into a repository total. Earlier passes do not
replace the final run after all edits settle.

| Check | Evidence available |
|---|---|
| Full repository tests | **15,648 passed, zero failures, three skipped** (15,651 tests; 177 seconds). The skips are the existing optional PostgreSQL energy/holder, partner-store and energy-release checks. The perps PostgreSQL lifecycle was exercised separately below. |
| Lane and live accounting regressions | 66 passed, including cap enforcement, failed-checkpoint accounting, retained real exposure, and paper/live last-known value isolation. |
| Authority and owner status | 105 authority tests and 14 recovery/status tests passed in focused runs. |
| Offline replay | 7 passed: shipped defaults, funding exactly once, missing funding, fees/stops, future-data refusal, binding caps and unread depth. These use fixtures. |
| Streamed financial recovery | 13 focused stream/normal-supervisor tests passed. The shutdown/IPC implementation run passed 19 tests. |
| Independent IPC recheck | 4 passed: cancelled-commit descriptor ownership, symlink replacement, bounded stream cleanup, and orphan sender-spool removal when the supervisor stops a child. |
| Independent final integration recheck | 23 shutdown/send-boundary tests and 41 fleet-feed lifecycle tests passed. No outstanding findings in those reviewed changes. |
| Durable payout allocation | 95 payout/on-chain-leg/accounting tests passed, including restart after partial allocation, duplicate logs, changed chain evidence, and transaction rollback. |
| TypeScript | Final `npm run typecheck` passed for worker, web, browser and SDK; the site TypeScript check passed separately. |
| Production build | `npm run build` completed successfully for the SDK and production Next.js app. |
| iOS | Simulator build succeeded; 34 policy tests passed; the signing bundle `--check` matched. |
| Android | Debug unit test task succeeded: 676 tests across 69 suites, zero failures, errors or skips. |
| PostgreSQL | Disposable local PostgreSQL lifecycle passed: cold recovery, grant revocation, shutdown checkpointing, expiry scrubbing and terminal accounting merge. This used local fixtures, not live venue execution. |

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
