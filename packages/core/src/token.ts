/**
 * $MERRYMEN — the token, and the "Merry Circle" holder-utility layer.
 *
 * STANCE (do not drift): utility only. Nothing here — or in any copy that renders
 * these tiers or ENERGY — promises price, returns, buybacks, or burns. Holding
 * earns ACCESS: a lower platform fee, the bonus strategies and, on the hosted
 * service, full ENERGY — the daily capacity an agent has for paid AI reviews and
 * the new trades it starts on its own (energy.ts). Hosted merrymen stays usable
 * without the token, on about a tenth of that capacity, and nothing ever limits
 * stop-losses, take-profits or the owner's own orders (the agent's own AI
 * reviews, of its open positions too, are paced). merrymen stays open source and
 * self-hostable; the energy gate is an operator switch (MERRYMEN_ENERGY_GATE),
 * off unless turned on, and never on for a self-hosted install.
 *
 * This replaces an earlier line — "the token buys perks, never the product". On
 * the hosted service it now buys capacity, and copy must say so plainly rather
 * than keep a sentence that stopped being true.
 *
 * The one material perk is a discount on the platform PERFORMANCE fee (the fee is
 * only ever taken on profit above the high-water mark; see worker/src/fees.ts).
 * Everything else is identity (a tier + badge), agency (governance weight), and a
 * bonus strategy pack. Tiers are read from an on-chain balanceOf — verifiable,
 * not claimed.
 *
 * Thresholds below are the SINGLE SOURCE OF TRUTH and are meant to be tuned; they
 * are round placeholders, not calibrated to any supply or price.
 */

/**
 * Where the Merry Circle gateway actually lives — the ONE place this is written.
 *
 * The gateway is the holder-utility layer in practice: it fronts the LLM and
 * Bitquery so a holder needs no keys of their own. Its hostname was previously
 * duplicated across the provider registry, the CLI's provider table and the
 * Bitquery client, which meant moving it was four edits and a test, and missing
 * one left some paths pointing at a host that wasn't serving.
 *
 * CURRENTLY the Railway service URL. `ai.merrymen.dev` is registered and its DNS
 * is correct, but Railway hasn't issued the Let's Encrypt certificate yet, so
 * TLS on that name resets. Both hostnames route to the same service — switch
 * this line back once the cert lands and every path follows.
 */
export const MERRYMEN_GATEWAY_ORIGIN = "https://merrymen-gateway-production.up.railway.app";

/** The token, on the same chain the agents trade (Robinhood Chain mainnet). */
export const MERRYMEN_TOKEN = {
  symbol: "MERRYMEN",
  address: "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32" as `0x${string}`,
  decimals: 18,
  chainId: 4663,
} as const;

export type CircleTierId = "outsider" | "villager" | "merryman" | "lord";

export interface CircleTier {
  id: CircleTierId;
  /** Sherwood-flavoured tier name. */
  name: string;
  emoji: string;
  /** Whole $MERRYMEN required to reach this tier (inclusive). */
  minTokens: number;
  /** Discount off the platform performance fee, in bps (2_500 = 25% off). */
  feeDiscountBps: number;
  /** Governance weight when signalling on basket/strategy proposals. */
  voteWeight: number;
  /** Does this tier unlock the holder-only "Merry Circle" strategy pack? */
  bonusStrategies: boolean;
  /** Plain-language perks, in display order. */
  perks: string[];
}

/**
 * Tiers, ascending. `outsider` is the non-holder baseline so callers always get a
 * tier back. Keep this sorted by minTokens ascending — tierForBalance relies on it.
 */
export const CIRCLE_TIERS: readonly CircleTier[] = [
  {
    id: "outsider",
    name: "Traveller",
    emoji: "🧭",
    minTokens: 0,
    feeDiscountBps: 0,
    voteWeight: 0,
    bonusStrategies: false,
    // NEUTRAL, ON PURPOSE. /api/circle hands every tier's perks to the web,
    // iOS and Android as they are, whatever MERRYMEN_ENERGY_GATE says — and the
    // gate is off until an operator turns it on (then 'observe' for a day). A
    // perk saying outsiders run on a tenth told every non-holder they were
    // throttled when nothing was limited, and nudged them to buy. Energy is
    // said only where the gate is known to be on (CreateAgent, Settings, the
    // worker's own report).
    perks: ["merrymen is free and open to everyone — hold $MERRYMEN to join the Circle"],
  },
  {
    id: "villager",
    name: "Villager of Sherwood",
    emoji: "🌱",
    minTokens: 10_000,
    feeDiscountBps: 1_000, // 10% off the performance fee
    voteWeight: 1,
    bonusStrategies: false,
    perks: [
      "10% off the platform performance fee",
      "Circle badge in your dashboard",
      "1× vote on basket & strategy proposals",
    ],
  },
  {
    id: "merryman",
    name: "Merry Man",
    emoji: "🏹",
    minTokens: 100_000,
    feeDiscountBps: 2_500, // 25% off
    voteWeight: 3,
    bonusStrategies: true,
    perks: [
      "25% off the platform performance fee",
      "The Merry Circle bonus strategy pack",
      "3× vote on basket & strategy proposals",
      "Priority in the roadmap queue",
    ],
  },
  {
    id: "lord",
    name: "Lord of Sherwood",
    emoji: "👑",
    minTokens: 1_000_000,
    feeDiscountBps: 5_000, // 50% off
    voteWeight: 10,
    bonusStrategies: true,
    perks: [
      "50% off the platform performance fee — the lowest merrymen offers",
      "Every bonus strategy, plus early access to new ones",
      "10× vote on basket & strategy proposals",
      "First look at features before they ship",
    ],
  },
] as const;

/** Whole tokens (floor) held at a raw 18-dp balance. */
export function wholeTokens(rawBalance: bigint): number {
  return Number(rawBalance / 10n ** BigInt(MERRYMEN_TOKEN.decimals));
}

/** Highest tier a raw on-chain balance qualifies for. Never null (outsider floor). */
export function tierForBalance(rawBalance: bigint): CircleTier {
  const whole = wholeTokens(rawBalance);
  let tier = CIRCLE_TIERS[0]!;
  for (const t of CIRCLE_TIERS) {
    if (whole >= t.minTokens) tier = t;
  }
  return tier;
}

/** The next tier up (for "hold N more to reach…"), or null at the top. */
export function nextTier(tier: CircleTier): CircleTier | null {
  const i = CIRCLE_TIERS.findIndex((t) => t.id === tier.id);
  return i >= 0 && i < CIRCLE_TIERS.length - 1 ? CIRCLE_TIERS[i + 1]! : null;
}

/**
 * The performance-fee bps actually applied for a tier — the base fee reduced by
 * the tier's discount. Pure and floored; the worker calls this each tick so the
 * discount shows up in the real accrual, not just in marketing.
 */
export function effectivePerfFeeBps(baseFeeBps: number, tier: CircleTier): number {
  const kept = 10_000 - tier.feeDiscountBps;
  return Math.floor((baseFeeBps * kept) / 10_000);
}
