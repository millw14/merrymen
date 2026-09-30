/**
 * Dip Hunter — a Merry Circle (holder-only) strategy.
 *
 * Instead of spreading the tick's budget evenly, it concentrates it on the one
 * basket token that has fallen furthest below its recent high — buying weakness.
 * Stateful by design: it keeps a rolling per-symbol high across ticks (the only
 * strategy that does), which is why it lives behind the Circle. Buys only; every
 * intent still clears the policy wall.
 */

import type { TradeIntent } from "../policy";
import { breakerIdle, opsSpent, type Snapshot, type Strategy, type Tick } from "./types";

export interface DipHunterConfig {
  legs: { symbol: string; token: `0x${string}` }[];
  swapRouter: `0x${string}`;
  usdg: `0x${string}`;
  /** USDG committed to the single deepest dip each tick. */
  buyPerTickUsdg: bigint;
  /** Minimum drawdown from the rolling high (bps) before it's a "dip" worth buying. */
  minDipBps: number;
}

/** Factory — holds the rolling highs in a closure (state the snapshot can't carry). */
export function makeDipHunter(cfg: DipHunterConfig): Strategy {
  const highs = new Map<string, bigint>();

  return {
    name: "dip-hunter",
    tick(snap: Snapshot): Tick {
      if (!snap.sequencerUp) return { intents: [], why: [] };
      if (snap.cashUsdg < cfg.buyPerTickUsdg) {
        // SILENT UNTIL NOW, AND WORSE THAN STEADY-BASKET'S VERSION OF IT: this
        // strategy emits no vault-withdraw anywhere, so once cash drifts under
        // one buy nothing clears it and the agent is finished — with no
        // sentence and no way back on its own. reasons.ts named this exact case
        // and already renders the vault figure and the remedy alongside it.
        return {
          intents: [],
          why: [],
          idle: {
            code: "under-one-buy",
            cashRaw: snap.cashUsdg,
            needRaw: cfg.buyPerTickUsdg,
            vaultRaw: snap.vaultUsdg,
          },
        };
      }

      // `symbol` rides along so the reason can name the leg, and `priced` counts
      // how many it actually had a fresh price for — 'deepest of the 3 I priced'
      // is a claim we can back; 'the deepest' alone is not.
      let best: { token: `0x${string}`; symbol: string; dipBps: number } | null = null;
      let priced = 0;

      for (const leg of cfg.legs) {
        const p = snap.prices.get(leg.symbol);
        if (!p || p.stale) continue; // no fresh price → skip (updates resume when live)
        if (snap.pausedTokens.has(leg.token.toLowerCase())) continue;
        priced += 1;

        const prevHigh = highs.get(leg.symbol) ?? 0n;
        const high = p.price8 > prevHigh ? p.price8 : prevHigh;
        highs.set(leg.symbol, high);
        if (high === 0n) continue;

        const dipBps = Number(((high - p.price8) * 10_000n) / high);
        if (dipBps >= cfg.minDipBps && (!best || dipBps > best.dipBps)) {
          best = { token: leg.token, symbol: leg.symbol, dipBps };
        }
      }

      /**
       * THE DAY'S TRADE COUNT, checked AFTER the price loop and never before it.
       *
       * With `maxOpsPerDay` used up the wall refuses every buy with `ops-cap`,
       * so proposing one is a refusal a tick. But the loop above is also where
       * the rolling highs are kept, and returning ahead of it would freeze them
       * for as long as the count stays spent — the first dip after it frees
       * would then be measured against a stale peak, which is a different
       * strategy from the one the owner picked.
       *
       * Ahead of `!best`, so the sentence does not flicker with the price: a
       * dip appearing and vanishing tick to tick would otherwise alternate
       * "ops-spent" with silence, and every change is an event to the owner.
       */
      if (opsSpent(snap)) return { intents: [], why: [], idle: { code: "ops-spent" } };
      // The drawdown breaker, on the same terms and for the same reasons: after
      // the loop so the highs keep moving, ahead of `!best` so the sentence
      // does not flicker with the price. This strategy only ever buys, so
      // tripped, there is nothing it may propose.
      const brake = breakerIdle(snap);
      if (brake) return { intents: [], why: [], idle: brake };

      if (!best) {
        /**
         * NOTHING PRICED IS NOT "NO DIP WAS DEEP ENOUGH".
         *
         * Every Chainlink equity feed is stale outside US market hours —
         * roughly 15.5 hours of every weekday plus the whole weekend — and a
         * stale leg is skipped above, so `priced` reaches zero and this
         * returned a tick byte-identical to a healthy quiet one. The agent
         * never got a price to measure a dip against, which is a fact about the
         * feeds and not about the market. A stale basket does NOT make the tick
         * "market unreadable" either (that needs every price missing), so
         * nothing else in the system reported it.
         *
         * `priced > 0` genuinely is "I looked and none were deep enough", and
         * that case stays quiet — it is the strategy working as designed.
         */
        const paused = cfg.legs.filter((l) => snap.pausedTokens.has(l.token.toLowerCase())).length;
        return priced === 0 && cfg.legs.length > 0
          ? { intents: [], why: [], idle: { code: "all-legs-stale", legs: cfg.legs.length, paused } }
          : { intents: [], why: [] };
      }
      /**
       * SIZED TO THE SIGNATURE, which this strategy never consulted.
       *
       * `snap.perTradeCapUsdg` is the cap sealed into the owner's grant and
       * `spendHeadroomUsdg` is what is left of the day; steady-basket honours
       * the first and trencher skips anything above either, while dip-hunter
       * proposed `buyPerTickUsdg` flat. An owner whose size per trade sits
       * above their signed cap therefore had every intent refused by their own
       * key, on every tick, for the life of the grant — and a tape of rejected
       * rows reads as a fussy agent rather than a mis-sized one.
       *
       * Clamping widens nothing: the wall is still the authority and still
       * refuses whatever it would have refused. It stops proposing what is
       * already known to be impossible.
       */
      const cap = snap.perTradeCapUsdg < snap.spendHeadroomUsdg ? snap.perTradeCapUsdg : snap.spendHeadroomUsdg;
      const size = cfg.buyPerTickUsdg < cap ? cfg.buyPerTickUsdg : cap;
      if (size <= 0n) {
        // The day's budget is spent, or the signed cap is zero. Either way
        // there is nothing to propose and the owner should hear which.
        return {
          intents: [],
          why: [],
          idle: {
            code: "under-one-buy",
            cashRaw: snap.cashUsdg,
            needRaw: cfg.buyPerTickUsdg,
            vaultRaw: snap.vaultUsdg,
          },
        };
      }
      return {
        intents: [
          {
            kind: "swap",
            target: cfg.swapRouter,
            sellToken: cfg.usdg,
            buyToken: best.token,
            sellAmountRaw: size,
            notionalUsdg: size,
          },
        ],
        why: [
          {
            code: "dip",
            symbol: best.symbol,
            dipBps: best.dipBps,
            priced,
            // THE SIZE ACTUALLY PROPOSED, not the configured one. They differ
            // whenever the signed cap or the day's headroom is the binding
            // constraint, and a reason that quotes the setting instead of the
            // intent describes a trade nobody made.
            usdgRaw: size,
            // And whether the wall is why it differs. `buyPerTickUsdg` is the
            // owner's setting; a shrink from it here can only be the signed cap
            // or the day's headroom, because nothing else applies between them.
            capped: size < cfg.buyPerTickUsdg,
          },
        ],
      };
    },
  };
}
