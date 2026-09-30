/**
 * ENERGY — what $MERRYMEN is for on the hosted service, written down once.
 *
 * An agent's energy is how much it may do ON ITS OWN each day: the paid AI
 * reviews it runs and the new trades it opens without being asked. While the
 * owner's wallet and the agent's own account hold ENERGY.fullTokens $MERRYMEN
 * between them it runs at full strength. Below that it still runs, on about a
 * tenth of a normal day, resetting at 00:00 UTC. Stop-losses, take-profits and
 * the owner's own orders are never limited by it, and no exit counts as a new
 * trade — an allowance on NEW work is not allowed to become a lock on the
 * doors. What IS paced is the agent's own AI review, including of what it
 * holds, so an exit the AI would decide waits for its next paced review; the
 * copy says exactly that and never "selling is never limited".
 *
 * WHAT LIVES HERE AND WHAT DOES NOT. This file is the contract every tier
 * shares: the thresholds, the shape the worker reports and the web reads, and
 * the one route the agent's key may use to buy its own energy. The throttle
 * itself (what counts, pacing, the durable counters) is worker/src/energy.ts;
 * the sentences the owner reads are worker/src/energy-copy.ts. Nothing here
 * reads a chain, a clock or an environment variable.
 *
 * STANCE, inherited from token.ts: utility only. Energy is capacity. Nothing in
 * this file, or in any copy that renders it, says anything about the token's
 * price, where it is going, or returns.
 */

import { CIRCLE_TIERS, MERRYMEN_TOKEN } from "./token";
import type { StoredGrant } from "./grant";

/** The one tier whose threshold is full energy — the Merry Man tier, never a literal. */
const FULL_TIER = CIRCLE_TIERS.find((t) => t.id === "merryman");
if (!FULL_TIER) throw new Error("energy: the merryman tier is missing from CIRCLE_TIERS");

export const ENERGY = Object.freeze({
  /** Whole $MERRYMEN between the owner's wallet and the agent's account for full energy. */
  fullTokens: FULL_TIER.minTokens,
  /** Share of a normal day a low-energy agent gets, in bps. 1_000 = about a tenth. */
  lowBps: 1_000,
  /**
   * The HOUSE baseline for new trades per day. The low allowance is a tenth of
   * min(the grant's own maxOpsPerDay, this) — never of the grant alone, because
   * the grant is signed by the very owner being throttled and re-signing is free.
   */
  baselineOpsPerDay: 24,
  /**
   * How long a successful balance read stands in for a failed one. A holder is
   * not throttled because the chain would not answer after a restart; a read
   * older than this is not evidence of anything.
   */
  lastGoodMaxAgeSec: 86_400,
  /**
   * The highest $MERRYMEN buy tax (bps) the energy buy will accept. The tax is
   * set by the token's own owner and can change without a line of our code
   * changing; a floor computed from a freshly read tax would silently accept a
   * hike, so above this the buy refuses instead.
   */
  maxTaxBps: 200,
  /** Router deadline for an energy buy, seconds from build. */
  deadlineSec: 180,
  /** The smallest energy buy worth a UserOp, raw USDG (6dp). */
  minChunkUsdg6: 1_000_000n,
  /** How often the worker re-prices the shortfall while an agent is low. */
  estimateEverySec: 1_800,
});

/** Raw (18dp) $MERRYMEN for full energy. */
export const ENERGY_FULL_RAW: bigint = BigInt(ENERGY.fullTokens) * 10n ** BigInt(MERRYMEN_TOKEN.decimals);

/**
 * How every "today's energy is spent" notice begins. The worker writes it, the
 * desk recognises it so a standing banner and the same sentence in the notice
 * slot are not shown twice. The sentence carries its UTC date so it stays true
 * while it sits in a notice slot after midnight.
 */
export const ENERGY_NOTICE_PREFIX = "Energy spent for ";

// ── the reserve token ─────────────────────────────────────────────────────

/**
 * Tokens held as ENERGY rather than traded, per chain. Never in a watch set,
 * never a position, never valued into equity, never sold by a strategy — it sits
 * outside the trading book the way ETH gas does.
 */
export const ENERGY_RESERVE_TOKENS: Readonly<Record<number, readonly `0x${string}`[]>> = Object.freeze({
  [MERRYMEN_TOKEN.chainId]: Object.freeze([MERRYMEN_TOKEN.address.toLowerCase() as `0x${string}`]),
});

export function energyReserveTokens(chainId: number): readonly `0x${string}`[] {
  return ENERGY_RESERVE_TOKENS[chainId] ?? [];
}

/** Is this address an energy reserve token on ANY chain? Case-insensitive; null/undefined → false. */
export function isEnergyReserveToken(addr?: string | null): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  return Object.values(ENERGY_RESERVE_TOKENS).some((list) => list.includes(a as `0x${string}`));
}

// ── the one route the agent's key may use to buy its energy ───────────────

/** VIRTUAL on Robinhood Chain — the middle hop; $MERRYMEN's deep pool is against it. */
export const VIRTUAL_TOKEN = "0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31" as const;

/**
 * grantFeatures marker: "this signature can buy $MERRYMEN energy over
 * ENERGY_ROUTE_V1, and nothing else, into its own account".
 *
 * VERSIONED, because the permission is built from the route below rather than
 * from an address sealed on the grant. A marker names a route FOREVER: if any
 * address below ever has to change, that is "energy-buy-v2", and grants signed
 * against v1 keep meaning v1. Editing ENERGY_ROUTE_V1 in place would leave old
 * grants' walls and the worker's calldata describing different routes — a
 * mirror looser than the chain.
 */
export const GRANT_ENERGY = "energy-buy-v1";

/**
 * The energy route, FROZEN LITERALS (lowercase) on purpose — see GRANT_ENERGY.
 * Uniswap v2 Router02, USDG → VIRTUAL → $MERRYMEN, output to the account itself.
 *
 * Why v2 and why two hops, measured on chain 2026-09-27: $MERRYMEN has no
 * Uniswap v3 pool and no v2 pair against USDG or WETH; its depth is a v2 pair
 * against VIRTUAL, and VIRTUAL has a v2 pair against USDG on the same factory.
 * energy-route.test.ts pins that these literals equal the registry constants.
 */
export const ENERGY_ROUTE_V1 = Object.freeze({
  chainId: 4663,
  router: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba" as `0x${string}`,
  path: Object.freeze([
    "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
    "0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31",
    "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32",
  ] as const) as readonly [`0x${string}`, `0x${string}`, `0x${string}`],
});

export type EnergyRoute = typeof ENERGY_ROUTE_V1;

/**
 * The route this grant may use, or null. BOTH the marker and chain 4663 — on any
 * other chain the router address is codeless, a CALL to it succeeds with empty
 * returndata, and an energy buy would "land" having bought nothing.
 */
export function grantEnergyRoute(
  grant: Pick<StoredGrant, "grantFeatures" | "chainId"> | null | undefined,
): EnergyRoute | null {
  if (!grant?.grantFeatures?.includes(GRANT_ENERGY)) return null;
  return grant.chainId === ENERGY_ROUTE_V1.chainId ? ENERGY_ROUTE_V1 : null;
}

/** Selector of swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256). */
export const ENERGY_SWAP_SELECTOR = "0x5c11d795";

/**
 * The calldata words of an energy swap, for the two places that must agree on
 * them: the wall (which pins words 2, 3, 5, 6, 7, 8) and the worker's final
 * fence. null when the data is not a whole number of words after a selector.
 *
 *   w0 amountIn · w1 amountOutMin · w2 offset of path (0xa0) · w3 to ·
 *   w4 deadline · w5 path.length (3) · w6..w8 path
 */
export function energyCallWords(data: string): { selector: string; words: bigint[] } | null {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data)) return null;
  const body = data.slice(10);
  if (data.length < 10 || body.length % 64 !== 0) return null;
  const words: bigint[] = [];
  for (let i = 0; i < body.length; i += 64) words.push(BigInt(`0x${body.slice(i, i + 64)}`));
  return { selector: data.slice(0, 10).toLowerCase(), words };
}

// ── what the worker reports and every surface reads ───────────────────────

export type EnergyMode = "off" | "observe" | "enforce";
export type EnergyLevel = "full" | "low" | "unread";
/**
 * Whether the agent can buy its own energy right now, decided by the worker:
 *   ready        — mainnet grant carrying GRANT_ENERGY, trading live
 *   resign       — mainnet, but the signed key has no energy route yet
 *   paper        — practising: it will not spend real USDG on energy
 *   not-mainnet  — the account is on another network; only the owner's own
 *                  wallet on Robinhood Chain counts, and tokens sent to the
 *                  account would not
 */
export type EnergyBuy = "ready" | "resign" | "paper" | "not-mainnet";

/** A used/allowed pair. null is "not known", never zero. */
export interface EnergyMeter {
  used: number | null;
  allowed: number | null;
}

/**
 * The worker's own report of an agent's energy, as stored on the agents row
 * and served by /api/grants. REPORTED BY THE WORKER, never computed by a
 * client: the process that throttles is the only one that knows.
 */
export interface EnergyStatus {
  v: 1;
  /** The gate is enforcing (mode 'enforce'). false = energy limits nothing. */
  gated: boolean;
  mode: EnergyMode;
  level: EnergyLevel;
  /** Whole $MERRYMEN in the agent's account; null = unread or not counted (not mainnet). */
  agentTokens: number | null;
  /** Whole $MERRYMEN in the counted owner wallet; null = unread or no wallet (holderCounted says which). */
  holderTokens: number | null;
  /**
   * Was an owner wallet counted at all? true = one was, so a null
   * holderTokens is a read that FAILED; false = no wallet counts (none linked,
   * or it already powers another account), so a null holderTokens is a
   * knowable nothing and the agent's account is the whole figure. Absent on
   * reports written before it existed: unknown, and read as before.
   */
  holderCounted?: boolean;
  needTokens: number;
  /** UTC day these counts belong to, 'YYYY-MM-DD'. */
  day: string;
  /** Unix seconds of the next 00:00 UTC. */
  resetsAt: number;
  /** Paid AI reviews today; null when the agent has no paid reviewer or is not throttled. */
  reviews: EnergyMeter | null;
  /** New trades started on its own today; null when not throttled. */
  entries: EnergyMeter | null;
  /** Today's new-trade allowance is used up. */
  spent: boolean;
  buy: EnergyBuy;
  /** USDG the energy buy would ask now, sized exactly as it buys (margin, fees and tax included; slippage is the router's floor, never the size); null = unknown. */
  estimateUsdg: number | null;
  /** Unix seconds of this report. */
  at: number;
}

const LEVELS: readonly EnergyLevel[] = ["full", "low", "unread"];
const MODES: readonly EnergyMode[] = ["off", "observe", "enforce"];
const BUYS: readonly EnergyBuy[] = ["ready", "resign", "paper", "not-mainnet"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function numOrNull(v: unknown): number | null | undefined {
  if (v === null) return null;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function meter(v: unknown): EnergyMeter | null | undefined {
  if (v === null) return null;
  if (typeof v !== "object" || v === undefined) return undefined;
  const m = v as Record<string, unknown>;
  const used = numOrNull(m.used);
  const allowed = numOrNull(m.allowed);
  if (used === undefined || allowed === undefined) return undefined;
  return { used, allowed };
}

/**
 * Read a stored energy report back, field by field. Anything that is not
 * exactly the shape above is null — a report we cannot trust is no report, and
 * a null count stays null: this never turns "unknown" into 0, which is the
 * number that sends somebody to buy tokens they may already hold.
 */
export function parseEnergyStatus(raw: unknown): EnergyStatus | null {
  let v: unknown = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (typeof o.gated !== "boolean" || typeof o.spent !== "boolean") return null;
  if (!MODES.includes(o.mode as EnergyMode)) return null;
  if (!LEVELS.includes(o.level as EnergyLevel)) return null;
  if (!BUYS.includes(o.buy as EnergyBuy)) return null;
  if (typeof o.day !== "string" || !DAY.test(o.day)) return null;
  const agentTokens = numOrNull(o.agentTokens);
  const holderTokens = numOrNull(o.holderTokens);
  const estimateUsdg = numOrNull(o.estimateUsdg);
  const needTokens = numOrNull(o.needTokens);
  const resetsAt = numOrNull(o.resetsAt);
  const at = numOrNull(o.at);
  const reviews = meter(o.reviews);
  const entries = meter(o.entries);
  // OPTIONAL, so every report written before it stays valid; when present it
  // must be exactly a boolean, like every other field here.
  if (o.holderCounted !== undefined && typeof o.holderCounted !== "boolean") return null;
  if (
    agentTokens === undefined ||
    holderTokens === undefined ||
    estimateUsdg === undefined ||
    reviews === undefined ||
    entries === undefined ||
    needTokens == null ||
    resetsAt == null ||
    at == null
  ) {
    return null;
  }
  return {
    v: 1,
    gated: o.gated,
    mode: o.mode as EnergyMode,
    level: o.level as EnergyLevel,
    agentTokens,
    holderTokens,
    ...(o.holderCounted === undefined ? {} : { holderCounted: o.holderCounted }),
    needTokens,
    day: o.day,
    resetsAt,
    reviews,
    entries,
    spent: o.spent,
    buy: o.buy as EnergyBuy,
    estimateUsdg,
    at,
  };
}
