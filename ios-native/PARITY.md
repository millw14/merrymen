# Native iOS parity ledger

Reference: trusted main `40cf77494e04de40eef88ac1113743c6e30c42a9` (2026-09-24). Android and Expo are unchanged. “Implemented” means source exists, not that a live account flow has passed acceptance.

| Web capability | Native state | Remaining verification/work |
| --- | --- | --- |
| Five main tabs, menus, search, agent/token links | Implemented | Simulator navigation + iPad/VoiceOver/Dynamic Type audit |
| Feed theses, paper/outcome labels, follow/like/share | Implemented subset | Counts, filtering parity, signed-in writes, retry behavior |
| Home portfolio, leaderboard, holdings | Implemented subset | Full accounting/provenance parity, activity and performance details |
| Stock/ETF market, device watchlist | Implemented | Live response/empty/error checks |
| Memecoin discovery, chart windows, liquidity caveats | In progress | Complete discovery controls and evidence tabs |
| Agent profile, banner/avatar, public book, theses | Implemented subset | Top trades, average hold, verified-X proof, owner controls |
| Alpha picks and research, passed-over coins | In progress | Complete research fields, disclosure and tier acceptance |
| Privy email/X sign-in | SDK and API wired | Public iOS Client ID missing; callback and returning-DID testing |
| External-wallet sign-in, linked holder wallet | Missing | Native wallet protocol and proof flow |
| Chat narration and proposed commands | Implemented subset | Streaming, complete command cards, voice, transcript persistence |
| Owner buy/sell request | Implemented | Test signed-in, queued/running/receipt/timeout and account switch with a controlled test backend |
| Group chat | Implemented | Cross-device updates, hide propagation, retries and moderation acceptance |
| Agent creation, asset selection, first grant | Missing | Native ZeroDev/Kernel signing integration with exact server binding |
| Signed permission renewal and caps | Missing | Same account derivation, adapter proof, coverage, on-chain policy parity |
| Deposit address/QR/balances | Implemented | Verify chain/account/units with authenticated fixtures and device |
| Withdraw / owner recovery | Missing | Signer-based recovery and transaction reconciliation; legacy custody remains a separate path |
| Stand-down | Implemented | Controlled backend acceptance; distinguish service stand-down from on-chain revocation |
| Settings | Implemented subset | AI providers/model/keys, token editing, risk profiles, discovery/trencher/advanced controls |
| Telegram | Status/linking implemented | Native bot token setup/test and remaining permission settings |
| Merry Circle | Tier/balance reads implemented | Holder wallet proof/link/unlink |
| Proposals | Read-only | Adding vetted token and resealing permission |
| Tour | Implemented subset | Pending sync retry and per-account versioned persistence parity |
| Languages: en, es, pt-BR, id, vi, tr, ru, th, zh-CN, ja, ko | English only | Port localized copy and locale-aware unambiguous amounts |
| Appearance | Palette/artwork and native layout | Use bundled typography, full screen-by-screen visual acceptance |
| iOS packaging | XcodeGen + simulator workflow | Apple team, client registration, entitlements, archive, TestFlight and privacy review |

## Acceptance boundary

Never mark a queued order as a fill, an unread balance as zero, a paper result as live, or a missing permission as enabled. A native action must not widen risk limits, suppress ownership checks, or let a cancelled/timed-out request repeat a financial operation. Review account changes and late responses before permitting any signed-in release.
