# merrymen

Autonomous trading agents for Robinhood Chain. Your band works Sherwood 24/7 —
trading Stock Tokens, farming yield, LPing — inside hard on-chain permission
walls you set and can see.

**The five promises:** your keys, your caps · bounded worst case · every trade
simulated first · fees only on profit above high-water mark · honest scoreboard.

## Layout

- `packages/core` — chain constants, token registry, shared types. Every address
  is probed on-chain before it lands here.
- `web` — Next.js app: onboarding, permission-grant flow, agent dashboard.
- `worker` — Node runtime: scheduler → strategy tick → policy check → simulate →
  execute → record.

Plan: `../agent-trading-platform-plan.md`. Architecture rule of the house:
**the LLM proposes, deterministic code disposes** — no model ever constructs
calldata or bypasses the policy layer.
