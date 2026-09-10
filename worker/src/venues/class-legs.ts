/**
 * Which fresh launches this agent could take a CLASS position in.
 *
 * A SEPARATE READER FROM curveLegsNow, and not by preference. That function
 * builds from `lastCurveLegs`, which the pricing pass fills by iterating
 * `watchTokens` — and a class token is not in `watchTokens` BY DEFINITION,
 * because it postdates the grant. So the class route cannot reuse the reserves
 * the tick already paid for; it has to read its own.
 *
 * That is a real cost, so the filters below are ordered to spend it late: every
 * test that can be answered from the launch record alone runs BEFORE any
 * eth_call, and only survivors cost a `getReserves`. Same discipline
 * `PONS_MAX_EVALUATE` applies to discovery.
 *
 * It lives in its own module rather than in index.ts so that
 * `curve-wiring.test.ts`'s "readCurveReserves appears exactly once in index.ts"
 * assertion stays both TRUE and MEANINGFUL. That test exists because reserves
 * must not be read twice in one tick — measured p99 movement is 1,546 bps over
 * 240 seconds, so two reads are two different markets and a slippage floor
 * derived from the wrong one is a floor for a market that no longer exists.
 * Weakening the assertion to accommodate this would delete the guarantee.
 */
import type { PublicClient } from "viem";
import { readCurveReserves } from "./pons";
import {
  CURVE_GUARD_DEFAULTS,
  curveGraduated,
  realQuoteRaw,
  type CurveGuard,
  type CurveReserves,
} from "./pons-price";

/** A launch this agent has seen, from the factory-filtered feed. */
export interface ClassCandidate {
  token: `0x${string}`;
  symbol: string;
  decimals: number;
  curve: `0x${string}`;
  /** The curve's pair token. All-zero means native-quoted — out of reach. */
  quoteToken: `0x${string}`;
  graduationThresholdRaw: bigint;
}

export interface ClassLeg {
  token: `0x${string}`;
  symbol: string;
  decimals: number;
  curve: `0x${string}`;
  quoteToken: `0x${string}`;
  reserves: CurveReserves;
}

/** Why a candidate was passed over, in the owner's vocabulary. */
export interface ClassRefusal {
  symbol: string;
  reason: string;
}

const ZERO = /^0x0{40}$/i;

export async function readClassLegs(deps: {
  client: Pick<PublicClient, "readContract">;
  candidates: readonly ClassCandidate[];
  /** The account's cash token. A class entry is one hop from it or not at all. */
  usdg: `0x${string}`;
  /** Minimum REAL quote depth, 6dp USDG. Never the reported reserve. */
  minRealDepthUsdg: bigint;
  /** Hard ceiling on eth_calls this pass. */
  maxReads: number;
  guard?: CurveGuard;
}): Promise<{ legs: ClassLeg[]; refused: ClassRefusal[] }> {
  const guard = deps.guard ?? CURVE_GUARD_DEFAULTS;
  const legs: ClassLeg[] = [];
  const refused: ClassRefusal[] = [];

  // ── FREE FILTERS FIRST. Each survivor costs an eth_call. ─────────────────
  const worthReading: ClassCandidate[] = [];
  for (const c of deps.candidates) {
    if (ZERO.test(c.quoteToken)) {
      // 53.6% of launches. The vault refuses these by name
      // (NativeQuoteNotSupported) and every wall permission carries
      // valueLimit 0, so the account cannot send native value at all.
      refused.push({ symbol: c.symbol, reason: "quoted in native ETH, which this route cannot reach" });
      continue;
    }
    if (c.quoteToken.toLowerCase() !== deps.usdg.toLowerCase()) {
      // ONE HOP FROM CASH, the same restriction all three existing curve
      // producers make. It does a second job here: it is what makes a class
      // SELL's notional honest, because the proceeds are then USDG BY
      // VERIFICATION from the launch record rather than by assumption.
      refused.push({ symbol: c.symbol, reason: "not quoted in USDG, so entering it would need a second hop" });
      continue;
    }
    if (c.graduationThresholdRaw <= 0n) {
      // Without it the virtual seed cannot be subtracted, so no depth figure
      // for this curve is real. Reading it would produce a number that looks
      // like money and is not.
      refused.push({ symbol: c.symbol, reason: "no graduation threshold on record, so its depth cannot be read as money" });
      continue;
    }
    worthReading.push(c);
    if (worthReading.length >= deps.maxReads) break;
  }

  // ── THEN THE CHAIN, ONCE PER SURVIVOR ────────────────────────────────────
  for (const c of worthReading) {
    let r: CurveReserves | null = null;
    try {
      r = await readCurveReserves(
        deps.client as PublicClient,
        { curve: c.curve, graduationThresholdRaw: c.graduationThresholdRaw },
        // The quote is USDG by the filter above, so 6dp is verified rather than
        // assumed. The token side is 18dp for every Pons launch.
        { quote: 6, token: c.decimals },
      );
    } catch {
      r = null;
    }
    if (!r) {
      // One unreadable curve refuses THAT candidate and does not abort the
      // pass — unlike the custody read, nothing here is destructive and the
      // other candidates are still honestly readable.
      refused.push({ symbol: c.symbol, reason: "its curve would not report reserves this tick" });
      continue;
    }
    if (curveGraduated(r)) {
      // A graduated curve RESETS its reserves, so it reads exactly like a fresh
      // launch while the real market has moved to a pool. The vault refuses it
      // by name too; refusing here saves the gas.
      refused.push({ symbol: c.symbol, reason: "already graduated — its real market has moved to a pool" });
      continue;
    }
    const real = realQuoteRaw(r);
    if (real < deps.minRealDepthUsdg) {
      // REAL, not reported. The quote reserve includes a virtual seed worth 40%
      // of the threshold, and reading that as depth is the confusion
      // pons-price.ts records having already been made once.
      refused.push({
        symbol: c.symbol,
        reason: `only ${(Number(real) / 1e6).toFixed(2)} USDG of real depth — the rest of its reserve is the virtual seed`,
      });
      continue;
    }
    legs.push({
      token: c.token,
      symbol: c.symbol,
      decimals: c.decimals,
      curve: c.curve,
      quoteToken: c.quoteToken,
      reserves: r,
    });
  }

  void guard;
  return { legs, refused };
}
