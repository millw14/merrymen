/**
 * ONE SWAPS TABLE, FOR A STRANGER AND FOR THE OWNER — its rules, where a test
 * can run them.
 *
 * The public profile rendered each fill as a four-line article ("Not realized
 * on a buy" under every buy, a full date, three footnotes, no coin), and the
 * owner's desk had its own list of every row of any status, so thirty ops-cap
 * refusals pushed the owner's actual fills off the screen. Both now build the
 * same rows and render them with SwapsTable.tsx:
 *
 *  - a Buy or Sell pill, the coin and its name, and a relative age with the
 *    full date on hover;
 *  - DOLLARS ONLY WHERE THEY MAY BE SHOWN: the owner's own desk, or a profile
 *    whose owner published the book. The server already withholds a private
 *    book's sizes; the table refuses to print one it was handed anyway;
 *  - a P&L chip on sells only — a buy realizes nothing, and saying so on every
 *    buy was noise;
 *  - REFUSALS COLLAPSED, per reason, into one muted "Tried" line placed where
 *    the newest of them happened: "Refused 12× today: past today's number of
 *    trades". The owner is still told every refusal and why — hiding refusals
 *    from the owner is the one thing this may not do — just not thirty times.
 */
import type { ProfileTrade } from "@/lib/profile-trades";
import { DESK_TAPE_LIMIT } from "@/lib/desk-trades";
import { pctBps, usd } from "@/lib/format";
import type { Thesis } from "./live";

export type SwapSide = "buy" | "sell" | null;
export type SwapStatus = "filled" | "pending" | "refused" | "reverted";

/**
 * WHAT KIND OF OPERATION A ROW IS. Only a trade is a swap.
 *
 * The owner's tape carries every kind the worker records — the default steady
 * basket parks idle cash in a vault and takes it back, and the chat can send
 * USDG out — and none of those has a side or a coin. Mapped as trades, each
 * read "Swap · Token label unavailable" and was counted in "Trades · N". Each
 * now says what it did, and is not a trade.
 */
export type SwapOp = "trade" | "vault-in" | "vault-out" | "transfer" | "other";

/** The worker's trade kinds — the intents that buy or sell something. */
const TRADE_KINDS: ReadonlySet<string> = new Set(["swap", "curve-trade", "equity-order"]);

/** A tape row's kind (`trades.kind`, carried as `Thesis.head`) as an operation. */
export function opOfKind(kind: string | null | undefined): SwapOp {
  if (typeof kind !== "string") return "other";
  if (TRADE_KINDS.has(kind)) return "trade";
  if (kind === "vault-deposit") return "vault-in";
  if (kind === "vault-withdraw") return "vault-out";
  if (kind === "transfer") return "transfer";
  return "other";
}

/** How a row that is not a trade is named: its pill, and the line in place of a coin. */
export const OP_WORDS: Record<Exclude<SwapOp, "trade">, { pill: string; line: string }> = {
  "vault-in": { pill: "Vault", line: "Moved to a vault" },
  "vault-out": { pill: "Vault", line: "Taken back from a vault" },
  transfer: { pill: "Transfer", line: "Sent out of the account" },
  other: { pill: "Other", line: "Not a trade" },
};

export interface SwapRow {
  id: string;
  /** A trade, or a move of cash that is not one — see SwapOp. */
  op: SwapOp;
  /** Null when nothing recorded which way it went — a "Swap", never a guess. */
  side: SwapSide;
  status: SwapStatus;
  symbol: string | null;
  displayName: string | null;
  /** Unix seconds. Null when unread. */
  at: number | null;
  paper: boolean;
  sizeUsdg: number | null;
  realizedBps: number | null;
  realizedUsd: number | null;
  /** The wall's reason, in words — refusals only. */
  reason: string | null;
  /** Why the agent did it, in its decision's words. The owner's desk only. */
  why: string | null;
}

/** From the public profile's fills (profile-trades.ts): every one filled, every one a trade. */
export function swapRowsOfProfile(trades: readonly ProfileTrade[]): SwapRow[] {
  return trades.map((t) => ({
    id: t.id,
    op: "trade",
    side: t.action === "swap" ? null : t.action,
    status: "filled",
    symbol: t.symbol,
    displayName: t.displayName,
    at: Number.isFinite(t.at) ? t.at : null,
    paper: t.paper,
    sizeUsdg: t.sizeUsdg,
    realizedBps: t.realizedPnlBps,
    realizedUsd: t.realizedPnlUsdg,
    reason: null,
    why: null,
  }));
}

/**
 * The fields the owner's tape carries beside a Thesis (D3): live.ts mineOf maps
 * them from the columns desk-trades.ts already selects. Optional, because a
 * feed from before them sends none — and absent is then "not read", never a
 * zero or an empty name.
 *
 * `realizedVouched` is desk-trades.ts `realized_vouched`: the realized figure
 * rests on proceeds and a cost that were both read. Absent is not a vouch.
 */
type DeskMove = Thesis & { displayName?: string | null; realizedPnlUsdg?: number | null; realizedVouched?: boolean; txHash?: string | null };

/**
 * From the owner's own tape (live.ts `mine.moves`, from /api/feed).
 *
 * The coin's own name and a sell's realized DOLLARS travel when the tape
 * carries them. Not a percentage: the tape holds no cost, and the order's size
 * is what was asked for rather than what the fill cost, so a % made from it
 * would be invented — the chip shows the dollars alone (see pnlChip).
 *
 * AND THE DOLLARS ONLY WHEN THE TAPE VOUCHES FOR THEM. The worker books a
 * realized figure on a sell whose proceeds came from the quote, and on one
 * whose cost a quoted buy built; the profile refuses a return on either
 * (profile-trades.ts), and a chip printing it here would present the same
 * estimate to the owner as a result. So a sell's dollars travel only beside the
 * tape's own `realizedVouched: true` — withheld, not guessed, when it is absent.
 */
export function swapRowsOfDesk(moves: readonly Thesis[]): SwapRow[] {
  return moves.map((raw, i) => {
    const m = raw as DeskMove;
    const status: SwapStatus =
      m.outcome === "landed" ? "filled"
        : m.outcome === "refused" ? "refused"
        : m.outcome === "reverted" ? "reverted"
        : "pending";
    const at = typeof m.at === "number" && Number.isFinite(m.at) ? m.at : null;
    const side: SwapSide = m.action === "buy" || m.action === "sell" ? m.action : null;
    const realized = typeof m.realizedPnlUsdg === "number" && Number.isFinite(m.realizedPnlUsdg) ? m.realizedPnlUsdg : null;
    return {
      id: `${at ?? "t"}-${i}`,
      op: opOfKind(m.head),
      side,
      status,
      symbol: m.symbol,
      displayName: admitName(m.displayName, m.symbol),
      at,
      paper: m.paper,
      sizeUsdg: m.sizeUsdg,
      realizedBps: null,
      // A sell that filled is the only row that realized anything; a buy's
      // stored zero is "nothing to realize", not a result. And only a figure
      // the tape vouches for is one.
      realizedUsd: side === "sell" && status === "filled" && m.realizedVouched === true ? realized : null,
      reason: status === "refused" || status === "reverted" ? m.outcomeText ?? null : null,
      why: m.reason ?? null,
    };
  });
}

/**
 * A coin names itself on chain, so its name is admitted rather than echoed —
 * the same rule profile-trades.ts applies to the public list: printable, short,
 * not an address, and not the symbol again.
 */
function admitName(raw: unknown, symbol: string | null): string | null {
  const named = typeof raw === "string" ? raw.trim() : "";
  if (!named || named.length > 64 || /[\u0000-\u001f\u007f]/.test(named) || /^0x/i.test(named)) return null;
  return symbol && named.toUpperCase() === symbol.toUpperCase() ? null : named;
}

/**
 * The P&L chip: on a SELL only, its return when it was read, its dollars only
 * where dollars may be shown. Null when there is nothing read to put on it — a
 * buy, or a sell whose cost basis was never evidenced — and then no chip is
 * drawn. The owner's desk has the dollars and no cost to make a % from, so its
 * chip is the dollars alone.
 */
export function pnlChip(r: SwapRow, showMoney: boolean): { text: string; tone: "up" | "down" } | null {
  if (r.side !== "sell") return null;
  const bps = r.realizedBps !== null && Number.isFinite(r.realizedBps) ? r.realizedBps : null;
  const dollars = showMoney && r.realizedUsd !== null && Number.isFinite(r.realizedUsd) ? r.realizedUsd : null;
  const usdText = dollars === null ? null : `${dollars >= 0 ? "+" : "−"}${usd(Math.abs(dollars))}`;
  if (bps === null) return usdText === null ? null : { text: usdText, tone: dollars! < 0 ? "down" : "up" };
  return { text: `${pctBps(bps)}${usdText === null ? "" : ` · ${usdText}`}`, tone: bps < 0 ? "down" : "up" };
}

/** A size, only where dollars may be shown, and never a measured zero. */
export function sizeText(r: SwapRow, showMoney: boolean): string | null {
  return showMoney && r.sizeUsdg !== null && Number.isFinite(r.sizeUsdg) && r.sizeUsdg > 0 ? usd(r.sizeUsdg) : null;
}

/**
 * How many rows the owner's tape holds at most — readDeskTrades' own limit,
 * read from desk-trades.ts rather than copied. A tape that came back this full
 * may have been cut at its old end, so a count reaching back to that end is a
 * FLOOR and says "12+×".
 */
export const DESK_TAPE_ROWS = DESK_TAPE_LIMIT;

export type SwapTab = "all" | "buys" | "sells";

export type SwapItem =
  | { kind: "row"; row: SwapRow }
  | {
      kind: "tried";
      key: string;
      status: "refused" | "reverted";
      count: number;
      reason: string | null;
      newestAt: number | null;
      oldestAt: number | null;
      /**
       * Where the tape was CUT, unix seconds — its oldest row, when it came back
       * full. Null when the tape was whole. Anything older was never read.
       */
      cutAt: number | null;
    };

/**
 * A fill, or an order still on its way — what "Trades · N" counts. A trade
 * KIND only: a vault move or a transfer that landed is not a trade.
 */
export const isTrade = (r: SwapRow) => r.op === "trade" && (r.status === "filled" || r.status === "pending");

/**
 * The rows one tab shows, newest first, with every refusal of one reason
 * folded into a single "tried" item where the newest of them sits.
 *
 * `tapeFull` says the rows came from a read that hit its limit; the cut is
 * then the oldest row of the WHOLE tape, whichever tab is showing.
 */
export function swapItems(rows: readonly SwapRow[], tab: SwapTab, opts: { tapeFull?: boolean } = {}): SwapItem[] {
  let cutAt: number | null = null;
  if (opts.tapeFull) {
    for (const r of rows) if (r.at !== null && (cutAt === null || r.at < cutAt)) cutAt = r.at;
  }
  const inTab = rows
    .filter((r) => (tab === "all" ? true : r.op === "trade" && r.side === (tab === "buys" ? "buy" : "sell")))
    .slice()
    .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
  const out: SwapItem[] = [];
  const groups = new Map<string, Extract<SwapItem, { kind: "tried" }>>();
  for (const r of inTab) {
    if (r.status !== "refused" && r.status !== "reverted") {
      out.push({ kind: "row", row: r });
      continue;
    }
    const key = `${r.status}|${r.reason ?? ""}`;
    const g = groups.get(key);
    if (g) {
      g.count += 1;
      if (r.at !== null && (g.oldestAt === null || r.at < g.oldestAt)) g.oldestAt = r.at;
      continue;
    }
    const item = { kind: "tried" as const, key, status: r.status, count: 1, reason: r.reason, newestAt: r.at, oldestAt: r.at, cutAt };
    groups.set(key, item);
    out.push(item);
  }
  return out;
}

/**
 * "Refused 12× today: past today's number of trades".
 *
 * THE SPAN IS READ OFF THE ROWS, not assumed from the tape's window: "today"
 * only when the oldest of them fell on the reader's own calendar day, and
 * otherwise since the day it did. `dayWords` formats that day in the reader's
 * locale; it is passed in so this stays a pure function.
 *
 * AND THE COUNT IS EXACT ONLY IF THE TAPE REACHES BACK PAST THAT SPAN. "12×
 * today" from a tape cut at 10:00 this morning cannot know about 09:00, so it
 * says "12+×"; the same tape cut three days ago read every one of today's.
 */
export function triedLine(
  item: Extract<SwapItem, { kind: "tried" }>,
  nowMs: number,
  dayWords: (ms: number) => string,
): string {
  const verb = item.status === "reverted" ? "Reverted on chain" : "Refused";
  const oldest = item.oldestAt === null ? null : item.oldestAt * 1000;
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const spanStart = oldest === null ? null : oldest >= today.getTime() ? today.getTime() : new Date(oldest).setHours(0, 0, 0, 0);
  const span = oldest === null ? "" : oldest >= today.getTime() ? " today" : ` since ${dayWords(oldest)}`;
  const floor = item.cutAt !== null && (spanStart === null || item.cutAt * 1000 >= spanStart);
  return `${verb} ${item.count}${floor ? "+" : ""}×${span}${item.reason ? `: ${item.reason}` : ""}`;
}
