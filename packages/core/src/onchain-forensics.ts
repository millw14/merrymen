/**
 * WHO ACTUALLY HOLDS THIS COIN, AND DID THEY ARRIVE TOGETHER.
 *
 * The memecoin desk asks for four lenses — technical, onchain, social,
 * liquidity — and `onchain` has never had a supplier. It was left unfed on
 * purpose and said so: "holder distribution and flow need an indexer this repo
 * does not have, and a lens fed a guess is worse than a lens fed nothing."
 *
 * ChainMind has that indexer, and this is its analysis brought across. The
 * arithmetic below is a port of the pure half of its holder, transfer and swap
 * forensics — the part that takes rows and returns a verdict, with no network,
 * no clock and no credentials. Only the fetching stays behind.
 *
 * WHAT THESE FOUR QUESTIONS ARE FOR. A launchpad coin's price says almost
 * nothing; the distribution behind it says most of what can be known:
 *
 *   CONCENTRATION  can a handful of wallets end this at will
 *   BUNDLING       did "many holders" arrive in one block window, i.e. one actor
 *   ROUND TRIPS    is the volume real, or the same wallet trading with itself
 *   CLUSTERING     are the amounts human, or stamped out by a script
 *
 * WHAT THIS IS NOT, AND THE PORT MUST NOT BE SOLD AS IT. There is no honeypot
 * simulation here, no sell-path test, no owner/mint/freeze/blacklist probe, no
 * LP-lock check and no proxy-upgradeability check — ChainMind has none of those
 * either. This is provenance and distribution. It complements a rug check; it
 * is not one, and an agent must not read a clean report here as "safe to buy".
 *
 * EVERY VERDICT CARRIES ITS SAMPLE. An indexer returns a PAGE of holders, not
 * all of them, and a concentration computed over the top 50 of 4,000 is a
 * different claim from one over all of them. So every result says what it saw,
 * and `complete: false` is a fact that travels rather than a caveat somebody
 * remembers to add.
 *
 * PURE. Rows in, verdicts out.
 */

/** One holder row, as any indexer can supply it. */
export interface HolderRow {
  address: string;
  /** Raw balance. Decimals are the caller's business; ratios need none. */
  raw: bigint;
}

/** One acquisition: when an address first received the token. */
export interface AcquisitionRow {
  address: string;
  /** Block number of the first inbound transfer. */
  block: number;
}

/** One trade, reduced to what a wash-trade check needs. */
export interface TradeRow {
  trader: string;
  block: number;
  /** Positive buys the token, negative sells it. Units are the caller's. */
  delta: bigint;
}

/** Addresses that are never "holders" in the sense that matters. */
export interface ExcludedAddresses {
  /** Pools, the launch curve, the router — inventory, not ownership. */
  venues?: readonly string[];
  /** Burn and zero addresses. */
  burns?: readonly string[];
}

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

const lower = (s: string) => String(s ?? "").trim().toLowerCase();

/**
 * The addresses excluded from every holder statistic, as one set.
 *
 * A bonding curve holding 92% of supply is not a whale — it is the market
 * itself, and counting it makes every launchpad coin look identically doomed.
 * The same is true of a burn address, in the other direction: excluded supply
 * is not owned by anyone and must not dilute a concentration ratio.
 */
export function excludedSet(x: ExcludedAddresses = {}): Set<string> {
  const out = new Set<string>([ZERO, DEAD]);
  for (const a of x.venues ?? []) out.add(lower(a));
  for (const b of x.burns ?? []) out.add(lower(b));
  return out;
}

export interface Concentration {
  /** Share of counted supply held by the largest N, in bps. */
  topBps: number;
  /** How many holders that N was. */
  n: number;
  /** Holders counted, after exclusions. */
  counted: number;
  /** False when the indexer returned a page rather than the whole set. */
  complete: boolean;
  /** Excluded addresses that appeared in the rows, for the sentence. */
  excluded: number;
}

/**
 * What share of the real float the biggest holders control.
 *
 * NULL WHEN THERE IS NOTHING TO DIVIDE BY. A token whose entire supply sits in
 * its own curve has no float and therefore no concentration — reporting 0% or
 * 100% would both be inventions about a distribution that does not exist yet.
 */
export function concentrationOf(
  holders: readonly HolderRow[],
  opts: { top?: number; complete?: boolean; exclude?: ExcludedAddresses } = {},
): Concentration | null {
  const skip = excludedSet(opts.exclude);
  const kept: bigint[] = [];
  let excluded = 0;
  for (const h of holders) {
    if (skip.has(lower(h.address))) { excluded += 1; continue; }
    if (h.raw > 0n) kept.push(h.raw);
  }
  if (kept.length === 0) return null;
  const total = kept.reduce((a, b) => a + b, 0n);
  if (total <= 0n) return null;

  const n = Math.max(1, Math.min(opts.top ?? 10, kept.length));
  const top = kept.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).slice(0, n).reduce((a, b) => a + b, 0n);
  return {
    topBps: Number((top * 10_000n) / total),
    n,
    counted: kept.length,
    complete: opts.complete !== false,
    excluded,
  };
}

export interface BundleFinding {
  /** Addresses that first acquired inside one window. */
  size: number;
  /** The window's first and last block. */
  fromBlock: number;
  toBlock: number;
  /** Share of the acquisitions examined that landed in this window, bps. */
  shareBps: number;
}

/**
 * DID "MANY HOLDERS" ARRIVE AS ONE ACTOR.
 *
 * A hundred wallets that all first touched a token inside four minutes are not
 * a hundred people who found it. They are one script, and the holder count that
 * looks like distribution is the opposite of it.
 *
 * THE WINDOW MUST BE DERIVED FROM THE CHAIN, NOT COPIED. ChainMind's 2,500
 * blocks came from chain 4663 measuring ~9.4 blocks a second — about four and a
 * half minutes. Ported as a REQUIRED argument rather than a constant, because a
 * window carried to a chain with a different block time measures nothing and
 * would still produce confident findings.
 */
export function detectBundle(
  acquisitions: readonly AcquisitionRow[],
  windowBlocks: number,
): BundleFinding | null {
  if (!Number.isFinite(windowBlocks) || windowBlocks <= 0) return null;
  const rows = acquisitions
    .filter((a) => Number.isFinite(a.block) && a.block > 0 && lower(a.address))
    .sort((a, b) => a.block - b.block);
  if (rows.length < 2) return null;

  // The densest window, by sliding one over the sorted blocks. Two pointers
  // rather than a scan per row: the acquisition list can be thousands long and
  // this runs inside a decision.
  let best = { size: 0, from: 0, to: 0 };
  let lo = 0;
  for (let hi = 0; hi < rows.length; hi += 1) {
    while (rows[hi]!.block - rows[lo]!.block > windowBlocks) lo += 1;
    const size = hi - lo + 1;
    if (size > best.size) best = { size, from: rows[lo]!.block, to: rows[hi]!.block };
  }
  // One address is not a bundle, and neither is a pair that happens to be near.
  if (best.size < 3) return null;
  return {
    size: best.size,
    fromBlock: best.from,
    toBlock: best.to,
    shareBps: Math.round((best.size / rows.length) * 10_000),
  };
}

export interface RoundTripFinding {
  /** Traders who both bought and sold inside the window. */
  traders: number;
  /** Their share of all traders seen, bps. */
  shareBps: number;
  /** Total traders examined. */
  total: number;
}

/**
 * IS THE VOLUME REAL, OR THE SAME WALLET TRADING WITH ITSELF.
 *
 * A round trip inside a short window — buy then sell, or sell then buy — is the
 * signature of volume manufactured to look like interest. It is not proof: a
 * real trader can scalp. It is a RATIO worth knowing, and it is stated as one
 * rather than as a verdict, because the honest reading of "8 of 10 traders
 * round-tripped" is different from "8 of 400 did".
 */
export function roundTrips(trades: readonly TradeRow[], windowBlocks: number): RoundTripFinding | null {
  if (!Number.isFinite(windowBlocks) || windowBlocks <= 0) return null;
  const byTrader = new Map<string, TradeRow[]>();
  for (const t of trades) {
    const who = lower(t.trader);
    if (!who || t.delta === 0n) continue;
    (byTrader.get(who) ?? byTrader.set(who, []).get(who)!).push(t);
  }
  if (byTrader.size === 0) return null;

  let round = 0;
  for (const rows of byTrader.values()) {
    const sorted = [...rows].sort((a, b) => a.block - b.block);
    let bought: number | null = null;
    let sold: number | null = null;
    let hit = false;
    for (const r of sorted) {
      if (r.delta > 0n) bought = r.block;
      else sold = r.block;
      if (bought !== null && sold !== null && Math.abs(bought - sold) <= windowBlocks) { hit = true; break; }
    }
    if (hit) round += 1;
  }
  return {
    traders: round,
    total: byTrader.size,
    shareBps: Math.round((round / byTrader.size) * 10_000),
  };
}

export interface ClusterFinding {
  /** The repeated amount, raw. */
  amount: bigint;
  /** How many transfers carried exactly it. */
  count: number;
  /** Its share of the transfers examined, bps. */
  shareBps: number;
}

/**
 * ARE THE AMOUNTS HUMAN.
 *
 * People send round-ish numbers that differ. A script sends the same number
 * many times. An identical raw amount repeated across many transfers is the
 * cheapest automation tell there is, and it needs no price, no decimals and no
 * second data source.
 */
export function amountClusters(
  amounts: readonly bigint[],
  opts: { minCount?: number } = {},
): ClusterFinding | null {
  const rows = amounts.filter((a) => a > 0n);
  if (rows.length < 3) return null;
  const counts = new Map<string, number>();
  for (const a of rows) counts.set(a.toString(), (counts.get(a.toString()) ?? 0) + 1);

  let best: { amount: bigint; count: number } | null = null;
  for (const [k, c] of counts) {
    if (!best || c > best.count) best = { amount: BigInt(k), count: c };
  }
  const minCount = opts.minCount ?? 3;
  if (!best || best.count < minCount) return null;
  return {
    amount: best.amount,
    count: best.count,
    shareBps: Math.round((best.count / rows.length) * 10_000),
  };
}
