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

## Run it

Self-hosted, terminal-first. You bring the keys; your machine runs the band.

```bash
git clone https://github.com/millw14/merrymen && cd merrymen
npm install
npm run onboard     # wizard: bundler URL, API keys, strategy, basket
npm start           # dashboard at localhost:3100 + the 24/7 worker
```

Then sign the permission wall at `localhost:3100/grant` (MetaMask, testnet
46630), grab gas from the faucet, and check the stack anytime:

```bash
npx merrymen doctor     # node/keys/RPC/bundler/grant/db diagnostics
npx merrymen status     # heartbeat, grant, trades, equity
npx merrymen selftest   # one policy-legal no-op through the full pipeline
npx merrymen kill       # kill switch from the terminal
```

## Write your own bot

Your strategies live in [`strategies/`](./strategies) — hot-reloaded on save,
crash-isolated, and incapable of exceeding the caps the user signed (every
intent passes shape validation → the policy wall → quote simulation → the
on-chain session key). Scaffold one and go:

```bash
npx merrymen strategy new my-bot   # drops a commented template
# edit strategies/my-bot.ts, select "my-bot" in /settings — done
```

See [strategies/README.md](./strategies/README.md) for the contract and
[strategies/example-dip-buyer.ts](./strategies/example-dip-buyer.ts) for a
fully commented walkthrough.

<details>
<summary>manual run (without the CLI)</summary>

```bash
npm run dev -w @merrymen/web -- -p 3100   # dashboard at localhost:3100
npm run dev -w @merrymen/worker           # the 24/7 loop
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
| `ANTHROPIC_API_KEY` | — | enables the LLM strategist's Claude driver (`MERRYMEN_LLM_MODEL`, `MERRYMEN_LLM_INTERVAL_MIN`, `MERRYMEN_LLM_MAX_ACTION_USDG` tune it) |

`npm run typecheck` and `npm test` cover the policy mirror, strategy, venue
math (slippage, quote selection, calldata), and the ERC-8056 invariant that a
stock split is not a crash.

Plan: `../agent-trading-platform-plan.md`. Architecture rule of the house:
**the LLM proposes, deterministic code disposes** — no model ever constructs
calldata or bypasses the policy layer.
