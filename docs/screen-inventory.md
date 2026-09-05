# App screen inventory and review

Reviewed September 5, 2026, after merging origin/main. This inventory covers reachable app surfaces, not only route files. Keep it current when introducing a route, fallback, dialog, or standalone HTML document.

## Fixes from this review

- Replaced the old green offline screen with the terminal palette, typography, compact copy, retry, home link, and optional self-hosting help. The message describes a server connection failure rather than asserting that the agent has stopped.
- Updated service-worker cache version to v3 so connected returning installations replace the old cached fallback. Existing offline installations need to reconnect before receiving it.
- Replaced the desktop startup splash with the current palette and clear loading copy; animation respects reduced motion.
- Added a standalone root-layout error boundary with inline styling, retry, and a home link. It does not depend on the root stylesheet being available.
- Found that the local preview was stopped and restarted the web server on port 3100. No trading process was started.

## Routed screens

| Surface | Result |
| --- | --- |
| Home `/` and markets `/tokens` | Current terminal shell; desktop inspected. Home also checked at mobile width. |
| Search `/search` | Current terminal shell; desktop and mobile width checked. |
| Feed `/feed` | Current terminal shell; desktop sidebar and mobile page checked. |
| Leaderboard `/leaderboard` | Current terminal shell; desktop and mobile width checked. |
| Agent chat `/agent` | Current terminal shell; desktop and mobile width checked. |
| Portfolio `/you` | Current design; desktop and mobile inspected, funding actions exercised. |
| Limits `/limits` | Current controls; desktop and mobile width checked. No signature submitted. |
| Settings `/settings` | Current form shell and desktop entry point checked; mobile width checked. No settings saved. |
| Wallet `/grant` | Current form shell, including restore state; desktop and mobile width checked. No key entered. |
| Create agent `/create` | Current creation component; route checked at desktop/mobile. Local account is already created; fresh signing flow not executed. |
| Token `/t/[token]` | Current terminal component confirmed in source; invalid-token route checked. Valid-token chart interactions are documented in terminal-review-2026-09-05.md from the earlier pass. |
| Public agent `/a/[key]` | Current terminal component confirmed in source; missing-agent route checked. Populated public profiles require available public data. |
| Gate `/gate` and `?again=1` | Current standalone design; desktop/mobile checked. Wrong-password presentation inspected without submitting a password. |
| Unknown route | Current not-found design; desktop/mobile checked. |
| `/app`, `/theses`, `/scoreboard` | Verified redirects to `/you`, `/feed`, and `/leaderboard`. |

## Surfaces outside the route list

| Surface | Result |
| --- | --- |
| `web/public/offline.html` | Desktop screenshot reviewed; mobile width checked; expandable help and retry-to-home exercised. The browser served the previous cached fallback while the server was stopped, confirming how the reported screen appeared. New offline interception after a forced network failure was not exercised. |
| `desktop/loading.html` | HTML preview visually reviewed in browser. Actual Electron launch not performed. |
| Route errors (`app/error.tsx`, `(app)/error.tsx`) | Current design confirmed in source. Error deliberately not injected into the running app. |
| Root-layout failure (`app/global-error.tsx`) | Added current standalone design; build/typechecked. Actual root failure not induced. |
| Deposit and withdrawal | Open/close exercised at mobile and desktop. Confirmed right-sidebar placement on desktop and no horizontal overflow. No transaction submitted. |
| Account menu | Visible Settings and account destinations preserved; Settings entry exercised. |
| Guide, sign-in, recovery, chat failure and loading states | Active components traced in source; use current terminal classes. Guided tour interactions are documented in onboarding-guide.md. Hosted login and provider success were not exercised in this self-hosted session. |
| Native startup failure dialog | Electron system dialog in desktop/main.js; intentionally uses native platform styling. |

No active page or terminal component imports the old visual stylesheets. Older unused components still exist in source; they are not mounted by the current route layout. This review does not claim verification of wallet signing, live trading, provider success, or every possible external-service failure.

Production build and TypeScript check passed. No automated tests were added or run. Changes have not been deployed.
