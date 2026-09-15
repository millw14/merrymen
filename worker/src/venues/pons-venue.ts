/**
 * PONS AS IMPLEMENTATION #1 of the launchpad seam.
 *
 * Almost nothing here is new. It is an adapter over modules that already work
 * and are already tested — `readClassLegs`, `curveBuyOut`/`curveSellOut`,
 * `simulateCurveTrade`, `buildClassBuyCalls`/`buildClassSellCalls`,
 * `readClassLog` — assembled behind one shape so the tick can stop naming Pons
 * and a second launchpad can be written against the same contract.
 *
 * THE HONEST GAPS ARE DECLARED RATHER THAN PAPERED OVER. Two methods cannot do
 * on this venue what their names suggest in general, and both say so in place:
 * `simulate` can rehearse a BUY and not a SELL, and `positionState` can report
 * that a position has become unsellable but cannot make it sellable again. A
 * seam that hides those would make the second venue's author believe they are
 * free, and they are not.
 */
import type { PublicClient } from "viem";

import type { Call } from "../executor";
import { readClassLegs, type ClassCandidate } from "./class-legs";
import { readClassLog } from "./class-log";
import { buildClassBuyCalls, buildClassSellCalls } from "./pons-class";
import { curveBuyOut, curveGraduated, curveSellOut, realQuoteRaw, type CurveReserves } from "./pons-price";
import { simulateCurveTrade } from "./pons-simulate";
import type {
  LaunchVenue,
  VenueCandidate,
  VenueLeg,
  VenuePositionState,
  VenueQuote,
  VenueRefusal,
  VenueSimulation,
} from "./venue";

const ERC20_BALANCE = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** A discovered row, as the store hands it back. */
export interface PonsDiscoveryRow {
  address: string;
  symbol: string;
  decimals: number;
  firstSeen: number;
  curve?: { curve: string; quoteToken: string; graduationThresholdRaw: string };
}

export interface PonsVenueDeps {
  client: PublicClient;
  /** Rows from the factory-filtered launch scan. THE ONLY admissible source. */
  discoverRows: (limit: number) => Promise<readonly PonsDiscoveryRow[]>;
  now?: () => number;
}

/**
 * How far along a curve is, in bps of its graduation threshold.
 *
 * Measured from REAL quote depth, never the reported reserve: the reserve
 * carries a virtual seed worth 40% of the threshold, and reading that as
 * progress is the confusion pons-price.ts records having already been made
 * once. A curve that has graduated reports 10,000 rather than resetting to
 * nothing, because a graduated curve's reserves reset and would otherwise read
 * exactly like a fresh launch.
 */
export function graduationBpsOf(r: CurveReserves, graduationThresholdRaw: bigint): number | null {
  if (curveGraduated(r)) return 10_000;
  if (graduationThresholdRaw <= 0n) return null;
  const real = realQuoteRaw(r);
  if (real < 0n) return null;
  const bps = Number((real * 10_000n) / graduationThresholdRaw);
  return Math.max(0, Math.min(10_000, bps));
}

export function makePonsVenue(deps: PonsVenueDeps): LaunchVenue {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  /**
   * Reserves measured during `verify`, kept for the quote calls.
   *
   * Quoting is pure arithmetic over reserves, so re-reading the chain for it
   * would spend an eth_call to learn something this pass already knows. Keyed
   * by route and replaced wholesale each verify, so a stale entry cannot
   * outlive the pass that measured it.
   */
  let reserves = new Map<string, { r: CurveReserves; threshold: bigint }>();

  return {
    id: "pons",

    async discover({ limit }) {
      const rows = await deps.discoverRows(limit);
      const out: VenueCandidate[] = [];
      for (const row of rows) {
        // No curve means this row did not come from the launch scan. The class
        // route's entire provenance guarantee rests on that one producer, so a
        // row without one is not a Pons candidate at all.
        if (!row.curve) continue;
        out.push({
          venue: "pons",
          token: row.address as `0x${string}`,
          symbol: row.symbol,
          decimals: row.decimals,
          route: row.curve.curve as `0x${string}`,
          quoteToken: row.curve.quoteToken as `0x${string}`,
          firstSeen: row.firstSeen > 0 ? row.firstSeen : null,
        });
      }
      return out;
    },

    async verify({ candidates, quoteToken, minRealDepthRaw, maxReads }) {
      const byRoute = new Map(candidates.map((c) => [c.route.toLowerCase(), c]));
      const legacy: ClassCandidate[] = candidates.map((c) => ({
        token: c.token,
        symbol: c.symbol,
        decimals: c.decimals,
        curve: c.route,
        quoteToken: c.quoteToken,
        graduationThresholdRaw: 0n,
      }));

      // The store carries the threshold as a decimal string per row; re-attach
      // it, because without it depth cannot be read as money and readClassLegs
      // refuses the candidate by name.
      const rows = await deps.discoverRows(candidates.length);
      const thresholds = new Map<string, bigint>();
      for (const row of rows) {
        if (!row.curve) continue;
        try {
          thresholds.set(row.curve.curve.toLowerCase(), BigInt(row.curve.graduationThresholdRaw));
        } catch {
          /* an unparseable threshold stays absent, and the candidate is refused below */
        }
      }
      for (const c of legacy) c.graduationThresholdRaw = thresholds.get(c.curve.toLowerCase()) ?? 0n;

      const { legs, refused } = await readClassLegs({
        client: deps.client,
        candidates: legacy,
        usdg: quoteToken,
        minRealDepthUsdg: minRealDepthRaw,
        maxReads,
      });

      reserves = new Map();
      const out: VenueLeg[] = [];
      for (const l of legs) {
        const threshold = thresholds.get(l.curve.toLowerCase()) ?? 0n;
        reserves.set(l.curve.toLowerCase(), { r: l.reserves, threshold });
        const seen = byRoute.get(l.curve.toLowerCase())?.firstSeen ?? null;
        out.push({
          venue: "pons",
          token: l.token,
          symbol: l.symbol,
          decimals: l.decimals,
          route: l.curve,
          quoteToken: l.quoteToken,
          realDepthRaw: realQuoteRaw(l.reserves),
          graduationBps: graduationBpsOf(l.reserves, threshold),
          ageSec: seen === null ? null : Math.max(0, now() - seen),
          // NOT MEASURED ON THIS PASS, and null says so. `readCurveActivity`
          // can supply it, at an eth_getLogs per curve — a cost the scan
          // budget has to agree to before a style may depend on it.
          recentTrades: null,
        });
      }
      return { legs: out, refused: refused as VenueRefusal[] };
    },

    quoteBuy({ leg, quoteInRaw }) {
      const held = reserves.get(leg.route.toLowerCase());
      if (!held || quoteInRaw <= 0n) return null;
      const out = curveBuyOut(held.r, quoteInRaw);
      if (out === null || out <= 0n) return null;
      // Round-trip cost: what selling it straight back would return against
      // what went in. This is the figure the scorer's impact ceiling reads, and
      // it is measured rather than assumed.
      const back = curveSellOut(held.r, out);
      const costBps =
        back === null || quoteInRaw <= 0n
          ? null
          : Math.max(0, Number(((quoteInRaw - back) * 10_000n) / quoteInRaw));
      return { amountOutRaw: out, costBps };
    },

    quoteSell({ leg, tokensInRaw }) {
      const held = reserves.get(leg.route.toLowerCase());
      if (!held || tokensInRaw <= 0n) return null;
      const out = curveSellOut(held.r, tokensInRaw);
      if (out === null || out <= 0n) return null;
      return { amountOutRaw: out, costBps: null };
    },

    async simulate(opts) {
      const { leg, side, amountInRaw } = opts;
      /**
       * A BUY CAN BE REHEARSED; A SELL CANNOT, AND THAT ASYMMETRY IS CORRECT.
       *
       * `simulateCurveTrade` replays exactly two calls — an approve and a trade
       * — which is the shape of a class buy. A class sell is ONE call
       * (`buildClassSellCalls` returns one on purpose: an approve leg there is
       * a call the wall refuses, on the exit path).
       *
       * Nothing is lost. The buy is the side that needs a rehearsal, because it
       * is the side that acquires a token nobody enumerated. The sell's floor is
       * enforced on-chain by the vault, and `proposeClassExits` deliberately
       * applies no impact ceiling to an exit — an expensive exit is still an
       * exit. So a sell reports `ok` with no figure rather than inventing one.
       */
      if (side === "sell") {
        return { ok: true, amountOutRaw: null, reason: null };
      }
      const held = reserves.get(leg.route.toLowerCase());
      if (!held) return { ok: false, amountOutRaw: null, reason: "no live reserves for that market this pass" };
      if (curveBuyOut(held.r, amountInRaw) === null) {
        return { ok: false, amountOutRaw: null, reason: "that size does not price on this curve" };
      }

      // THE REAL CALLS, NOT A MODEL OF THEM. Building the same two calls the
      // executor would send is the only version of this worth running: a
      // rehearsal of an approximation tells you an approximation would have
      // worked.
      let calls: Call[];
      try {
        calls = buildClassBuyCalls({
          vault: opts.custody,
          curve: leg.route,
          quoteAsset: leg.quoteToken,
          quoteInRaw: amountInRaw,
          minTokensOutRaw: opts.minOutRaw,
          deadline: opts.deadline,
        }) as Call[];
      } catch (e) {
        // An unbuildable call is a refusal with a reason, not a crash: a
        // native-quoted curve lands here by design.
        return { ok: false, amountOutRaw: null, reason: e instanceof Error ? e.message : String(e) };
      }

      const sim = await simulateCurveTrade({
        client: deps.client,
        account: opts.account,
        calls,
        adapter: opts.custody,
      });
      if (!sim.ok) return { ok: false, amountOutRaw: null, reason: sim.reason };
      return { ok: true, amountOutRaw: sim.amountOut, reason: null };
    },

    buyCalls({ custody, leg, quoteInRaw, minOutRaw, deadline }) {
      return buildClassBuyCalls({
        vault: custody,
        curve: leg.route,
        quoteAsset: leg.quoteToken,
        quoteInRaw,
        minTokensOutRaw: minOutRaw,
        deadline,
      }) as Call[];
    },

    sellCalls({ custody, leg, tokensInRaw, minOutRaw, deadline }) {
      return buildClassSellCalls({
        vault: custody,
        curve: leg.route,
        tokensInRaw,
        minQuoteOutRaw: minOutRaw,
        deadline,
      }) as Call[];
    },

    async positionState({ custody, token, route }) {
      let balanceRaw: bigint;
      try {
        balanceRaw = (await deps.client.readContract({
          address: token,
          abi: ERC20_BALANCE,
          functionName: "balanceOf",
          args: [custody],
        })) as bigint;
      } catch {
        // UNREADABLE IS NOT EMPTY. Returning a zero balance here would report a
        // held position as closed, and the exit producer would stop trying.
        return null;
      }

      let graduated: boolean | null = null;
      let graduationBps: number | null = null;
      try {
        const r = (await deps.client.readContract({
          address: route,
          abi: [{ type: "function", name: "graduated", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }] as const,
          functionName: "graduated",
        })) as boolean;
        graduated = r;
        graduationBps = r ? 10_000 : null;
      } catch {
        graduated = null;
      }

      const state: VenuePositionState = {
        venue: "pons",
        token,
        balanceRaw,
        // THE FIELD THIS MILESTONE TURNS ON. The vault refuses a graduated
        // curve by name, so success closes the exit. Unknown is NOT sellable:
        // an exit planned against a curve we could not read is one that reverts
        // after paying the gas.
        sellable: graduated === false,
        unsellableReason:
          graduated === true
            ? "it has graduated to a real pool, so the vault can no longer sell it — your own key can still move it out"
            : graduated === null
              ? "its curve would not answer this pass, so a sale cannot be planned safely yet"
              : null,
        graduationBps,
        custody: "vault",
      };
      return state;
    },
  };
}

/** The log reader, re-exported so the seam is the only import the tick needs. */
export { readClassLog };
