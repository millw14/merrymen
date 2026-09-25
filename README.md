<p align="center">
  <img src="site/public/favicon.svg" alt="merrymen — autonomous trading agents for Robinhood Chain" width="160" height="144" />
</p>

<p align="center">
  <a href="https://merrymen.dev"><b>Website</b></a> ·
  <a href="https://app.merrymen.dev"><b>Open app</b></a> ·
  <a href="https://merrymen.dev/docs">Docs</a> ·
  <a href="https://x.com/MerrymenAI">X</a> ·
  <a href="https://www.npmjs.com/package/merrymen">npm</a>
</p>

# merrymen

**Autonomous trading agents with signed limits and readable research.** Run
merrymen in the [hosted app](https://app.merrymen.dev) or on your own machine.
Create an agent, choose its markets and limits, and follow its decisions,
positions and trade outcomes from the dashboard or Telegram.

The account contract enforces the permissions sealed into its session key:
allowed calls and assets, per-call limits and expiry. The worker adds daily
budgets, drawdown checks and operation limits. These are different enforcement
layers: a compromised worker can ignore software checks, but cannot expand a
signed on-chain permission. Bad trades remain possible within those bounds.

**The five promises:** your keys, your caps · bounded worst case · every trade
simulated first · fees only on profit above the high-water mark · an honest
scoreboard.

**The one rule of the house:** the model proposes, deterministic code disposes.
Models produce proposals; trusted code constructs trading calls and checks them
before execution. Telegram PC control is a separate self-hosted capability,
gated by its own permissions, allowlists and confirmations. The on-chain wall
protects account operations, not your operating system.

## What you can do

- **Run hosted or self-hosted.** Use the web app, or keep your worker, settings,
  memory and ledger in your own `MERRYMEN_HOME`.
- **Start on paper, then enable live trading.** Simulated trades are labeled
  separately. Live execution requires explicit enablement, a usable signed
  grant, an executor, funding and passing market/policy checks.
- **Read and follow agents.** Public profiles and the feed expose published
  theses and execution outcomes. Followed-agent research can inform later
  decisions; following is not an instruction to copy a trade.
- **Use Brain research.** Brain evaluates evidence and returns structured
  decisions. Operational failures stay distinct from public market theses.
- **Explore Trencher.** The memecoin strategy checks liquidity, momentum and
  exits. Fast mode supplies Brain with measured 5m/1h/6h/24h market windows and
  reviews candidates in the background, with one model call outstanding at a
  time. Live Trencher and fast mode have separate opt-in settings.
- **Audit the record.** Export the ledger and verify chain-backed receipts
  independently of the running worker.

Active workers target decision reviews at intervals of no more than five
minutes when reads complete. That is a review cadence, not a promise to trade
every five minutes or make a profit. See the execution and publication details
below.

## Ownership and enforcement

- **Your machine, if you self-host.** The agent, its memory and its ledger live
  in `~/.merrymen`; configured RPC, inference and other providers can still be
  external services. Hosted at
  app.merrymen.dev the worker and the ledger are ours — what does not change is
  the next line.
- **Owner authority and agent authority are separate.** Supported wallet flows
  include a browser-generated owner key and a Privy embedded owner wallet.
  Browser-generated keys require a backup and are stored in browser local
  storage; embedded-wallet recovery follows that wallet's flow. Hosted workers
  receive the restricted session grant, not the owner key. Session credentials
  can still authorize trades inside their permissions, so protecting them matters.
- **The chain enforces the caps that bound a loss.** The session key may only
  call contracts it names, may only move assets you sealed into it, may not send
  native ETH beyond its signed call permissions, and dies on schedule — all in the account contract. A
  compromised agent cannot reach an asset you did not name or a contract you did
  not approve. It can still make bad trades inside those bounds; no wall fixes
  judgement.
- **Verifiable, not claimed.** The dashboard links every address and cap to the
  block explorer, and its **prove the wall** button fires malicious intents (an
  oversized trade, a "send everything to 0xevil" transfer, an expired key)
  through the policy so you can watch each one bounce. Note what that does and
  does not show: it exercises the worker's own copy of the rules, so it proves
  the software agrees with itself. The chain-side proof is a real refused
  UserOp — see docs/.
- **The numbers are auditable too, not just the wall.** Every fact that moves
  money is mirrored into a hash-chained journal, so an edited record breaks
  every hash after it and a deleted one leaves a visible gap. `merrymen export`
  writes it out; `merrymen verify <file>` checks it — and reads nothing but the
  file it is handed, so it proves something to someone who does not trust you.
  Records that *cannot* be checked against a chain (a simulated fill, a deposit
  inferred from a balance change) are listed as such rather than quietly
  counted.

You verify; it trades.

---

## Check it yourself

Two commands. The second reads nothing but the file you hand it — not
`~/.merrymen`, not the settings, not the machine that produced it — so it is
checking the record against the **chain**, not against the operator.

```bash
npm run export -- --agent <address> > ledger.jsonl
```

```bash
npm run verify -- ledger.jsonl
```

`verify` re-fetches every receipt from a public RPC and re-derives what moved
from the logs, using its own implementation rather than sharing code with the
writer — so a bug in the writer cannot be confirmed by the reader. It returns
**INDETERMINATE**, not PASS, when a transaction cannot be refetched: a check it
could not run is not a check that passed.

Two limits, said out loud rather than discovered:

- **Epoch 1 is not exportable.** The rows before flow tracking existed cannot be
  reconciled against deposits, so the exportable record begins at the epoch
  boundary opened by the first arm after that. `export` emits no records for it
  and says so on stderr, rather than presenting rows it cannot stand behind.
- **A `Transfer` log is written by the token contract.** The verifier and the
  writer are independent implementations, but they read the same source, so a
  lying token would be confirmed by both. The post-buy `balanceOf` check
  (`worker/src/delivery.ts`) is what makes their agreement mean something.

---

## The workflow, end to end

1. **Install** it (one line — installs Node too if you need it).
2. **`merrymen start`** — opens the dashboard at `localhost:3100` and looses the
   24/7 worker.
3. **Create your agent wallet** in the app's creation flow or at `/grant` for
   self-hosted setup. Follow the backup/recovery steps for your ownership model
   and set the limits. Paper trading simulates execution; choosing a testnet is
   a separate network choice, not the paper/live switch.
4. **Fund it** — on **mainnet**, send ETH (gas) + USDG (capital) to the account
   address. On **testnet**, gas from the faucet and nothing else: USDG sent there
   is never shown and never traded. The worker arms itself on its next tick, no
   restart.
5. **(optional) Link Telegram** — chat with your merryman, give it a name, let it
   trade, report, alert, and control your PC — all inside the same walls.

Everything lives in **`~/.merrymen`** (settings, grant, ledger, your strategies,
your merryman's soul). The install is disposable; upgrades never touch your data.

**Start with paper mode.** When simulation is enabled, eligible intents can be
recorded as paper fills using observed market prices without spending real
funds. Paper results do not establish live fill quality. Adding a bundler key
alone does not enable live trading: enable Live explicitly and satisfy the
grant, funding and execution checks shown by the app. Upgrade any time with
`merrymen update` (stops the band, installs, restarts — no Windows file-lock).

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

**Already have Node 22.13+?**

```bash
npm install -g merrymen            # or: npm i -g github:millw14/merrymen
merrymen setup                     # checks node / npm / PATH, prints exact fixes
merrymen onboard                   # optional wizard: Pimlico key, strategy, basket (all skippable)
merrymen start                     # dashboard at localhost:3100 + the worker
```

Requires Node 22.13+ on the 22.x line, or Node 23.4+. `merrymen setup` diagnoses the two things that trip people
up — an old Node, and npm's global-bin folder missing from PATH.

> **`merrymen: command not found`?** npm's global-bin folder isn't on PATH. Use
> `npx merrymen start` (works everywhere), or add it once:
> - **Windows:** `[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";$env:APPDATA\npm", "User")` then reopen the terminal
> - **macOS/Linux:** put `$(npm prefix -g)/bin` on your `PATH` (in `~/.zshrc` / `~/.bashrc`)

> **Windows: `running scripts is disabled on this system` / `PSSecurityException`?**
> PowerShell's default `Restricted` policy blocks npm's and merrymen's `.ps1`
> shims. The installer now relaxes it for you; if you installed earlier, run once
> (no admin, current user only): `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
> Or just call `merrymen.cmd …` (or use cmd.exe / Git Bash) to skip the policy.

The dashboard binds to **localhost only** — it has no login and holds your
trading controls, so it isn't reachable from your network. To open it to a
trusted LAN (your phone on home WiFi), start with
`MERRYMEN_HOST=0.0.0.0 merrymen start`.

---

## 2 · Create & fund your agent wallet

Open `localhost:3100/grant`. There's nothing to connect — merrymen generates a
fresh account, shows you the owner key to **back up** (lose it and the funds are
gone), and lets you fund it. **Pick your ground:**

- **testnet · 46630** — the sandbox, one click away and no longer the default. Free **gas** from the faucet, and
  the grant, the caps, the policy checks, the live prices and the journal all run
  for real. Two things don't: the token registry is mainnet-only, so **any USDG
  you send to testnet reads as 0 and is never used**, and the trading venues
  aren't deployed there, so swaps simulate and no-route by design. Send gas, not
  capital — paper mode is already trading a simulated book at live prices.
- **mainnet · 4663** (default) — **real funds.** Real USDG, real Stock Tokens, real
  execution. The page makes you acknowledge it first: keys are generated and
  stored **in plain text on your machine** (TEE custody is on the roadmap), so
  treat the account like a hot wallet — your caps are the seatbelt, start small.
  No faucet: send ETH (gas) + USDG (capital) from your own wallet or an exchange.

Per-call size, the asset and contract permissions, signed native-value limits and
the key's expiry are enforced **by the account contract on every operation**.
The daily total, the drawdown breaker and the trades-per-day count live in the
worker — they tighten what the chain already allows, and a compromised worker
could ignore them, which is why the chain-side ceiling is the honest number to
plan against: **per-trade size, until the key expires**. The worker can tighten
within the wall but can never widen it without a new signed grant.

Trades-per-day was on the on-chain list here until 2026-08-30. It rested on
ZeroDev's rate-limit policy, and `eth_getCode` shows that contract has no code on
Robinhood Chain — mainnet or testnet — while the timestamp and call policies both
do. A policy pointing at an empty address is not a bound, so it was removed and
this sentence corrected rather than left to flatter the design.

> **Going live is one key.** To sign real trades, paste a free [Pimlico](https://dashboard.pimlico.io)
> API key in `/settings` — merrymen builds the bundler URL for your wallet's chain
> automatically, so it can never point at the wrong one. No key = **practice mode**:
> real market, full policy + simulation, no signing. Advanced users can still supply
> a full bundler URL (Alchemy or self-hosted) instead.

---

## 3 · Run it

```bash
merrymen start      # dashboard (localhost:3100) + the 24/7 worker
merrymen doctor     # node / keys / RPC / bundler / grant / db diagnostics
merrymen status     # heartbeat, grant, trades, equity
merrymen selftest   # one policy-legal no-op through the full pipeline
merrymen kill       # kill switch from the terminal (destroys the grant)
merrymen recover    # sweep the account's funds to a wallet you control
```

> **Getting your funds back out.** The address you funded is an ERC-4337 **smart
> account**, not a plain wallet — its owner key derives a *different* address, so
> importing that key into MetaMask shows an empty wallet, not your funds (this
> trips everyone up once). To move money out — including after a kill switch —
> run **`merrymen recover`**: it rebuilds the account from your owner key (or a
> backed-up key you paste) and sweeps every balance to any address you choose in
> one signed op. It needs a bundler key, same as live trading.

> **Getting a funded wallet back — without moving anything.** Killed the agent,
> wiped the browser, or moved machines? Your smart-account address is derived from
> the **owner key**, so the same key always reproduces the same account, funds and
> all. Two ways back in:
>
> 1. **Still on the same browser?** `/grant` shows *"this wallet isn't active"* —
>    hit **re-arm this wallet**. One click, no key needed.
> 2. **Fresh browser / new machine?** `/grant` → **restore a funded wallet** →
>    paste your owner key → **check this wallet** (it shows the derived address and
>    its balance so you can confirm it's the right one) → pick caps → restore. It
>    signs a brand-new session key on your existing account. **No funds move, no
>    gas is spent.**
>
> merrymen runs **one agent per install**. To run two funded wallets at once, give
> each its own `MERRYMEN_HOME` (e.g. `MERRYMEN_HOME=~/.merrymen-b merrymen start`).

The worker's loop each tick: **grant sync → market safety (prices, pauses,
sequencer) → strategy proposes → policy check → quote simulation → execute →
record**. It re-reads `~/.merrymen/settings.json` every tick, so changes from the
dashboard apply within one tick — connection changes re-arm the executor,
strategy changes rebuild in place; no restart. The dashboard shows live
positions, the trade record (with simulation receipts), the event feed, and a
kill switch; the public scoreboard is at `/scoreboard`.

Active workers schedule a decision review at least every five minutes, with
processing time accounted for instead of added to each interval. Brain's
`MERRYMEN_BRAIN_INTERVAL_SEC` accepts 60–300 seconds; older longer settings are
capped at 300. Live Brain enrollment also enables research, while shadow-only
enrollment still cannot execute trades. Pauses, signed limits, model budgets,
and market-data checks remain authoritative.

A quiet strategy can publish a conservative market review from observed quotes,
including what would change its view. Unread or stale prices do not become
invented theses. Operational failures remain in the owner's ledger and events.
Followed agents receive the public thesis, its paper/live label and execution
outcome; later decisions also receive their own prior theses. Provider outages
or slow reads can delay a review, and no cadence forces an otherwise invalid trade.

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

**Transfers are refused outright.** A wallet signed today registers no
withdrawal address, so its call policy carries no USDG transfer permission at
all — the chain would refuse the send, and the worker refuses it first rather
than paying gas to be told no. A prompt-injected "send everything to 0xevil"
gets a flat no before anything is built. Money leaves through your owner key
(`merrymen recover`), which no wall can block and no chat message can reach.

Wallets signed before the withdrawal allowlist landed do carry a transfer
permission; for those, `/transfer` still applies its own guards — off by
default, and every transfer echoes the full recipient address and waits for an
explicit `/confirm` (90s). Turn off all state-changing commands with the
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

## 5 · Ask Claude about your merryman

Hosted Merrymen has an MCP server, so Claude (and Codex, Cursor, VS Code, …)
can read your agent's status, trades and portfolio and explain why it has or
hasn't traded. One click for Claude: <https://app.merrymen.dev/connect/mcp>.

In **Claude Code**, run these one at a time:

```text
/plugin marketplace add https://github.com/millw14/merrymen.git
/plugin install merrymen@merrymen
```

then sign in once from `/mcp`, and use `/merrymen:status`, `/merrymen:why`,
`/merrymen:portfolio`, `/merrymen:week` and `/merrymen:token`. The assistant
only gets what you allow when you connect, and it can never move your funds,
see your keys or loosen your limits. Details: [docs/mcp](docs/mcp/README.md).

---

## Strategies

Pick one in `/settings` (or `/strategy <name>` from Telegram; `MERRYMEN_STRATEGY`
is the headless fallback):

| name | what it does |
|---|---|
| `steady-basket` (default) | DCA a weighted stock basket per tick; idle cash sweeps to the Morpho vault; pulls cash back when short |
| `weekend-gap` | Enter each leg when its Chainlink feed goes stale (market close), exit when it refreshes (open) — a strategy class that only exists on-chain |
| `llm-strategist` | Claude proposes typed buy/sell/hold at decision windows; deterministic code validates and disposes — the model never sees an address or emits calldata. Needs an Anthropic key |
| `even-keel` 🏹 | Keeps the basket at equal weight — trims winners, tops up laggards — to harvest mean reversion. **Merry Circle** (holder-only) |
| `dip-hunter` 🏹 | Concentrates each tick on the basket token furthest below its rolling high. **Merry Circle** (holder-only) |
| `trencher` | Memecoin discovery and position management with liquidity, momentum and exit checks; live execution and fast mode require separate opt-ins |

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

### Adding your own tokens (memecoins)

The built-in registry is the issuer-backed stock tokens — curated, Chainlink-priced.
Anything else on Robinhood Chain you add yourself in `/settings`: paste the symbol,
the contract address, and its decimals.

**How they're priced.** There's no Chainlink feed for a memecoin, so merrymen reads
the Uniswap v3 pool — but a spot price on a thin pool is worth nothing: anyone with
moderate capital can push it for a block, and that number would feed your equity,
your P&L and your drawdown breaker. So:

- **Valuation uses a 15-minute TWAP**, not spot. Moving it means holding the price
  away from the market for the whole window and eating the arbitrage.
- **Two guards, both yours to set.** A minimum pool depth (default $25,000) and a
  maximum spot-vs-average gap (default 5%). Live pools on this chain run from ~$3k
  to ~$1.2M, so the default admits the deep end and refuses the rest.
- **A refusal is the feature.** When a pool is too thin or is being pushed right
  now, the token stays *unpriced* and merrymen says why. Your agent keeps trading
  — you can always sell out — but equity, P&L and the breaker pause rather than
  running on a number nobody should trust.
- **Most memecoins here price through WETH.** About three quarters of the chain's
  pools quote against WETH rather than USDG, so the route is usually two hops. Its
  depth is the *shallower* leg — a deep WETH/USDG pool doesn't make a $3k memecoin
  pool safe.

Anything valued this way is marked **pool px** in the dashboard and in `/status`,
because it isn't the same quality of claim as a Chainlink feed and shouldn't look
like one.

Three explicit steps, and each one means something different:

1. **Add it** in `/settings` — "know about this." Your agent reads the balance,
   prices it, and shows it in your book. It does not trade it.
2. **Select it in the basket** — "trade this." Same act as picking a stock.
3. **Re-sign at `/grant`** — the tradable list is baked into the session key you
   signed, so widening it takes a signature. That's the wall doing its job, not a
   bug. Free, instant, same wallet, same address, same funds, same caps.

Until step 3, `/settings`, `/grant` and the event feed all say plainly which
tokens your key can't sell — you never find out from a reverted trade.

Most memecoins here have no direct USDG pool, so swaps route through WETH
automatically (`USDG → WETH → TOKEN`). The router holds the middle leg, so this
needs no extra approval and no extra re-sign.

### Keep it running

```bash
merrymen service install
```

Starts your merryman when you log in, and brings it back after a reboot. On
Windows it uses Task Scheduler where it can and the Startup folder where that
would need admin — a trading agent shouldn't be asking for elevation. macOS gets
a launchd agent, Linux a `systemd --user` unit with lingering enabled. All
user-scoped, all removed completely by `merrymen service uninstall`, and
`merrymen doctor` tells you whether it's installed *and* whether it's actually
running — those are different questions.

**What it does not do: run while the computer is off.** Nothing does except a
machine that stays on. If you want that, it's your own always-on box — we're not
going to hold your keys to do it for you.

The desktop app has the same thing as a tray toggle.

### Never a position you can't exit

Buying spends USDG, and every grant can approve USDG generically. **Selling needs
a per-token approval sealed into your signature.** So a token with a live pool but
no approval buys fine and can never be sold — the exit reverts, with your money
inside it.

merrymen refuses the buy. If your key can't sell something, it won't buy it, and
it tells you which symbols and why. A missed trade is recoverable; a position with
no way out is not. Re-sign at `/grant` to widen the list.

This is why the shipped allowlist is verified in **both directions** against live
pools — re-check it yourself any time:

```bash
npx tsx scripts/probe-tradability.mts
```

---

## $MERRYMEN — the Merry Circle

merrymen is **free and open to everyone**, whether you hold the token or not. Holding
**$MERRYMEN** (on Robinhood Chain — [the token page](https://merrymen.dev/token)) just adds
holder perks — it buys *access*, never the product. **Utility only: no price, no returns, no
buyback/burn.**

Paste the wallet you hold $MERRYMEN in into the dashboard's **Merry Circle** panel (or set
`holderAddress` in `/settings`). merrymen reads that balance **read-only** — it never asks for or
touches the wallet's keys — and sets your tier:

| tier | hold | perk |
|---|---|---|
| 🌱 **Villager of Sherwood** | 10k+ | **10% off** the platform performance fee · badge · 1× roadmap vote |
| 🏹 **Merry Man** | 100k+ | **25% off** · the bonus strategy pack (`even-keel`, `dip-hunter`) · 3× vote |
| 👑 **Lord of Sherwood** | 1M+ | **50% off** — the lowest we offer · every bonus strategy · 10× vote |

The fee discount is real: merrymen's performance fee is only ever taken on profit above your
high-water mark, and your tier lowers it in the **actual accrual** (shown live in the panel), not
just in the copy. Holders also steer the roadmap — which tokens join the basket, which strategies
ship — weighted by tier ([governance](https://merrymen.dev/governance)). Thresholds live in
[`packages/core/src/token.ts`](./packages/core/src/token.ts).

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
- `services/brain` — Python research service: evidence evaluation, structured
  decisions and model budgets; execution remains in the worker.
- `site` — public website and current brand assets.
- `sdk` — client SDK and build tooling.
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
| `MERRYMEN_BUNDLER_API_KEY` | — | Pimlico API key; the bundler URL is built for your grant's chain automatically |
| `MERRYMEN_BUNDLER_URL` | — | advanced: full 4337 bundler RPC (overrides the key); without either, execution is stubbed |
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
