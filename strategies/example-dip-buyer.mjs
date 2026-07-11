/**
 * Example strategy — copy me and make me yours:
 *
 *   merrymen strategy new my-bot     # scaffolds ~/.merrymen/strategies/my-bot.mjs
 *   # edit it, pick "my-bot" in /settings (or `merrymen onboard`) — done
 *
 * The contract: default-export { name, tick(snapshot, ctx) }. Every tick
 * (~60s) you get the world and return an array of intents — what you WANT.
 * You never execute anything:
 *
 *   your intents → shape validation → policy wall (per-trade cap, daily cap,
 *   ops cap, drawdown breaker, allowlists) → quote simulation → the on-chain
 *   session-key wall. Your code cannot exceed the caps the user signed.
 *
 * No imports needed — `ctx` injects the verified registry:
 *   ctx.tokenBySymbol.QQQ          token address by symbol
 *   ctx.CASH.USDG                  the cash leg
 *   ctx.UNISWAP.swapRouter02       swap router (or ctx.RIALTO.routerSnapshot)
 *   ctx.MORPHO.steakhouseUsdgVault the yield vault
 *   ctx.usdg(25)                   25 → 25_000_000n (USDG is 6dp)
 *
 * snapshot fields:
 *   cashUsdg, vaultUsdg            bigint, USDG 6dp
 *   holdings                       Map<symbol, { token, rawBalance(18dp), valueUsdg(6dp), priceStale }>
 *   prices                         Map<symbol, { price8(8dp USD), stale }>
 *   pausedTokens, staleFeeds       Set — stale is EXPECTED nights/weekends (24/5 feeds, 24/7 tokens)
 *   sequencerUp                    boolean — respect it
 *
 * Edits hot-reload on the next tick. A thrown error or malformed intent just
 * skips the tick with the reason in the activity feed — you can't crash the
 * worker, and you can't exceed the wall.
 */

const WATCHED = "QQQ"; // the stock with real Uniswap v3 liquidity today
const DIP_BPS = 200n; // buy 2% under the slow reference price
const state = { referencePrice8: 0n }; // survives between ticks (not restarts)

export default {
  name: "example-dip-buyer",

  /**
   * @param {object} snap  market + account snapshot (see header)
   * @param {object} ctx   injected registry + helpers (see header)
   * @returns {Array}      intents; [] = do nothing this tick
   */
  tick(snap, ctx) {
    if (!snap.sequencerUp) return [];

    const token = ctx.tokenBySymbol[WATCHED];
    if (!token || snap.pausedTokens.has(token.toLowerCase())) return [];

    const price = snap.prices.get(WATCHED);
    if (!price || price.stale) return []; // no fresh reference → no opinion

    // Slow EMA-ish reference: 95% old, 5% new.
    state.referencePrice8 =
      state.referencePrice8 === 0n
        ? price.price8
        : (state.referencePrice8 * 95n + price.price8 * 5n) / 100n;

    const clip = ctx.usdg(10); // 10 USDG per buy
    const dipLine = (state.referencePrice8 * (10000n - DIP_BPS)) / 10000n;
    if (price.price8 >= dipLine) return []; // not a dip
    if (snap.cashUsdg < clip) return []; // can't afford the clip

    return [
      {
        kind: "swap",
        target: ctx.UNISWAP.swapRouter02,
        sellToken: ctx.CASH.USDG, // buying: sell USDG…
        buyToken: token, // …for the stock token
        sellAmountRaw: clip, // raw units of sellToken (USDG = 6dp)
        notionalUsdg: clip, // what the policy caps judge
      },
    ];

    // Other intents you can return:
    //   sell everything:  { kind: "swap", target: ctx.UNISWAP.swapRouter02,
    //                       sellToken: token, buyToken: ctx.CASH.USDG,
    //                       sellAmountRaw: snap.holdings.get(WATCHED).rawBalance,
    //                       notionalUsdg: snap.holdings.get(WATCHED).valueUsdg }
    //   park cash:        { kind: "vault-deposit",  target: ctx.MORPHO.steakhouseUsdgVault, amountUsdg: ctx.usdg(50) }
    //   pull cash:        { kind: "vault-withdraw", target: ctx.MORPHO.steakhouseUsdgVault, amountUsdg: ctx.usdg(50) }
    // tick may be async (return a Promise) if you fetch external signals.
  },
};
