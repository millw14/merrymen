# Terminal review — September 5, 2026

Reviewed the main app at localhost:3100 in the in-app browser, including desktop (1440 × 900) and mobile (390 × 844) views. The local account had one agent, no recorded positions or trades, an empty on-chain recovery balance, and no working chat provider. No wallet was created, re-signed, funded, withdrawn from, or revoked during this review. Settings changes were not saved.

## Changes made

- Empty personal balances and available cash show $0.00. Missing market quotes and unavailable public information remain distinct from a zero balance.
- Portfolio data loads independently of slower market discovery. Discovery requests have more time to complete, and off-screen token images load lazily.
- Registered stocks retain their identity when also returned by pool discovery. Buyer counts are no longer presented as holder counts.
- Worker status distinguishes running, paper trading, idle, and waiting for a worker. Missing status no longer claims trading was paused.
- Profile has a withdrawal action. Desktop funding stays in the right sidebar; mobile funding replaces the current view and closes back to it.
- Watch controls save locally and connect to the desktop Watchlist filter. Empty watchlists and empty holdings have separate messages.
- Failed chart loads retain timeframe controls. Memecoin timeframe choices filter the returned series to the requested duration. Missing chart data no longer borrows a daily percentage and labels it as a different timeframe.
- Unavailable public holdings no longer simultaneously claim no agents hold the token. Unregistered coins no longer receive the registered-asset badge.
- Fully diluted value is labelled correctly. Dither avatar markers require an entry inside the displayed period.
- Chat configuration errors provide a Settings link and preserve the unsent question. Missing daily change uses neutral styling.
- Invalid token and agent links provide a way back. The old /theses address now redirects to /feed.
- Wallet management defaults to restore when a server agent exists but this browser lacks its wallet. Ordinary new-wallet creation goes through /create.
- Image fallbacks recover when their source changes. The local development badge no longer covers the mobile Home button.

## Page coverage

| Page or flow | Browser checks |
| --- | --- |
| `/` | Existing-agent zero balance, market list, mobile search entry, desktop sidebar and account actions. |
| `/tokens` | Direct route and responsive layout. This legacy address currently displays the home market view. |
| `/search` | Token search, no results, clearing the query, opening a result. |
| `/t/[token]` | AMD and PONS; candlestick and dither charts; timeframe changes; reset control present; watch toggle and connected sidebar; share action; missing holdings state; invalid-token recovery. |
| `/agent` | Empty balance and positions, portfolio dialog open/close, Positions/Trades switching, disabled empty send, sending a balance question, configuration error and retained draft, mobile composer placement. |
| `/you` | Zero balance, trading controls, settings/wallet links, added withdrawal action, desktop and mobile funding placement. |
| Deposit | Open/close, chain and account displayed, copy address confirmed. No transfer submitted. |
| Withdrawal | Open/close, recovery expansion, actual empty-account response. No sweep submitted. |
| `/feed` | Desktop tab and direct/mobile route; filters open/close, deselect all, empty filtered state, clear filters; mobile sheet dimensions. |
| `/leaderboard` | Desktop tab, direct route, mobile route, empty leaderboard state. No populated rankings available locally. |
| `/limits` | Signed per-trade and daily values, close action and management/settings links. No signature changed. |
| `/create` | Existing-agent guard and management link, desktop and mobile layout. New creation cannot be exercised against this account without replacing its setup. |
| `/a/[key]` | Invalid/missing agent state and recovery link. No public agents available locally to verify a populated profile. |
| `/settings` | Sections and controls inspected; invalid custom-token input rejected; desktop/mobile width checked. No settings saved. |
| `/grant` | Restore mode, required controls, existing-agent restore default, mobile width checked. No recovery key entered or displayed. |
| `/gate` | Initial page and explicit wrong-password presentation. No gate password submitted. |
| `/app`, `/theses`, `/scoreboard` | Legacy redirects visited; `/theses` corrected to the feed. |

## Remaining verification and product gaps

- Chat cannot complete a successful reply with the current local AI configuration. The UI reports the problem and retains the question. A working provider is needed for the successful-response check.
- The agent has no worker heartbeat. The app now states this instead of claiming it is paused; worker execution was not started as part of UI review.
- The local public ledger did not supply token holdings or public agents. Populated public profiles, chart avatar placement against actual fills, ranking order, and live trade history still need a populated environment.
- Wallet login, hosted session expiry, successful funding/withdrawal, activation retries, and permission renewal need the corresponding hosted account or an explicitly authorized wallet exercise. They were not represented as verified by this review.
- Settings and wallet management now use the terminal shell, shared fonts, controls, and responsive layout. Help text is disclosed on demand; custom tokens, Telegram, and advanced settings are collapsed. Settings requests have a visible failure and retry state.
- Original route bodies and loading screens were removed from the active route tree. The gate, missing-page screen, and error boundaries use the current design. Legacy stylesheet imports were removed from active pages.
- Onboarding now separates paper and live completion: paper users proceed to their agent, while live funding opens through the desktop sidebar. The setup checklist does not ask paper users for a deposit. Agent names match the saved 24-character limit. New-wallet signing and activation were reviewed in code, not executed.
- Some external coin images are unavailable; visible images fall back to initials rather than broken-image icons.

The production build and TypeScript check were run separately. Browser checks do not establish that real transactions or hosted-only flows work. No deployment was performed.
