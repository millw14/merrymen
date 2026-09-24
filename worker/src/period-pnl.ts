/**
 * WHAT MOVED AN ACCOUNT'S VALUE OVER A PERIOD: MONEY IN OR OUT, TRADING AND
 * PRICE MOVES — OR SOMETHING THE RECORDS CANNOT EXPLAIN.
 *
 * The chat answers "how did I do today" as (latest value − opening value −
 * money put in or taken out), which is right while the records are complete.
 * They are not across a restart: a deposit made while the agent was down is
 * booked by nobody, and an old incarnation could book the opening balance
 * again as a flow when it came back. Either way the difference landed in
 * "trading", as a gain or a loss the agent never made.
 *
 * So wherever the record is known to be BROKEN, the step is judged from what
 * its cash did. Known breaks are: the step across a hosted redeploy (the seam
 * between the carried record and this ledger); the step containing this
 * process's own start (a crash or watchdog restart that kept the ledger); and
 * any step far longer than the book's usual spacing (an outage, a stall). An
 * EARLIER restart shorter than that leaves no mark in the record — no run id
 * is written — and is not judged; a deposit made during one counts as trading,
 * as it always did.
 *
 *   - a trade in the step explains any cash move: its flows are money in or
 *     out, the rest is trading;
 *   - cash that moved by exactly the recorded flows: they are money in or out;
 *   - cash that moved by exactly the EVIDENCED flows (a chain log, an epoch
 *     carry): those count, and a flow nobody saw the balance make — a
 *     re-booked opening balance — does not;
 *   - otherwise nothing explains it, and the step's whole change is
 *     UNATTRIBUTED: reported as such, never as trading.
 *
 * Within a CONTINUOUS run every flow counts, exactly as before. Judging those
 * steps one by one misfired on timing alone: an order typed in Telegram is
 * stamped before the mark its cash lands after, and a deposit can be booked a
 * tick before the balance shows it — each an "unexplained" move the records
 * did explain, a step later.
 *
 * Windows follow the tick's order — balances read, flows booked, mark written,
 * then trades — so a step's flows are those in (prev, cur] and its trades
 * those in [prev, cur). Never earlier: a trade stamped before the opening mark
 * is already in its cash, and letting it excuse the step would put a deposit
 * made while the agent was down into trading.
 *
 * Pure: no ledger, no clock. The orchestrator runs it over the shared ledger,
 * telegram/chat-tools.ts over the child's own and across the seam between.
 */

/** A cash move smaller than this is rounding, not money (the child's MATERIAL_DRIFT_USDG). */
export const RECONCILE_TOLERANCE_USDG = 0.01;
/** No gap shorter than this is a break in the record, whatever the tick. */
export const MIN_BREAK_SEC = 120;

export interface BookMark {
  at: number;
  equity: number;
  cash: number;
}

export interface BookFlow {
  at: number;
  /** Positive in, negative out. */
  signed: number;
  /** Chain-log or epoch-carry (packages/core isEvidencedFlow). */
  evidenced: boolean;
}

export interface Attribution {
  /** Money put in (+) or taken out (−). */
  flows: number;
  /** Change no record explains — never counted as trading. */
  unattributed: number;
}

/** One judged step's attribution. */
export function stepAttribution(prev: BookMark, cur: BookMark, flows: readonly BookFlow[], traded: boolean): Attribution {
  let fe = 0;
  let fu = 0;
  for (const f of flows) {
    if (f.evidenced) fe += f.signed;
    else fu += f.signed;
  }
  if (traded) return { flows: fe + fu, unattributed: 0 };
  const dC = cur.cash - prev.cash;
  if (Math.abs(dC - fe - fu) < RECONCILE_TOLERANCE_USDG) return { flows: fe + fu, unattributed: 0 };
  if (Math.abs(dC - fe) < RECONCILE_TOLERANCE_USDG) return { flows: fe, unattributed: 0 };
  return { flows: fe, unattributed: cur.equity - prev.equity - fe };
}

/**
 * The shortest gap between two marks that is a break in the record: three
 * times the book's usual (median) spacing, and never under MIN_BREAK_SEC.
 */
export function breakGap(marks: readonly BookMark[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < marks.length; i++) gaps.push(marks[i]!.at - marks[i - 1]!.at);
  if (!gaps.length) return MIN_BREAK_SEC;
  gaps.sort((a, b) => a - b);
  return Math.max(MIN_BREAK_SEC, 3 * gaps[Math.floor((gaps.length - 1) / 2)]!);
}

/** Is there a trade in [from, to)? `sortedTrades` ascending. */
function tradedIn(sortedTrades: readonly number[], from: number, to: number): boolean {
  let lo = 0;
  let hi = sortedTrades.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedTrades[mid]! < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < sortedTrades.length && sortedTrades[lo]! < to;
}

/**
 * Running attribution over one book's marks (ascending by time): entry i is
 * `start` plus every step up to mark i, so any period is a difference of two
 * entries. Flows at or before the first mark belong to whatever came before
 * and are skipped. Only a break is judged (stepAttribution) — a step longer
 * than `gap`, or one containing a known restart in `breaks` (prev < b ≤ cur);
 * every other step counts its flows as money in or out.
 */
export function attributeBook(
  marks: readonly BookMark[],
  flows: readonly BookFlow[],
  tradeTimes: readonly number[],
  start: Attribution = { flows: 0, unattributed: 0 },
  gap: number = breakGap(marks),
  breaks: readonly number[] = [],
): Attribution[] {
  if (!marks.length) return [];
  const fl = [...flows].sort((a, b) => a.at - b.at);
  const tt = [...tradeTimes].sort((a, b) => a - b);
  const out: Attribution[] = [{ ...start }];
  let fi = 0;
  while (fi < fl.length && fl[fi]!.at <= marks[0]!.at) fi++;
  for (let i = 1; i < marks.length; i++) {
    const prev = marks[i - 1]!;
    const cur = marks[i]!;
    const inStep: BookFlow[] = [];
    while (fi < fl.length && fl[fi]!.at <= cur.at) inStep.push(fl[fi++]!);
    const broken = cur.at - prev.at > gap || breaks.some((b) => b > prev.at && b <= cur.at);
    const s = broken
      ? stepAttribution(prev, cur, inStep, tradedIn(tt, prev.at, cur.at))
      : { flows: inStep.reduce((sum, f) => sum + f.signed, 0), unattributed: 0 };
    const p = out[i - 1]!;
    out.push({ flows: p.flows + s.flows, unattributed: p.unattributed + s.unattributed });
  }
  return out;
}

/** A book: marks in one mode. NULL (a mark from before modes were recorded) is its own. */
export type BookKey = "paper" | "live" | "unknown";

export function bookOf(mode: string | null | undefined): BookKey {
  return mode === "paper" ? "paper" : mode === "live" ? "live" : "unknown";
}

/** A mark with its book and running attribution. */
export interface AccountPoint extends BookMark, Attribution {
  book: BookKey;
  /** From before the last restart (the shared ledger), not this ledger. */
  carried: boolean;
}

/** Flows after a book's last carried mark, up to when the carried record was taken. */
export interface CarriedTail {
  book: BookKey;
  evidenced: number;
  unevidenced: number;
}

export interface SeriesInput {
  /** Points from before the restart, with running attribution already applied by the orchestrator. */
  carried: readonly Omit<AccountPoint, "carried">[];
  carriedTail: readonly CarriedTail[];
  /** This ledger's marks, flows and trade times (restart copies excluded). */
  local: readonly (BookMark & { book: BookKey })[];
  localFlows: readonly BookFlow[];
  /** Times this ledger is known to have been restarted (the running process's start). */
  localBreaks?: readonly number[];
  /** Trade times by book: practice fills for the practice book, landed or submitted for the others. */
  tradeTimes: { paper: readonly number[]; live: readonly number[] };
}

/**
 * Every point of every book, ascending, with one running attribution per book
 * that crosses the restart: carried points as the shared ledger computed them,
 * then the SEAM — the step from the last carried mark to this ledger's first,
 * across the downtime, always judged — then this ledger's own steps.
 *
 * Practice books take no flows: practice cash is simulated, and flows are
 * real money.
 */
export function accountSeries(s: SeriesInput): AccountPoint[] {
  const out: AccountPoint[] = [];
  for (const book of ["paper", "live", "unknown"] as const) {
    const P = s.carried.filter((p) => p.book === book).sort((a, b) => a.at - b.at);
    const L = s.local.filter((m) => m.book === book).sort((a, b) => a.at - b.at);
    const flows = book === "paper" ? [] : s.localFlows;
    const trades = [...(book === "paper" ? s.tradeTimes.paper : s.tradeTimes.live)].sort((a, b) => a - b);
    for (const p of P) out.push({ ...p, carried: true });
    if (!L.length) continue;
    let start: Attribution = { flows: 0, unattributed: 0 };
    const last = P[P.length - 1];
    if (last) {
      const first = L[0]!;
      const tail = book === "paper" ? undefined : s.carriedTail.find((t) => t.book === book);
      const seamFlows: BookFlow[] = [
        ...(tail && tail.evidenced ? [{ at: first.at, signed: tail.evidenced, evidenced: true }] : []),
        ...(tail && tail.unevidenced ? [{ at: first.at, signed: tail.unevidenced, evidenced: false }] : []),
        ...flows.filter((f) => f.at > last.at && f.at <= first.at),
      ];
      const seam = stepAttribution(last, first, seamFlows, tradedIn(trades, last.at, first.at));
      start = { flows: last.flows + seam.flows, unattributed: last.unattributed + seam.unattributed };
    }
    const cum = attributeBook(L, flows, trades, start, breakGap(L), s.localBreaks ?? []);
    L.forEach((m, i) => out.push({ at: m.at, equity: m.equity, cash: m.cash, book, ...cum[i]!, carried: false }));
  }
  // Carried points are all older than this ledger's (it began after they were
  // read), so time alone orders them; the sort is stable within a second.
  return out.sort((a, b) => a.at - b.at);
}

export type PeriodChange =
  | { kind: "none" }
  | {
      kind: "change";
      open: AccountPoint;
      close: AccountPoint;
      change: number;
      flows: number;
      unattributed: number;
      trading: number;
      /** The other book (practice, or real money) also used in the period — its money is not in these figures. Mode-less marks never count. */
      also: "paper" | "live" | null;
    };

/**
 * The change over a period starting at `since`, in the book the account is in
 * now: from its last point at or before `since` (else its first after) to its
 * newest. Practice and real money are never compared with each other; a
 * period that used the other book too says so.
 */
export function periodChange(series: readonly AccountPoint[], since: number): PeriodChange {
  const close = series[series.length - 1];
  if (!close) return { kind: "none" };
  const book = series.filter((p) => p.book === close.book);
  let open: AccountPoint | undefined;
  for (const p of book) if (p.at <= since) open = p;
  open ??= book.find((p) => p.at >= since);
  if (!open) return { kind: "none" };
  const change = close.equity - open.equity;
  const flows = close.flows - open.flows;
  const unattributed = close.unattributed - open.unattributed;
  const other = series.find((p) => p.book !== close.book && p.book !== "unknown" && p.at > Math.min(since, open!.at) && p.at <= close.at);
  const also = other ? (other.book as "paper" | "live") : null;
  return { kind: "change", open, close, change, flows, unattributed, trading: change - flows - unattributed, also };
}
