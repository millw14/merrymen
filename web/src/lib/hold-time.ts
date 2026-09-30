/**
 * HOW LONG THIS AGENT HOLDS WHAT IT BUYS, from its own fills and nothing else.
 *
 * Its own module with NO IMPORTS, for the reason growth-index and rank-pnl have
 * none: this is a figure published about a named agent, and a rule buried in a
 * database read is a rule nobody can test.
 *
 * FIFO BY QUANTITY. Each sell closes the oldest still-open buy of the same coin
 * first, taking as much of it as the sell sold, then the next oldest. Every
 * (buy, sell) piece that meets is one round trip, and the figure is the mean of
 * their holds, UNWEIGHTED. Weighting by quantity would compare raw units across
 * coins with different decimals — an 18-decimal memecoin would outvote a
 * 6-decimal stock token by a factor of 10^12 — so each pairing counts once.
 *
 * WHAT WAS CARRIED INTO THE PERIOD IS SOLD FIRST. A new period carries positions
 * over (openNextEpoch bumps the epoch and leaves cost_basis and the holdings
 * alone), so the oldest lot of a coin held at the period's start is the one it
 * started with. Those units open the FIFO as lots with no time: a sell consumes
 * them first and they never make a pair, because their hold began outside what
 * is measured. Without them an agent carrying 1,000 TSLA that bought 10 and
 * trimmed 10 a minute later printed "avg hold 1m", where the trim closed units
 * held for weeks. The opening is read from the fills before the period
 * (openingOf); a coin whose opening could not be read refuses the whole hold
 * the moment the period sells it.
 *
 * WHAT MAKES IT NULL, and why each is a refusal rather than a smaller figure:
 *  - no sell ever met a buy of this period: there is no round trip, so there is
 *    no hold to average. The stats line leaves the term out rather than
 *    printing "0s".
 *  - any fill whose side, coin or quantity was not read. FIFO is ORDER-
 *    dependent: one unreadable sell shifts which buy every later sell of that
 *    coin closes, so skipping it would not make the answer smaller, it would
 *    make it a different answer about a different sequence.
 *  - a sell of a coin whose opening quantity is unknown, for the same reason:
 *    how much of it closed carried units decides which of this period's buys
 *    the rest closed.
 */

export interface HoldFill {
  side: "buy" | "sell" | null;
  /** The position key: the coin's token address. Null when unread. */
  coin: string | null;
  /** Raw token units. Null when unread. */
  qty: bigint | null;
  /** Unix seconds. */
  at: number;
  /**
   * `trades.basis_source` — how the quantity was evidenced. Read by openingOf
   * only: a quantity booked from the quote is the slippage floor, not what
   * arrived, so it cannot be carried.
   */
  source?: string | null;
}

/**
 * What was held of each coin (lowercased) when the period began. A coin absent
 * from the map was flat; a null quantity is one that could not be read.
 */
export type Opening = ReadonlyMap<string, bigint | null>;

/**
 * THE PAPER BOOK'S ROUNDING, in the raw units its fills are booked in (1e18 per
 * share). paper.ts keeps a holding's share count to six decimals after every
 * sell, so a paper book and the fills that built it drift by up to half a
 * millionth of a share per partial sell; this is twenty such sells' worth. A
 * leftover no bigger than it is rounding, not a position — left in, a lot of it
 * would be paired with a sell months later and pull the mean with a hold that
 * never happened. A funded book's quantities are read off receipts and exact,
 * so its callers pass zero.
 */
export const PAPER_DUST_RAW = 10n ** 13n;

const EVIDENCED = new Set(["receipt", "paper"]);

/**
 * What was carried into the period, from every fill of the same book BEFORE it,
 * oldest first — or null when nothing can be said about any coin.
 *
 * Replayed the way the worker's own ledger moved: a buy adds, a sell removes.
 * Per coin, the carried quantity is KNOWN only when every fill of it replayed
 * exactly and every buy still in what is held was read off a receipt (or is a
 * paper fill, which is exact). It is UNKNOWN (null) after a fill nobody could
 * size, after a sell of more than the tape ever bought — something the tape
 * never saw came in, so what is left is not what it says — and while an
 * estimated buy is still held. Selling out clears an estimate: nothing bought
 * before a flat point is in what is held after it.
 *
 * Null overall when the read was cut short (`complete` false) — its first row
 * is not the book's first — or when a fill of an unknown coin could have been
 * any coin's.
 */
export function openingOf(prior: readonly HoldFill[], opts: { complete: boolean; dust: bigint }): Map<string, bigint | null> | null {
  if (!opts.complete) return null;
  const state = new Map<string, { held: bigint; estimated: boolean; known: boolean }>();
  for (const f of prior) {
    if (f.coin === null) return null;
    const key = f.coin.toLowerCase();
    const s = state.get(key) ?? { held: 0n, estimated: false, known: true };
    state.set(key, s);
    if (!s.known) continue;
    if (f.side === null || f.qty === null || f.qty <= 0n || !Number.isFinite(f.at)) {
      s.known = false;
      continue;
    }
    if (f.side === "buy") {
      s.held += f.qty;
      if (!EVIDENCED.has(f.source ?? "")) s.estimated = true;
      continue;
    }
    if (f.qty > s.held + opts.dust) {
      s.known = false;
      continue;
    }
    s.held -= f.qty < s.held ? f.qty : s.held;
    if (s.held <= opts.dust) {
      s.held = 0n;
      s.estimated = false;
    }
  }
  const out = new Map<string, bigint | null>();
  for (const [key, s] of state) out.set(key, !s.known ? null : s.held === 0n ? 0n : s.estimated ? null : s.held);
  return out;
}

/**
 * The mean hold of every FIFO-paired round trip of the period, in seconds, or
 * null.
 *
 * `fills` are the period's own, oldest first — the order the ledger read
 * returns — because FIFO is defined over time and sorting here would hide a
 * caller that did not. `opening` is what was carried in (openingOf); null says
 * nothing is known about it. `dust` is the book's rounding (PAPER_DUST_RAW for
 * a paper book, zero otherwise).
 */
export function averageHoldSec(fills: readonly HoldFill[], opening: Opening | null, dust = 0n): number | null {
  if (opening === null) return null;
  const open = new Map<string, { qty: bigint; at: number | null }[]>();
  let total = 0;
  let pairs = 0;
  for (const f of fills) {
    if (f.side === null || f.coin === null || f.qty === null || f.qty <= 0n || !Number.isFinite(f.at)) return null;
    const key = f.coin.toLowerCase();
    let lots = open.get(key);
    if (!lots) {
      const carried = opening.get(key);
      // Unknown opening: harmless until the period sells the coin.
      if (carried === null && f.side === "sell") return null;
      lots = carried !== null && carried !== undefined && carried > 0n ? [{ qty: carried, at: null }] : [];
      open.set(key, lots);
    } else if (f.side === "sell" && opening.get(key) === null) {
      return null;
    }
    if (f.side === "buy") {
      lots.push({ qty: f.qty, at: f.at });
      continue;
    }
    let left = f.qty;
    while (left > 0n && lots.length > 0) {
      const lot = lots[0]!;
      const take = lot.qty < left ? lot.qty : left;
      // A carried lot's hold began outside the period; a piece no bigger than
      // the book's rounding is not a trade.
      if (lot.at !== null && take > dust) {
        total += Math.max(0, f.at - lot.at);
        pairs += 1;
      }
      lot.qty -= take;
      left -= take;
      if (lot.qty === 0n) lots.shift();
    }
  }
  return pairs > 0 ? total / pairs : null;
}

/**
 * A hold, in the largest two units that say it: "45s", "12m", "3h 20m",
 * "2d 4h". Null in, null out — never "0s" for a figure that does not exist.
 */
export function holdWords(sec: number | null): string | null {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return null;
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
