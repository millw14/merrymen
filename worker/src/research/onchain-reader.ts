/**
 * THE SUPPLIER THE `onchain` LENS NEVER HAD — and it is not an indexer.
 *
 * coin-liquidity.ts filled one of the memecoin desk's four lenses and named the
 * two it could not: "holder distribution and flow need an indexer this repo does
 * not have, and a lens fed a guess is worse than a lens fed nothing."
 * onchain-forensics.ts then brought across ChainMind's analysis — the pure half,
 * rows in and verdicts out. This is the half that was left behind: where the
 * rows come from.
 *
 * WHY NOT BLOCKSCOUT, WHICH IS WHAT CHAINMIND USES. Because it cannot be
 * reached from a server. `robinhoodchain.blockscout.com` sits behind a
 * Cloudflare *JS challenge*, not a user-agent check: measured 2026-09-09, the
 * v2 holders endpoint answers 403 with a `_cf_chl_opt` interstitial to a bare
 * request AND to one carrying ChainMind's `BROWSER_UA`. That UA fixed a
 * different block on a different day; it does not fix this one. Porting the
 * fetcher would have shipped a lens that is empty in production and green in
 * every test, which is the failure mode this repo keeps writing files about.
 *
 * SO THE ROWS ARE RECONSTRUCTED FROM `eth_getLogs`, which this chain serves
 * well: measured against the public RPC, one 1,000,000-block window of one
 * token's Transfer logs came back in 1.9s. Every holder statistic an explorer
 * would return is derivable from the transfer history, because an ERC-20 has no
 * other way to move.
 *
 * AND THE RECONSTRUCTION CHECKS ITSELF, which is the property that makes this
 * honest rather than merely cheap. Balances rebuilt from a PARTIAL window are
 * not balances — they are net flow over that window, and reporting them as
 * concentration would be a confident number about the wrong quantity. Two facts
 * settle it with no indexer at all:
 *
 *   · a token can only come into existence in a Transfer from the zero address,
 *     so if the reconstructed balances sum to `totalSupply()` we have seen every
 *     token that exists; and
 *   · an address that spends more than we saw it receive proves we started
 *     watching too late — a negative balance is not a small error, it is a
 *     receipt for a missing window.
 *
 * Both must pass. When they do, the numbers are EXACT — better than an
 * explorer's page, not worse. When either fails, `wholeHistory` is false and the
 * caller must not speak about distribution at all. Nothing here degrades
 * gracefully into a plausible number.
 *
 * WHAT IS STILL WINDOW-LOCAL EVEN WHEN COMPLETE. Round trips and amount
 * clustering are claims about a period, not about the token's life, and they
 * stay true whatever `wholeHistory` says — "in the last day, one wallet in three
 * bought and sold" needs no earlier history. Bundling does not: "when did these
 * holders arrive" is a question about the beginning, and answering it from a
 * window that missed the beginning invents a launch. So it travels with the
 * flag and the renderer honours it.
 *
 * THE IMPURE EDGE, kept to two calls — one `getLogsAdaptive` sweep and one
 * `totalSupply()` — behind a seam a fake can stand in for, exactly as
 * deposit-log.ts does with the same sweep.
 */
import type { Hex } from "viem";
import { getLogsAdaptive, type RawLog, type ReconcileChain } from "../inflight-reconcile";
import { TRANSFER_TOPIC } from "../deposit-log";
import type { AcquisitionRow, HolderRow, TradeRow } from "../../../packages/core/src/onchain-forensics";

/**
 * MEASURED, NOT ASSUMED. 1,048,576 blocks of chain 4663 spanned 105,799 seconds
 * on 2026-09-09 — 9.911 blocks a second. Every window below is written in
 * SECONDS and converted here, because a block count is a unit only in the
 * presence of a block time, and onchain-forensics.ts made that a required
 * argument for precisely this reason.
 *
 * ChainMind's own 2,500-block bundle window was derived from ~9.4 blocks a
 * second on this same chain, so it survives the crossing at ~4.2 minutes. That
 * is a fact about this chain, not a constant to carry anywhere else.
 */
export const BLOCKS_PER_SEC = 9.911;

/** Blocks spanning `sec` seconds of this chain, rounded up. */
export const blocksFor = (sec: number): bigint => BigInt(Math.max(1, Math.ceil(sec * BLOCKS_PER_SEC)));

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

const lower = (s: string) => String(s ?? "").trim().toLowerCase();

/** A 32-byte topic back to the 20-byte address it encodes. */
const fromTopic = (t: Hex | undefined): string => (t ? `0x${t.slice(-40)}`.toLowerCase() : "");

export interface OnchainSource {
  /** The same narrow seam the reconciler and the deposit scanner take. */
  chain: ReconcileChain;
  /**
   * `totalSupply()` for the token, or null when it could not be read.
   *
   * NULL IS NOT ZERO and it is not an error to swallow: without it the
   * completeness proof cannot run, so the scan reports `wholeHistory: false` and
   * says why. A supply read that fails must never let a partial window pass as
   * a full one.
   */
  totalSupply(token: `0x${string}`): Promise<bigint | null>;
}

export interface OnchainRequest {
  token: `0x${string}`;
  /** Chain head. Passed in so the caller can reuse a number it already read. */
  head: bigint;
  /** How far back to sweep. Required — see the module header. */
  windowBlocks: bigint;
  /** Ceiling on one `eth_getLogs` range; the sweep halves below it on a range error. */
  maxSpan?: bigint;
  /**
   * Curves, pools and routers. Inventory, not ownership — excluded from holder
   * statistics, and the counterparty that makes a transfer a TRADE rather than
   * a wallet-to-wallet move.
   */
  venues?: readonly string[];
  log?: (m: string) => void;
}

export interface OnchainScan {
  fromBlock: bigint;
  toBlock: bigint;
  /** Did the sweep actually cover the window it asked for. */
  scanned: boolean;
  /**
   * Do the reconstructed balances account for every token in existence.
   * FALSE MEANS DO NOT SPEAK ABOUT DISTRIBUTION — see the module header.
   */
  wholeHistory: boolean;
  /** Why not, in words, when `wholeHistory` is false. Null when it is true. */
  why: string | null;
  /** Exact when `wholeHistory`; otherwise net flow over the window and not to be used. */
  holders: readonly HolderRow[];
  /** First inbound block per address. Meaningful only when `wholeHistory`. */
  acquisitions: readonly AcquisitionRow[];
  /** Buys and sells against a venue. Window-local and always meaningful. */
  trades: readonly TradeRow[];
  /**
   * Wallet-to-wallet transfer amounts — neither side a venue, neither side the
   * zero address. Curve fills are excluded deliberately: a bonding curve's
   * amounts are set by whoever bought, so clustering over them measures the
   * market rather than a distributor. The tell this is for is round-number
   * fan-out to fresh wallets.
   */
  amounts: readonly bigint[];
  /** Transfer logs decoded. */
  transfers: number;
}

/**
 * Sweep one token's Transfer logs and reduce them to the four forensics inputs.
 *
 * Throws nothing that the sweep itself does not throw: a supply read that fails
 * becomes an absence, and a short sweep becomes `scanned: false`. The caller
 * gets a scan it can read the honesty of, never an exception in place of one.
 */
export async function scanToken(src: OnchainSource, req: OnchainRequest): Promise<OnchainScan> {
  const window = req.windowBlocks > 0n ? req.windowBlocks : 1n;
  const from = req.head > window ? req.head - window : 0n;
  const swept = await getLogsAdaptive(
    src.chain,
    { address: req.token, topics: [TRANSFER_TOPIC] },
    from,
    req.head,
    req.maxSpan ?? window,
    req.log,
  );

  const venues = new Set<string>((req.venues ?? []).map(lower));
  const skip = new Set<string>([ZERO, DEAD, ...venues]);

  const bal = new Map<string, bigint>();
  const firstIn = new Map<string, number>();
  const trades: TradeRow[] = [];
  const amounts: bigint[] = [];
  let minted = 0n;
  let burned = 0n;
  let transfers = 0;

  const credit = (a: string, v: bigint) => bal.set(a, (bal.get(a) ?? 0n) + v);

  for (const raw of swept.logs) {
    const decoded = decodeTransfer(raw);
    if (!decoded) continue;
    const { from: f, to: t, value, block } = decoded;
    transfers += 1;

    // A mint is supply arriving, not the zero address spending; a burn is
    // supply leaving. Booking either against ZERO's balance would put a
    // vast negative in the map and fail the negativity proof on every token.
    if (f === ZERO) minted += value;
    else credit(f, -value);
    if (t === ZERO || t === DEAD) burned += value;
    else credit(t, value);

    // FIRST INBOUND, and only for something that could be a holder. A venue's
    // first fill is not an acquisition, and neither is a burn.
    if (value > 0n && !skip.has(t) && !firstIn.has(t)) firstIn.set(t, block);

    if (value > 0n) {
      const fv = venues.has(f);
      const tv = venues.has(t);
      // Exactly one side a venue ⇒ a trade, and the other side is the trader.
      if (fv !== tv) {
        const trader = fv ? t : f;
        if (!skip.has(trader)) trades.push({ trader, block, delta: fv ? value : -value });
      } else if (!fv && f !== ZERO && t !== ZERO && t !== DEAD) {
        amounts.push(value);
      }
    }
  }

  const holders: HolderRow[] = [];
  let sum = 0n;
  let negative = 0;
  for (const [address, raw] of bal) {
    if (raw < 0n) negative += 1;
    else if (raw > 0n) {
      sum += raw;
      holders.push({ address, raw });
    }
  }

  const supply = await src.totalSupply(req.token).catch(() => null);
  const why = completenessFailure({ scanned: swept.complete, negative, sum, supply });

  return {
    fromBlock: from,
    toBlock: swept.scannedTo,
    scanned: swept.complete,
    wholeHistory: why === null,
    why,
    holders,
    acquisitions: [...firstIn].map(([address, block]) => ({ address, block })),
    trades,
    amounts,
    transfers,
  };
}

/**
 * The completeness proof, as one sentence or nothing.
 *
 * ORDERED SO THE MOST DECISIVE ANSWER WINS, and the last two are a real
 * distinction rather than two words for one failure. With no address negative
 * the balances necessarily sum to mints minus burns, so a disagreement with
 * `totalSupply()` has a DIRECTION, and the direction says which thing is wrong:
 *
 *   sum < supply   tokens exist that we never saw arrive and that have not
 *                  moved since — a mint before this window. Scanning further
 *                  back would fix it.
 *   sum > supply   we counted more than the contract says exists, so supply
 *                  left without a Transfer: a rebase, or a burn taken
 *                  in-contract. No amount of extra scanning fixes that, and it
 *                  is itself a fact about the coin an analyst would want.
 *
 * Reporting the second as the first would send an operator widening a window
 * forever against a token that can never reconcile.
 */
function completenessFailure(x: {
  scanned: boolean;
  negative: number;
  sum: bigint;
  supply: bigint | null;
}): string | null {
  if (!x.scanned) return "the transfer sweep did not finish, so some of this token's history was never read";
  if (x.negative > 0) {
    return `${x.negative} address${x.negative === 1 ? "" : "es"} spent more than we saw arrive, so this window starts after the token did`;
  }
  if (x.supply === null) return "the token's total supply could not be read, so the holder set cannot be checked against it";
  if (x.sum < x.supply) {
    return `the balances add up to ${x.sum} against a supply of ${x.supply} — ${x.supply - x.sum} was minted before this window and has not moved since`;
  }
  if (x.sum > x.supply) {
    return `the balances add up to ${x.sum} against a supply of ${x.supply} — this token does not conserve on transfer, so its ledger moves without a Transfer log`;
  }
  return null;
}

interface DecodedTransfer {
  from: string;
  to: string;
  value: bigint;
  block: number;
}

/**
 * One Transfer log to its three fields, or null.
 *
 * BY HAND RATHER THAN `decodeEventLog`, for the reason venues/pons.ts gives
 * about raw topics: this filter matches on topic0 alone across every token, and
 * a malformed or ERC-721-shaped log (three indexed args, empty data) must be
 * SKIPPED rather than throw and end a sweep of thousands of good ones.
 */
function decodeTransfer(raw: RawLog): DecodedTransfer | null {
  if (raw.topics?.length !== 3) return null;
  if (lower(raw.topics[0] ?? "") !== lower(TRANSFER_TOPIC)) return null;
  const from = fromTopic(raw.topics[1]);
  const to = fromTopic(raw.topics[2]);
  if (from.length !== 42 || to.length !== 42) return null;
  const body = String(raw.data ?? "0x");
  if (!/^0x[0-9a-fA-F]*$/.test(body)) return null;
  let value: bigint;
  try {
    value = body === "0x" ? 0n : BigInt(body.length > 66 ? body.slice(0, 66) : body);
  } catch {
    return null;
  }
  const block = raw.blockNumber ? Number(BigInt(raw.blockNumber)) : NaN;
  if (!Number.isFinite(block)) return null;
  return { from, to, value, block };
}
