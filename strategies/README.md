# strategies/ — write your own bot

Drop a `.ts` / `.mjs` / `.js` file here, default-export `{ name, tick }`, and
select it by filename in `/settings` (or during `npm run onboard`). Scaffold
one with:

```bash
npx merrymen strategy new my-bot
```

## The contract

```ts
export default {
  name: "my-bot",
  tick(snapshot) {
    // return TradeIntent[] (or a Promise of one)
  },
};
```

`snapshot` gives you: `cashUsdg`, `vaultUsdg`, `holdings` (per-symbol raw
balance + USDG value + staleness), `prices` (Chainlink, 8dp, stale-flagged),
`pausedTokens`, `staleFeeds`, `sequencerUp`. See
[example-dip-buyer.ts](./example-dip-buyer.ts) for a fully commented walkthrough
including the units cheat-sheet (USDG = 6dp bigint, shares = 18dp, prices = 8dp).

## What you can rely on

- **Hot reload** — save the file, it applies on the next tick. No restarts.
- **Crash isolation** — a thrown tick or malformed intent skips the tick and
  puts the reason in the dashboard activity feed. The worker never dies on
  your bug.
- **You cannot exceed the wall** — every intent you return is shape-validated,
  then passes the policy layer (per-trade/daily/ops caps, drawdown breaker,
  asset/target allowlists), quote simulation, and the on-chain session-key
  policies the user signed. Your strategy proposes; deterministic code
  disposes. There is no code path from here to raw calldata.

## Rules of the house

- Strategy names are plain tokens (`[A-Za-z0-9_-]`) — the filename is the name.
- Never put API keys in a strategy file; use `/settings`.
- Feed staleness is *expected* on nights/weekends (24/5 Chainlink feeds on 24/7
  tokens) — it's a signal, not an error. That gap is where the native
  strategies live.
