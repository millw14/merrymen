/**
 * $MERRYMEN — the token, and the "Merry Circle" holder-utility layer.
 *
 * STANCE (do not drift): utility only. Nothing here — or in any copy that renders
 * these tiers — promises price, returns, buybacks, or burns. Holding earns you
 * ACCESS and a lower platform fee, full stop. merrymen itself stays free, open,
 * and self-hosted whether you hold or not; the token buys perks, never the product.
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
