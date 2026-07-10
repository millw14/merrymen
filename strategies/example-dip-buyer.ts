/**
 * Example custom strategy — copy this file, rename it, make it yours:
 *
 *   cp strategies/example-dip-buyer.ts strategies/my-bot.ts
 *   # then select "my-bot" in /settings (or: merrymen onboard)
 *
 * The contract: default-export { name, tick }. Every tick (~60s) you get a
 * Snapshot of the world and return an array of intents — what you WANT to do.
 * You never execute anything:
 *
 *   your intents → shape validation → policy wall (per-trade cap, daily cap,
 *   ops cap, drawdown breaker, allowlists) → quote simulation → the on-chain
 *   session-key wall. Your code cannot exceed the caps the user signed.
 *
 * Edits to this file hot-reload on the next tick. A thrown error or a bad
 * intent just skips the tick with the reason in the activity feed.
 *
 * Units cheat-sheet:
 *   USDG amounts   → bigint, 6 decimals  (25 USDG = 25_000_000n)
 *   stock balances → bigint, 18 decimals (raw; multiply by uiMultiplier/1e18 for shares)
 *   prices         → bigint, 8 decimals  (Chainlink USD; $214.50 = 21_450_000_000n)
 */

// Types come from the worker; addresses come from the shared registry.
import type { Snapshot } from "../worker/src/strategies/types";
import type { TradeIntent } from "../worker/src/policy";
import { CASH, STOCK_TOKENS, UNISWAP } from "../packages/core/src";

const USDG = CASH.USDG as `0x${string}`;
const ROUTER = UNISWAP.swapRouter02 as `0x${string}`; // or RIALTO.routerSnapshot
const WATCHED = "QQQ"; // the only stock with real Uniswap v3 liquidity today
const TOKEN = STOCK_TOKENS.find((t) => t.symbol === WATCHED)!.address;

/** Dip buyer: track a slow reference price; buy a fixed clip when spot is 2% under it. */
const CLIP_USDG = 10_000_000n; // 10 USDG per buy
const DIP_BPS = 200n; // buy 2% below reference
const state = { referencePrice8: 0n }; // module state survives between ticks (not restarts)

export default {
  name: "example-dip-buyer",

  tick(snap: Snapshot): TradeIntent[] {
    // Respect the world: no trading when the sequencer is down or the token is paused.
    if (!snap.sequencerUp) return [];
    if (snap.pausedTokens.has(TOKEN.toLowerCase())) return [];

    const price = snap.prices.get(WATCHED);
    if (!price || price.stale) return []; // no fresh reference price → no opinion

    // Slow EMA-ish reference: 95% old, 5% new.
    state.referencePrice8 =
      state.referencePrice8 === 0n
        ? price.price8
        : (state.referencePrice8 * 95n + price.price8 * 5n) / 100n;

    const dipThreshold = (state.referencePrice8 * (10_000n - DIP_BPS)) / 10_000n;
    if (price.price8 >= dipThreshold) return []; // not a dip
    if (snap.cashUsdg < CLIP_USDG) return []; // can't afford the clip

    return [
      {
        kind: "swap",
        target: ROUTER,
        sellToken: USDG, // buying: sell USDG…
        buyToken: TOKEN, // …for the stock token
        sellAmountRaw: CLIP_USDG, // raw units of sellToken (USDG = 6dp)
        notionalUsdg: CLIP_USDG, // what the policy caps judge
      },
    ];

    // Other things you can return:
    //   sell:          { kind: "swap", target: ROUTER, sellToken: TOKEN, buyToken: USDG,
    //                    sellAmountRaw: snap.holdings.get(WATCHED)!.rawBalance,   // 18dp shares
    //                    notionalUsdg: snap.holdings.get(WATCHED)!.valueUsdg }
    //   park cash:     { kind: "vault-deposit",  target: MORPHO.steakhouseUsdgVault, amountUsdg: 50_000_000n }
    //   pull cash:     { kind: "vault-withdraw", target: MORPHO.steakhouseUsdgVault, amountUsdg: 50_000_000n }
    // tick may also be async (return Promise<TradeIntent[]>) if you fetch signals.
  },
};
