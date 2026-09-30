/**
 * WHAT THE SHELL DERIVES FROM /api/grants, and what it may say when it could
 * not read it.
 *
 * Out of App.tsx so it can be executed rather than read: App renders under
 * next/navigation and cannot be mounted by the test runner, and every mistake
 * this file exists to prevent was a coercion that looked harmless in source.
 */
import type { AccountState } from "./HostedControls";
import type { ReadState } from "./live";

/**
 * A 6dp USDG amount from the chain, in dollars — or null when nobody read it.
 *
 * `Number(null)` is 0, which is how a failed balance read used to become a
 * balance of zero here even after the route stopped inventing one. An amount
 * that does not parse is unread too: it is not evidence of an empty account.
 */
export function usdgOrNull(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n / 1e6 : null;
}

const capOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * The two signed caps, or null for each one the shell has not read.
 *
 * WAS `String(caps ?? "")`, and every surface rendered `money(Number(perTrade))`
 * — so an unread key printed "$0.00 per trade". That is a limit, and a limit
 * of zero is the most alarming thing a trading screen can show about money the
 * owner has signed away. Null reaches `money`, which draws a dash.
 */
export function capsOf(account: AccountState | null): { perTrade: number | null; perDay: number | null } {
  const caps = account?.status.grant?.caps;
  return { perTrade: capOrNull(caps?.perTradeUsdg), perDay: capOrNull(caps?.dailyUsdg) };
}

/**
 * WHERE THE OWNER'S BOOK READ STANDS, for the entry that stands in for it.
 *
 * `reads.mine` starts as the seed's "unread" and only changes when a market
 * load returns. If that load THREW, it never returns, and "unread" would draw a
 * skeleton for ever — so once the load has finished, a read that never
 * happened is a failure, not a wait.
 */
export function portfolioReadOf(mine: ReadState, liveLoaded: boolean): ReadState {
  return settledRead(mine, liveLoaded);
}

/**
 * WHICH AGENT THE PROFILE SCREEN MAY DRAW, given where its own read stands.
 *
 * It was `profile ?? listed`, so for the whole of the fetch the page drew the
 * LEADERBOARD row — whose curve is raw equity, which the profile refuses to
 * chart — and told the reader "Performance history isn't available yet" about a
 * request that had not come back. Loading is not an answer; while it lasts the
 * screen draws a skeleton.
 *
 * The board row is still worth showing once the profile read has FAILED, and
 * App says so beside it. A profile that loaded once is kept through a later
 * failed refresh: stale and said to be stale beats blank.
 */
export function profileShown<A>(profile: A | null, error: string, listed: A | undefined): A | undefined {
  return profile ?? (error ? listed : undefined);
}

/**
 * A READ NOBODY IS WAITING ON ANY MORE IS A FAILED ONE.
 *
 * The seed's reads are "unread". A load that THREW never replaces them, so
 * once it has finished, "unread" means it failed — the rule portfolioReadOf
 * already applies to the owner's book, for any read.
 */
export function settledRead(read: ReadState, liveLoaded: boolean): ReadState {
  return read === "unread" && liveLoaded ? "unreadable" : read;
}

/**
 * MAY THE TOKEN PAGE CALL A MISSING TOKEN OURS TO EXPLAIN?
 *
 * "Token not listed / Check the address" is a claim about the instrument, and
 * it is only true when the market was read. It was decided from `failing`,
 * which the refresh loop reports only after BOTH halves of a pass settle, and
 * from reads that were still the seed's "unread" when the market load had
 * thrown — so for as long as a slow account read took, our outage was printed
 * as a fact about somebody's token.
 */
export function tokenPageUnreadable(p: {
  failing: boolean;
  market: ReadState;
  discoveries: ReadState;
  liveLoaded: boolean;
}): boolean {
  return (
    p.failing ||
    settledRead(p.market, p.liveLoaded) === "unreadable" ||
    settledRead(p.discoveries, p.liveLoaded) === "unreadable"
  );
}

/**
 * DID THE MARKET HALF OF A PASS ACTUALLY READ THE MARKET?
 *
 * loadLive throws only when the market, the board AND the theses all failed,
 * so a pass counted as healthy whenever one of them came back: the backoff
 * reset to a minute, the last-read time was stamped as now, and the banner came
 * down, while the market list carried old prices forward with nothing saying
 * they were old. The public reads decide it. The owner's own book does not: a
 * signed-out visitor and a fresh self-hosted install both read it as
 * unreadable by design, and it says so on its own surface (portfolioReadOf).
 */
export function liveReadsOk(reads: { market: ReadState; board: ReadState; theses: ReadState; discoveries: ReadState }): boolean {
  return (["market", "board", "theses", "discoveries"] as const).every((k) => reads[k] !== "unreadable");
}

/** Which half of a refresh pass failed, and whether nothing answered at all. */
export interface PassFailure {
  account: boolean;
  market: boolean;
  /**
   * True only when every half failed with nothing answering — the one case
   * "Can't reach merrymen" is true. A 500, or a market read that half landed,
   * means merrymen answered and could not load something.
   */
  unreachable: boolean;
}

/**
 * WHAT A PASS AMOUNTED TO, from how its two halves settled. Null when both read.
 *
 * The account half rejects with a RequestError whose status 0 means nothing
 * answered; the market half resolves false for a partial read, or rejects with
 * a LiveLoadError that says whether anything answered.
 */
export function passOutcome(account: PromiseSettledResult<unknown>, market: PromiseSettledResult<boolean>): PassFailure | null {
  const accountFailed = account.status === "rejected";
  const marketFailed = market.status === "rejected" || market.value !== true;
  if (!accountFailed && !marketFailed) return null;
  const silent = (r: PromiseSettledResult<unknown>, key: "status" | "answered") => {
    if (r.status !== "rejected") return false;
    const v = (r.reason as Record<string, unknown> | null)?.[key];
    return key === "status" ? v === 0 : v === false;
  };
  return {
    account: accountFailed,
    market: marketFailed,
    unreachable: accountFailed && marketFailed && silent(account, "status") && silent(market, "answered"),
  };
}

/**
 * HOW OLD WHAT IS ON SCREEN IS, for the half that failed — the older of the two
 * when both did, so the line never understates it. Null when the failed half
 * has never been read, and then nothing on screen is its to call stale.
 */
export function staleSince(failure: PassFailure, okAt: { account: number | null; market: number | null }): number | null {
  if (failure.account && !failure.market) return okAt.account;
  if (failure.market && !failure.account) return okAt.market;
  const known = [okAt.account, okAt.market].filter((t): t is number => t !== null);
  return known.length ? Math.min(...known) : null;
}

/**
 * THE AGENT'S REAL CASH, in dollars, from the chain read /api/grants made — or
 * null when it made none.
 *
 * `autonomyOf` answers a real cash of zero with "Add funds", so this is the
 * value that decides whether a funded owner is told to deposit. It was
 * derived inline in App, where reverting it to `Number(...) / 1e6` (which
 * reads null as 0) left every test green. Out here it is the function the
 * tests run.
 */
export function realCashOf(account: AccountState | null): number | null {
  return account?.status.balances ? usdgOrNull(account.status.balances.cashUsdg) : null;
}
