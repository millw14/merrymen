/**
 * ONE DIAL INSTEAD OF SIX — AND AN HONEST ACCOUNT OF WHAT IT CANNOT MOVE.
 *
 * From the beta, and it is the right complaint: "would it be helpful for
 * beginners to have risk level bar or options rather than setting trade limit
 * or trades per day". Somebody opening this product for the first time is asked
 * for a per-trade cap, a daily cap, a slippage tolerance in basis points, a
 * price-impact ceiling also in basis points, a stop-loss, a take-profit and a
 * size per tick — seven numbers, in three different units, before they have any
 * idea what a normal value looks like.
 *
 * They do not have a view on 300 basis points of price impact. They have a view
 * on how much they mind losing money.
 *
 * WHAT A LEVEL CAN AND CANNOT DO, because this is the part a risk selector
 * usually gets wrong. Six of those dials are SETTINGS: the worker re-reads them
 * every tick and changing one costs nothing. Two of them — the per-trade and
 * per-day caps — are SEALED INTO THE SIGNATURE, enforced on-chain by a key that
 * was signed once, and no setting can move them. A selector that silently left
 * those behind would tell a careful owner they were careful while the wall
 * still permitted the old size; a selector that pretended to change them would
 * be lying about the only limits that are actually enforced.
 *
 * So a level returns the settings it moves AND names the caps it cannot, and
 * the caller is expected to say so. `capsNeedResign` is not advisory.
 *
 * THE SHAPE OF THE LADDER. Size first, because how much is at stake in one
 * trade is the risk a beginner actually means. Then the exits: careful takes
 * profit sooner and cuts sooner; bold gives a position room to be wrong, which
 * is not recklessness but the recognition that a tight floor on a volatile book
 * pays the spread to be stopped out by noise. Then the execution tolerances,
 * which decide how much of the price you give away to get filled at all.
 *
 * PURE. Given a level, returns numbers. No I/O, no settings read, no opinion
 * about what is currently set.
 */

export type RiskLevel = "careful" | "balanced" | "bold";

/** The settings keys a level writes. Every one is accepted by PUT /api/settings. */
export interface RiskSettings {
  /** Sell a holding this far below what it cost, bps. */
  strategistStopLossBps: number;
  /** Sell one this far above what it cost, bps. */
  takeProfitBps: number;
  /** USDG the basket strategy deploys each tick. */
  buyPerTickUsdg: number;
  /** The strategist's own ceiling per action, USDG — min'd against the sealed cap. */
  llmMaxActionUsdg: number;
  /** Refuse a fill worse than this off the quote, bps. */
  slippageBps: number;
  /** Refuse a trade that would move the price more than this, bps. */
  maxImpactBps: number;
}

export interface RiskProfile {
  level: RiskLevel;
  /** What a person calls it. */
  name: string;
  /** One line, in the owner's terms rather than in basis points. */
  blurb: string;
  settings: RiskSettings;
}

/**
 * THE THREE LEVELS.
 *
 * `balanced` is the shipped default made explicit rather than a new set of
 * numbers: 2,500/2,000 is the band the graded floor was specified against, and
 * 300bps of impact and 100bps of slippage are what `SETTINGS_DEFAULTS` already
 * carries. Choosing "balanced" therefore changes nothing for an owner who never
 * touched a dial, which is what makes it safe to offer as the middle rung.
 */
export const RISK_PROFILES: Readonly<Record<RiskLevel, RiskProfile>> = Object.freeze({
  careful: {
    level: "careful",
    name: "Careful",
    blurb: "Small positions, quick to take a profit, quick to cut a loss.",
    settings: {
      strategistStopLossBps: 1_500,
      takeProfitBps: 1_200,
      buyPerTickUsdg: 10,
      llmMaxActionUsdg: 10,
      slippageBps: 50,
      maxImpactBps: 150,
    },
  },
  balanced: {
    level: "balanced",
    name: "Balanced",
    blurb: "The default. Room to be wrong, without betting the book on one name.",
    settings: {
      strategistStopLossBps: 2_500,
      takeProfitBps: 2_000,
      buyPerTickUsdg: 25,
      llmMaxActionUsdg: 50,
      slippageBps: 100,
      maxImpactBps: 300,
    },
  },
  bold: {
    level: "bold",
    name: "Bold",
    blurb: "Bigger positions and more room before a rule sells — including through a bad week.",
    settings: {
      strategistStopLossBps: 3_500,
      takeProfitBps: 4_000,
      buyPerTickUsdg: 50,
      llmMaxActionUsdg: 100,
      slippageBps: 200,
      maxImpactBps: 500,
    },
  },
});

export const RISK_LEVELS: readonly RiskLevel[] = Object.freeze(["careful", "balanced", "bold"]);

/**
 * WHAT THIS LEVEL CANNOT REACH, so the caller can say it.
 *
 * The per-trade and per-day caps live in the signature, are enforced on-chain,
 * and a settings write cannot touch them. Returned as a fact rather than a
 * warning string so the UI can render it however it likes — but returned
 * always, because a risk selector that quietly stops at the settings boundary
 * is the exact failure this file exists to avoid.
 */
export const capsNeedResign = Object.freeze(["perTradeUsdg", "dailyUsdg"] as const);

/** The profile for a level, or `balanced` for anything unrecognised. */
export function riskProfile(level: string | null | undefined): RiskProfile {
  const key = String(level ?? "").trim().toLowerCase() as RiskLevel;
  return RISK_PROFILES[key] ?? RISK_PROFILES.balanced;
}

/**
 * Which level a settings blob currently matches, or null when it matches none.
 *
 * NULL IS THE COMMON ANSWER AND IT IS NOT A FAULT. An owner who has tuned one
 * dial by hand is on no level, and a selector that rounded them to the nearest
 * one would silently move the other five the moment they opened the screen.
 * "Custom" is a real state and the UI has to be able to show it.
 */
export function levelOf(settings: Partial<RiskSettings> | null | undefined): RiskLevel | null {
  if (!settings) return null;
  const keys = Object.keys(RISK_PROFILES.balanced.settings) as (keyof RiskSettings)[];
  for (const level of RISK_LEVELS) {
    const want = RISK_PROFILES[level].settings;
    if (keys.every((k) => Number(settings[k]) === want[k])) return level;
  }
  return null;
}
