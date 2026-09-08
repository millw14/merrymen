/**
 * WHAT AN ONCHAIN ANALYST CAN HONESTLY BE TOLD ABOUT WHO HOLDS THIS COIN.
 *
 * The last of the memecoin desk's four lenses to get a supplier. `technical`
 * had one, coin-liquidity.ts filled `liquidity`, peer theses fill `social`, and
 * this fills `onchain` — which coin-liquidity.ts named as the gap and declined
 * to guess at, because "a lens fed a guess is worse than a lens fed nothing".
 *
 * The arithmetic is onchain-forensics.ts (ChainMind's, ported pure); the rows
 * are onchain-reader.ts (reconstructed from Transfer logs, self-verified). This
 * file only turns verdicts into prose, and its whole job is to make the SAMPLE
 * travel with every number — because the reader can return two very different
 * kinds of answer and they look identical once they are sentences.
 *
 * THE ONE THING THIS LENS EXISTS TO SAY. A launchpad token's price says almost
 * nothing at this size; distribution says most of what can be known. Whether
 * four wallets can end it, whether its holders arrived as one script, and
 * whether its volume is the same wallet trading with itself are questions with
 * real answers, and none of them is visible on a chart.
 *
 * WHAT IT REFUSES TO SAY, STATED IN THE PROSE ITSELF rather than left to the
 * reader. There is no honeypot simulation here, no sell-path test, no
 * owner/mint/freeze/blacklist probe, no LP-lock check and no proxy-upgrade
 * check — ChainMind has none of those either, so the port could not bring what
 * did not exist. An analyst handed a clean distribution report will otherwise
 * conclude "safe", which is the single most expensive thing it could conclude,
 * so the block says outright that this is provenance and not safety.
 *
 * AND WHEN THE WINDOW MISSED THE BEGINNING, THE DISTRIBUTION SECTION IS ABSENT
 * ENTIRELY — not hedged, not marked approximate. Balances rebuilt from a
 * partial window are net flow, and a hedged wrong number is still read as a
 * number. The block says which questions it could not reach and why, which is
 * the difference between "we asked and there was nothing" and "we never asked"
 * that this repo keeps insisting on.
 *
 * PURE. Given a scan, returns prose.
 */
import {
  amountClusters,
  concentrationOf,
  detectBundle,
  roundTrips,
} from "../../../packages/core/src/onchain-forensics";
import { BLOCKS_PER_SEC, blocksFor, type OnchainScan } from "./onchain-reader";

export interface OnchainInputs {
  symbol: string;
  scan: OnchainScan;
  /** Curves, pools and routers — the same set the scan excluded. */
  venues?: readonly string[];
  /**
   * How close together acquisitions have to be to read as one actor, in
   * SECONDS. ChainMind used 2,500 blocks; that number is only a duration on the
   * chain it was measured on, so this is stated in time and converted.
   */
  bundleWindowSec?: number;
  /** How close a buy and a sell have to be to read as a round trip, in seconds. */
  roundTripWindowSec?: number;
}

/** ~4.2 minutes, which is ChainMind's 2,500 blocks expressed as what it meant. */
const BUNDLE_WINDOW_SEC = 252;
/** An hour. A scalp inside an hour is the shape wash volume takes. */
const ROUND_TRIP_WINDOW_SEC = 3_600;
/**
 * The share at which a repeated amount stops being coincidence.
 *
 * A fifth of every wallet-to-wallet transfer carrying one identical figure is a
 * distributor. Seven in six hundred is a busy token — measured, on a real one.
 */
const MATERIAL_CLUSTER_BPS = 2_000;

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;

const hours = (blocks: bigint) => {
  const h = Number(blocks) / BLOCKS_PER_SEC / 3600;
  return h >= 1 ? `${h.toFixed(1)} hours` : `${Math.round(h * 60)} minutes`;
};

/**
 * Turn one token's scan into the onchain analyst's material.
 *
 * Returns null when there is genuinely nothing to say — no transfers at all in
 * the window. That is a real reading and a rare one, and it is left to the
 * caller to omit the lens rather than reported as a clean bill of health.
 */
export function renderOnchain(i: OnchainInputs): string | null {
  const s = i.scan;
  if (s.transfers === 0) return null;

  const span = s.toBlock > s.fromBlock ? s.toBlock - s.fromBlock : 0n;
  const bundleWindow = blocksFor(i.bundleWindowSec ?? BUNDLE_WINDOW_SEC);
  const tripWindow = blocksFor(i.roundTripWindowSec ?? ROUND_TRIP_WINDOW_SEC);
  const lines: string[] = [];

  // ── what was read, before anything read from it ───────────────────────────
  //
  // First rather than last, because every figure below is a claim about this
  // sample and an analyst who meets the sample afterwards has already formed
  // the view.
  lines.push(
    `${i.symbol} holder and flow forensics, rebuilt from ${s.transfers} Transfer log${s.transfers === 1 ? "" : "s"} ` +
      `over the last ${hours(span)} of chain (blocks ${s.fromBlock}–${s.toBlock}). There is no indexer ` +
      `behind this: an ERC-20 has no way to move except a Transfer, so the transfer history IS the ` +
      `holder set.`,
  );

  if (s.wholeHistory) {
    // EXACT, AND WORTH SAYING SO. An explorer returns a page; this window
    // contains every token that exists, checked against totalSupply() and
    // against the absence of any address spending more than it received.
    lines.push(
      `This window reaches back past the token's first mint: the rebuilt balances sum exactly to the ` +
        `contract's own totalSupply and no address spends more than it received. So the distribution ` +
        `below is COMPLETE — every holder, not a top-N page.`,
    );
  } else {
    lines.push(
      `DISTRIBUTION IS UNAVAILABLE FOR THIS TOKEN, and that is different from it looking fine: ` +
        `${s.why ?? "the window could not be verified"}. Balances rebuilt from a partial window are net ` +
        `flow over that window, not holdings, so nothing about concentration or how the holders arrived ` +
        `is stated below. Read the absence as "we could not see it", never as "there was nothing there".`,
    );
  }

  // ── can a handful of wallets end this ─────────────────────────────────────
  if (s.wholeHistory) {
    const top10 = concentrationOf(s.holders, { top: 10, exclude: { venues: i.venues ?? [] } });
    const top1 = concentrationOf(s.holders, { top: 1, exclude: { venues: i.venues ?? [] } });
    if (top10 === null) {
      lines.push(
        `No float: every token is still held by the curve or a burn address, so there is no ` +
          `distribution yet. Not 0% concentrated and not 100% — there is nothing to divide.`,
      );
    } else {
      lines.push(
        `CONCENTRATION: the largest ${top10.n} of ${top10.counted} holders control ${pct(top10.topBps)} of ` +
          `the float` +
          (top1 ? `, and the single largest holds ${pct(top1.topBps)}` : "") +
          `. ${top10.excluded > 0 ? `${top10.excluded} address${top10.excluded === 1 ? " was" : "es were"} excluded as venue or burn — a bonding curve holding most of its own supply is the market, not a whale, and counting it would make every launchpad coin read as 99% owned by one address. ` : ""}` +
          `This is what "can a handful of wallets end it" actually measures.`,
      );
    }

    // ── did they arrive as one actor ────────────────────────────────────────
    const bundle = detectBundle(s.acquisitions, Number(bundleWindow));
    if (bundle) {
      lines.push(
        `BUNDLING: ${bundle.size} of ${s.acquisitions.length} holders first received this token inside a ` +
          `single ${Math.round(Number(bundleWindow) / BLOCKS_PER_SEC / 60)}-minute span (blocks ` +
          `${bundle.fromBlock}–${bundle.toBlock}) — ${pct(bundle.shareBps)} of everyone who ever held it. ` +
          `Wallets that all appear inside four minutes are one script, not ${bundle.size} people who found ` +
          `it, so a holder count of that shape is the OPPOSITE of distribution.`,
      );
    } else {
      lines.push(
        `Bundling: no cluster of three or more first acquisitions inside one ` +
          `${Math.round(Number(bundleWindow) / BLOCKS_PER_SEC / 60)}-minute span. The holders arrived ` +
          `spread out, which is what organic acquisition looks like.`,
      );
    }
  }

  // ── is the volume real ────────────────────────────────────────────────────
  //
  // Window-local by nature and therefore stated whatever the completeness flag
  // says: "in the last day one wallet in three bought and sold" needs no
  // earlier history to be true.
  const trips = roundTrips(s.trades, Number(tripWindow));
  if (trips === null) {
    lines.push(`Round trips: no venue trades in this window at all, so there is no volume to judge.`);
  } else if (trips.traders === 0) {
    lines.push(
      `Round trips: none of the ${trips.total} wallets that traded in this window both bought and sold ` +
        `inside an hour. The volume is people taking positions, not a wallet trading with itself.`,
    );
  } else {
    lines.push(
      `ROUND TRIPS: ${trips.traders} of ${trips.total} wallets that traded here both bought and sold ` +
        `within an hour — ${pct(trips.shareBps)}. That is the signature of volume manufactured to look ` +
        `like interest, though it is not proof: a real trader can scalp. Read the ratio, not the count — ` +
        `${trips.traders} of 10 and ${trips.traders} of 400 are different markets.`,
    );
  }

  // ── are the amounts human ─────────────────────────────────────────────────
  const cluster = amountClusters(s.amounts);
  if (cluster) {
    // MATERIALITY IS THE RENDERER'S CALL, NOT THE DETECTOR'S — and the live
    // probe is why this exists. Against a real token, seven repeats among 617
    // transfers came back as "AMOUNT CLUSTERING: … 1.1%", a shouted heading
    // over a number that means nothing, and a model reading a shouted heading
    // does not go on to weigh the ratio underneath it. The detector's job is
    // to find the largest repeated amount and say how big it is; deciding
    // whether that is a finding is a judgement, and it belongs here where it
    // can be argued with. Same rule as the round trips above: the denominator
    // is what makes the count mean anything.
    const material = cluster.shareBps >= MATERIAL_CLUSTER_BPS;
    lines.push(
      material
        ? `AMOUNT CLUSTERING: ${cluster.count} of ${s.amounts.length} wallet-to-wallet transfers moved the ` +
            `identical raw amount ${cluster.amount} — ${pct(cluster.shareBps)} of them. People send numbers ` +
            `that differ; a script sends the same number. Curve fills are excluded from this count, so it ` +
            `is distribution being measured and not the market.`
        : `Amount clustering: the most repeated wallet-to-wallet amount appears ${cluster.count} times in ` +
            `${s.amounts.length} transfers — ${pct(cluster.shareBps)}, which is not a pattern. A repeated ` +
            `figure at this share is what any busy token looks like, and calling it automation would be ` +
            `reading noise.`,
    );
  } else if (s.amounts.length >= 3) {
    lines.push(
      `Amount clustering: none — the ${s.amounts.length} wallet-to-wallet transfers here carry amounts ` +
        `that differ, with no repeated figure.`,
    );
  }

  // ── the refusal, last, where it is read last ──────────────────────────────
  lines.push(
    `WHAT THIS IS NOT: a safety check. There is no honeypot simulation here, no test that the token can ` +
      `actually be sold, no owner/mint/freeze/blacklist probe, no liquidity-lock check and no ` +
      `proxy-upgradeability check — none of those were available to build this from. Everything above is ` +
      `provenance and distribution. A clean reading here does NOT mean the token can be exited, and must ` +
      `not be treated as permission to size up.`,
  );

  return lines.join("\n\n");
}
