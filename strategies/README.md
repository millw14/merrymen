# write your own bot

Your strategies live in **`~/.merrymen/strategies/`** — outside the install,
so upgrades and reinstalls never touch them. Scaffold one:

```bash
merrymen strategy new my-bot
# edit ~/.merrymen/strategies/my-bot.mjs, select "my-bot" in /settings — done
```

(This folder in the package only ships the example + this doc; `merrymen
onboard` copies them into your home folder.)

## The contract

```js
export default {
  name: "my-bot",
  tick(snapshot, ctx) {
    // return an array of intents (or a Promise of one); [] = do nothing
  },
};
```

No imports needed — `ctx` injects the verified registry and helpers:
`ctx.tokenBySymbol.QQQ`, `ctx.CASH.USDG`, `ctx.UNISWAP.swapRouter02`,
`ctx.RIALTO.routerSnapshot`, `ctx.MORPHO.steakhouseUsdgVault`,
`ctx.STOCK_TOKENS`, and `ctx.usdg(25)` → `25_000_000n`.

`snapshot` gives you `cashUsdg`, `vaultUsdg`, `holdings` (per-symbol raw
balance + USDG value + staleness), `prices` (Chainlink, stale-flagged),
`pausedTokens`, `staleFeeds`, `sequencerUp`. Units: USDG = 6dp bigint,
stock balances = 18dp bigint, prices = 8dp bigint.

See [example-dip-buyer.mjs](./example-dip-buyer.mjs) for a fully commented
walkthrough including sell / vault intents.

## What you can rely on

- **Hot reload** — save the file, it applies on the next tick. No restarts.
- **Crash isolation** — a thrown tick or malformed intent skips the tick with
  the reason in the dashboard activity feed. The worker never dies on your bug.
- **You cannot exceed the wall** — every intent is shape-validated, then passes
  the policy layer (per-trade/daily/ops caps, drawdown breaker, allowlists),
  quote simulation, and the on-chain session-key policies the user signed.
  Your strategy proposes; deterministic code disposes.

## Rules of the house

- Strategy names are plain tokens (`[A-Za-z0-9_-]`) — the filename is the name.
- Never put API keys in a strategy file; use `/settings`.
- Feed staleness is *expected* on nights/weekends (24/5 Chainlink feeds on 24/7
  tokens) — it's a signal, not an error. That gap is where the native
  strategies live.
