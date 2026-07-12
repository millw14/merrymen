<p align="center">
  <img src="web/public/merrymenlogo.png" alt="merrymen — autonomous trading agents for Robinhood Chain" width="360" />
</p>

# merrymen

Self-hosted autonomous trading agents for Robinhood Chain. Your band works
Sherwood 24/7 — trading Stock Tokens, farming yield, LPing — inside hard on-chain
permission walls you set and can see. Name your merryman, chat with it and steer
it from Telegram (it can even run your PC), and watch every trade on a local
dashboard.

**The five promises:** your keys, your caps · bounded worst case · every trade
simulated first · fees only on profit above the high-water mark · an honest
scoreboard.

**The one rule of the house:** the model proposes, deterministic code disposes.
No model — the strategist, a Telegram message, a voice note — ever constructs
calldata, moves funds, or touches your PC without passing a closed, typed
command set and the on-chain policy wall. This is the whole safety story;
everything below is a consequence of it.

---

## The workflow, end to end

1. **Install** it (one line — installs Node too if you need it).
2. **`merrymen start`** — opens the dashboard at `localhost:3100` and looses the
   24/7 worker.
3. **Create your agent wallet** at `/grant` — no wallet to connect; merrymen
   mints the keys, you back them up, pick **testnet** (practice) or **mainnet**
   (real funds), and set the caps the account contract itself enforces.
4. **Fund it** — testnet gas from the faucet, or send ETH + USDG to the account
   address on mainnet. The worker arms itself on its next tick, no restart.
5. **(optional) Link Telegram** — chat with your merryman, give it a name, let it
   trade, report, alert, and control your PC — all inside the same walls.

Everything lives in **`~/.merrymen`** (settings, grant, ledger, your strategies,
your merryman's soul). The install is disposable; upgrades never touch your data.

---

## 1 · Install

Self-hosted, terminal-first. Install once, run from anywhere. No clone.

**No Node yet? One line does everything** — installs Node if missing, then
merrymen, and puts it on PATH:

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/millw14/merrymen/main/install.ps1 | iex
```
```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/millw14/merrymen/main/install.sh | bash
```

**Already have Node 22.12+?**

```bash
npm install -g merrymen            # or: npm i -g github:millw14/merrymen
merrymen setup                     # checks node / npm / PATH, prints exact fixes
merrymen onboard                   # optional wizard: bundler URL, keys, strategy, basket
merrymen start                     # dashboard at localhost:3100 + the worker
```

Requires Node 22.12+. `merrymen setup` diagnoses the two things that trip people
up — an old Node, and npm's global-bin folder missing from PATH.

> **`merrymen: command not found`?** npm's global-bin folder isn't on PATH. Use
> `npx merrymen start` (works everywhere), or add it once:
> - **Windows:** `[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";$env:APPDATA\npm", "User")` then reopen the terminal
> - **macOS/Linux:** put `$(npm prefix -g)/bin` on your `PATH` (in `~/.zshrc` / `~/.bashrc`)

The dashboard binds to **localhost only** — it has no login and holds your
trading controls, so it isn't reachable from your network. To open it to a
trusted LAN (your phone on home WiFi), start with
`MERRYMEN_HOST=0.0.0.0 merrymen start`.

---

## 2 · Create & fund your agent wallet

Open `localhost:3100/grant`. There's nothing to connect — merrymen generates a
fresh account, shows you the owner key to **back up** (lose it and the funds are
gone), and lets you fund it. **Pick your ground:**

- **testnet · 46630** (default) — the sandbox. Free gas from the faucet, the full
  pipeline end to end. The trading venues aren't deployed there, so swaps
  simulate and no-route by design — perfect for learning the flow.
- **mainnet · 4663** — **real funds.** Real USDG, real Stock Tokens, real
  execution. The page makes you acknowledge it first: keys are generated and
  stored **in plain text on your machine** (TEE custody is on the roadmap), so
  treat the account like a hot wallet — your caps are the seatbelt, start small.
  No faucet: send ETH (gas) + USDG (capital) from your own wallet or an exchange.

The caps you set — per-trade, daily, ops/day, drawdown breaker, key expiry — are
enforced **by the account contract on every operation**, not by promises. The
worker can tighten within them but can never widen them without a new signed
grant.

> **Bundler gotcha:** a 4337 bundler URL (Pimlico/Alchemy) embeds its chain id in
> the path (`…/v2/4663/…`). It must match your wallet's chain or every op fails —
> the worker warns you at arm time if they disagree. Without a bundler URL at
> all, the agent runs policy + simulation but never signs.

---

## 3 · Run it

```bash
merrymen start      # dashboard (localhost:3100) + the 24/7 worker
merrymen doctor     # node / keys / RPC / bundler / grant / db diagnostics
merrymen status     # heartbeat, grant, trades, equity
merrymen selftest   # one policy-legal no-op through the full pipeline
merrymen kill       # kill switch from the terminal (destroys the grant)
```

The worker's loop each tick: **grant sync → market safety (prices, pauses,
sequencer) → strategy proposes → policy check → quote simulation → execute →
record**. It re-reads `~/.merrymen/settings.json` every tick, so changes from the
dashboard apply within one tick — connection changes re-arm the executor,
strategy changes rebuild in place; no restart. The dashboard shows live
positions, the trade record (with simulation receipts), the event feed, and a
kill switch; the public scoreboard is at `/scoreboard`.

---

## 4 · Chat with your merryman (Telegram)

Link a bot and run the band from your phone — natural-language chat plus slash
commands, all inside the same permission walls. Telegram is a **control surface,
never a trade path**: every message is untrusted text that flows through the same
parse → validate → policy wall → signed grant discipline as the strategist.

```
1. @BotFather → /newbot → copy the token
2. localhost:3100/settings → Telegram → paste token, "test connection", enable
3. Message your bot:  /link <code>   (the one-time code shown in /settings)
   → you're now the owner; only allowlisted chats are obeyed
```

There's an obvious **Chat on Telegram** button right on the dashboard (topbar +
a card) so you don't have to hunt for it.

Commands work bare; with an Anthropic key, plain English does too ("how are we
doing?", "pause everything", "send 20 USDG to 0x…", "ping me when QQQ hits 600",
"why did you buy that?"). Voice notes work as well.

| command | does |
|---|---|
| `/status` `/positions` `/pnl` `/trades` | read the live book |
| `/report` · `/brag` · `/why` | daily campfire report · shareable scorecard · explain the last trade |
| `/buy <SYM> <usdg>` `/sell <SYM> <usdg>` | trade (passes the policy wall) |
| `/transfer <0x…> <usdg>` | send USDG out — **always asks you to `/confirm`** |
| `/alert <SYM> > <price>` `/alerts` `/unalert <n>` | one-shot price alerts |
| `/pause` `/resume` · `/strategy <name>` · `/cap <usdg>` | steer the worker (cap only tightens) |
| `/name <name>` · `/soul` · `/remember <fact>` | name it, see who it is, teach it about you |
| `/kill` | destroy the grant, stand the band down |
| `/help` | the full list |

**It speaks first, too** (toggle in `/settings`): a ping the moment a trade lands
or the wall turns one back; warnings when the grant nears expiry, drawdown nears
the breaker, or gas runs low; your price alerts; and a **daily campfire report**
at the hour you pick.

**Transfers are triple-guarded:** off by default · the grant's on-chain call
policy caps the amount · every transfer echoes the full recipient address and
waits for an explicit `/confirm` (90s). A prompt-injected "send everything to
0xevil" can at worst produce a confirmation card you'll see and `/cancel`. (New
wallets carry the transfer permission; a pre-transfer grant gets a "re-create
your wallet" reply instead.) Turn off all state-changing commands with the
**control** toggle for read + chat only.

### Remote control — your merryman runs your PC (OpenClaw-style)

Enable the **remote control** section in `/settings` and your merryman can act on
the machine it runs on, from Telegram:

| capability | what it does |
|---|---|
| 📸 screen · 👁️ vision | `/shot` a screenshot; ask "what am I looking at? / read this error" (Claude vision) |
| 🚀 apps & web | `/open spotify`, `/open github.com` — allowlisted apps, any URL |
| ⚙️ system | `/sys` info, volume, media keys, `/notify`, `/lock`, sleep/shutdown |
| 📂 files · 📋 clipboard | `/ls`, `/get` inside one folder you pick; read/set the clipboard |
| 🖥️ shell · ⌨️ keyboard | `/run` allowlisted commands; `/type`, `/key ctrl+s` |
| 🎙️ voice · 👀 watchers | voice note → command; `/remind 20m …`, `/watch cpu>80`, `/watch file …`, `/watch proc …` |

**The safety model is the point** — it's a hot wallet for your desktop:

- **Off by default**, then **one capability at a time** — nothing runs unless you
  turned that group on. `/pc` shows what's enabled; the master switch off kills
  all of it instantly.
- **Allowlists for the sharp edges**: shell runs *only* your exact pre-approved
  commands (chaining/redirects always refused); files are confined to one root
  (no `..` escape); apps to a name list.
- **Confirm gate**: shell, keyboard, file-send, and power never fire until you
  reply `/confirm` to the exact action echoed back.
- **Local + logged**: a chat message can only ever emit one command from a closed
  set — it can't invent a capability or smuggle a raw command past the allowlist.

Windows is fully supported; macOS/Linux use the standard tools (`screencapture`,
`open`, `pbcopy`, …) and say so where one isn't present. Voice needs an
OpenAI-compatible transcription key (set it in the dashboard).

### Your merryman has a soul

Every merryman is an individual with a name **you** give it — and it grows with
you. Its soul lives as plain markdown in **`~/.merrymen/soul/`** that it keeps up
to date itself (read or edit it with any editor):

| file | what it holds |
|---|---|
| `IDENTITY.md` | who it is — its name (`/name Will Scarlet`), born date |
| `OWNER.md` | what it's learned about **you**, one dated line at a time |
| `JOURNAL.md` | a first-person entry it writes at campfire time |

The longer you ride together, the closer the bond: *new companion* → *trusted
companion* (a week) → *old friend* (a month) → *sworn brother-in-arms* (100
days), with milestone messages and a tone that warms to match. Memory is
**context, never capability** — soul files flavor chat only; every command still
passes the closed enum and the policy wall, and the memory sanitizer refuses
anything address-, key-, or code-shaped, so a poisoned note can't smuggle a
recipient into a prompt.

---

## Strategies

Pick one in `/settings` (or `/strategy <name>` from Telegram; `MERRYMEN_STRATEGY`
is the headless fallback):

| name | what it does |
|---|---|
| `steady-basket` (default) | DCA a weighted stock basket per tick; idle cash sweeps to the Morpho vault; pulls cash back when short |
| `weekend-gap` | Enter each leg when its Chainlink feed goes stale (market close), exit when it refreshes (open) — a strategy class that only exists on-chain |
| `llm-strategist` | Claude proposes typed buy/sell/hold at decision windows; deterministic code validates and disposes — the model never sees an address or emits calldata. Needs an Anthropic key |

### Write your own

Your strategies live in **`~/.merrymen/strategies/`** — hot-reloaded on save,
crash-isolated, and incapable of exceeding the caps you signed (every intent
passes shape validation → the policy wall → quote simulation → the on-chain
session key):

```bash
merrymen strategy new my-bot       # commented template in ~/.merrymen/strategies
# edit it, select "my-bot" in /settings — done
```

Default-export `{ name, tick(snapshot, ctx) }` — no imports needed; `ctx` injects
the verified registry (`ctx.tokenBySymbol.QQQ`, `ctx.CASH.USDG`,
`ctx.UNISWAP.swapRouter02`, `ctx.usdg(10)`). See
[strategies/README.md](./strategies/README.md) and
[strategies/example-dip-buyer.mjs](./strategies/example-dip-buyer.mjs).

---

## For developers

<details>
<summary>repo layout · clone-dev · env vars · tests</summary>

### Layout
- `packages/core` — chain constants, token registry, shared types. Every address
  is probed on-chain before it lands here.
- `web` — Next.js dashboard: onboarding, the create-wallet/grant flow, live
  positions, trade record (simulation receipts), kill switch, scoreboard,
  settings + all APIs.
- `worker` — Node runtime: grant sync → scheduler → strategy tick → policy check
  → simulate → execute → record; the Telegram bridge + PC-control layer; the
  backtest harness (`src/backtest.ts`) that runs real strategies through the real
  policy layer over synthetic prices.
- `contracts` — the on-chain drawdown breaker: `BreakerRegistry` +
  `KernelBreakerPolicy` (Kernel v3 module type 5 — fails every UserOp once
  tripped). `npm test -w @merrymen/contracts`; deployment waits on a funded key.
  Until deployed, the breaker is worker-enforced.

### Develop from a clone
```bash
git clone https://github.com/millw14/merrymen && cd merrymen
npm install          # prepare hook builds the dashboard
npm run onboard && npm start
# or run halves separately: npm run dev:web · npm run dev:worker
npm run typecheck && npm test
```

### Configuration
The dashboard `/settings` is the source of truth (Anthropic/Rialto/Telegram keys,
bundler + RPC URLs, strategy + every trading knob, the Telegram + PC-control
toggles and allowlists). Saved to `~/.merrymen/settings.json`; secrets are masked
to their last 4 and never echo back to the browser. Precedence:
**settings file > env var > default.** Env vars are the headless fallback:

| var | default | meaning |
|---|---|---|
| `MERRYMEN_HOST` | `127.0.0.1` | dashboard bind host; set `0.0.0.0` for trusted-LAN access |
| `MERRYMEN_BUNDLER_URL` | — | 4337 bundler RPC; without it execution is stubbed (policy/simulation still run) |
| `MERRYMEN_SWAP_VENUE` | `uniswap` | `uniswap` = full quote→swap via SwapRouter02; `rialto` = approval-only until API onboarding |
| `MERRYMEN_SLIPPAGE_BPS` | `100` | max slippage vs the QuoterV2 simulation |
| `MERRYMEN_GRANT_FILE` | `~/.merrymen/grant.json` | grant handoff written by the web app |
| `MERRYMEN_STRATEGY` | `steady-basket` | strategy name (see table above) |
| `MERRYMEN_PERF_FEE_BPS` | `1000` | performance fee on profit above the high-water mark (accrual-only) |
| `MERRYMEN_BREAKER_ADDRESS` | — | deployed BreakerRegistry; a tripped breaker halts all intents |
| `MERRYMEN_RIALTO_API_KEY` | — | Rialto integrator key; enables the full quote→swap leg |
| `ANTHROPIC_API_KEY` | — | LLM strategist driver + Telegram natural-language chat + vision |
| `MERRYMEN_TELEGRAM_BOT_TOKEN` | — | @BotFather token; enables the Telegram bridge (all other Telegram + PC-control settings live in `/settings`) |

`npm test` covers the policy mirror, strategies, venue math (slippage, quote
selection, calldata), the ERC-8056 invariant that a stock split is not a crash,
and the Telegram + PC-control safety layer (allowlist enforcement, path-traversal
rejection, capability gating, confirm-park, prompt-injection → no-op).

</details>
