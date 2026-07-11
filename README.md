# merrymen

Autonomous trading agents for Robinhood Chain. Your band works Sherwood 24/7 —
trading Stock Tokens, farming yield, LPing — inside hard on-chain permission
walls you set and can see.

**The five promises:** your keys, your caps · bounded worst case · every trade
simulated first · fees only on profit above high-water mark · honest scoreboard.

## Layout

- `packages/core` — chain constants, token registry, shared types. Every address
  is probed on-chain before it lands here.
- `web` — Next.js app: onboarding, permission-grant flow, agent dashboard with
  live positions, trade record (simulation receipts included), kill switch, and
  the public scoreboard at `/scoreboard`.
- `worker` — Node runtime: grant sync → scheduler → strategy tick → policy
  check → simulate → execute → record. Plus the backtest harness
  (`src/backtest.ts`) that runs real strategies through the real policy layer
  over synthetic price series.
- `contracts` — the on-chain drawdown breaker: `BreakerRegistry` (keeper-reported
  equity, permissionless trip on reported data, owner-only reset) and
  `KernelBreakerPolicy` (Kernel v3 module type 5 — fails every UserOp at
  validation once tripped). `npm test -w @merrymen/contracts`; deployment waits
  on a funded key (targets in `hardhat.config.ts`).

## Strategies

Selected via `MERRYMEN_STRATEGY`:

| name | what it does |
|---|---|
| `steady-basket` (default) | DCA a weighted stock basket per tick; idle cash sweeps to the Morpho vault; pulls cash back when short |
| `weekend-gap` | Enter each leg when its Chainlink feed goes stale (market close), exit the full holding when it refreshes (open) — the strategy class that only exists on-chain |
| `llm-strategist` | Claude proposes typed buy/sell/hold actions at decision windows (default 30min); deterministic code validates and disposes — the model never sees an address or emits calldata. Needs `ANTHROPIC_API_KEY`; without it, the null driver proposes nothing |

## Install

Self-hosted, terminal-first — install once, run from anywhere. No clone.

**No Node yet? One line does everything** — installs Node if missing, then merrymen, and fixes PATH:

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/millw14/merrymen/main/install.ps1 | iex
```
```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/millw14/merrymen/main/install.sh | bash
```

**Already have Node 22.12+?** Just:

```bash
npm install -g merrymen            # or: npm i -g github:millw14/merrymen
merrymen setup                     # check node/npm/PATH (prints fixes if anything's off)
merrymen onboard                   # wizard: bundler URL, API keys, strategy, basket
merrymen start                     # dashboard at localhost:3100 + the 24/7 worker
```

Requires Node 22.12+. `merrymen setup` diagnoses the two things that trip people
up — an old Node, and npm's global-bin folder missing from PATH — and gives you
the exact copy-paste fix for your OS. All your data lives in **`~/.merrymen`** (settings, grant,
ledger, strategies) — the install is disposable, upgrades never touch it. Secrets
(bundler/RPC keys, Anthropic, Rialto, Telegram token) stay in that folder, never
leave the machine, and never echo back to the browser (masked to their last 4).
The dashboard binds to **localhost only** — it has no login and holds your trading
controls, so it isn't reachable from your network. To open it to a trusted LAN
(e.g. your phone on home WiFi), start with `MERRYMEN_HOST=0.0.0.0 merrymen start`.

> **`merrymen: command not found`?** Your npm global-bin folder isn't on PATH
> (this also breaks other global CLIs like `yarn`/`vercel`). Two options:
> use `npx merrymen onboard` / `npx merrymen start` — works everywhere, no PATH
> changes — or add the folder to PATH once:
> - **Windows:** `[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";$env:APPDATA\npm", "User")` then open a new terminal
> - **macOS/Linux:** ensure `$(npm prefix -g)/bin` is on your `PATH` (add it to `~/.zshrc` / `~/.bashrc`)

Then sign the permission wall at `localhost:3100/grant` (MetaMask, testnet
46630), grab gas from the faucet, and check the stack anytime:

```bash
merrymen doctor     # node/keys/RPC/bundler/grant/db diagnostics
merrymen status     # heartbeat, grant, trades, equity
merrymen selftest   # one policy-legal no-op through the full pipeline
merrymen kill       # kill switch from the terminal
```

## Write your own bot

Your strategies live in **`~/.merrymen/strategies/`** — hot-reloaded on save,
crash-isolated, and incapable of exceeding the caps you signed (every intent
passes shape validation → the policy wall → quote simulation → the on-chain
session key). Scaffold one and go:

```bash
merrymen strategy new my-bot       # drops a commented template in ~/.merrymen/strategies
# edit ~/.merrymen/strategies/my-bot.mjs, select "my-bot" in /settings — done
```

Default-export `{ name, tick(snapshot, ctx) }` — no imports needed, `ctx`
injects the verified registry (`ctx.tokenBySymbol.QQQ`, `ctx.CASH.USDG`,
`ctx.UNISWAP.swapRouter02`, `ctx.usdg(10)`). See
[strategies/README.md](./strategies/README.md) and
[strategies/example-dip-buyer.mjs](./strategies/example-dip-buyer.mjs) for the
full walkthrough.

## Chat with your merryman (Telegram)

Link a Telegram bot and run your band from your phone — natural-language chat plus
commands, all inside the same permission walls. Telegram is a **control surface,
never a trade path**: every message is untrusted text that flows through the same
discipline the LLM strategist uses (parse → validate → policy wall → signed
on-chain grant). Chat can *tighten* caps but can never widen them — raising a cap
still needs a browser re-sign.

```
1. @BotFather on Telegram → /newbot → copy the token
2. /settings → Telegram → paste token, "test connection" (shows @yourbot), enable
3. Message your bot: /link <code>   (the one-time code shown in /settings)
   → you're now the owner; only allowlisted chats are obeyed
```

Commands (all work without an Anthropic key; with one, plain English works too —
"how are we doing?", "pause everything", "switch to weekend-gap"):

| command | does |
|---|---|
| `/status` `/positions` `/pnl` `/trades` | read the live book |
| `/pause` `/resume` | halt / resume the strategy loop (kill-switch marker) |
| `/strategy <name>` | switch strategy (builtin or your `~/.merrymen/strategies/*`) |
| `/cap perTrade <usdg>` | tighten a cap within the signed grant (never widens) |
| `/kill` | destroy the grant — the worker halts next tick |
| `/help` | the full list |

Turn off state-changing commands (read + chat only) with the **control** toggle,
and bound any chat-triggered trade with the per-action USDG ceiling — both in
`/settings`. The bot token is a secret: it stays in `~/.merrymen` and never
returns to the browser. Polling is off by default; existing installs are
untouched until you opt in.

<details>
<summary>develop from a clone</summary>

```bash
git clone https://github.com/millw14/merrymen && cd merrymen
npm install          # prepare hook builds the dashboard
npm run onboard && npm start
# or run halves separately: npm run dev:web · npm run dev:worker
```

</details>

**Configure everything at `/settings`** — bundler URL, RPC overrides, API keys
(Anthropic, Rialto), breaker address, strategy, and every trading knob. Saved
to `.data/settings.json` (gitignored; secrets never echo back to the browser)
and picked up by the worker within one tick: connection changes re-arm the
executor, strategy changes rebuild in place. Precedence: settings file > env
var > default.

Sign a grant at `/grant` (testnet 46630); the worker arms itself on its next
tick — no restart. The kill switch on the dashboard destroys the grant and the
worker halts on its next tick; hard on-chain expiry is the backstop.

Worker env (fallbacks when the settings file doesn't set a value):

| var | default | meaning |
|---|---|---|
| `MERRYMEN_BUNDLER_URL` | — | 4337 bundler RPC; without it execution is stubbed (policy/simulation still run) |
| `MERRYMEN_SWAP_VENUE` | `uniswap` | `uniswap` = full quote→swap leg via SwapRouter02; `rialto` = approval-only until API onboarding |
| `MERRYMEN_SLIPPAGE_BPS` | `100` | max slippage vs the QuoterV2 simulation |
| `MERRYMEN_GRANT_FILE` | `.data/grant.json` | grant handoff written by the web app |
| `MERRYMEN_STRATEGY` | `steady-basket` | strategy name (see table above) |
| `MERRYMEN_PERF_FEE_BPS` | `1000` | performance fee on profit above the high-water mark (accrual-only ledger) |
| `MERRYMEN_BREAKER_ADDRESS` | — | deployed BreakerRegistry; a tripped breaker halts all intents |
| `MERRYMEN_RIALTO_API_KEY` | — | Rialto integrator key; enables the full quote→swap leg (target validated against the on-chain router registry) |
| `ANTHROPIC_API_KEY` | — | enables the LLM strategist's Claude driver (`MERRYMEN_LLM_MODEL`, `MERRYMEN_LLM_INTERVAL_MIN`, `MERRYMEN_LLM_MAX_ACTION_USDG` tune it) — also powers Telegram natural-language chat |
| `MERRYMEN_TELEGRAM_BOT_TOKEN` | — | @BotFather token; enables the Telegram control/chat bridge (`MERRYMEN_TELEGRAM_ENABLED`, `MERRYMEN_TELEGRAM_CONTROL_ENABLED`, `MERRYMEN_TELEGRAM_ALLOWLIST`, `MERRYMEN_TELEGRAM_MAX_ACTION_USDG` tune it) |

`npm run typecheck` and `npm test` cover the policy mirror, strategy, venue
math (slippage, quote selection, calldata), and the ERC-8056 invariant that a
stock split is not a crash.

Plan: `../agent-trading-platform-plan.md`. Architecture rule of the house:
**the LLM proposes, deterministic code disposes** — no model ever constructs
calldata or bypasses the policy layer.
