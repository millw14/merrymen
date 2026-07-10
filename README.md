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
  live positions, trade record (simulation receipts included), and kill switch.
- `worker` — Node runtime: grant sync → scheduler → strategy tick → policy
  check → simulate → execute → record.

## Run it

```bash
npm install
npm run dev -w @merrymen/web -- -p 3100   # dashboard at localhost:3100
npm run dev -w @merrymen/worker           # the 24/7 loop
```

Sign a grant at `/grant` (testnet 46630); the worker arms itself on its next
tick — no restart. The kill switch on the dashboard destroys the grant and the
worker halts on its next tick; hard on-chain expiry is the backstop.

Worker env:

| var | default | meaning |
|---|---|---|
| `MERRYMEN_BUNDLER_URL` | — | 4337 bundler RPC; without it execution is stubbed (policy/simulation still run) |
| `MERRYMEN_SWAP_VENUE` | `uniswap` | `uniswap` = full quote→swap leg via SwapRouter02; `rialto` = approval-only until API onboarding |
| `MERRYMEN_SLIPPAGE_BPS` | `100` | max slippage vs the QuoterV2 simulation |
| `MERRYMEN_GRANT_FILE` | `.data/grant.json` | grant handoff written by the web app |

`npm run typecheck` and `npm test` cover the policy mirror, strategy, venue
math (slippage, quote selection, calldata), and the ERC-8056 invariant that a
stock split is not a crash.

Plan: `../agent-trading-platform-plan.md`. Architecture rule of the house:
**the LLM proposes, deterministic code disposes** — no model ever constructs
calldata or bypasses the policy layer.
