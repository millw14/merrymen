# Native iOS parity ledger

Reference: trusted main `40cf77494e04de40eef88ac1113743c6e30c42a9`, fetched again on 2026-09-24. Android and Expo are unchanged. **Source implementation is not authenticated acceptance.** Keep PR #165 draft until configuration, feature gaps and release checks below are resolved.

| Capability | Native source | Outstanding acceptance or gap |
| --- | --- | --- |
| Navigation/appearance | Five tabs, native stacks/sheets, menus, search, app links, dark palette, current striped logo from web/site vector geometry, DM Sans/Geist Pixel | Full visual comparison, iPad, Dynamic Type and VoiceOver |
| Feed | Shared web grouping and All/Trades/Theses/Holds/Debates/Following filters; real-money/latest/likes; paper/outcome labels; verified mentions; natural posts/Why; follow/like/share | Controlled signed-in writes and interaction acceptance |
| Home | Shared portfolio/position/trade readers, evidenced returns, receipts, daily usage, leaderboard, Telegram/Trencher status and deposit/withdraw | Native daily real usage explicitly excludes paper fills. API omits an unambiguous portfolio book mode; full owner accounting acceptance remains |
| Markets | Shared token joins, Buying/Held/All views, coins first, discovery research, fresh launches, watchlist, name/symbol/address search | Read failures remain distinct from zero activity; live query/quote acceptance remains |
| Token | OHLC windows, age/gap warnings, holders/activity, trade entry | Includes indexed trading windows and optional recent pool transactions with token binding; live empty/error acceptance remains |
| Profile | Images, verified X, private-book handling, holdings/fills/top trades, average hold, strategy, heartbeat/joined time, shared evidenced chart windows | Owner-only trade overlay with session invalidation; controlled cross-account acceptance remains |
| Alpha | Tier/lock explanations, picks, passed coins, research/liquidity warnings | All six site-research fields and advisory conviction shown; tier acceptance remains |
| Privy email/X | SDK, canonical challenge/signature exchange, server-owner checks | **Public iOS Client ID missing**; callbacks, returning identities, account switches and expiry acceptance blocked |
| External wallet / holder | Manual copy-message/paste-signature proof, local signer recovery, login/link/unlink; embedded-wallet shortcut | No automatic wallet-app/WalletConnect handoff; backend/device acceptance remains |
| Chat | SSE, reasoning removal, per-owner text history, canonical command allowlist, editable setting/order prefills, coin resolver | Proposals are ephemeral and never restored from history; conversation/reconnection acceptance remains |
| Voice | On-device Apple speech into an editable draft; explicit start/stop/timeout/background cancellation | Physical-device/language acceptance; no server fallback |
| Orders | Frozen confirmation, exact amount, owner/session binding, pending Keychain record, receipt polling, no automatic replay | Fixture verifies restart after timeout; actual queue/fill/rejection acceptance remains |
| Snipe | Ambiguous contract choice, read-only resolution, permission explanation, separate order review | Fixture covered; production resolver/permission acceptance |
| Group chat | History, incremental updates, replies, take-back, stable retry IDs, presence, mute/time zone/never-sleep | Cross-device, moderation and retry acceptance |
| Create/renew | Canonical Kernel/ZeroDev prep, native signatures, presets/caps, basket/custom tokens, explicit live consent, standard/Class/Trencher custody checks | Offline standard/Trencher fixtures pass; native SDK/backend acceptance blocked. Basket choices follow the shared stock registry and selected asset mode |
| Deposit | QR/address, network, exact raw-unit balances | Authenticated device comparison |
| Withdraw/recovery | Canonical smart account + selected Class vault plan, confirmation, durable journal, receipt reconciliation | **Trencher vault and legacy owner/grant-wallet recovery missing**; no native end-to-end withdrawal performed |
| Stand-down | Owner-bound confirmation/DELETE; distinct from sale/revocation | Controlled backend acceptance |
| Settings | Name/strategy/mode, live/paper, public book, AI keys/provider/model, basket/custom tokens, risk/discovery/scout/Class/Trencher, swap connections, Virtuals toggle | Web form field comparison includes performance fee and breaker connection. Hosted house credentials and remote-PC/shell controls intentionally unavailable; device/form acceptance remains |
| Telegram | Bot secret replacement/removal, connection test, private linking command, control/notify/transfer budget | Controlled bot acceptance; no Telegram message sent |
| Proposals | Review metadata, save token/basket, then separate permission review | Signed-in acceptance; saving is not signing |
| Uploads / X proof | Native picker, bounded JPEG upload/removal; proof-message/X-post verification | Image previews/cache invalidation implemented; authenticated upload and proof acceptance |
| Tour | All 26 topics, versioned per-account local/server dismissal, resume/replay/retry | Restart fixture passed; signed-in cross-device acceptance |
| Languages | en, es, pt-BR, id, vi, tr, ru, th, zh-CN, ja, ko catalogue; tour/mode/consent localization; dot/comma amounts without grouping | Most screens remain English. Other web languages have fewer keys than English; full-screen localization is not claimed |
| Distribution | XcodeGen, pinned SDK, simulator CI, source manifest, screenshot artifacts | Apple Team/provisioning, device tests, archive/TestFlight, entitlements and privacy/App Store review |

## Evidence and boundaries

- Linux: bundle/source consistency, complete standard/Trencher grant preparation, identity recovery, shared feed/profile rules.
- macOS policy: decimal/routing rules, network/signature restrictions, complete streams, identity messages, runtime exceptions and terminal timeouts.
- App tests: bundled resources/fonts, real simulator Keychain updates/deletion, stale-session rejection before transport.
- UI tests: native guest navigation/thesis, tour dismissal across restart, unknown order reconciliation without replay, ambiguous contract choice followed by separate cancelable confirmation, and a private-profile dollar visibility check.
- The all-green baseline for `4866bf97` is [36071063752](https://github.com/millw14/merrymen/actions/runs/36071063752): 12 policy, 3 app and 5 UI tests. Later revisions require their own passing run. Debug fixture transport never forwards requests to production and is excluded from release builds.

Never relabel a queue as a fill, an unread balance as zero, paper as live, private dollars as public, or a partial chart as a full period. Timeout/cancellation must not repeat a financial operation. No live financial operation has been performed; authentication and account-switch acceptance are required before distribution.

Milla will provide the public iOS Client ID and Apple Team later. Remind her at handoff; no secret or certificate is needed in this task.
