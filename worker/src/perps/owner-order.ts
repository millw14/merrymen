/**
 * AN OWNER'S PERPETUAL EXIT, AS AN ORDER'S ARGUMENTS SAY IT — the one shape
 * the web route checks before it writes the row and the worker checks again
 * before it builds an exit (order-gate.ts placeOrder, index.ts runOrderCommand).
 *
 * BROWSER-SAFE ON PURPOSE: nothing here reads a store, the feed or the clock,
 * and the only import is a type. The web's order route and the chat card
 * import this file by path, so the two gates cannot come to disagree about
 * what an exit is.
 *
 * TWO KINDS, BOTH REDUCE-ONLY, BOTH CARRIED AS kind 'trade' (so the ferry's
 * short loop, the one-at-a-time slot and the stale sweep treat an exit like
 * any order the owner sits watching):
 *
 *   close-perp     { side: "sell", symbol: "<MARKET>-PERP", usdgAmount: 0,
 *                    purpose: "close-perp", book: "paper" }
 *   flatten-perps  { side: "sell", symbol: "ALL-PERPS", usdgAmount: 0,
 *                    purpose: "flatten-perps", book?: "paper" }
 *
 * `side` and `usdgAmount` are fixed values, never choices: an exit closes the
 * position that is held, so it cannot pick a direction or a size, and a gate
 * that only knows Spot orders reads a zero-sized sell and never a buy.
 *
 * THE BOOK IS THE ONE THE OWNER LOOKED AT, and in this build the only book is
 * the practice one. A close names it: the owner chose a row they could read.
 * A CLOSE ALL MAY OMIT IT (decision D11): when the desk could not read the
 * positions report it cannot say which book it saw, and an owner reaching for
 * Close all must not be stopped by a read that failed, so an absent book means
 * EVERY book — which in this build is the practice book. `live` is refused
 * here by name: there is no real-money perpetual position in this build to
 * close, and an exit the worker cannot carry out must not be queued as if it
 * could.
 */
import type { PerpKey } from "../../../packages/core/src/perps";

/** A market key as an owner's exit names it, or null. A shape check only: the lane refuses a market this build does not trade. */
export function ownerPerpMarket(raw: unknown): PerpKey | null {
  const key = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return /^[A-Z0-9]{1,24}-PERP$/.test(key) ? (key as PerpKey) : null;
}

/** What a flatten names instead of one market. */
export const ALL_PERPS = "ALL-PERPS";

export type PerpExitPurpose = "close-perp" | "flatten-perps";

export type PerpExitOrder =
  | { purpose: "close-perp"; side: "sell"; symbol: PerpKey; usdgAmount: 0; book: "paper" }
  /** No `book`: the desk could not read which book it saw, so every book is flattened (D11). */
  | { purpose: "flatten-perps"; side: "sell"; symbol: typeof ALL_PERPS; usdgAmount: 0; book?: "paper" };

/** Is this purpose one of the owner's perpetual exits? */
export function isPerpExitPurpose(purpose: unknown): purpose is PerpExitPurpose {
  return purpose === "close-perp" || purpose === "flatten-perps";
}

/**
 * The exit these arguments ask for, a refusal in the owner's words, or null
 * for an ordinary order. NULL ONLY WHEN `purpose` IS NOT AN EXIT'S: an exit is
 * never inferred from a ticker alone, and a `-PERP` symbol without the marker
 * is an ordinary order that the Spot gate refuses as a symbol it cannot look up.
 */
export function readPerpExitOrder(args: Record<string, unknown>): { order: PerpExitOrder } | { error: string } | null {
  const purpose = args.purpose;
  if (!isPerpExitPurpose(purpose)) return null;
  if (args.book === "live") {
    return { error: "Real-money perpetuals are not available in this version, so there is no real-money position to close. Nothing was sent." };
  }
  const book = args.book;
  if (book !== undefined && book !== "paper") return { error: "Choose the practice perpetual book before confirming. Nothing was sent." };
  if (args.side !== "sell" || args.usdgAmount !== 0) {
    return { error: "A perpetual exit closes the position that is held; it cannot choose a buy or an amount. Nothing was sent." };
  }
  if (purpose === "flatten-perps") {
    if (args.symbol !== ALL_PERPS) return { error: `Close all must name ${ALL_PERPS}. Nothing was sent.` };
    return { order: { purpose, side: "sell", symbol: ALL_PERPS, usdgAmount: 0, ...(book === "paper" ? { book } : {}) } };
  }
  const symbol = ownerPerpMarket(args.symbol);
  if (!symbol) return { error: "Name one perpetual market, for example BTC-PERP. Nothing was sent." };
  // A close names the book of the row the owner chose; only a Close all may leave it out (D11).
  if (book !== "paper") return { error: "Choose the practice perpetual book before confirming. Nothing was sent." };
  return { order: { purpose, side: "sell", symbol, usdgAmount: 0, book } };
}

/**
 * What a sentence calls an exit: "this close of BTC-PERP", "this Close all", or
 * null for anything that is not an exit. The market is named only when it has
 * an exit's shape (ownerPerpMarket): these args may have crossed a command file
 * anything on the machine can write, and never reach an owner's sentence as
 * they came.
 */
function exitNamed(args: Record<string, unknown> | undefined): string | null {
  if (!args || !isPerpExitPurpose(args.purpose)) return null;
  if (args.purpose === "flatten-perps") return "this Close all";
  const market = ownerPerpMarket(args.symbol);
  return market ? `this close of ${market}` : "this close";
}

/**
 * AN EXIT THAT DID NOT RUN, OR THAT NOBODY HEARD BACK FROM, IN AN EXIT'S WORDS.
 *
 * Every path that answers an order which was never run here — the drain's
 * expiry at the claim and the worker's own check (command-files.ts,
 * index.ts runCommand), and the orchestrator's stale sweep — was written for a
 * Spot fill: "I will not fill it into a different market", "I cannot tell you
 * whether it filled … Check your trades". An exit is not a fill into a market,
 * and two things a Close all owner needs were missing:
 *
 * - WHERE TO LOOK. A perpetual's fills are never `trades` rows (the trades
 *   boundary: they are booked in perp_fills), so "check your trades" sent the
 *   owner to a page that cannot show a close, and they saw nothing there.
 * - THE PAUSE. Close all writes the entries halt BEFORE it closes anything
 *   (lane.ts flatten), and only a practice reset lifts it. One that expired or
 *   never ran paused nothing, and says so; one nobody heard back from may have
 *   paused new practice positions, and says that.
 *
 * Null for anything that is not an exit, so a Spot order keeps its sentence
 * word for word. PURE, like the rest of this file: the lateness arrives already
 * worded (command-files.ts howLate), and nothing here reads a clock.
 */
export function perpExitExpiredLine(args: Record<string, unknown> | undefined, late: string): string | null {
  const named = exitNamed(args);
  if (named === null) return null;
  const nothing = args?.purpose === "flatten-perps"
    ? "nothing was sent, no practice position was closed and nothing was paused"
    : "nothing was sent and no practice position was closed";
  return `expired — I picked up ${named} ${late} after its window closed, so it did not run: ${nothing}. Ask again if you still want it.`;
}

/** The sweep's "never ran" for an exit: undelivered, or still queued past its window (perpExitExpiredLine). */
export function perpExitNeverRanLine(args: Record<string, unknown> | undefined): string | null {
  const named = exitNamed(args);
  if (named === null) return null;
  const nothing = args?.purpose === "flatten-perps"
    ? "nothing was sent, no practice position was closed and nothing was paused"
    : "nothing was sent and no practice position was closed";
  return `never ran — ${named} sat in my queue past its window without being picked up, so ${nothing}. Ask again if you still want it.`;
}

/**
 * The sweep's closing sentence for an exit the worker took and never answered
 * (perpExitExpiredLine): it does not claim to know what happened, says what
 * may have, and points at the Perps positions, which do show a close.
 */
export function perpExitUnansweredLine(args: Record<string, unknown> | undefined): string | null {
  const named = exitNamed(args);
  if (named === null) return null;
  if (args?.purpose === "flatten-perps") {
    return `I never heard back from my worker about ${named}, so I cannot tell you how far it got: some practice positions may have closed, and new practice positions may be paused until you reset the practice book. Check your Perps positions before asking again.`;
  }
  return `I never heard back from my worker about ${named}, so I cannot tell you whether the practice position was closed — it may have been. Check your Perps positions before asking again.`;
}

/**
 * AN EXIT THE WORKER WAS NOT ADMITTED TO RUN (worker-admission.ts
 * ownerPerpExitRefusal): the tenant is held at `observe` while the service
 * brings agents back, or the worker is on its way out for a restart. The
 * command was claimed and is answered, never run, so nothing was sent and no
 * practice position was closed — and a Close all paused nothing, because its
 * halt is written only by a Close all that runs (lane.ts flatten).
 *
 * `because` is the rule's owner sentence (thesis-policy.ts
 * ownerRejectRuleLabel), passed in so this file stays browser-safe and the
 * words stay the ones a held Spot order is told.
 */
export function perpExitNotAdmittedLine(order: PerpExitOrder, because: string): string {
  if (order.purpose === "flatten-perps") {
    return `Close all did not run — ${because} — so nothing was sent, no practice position was closed and nothing was paused. Ask again once it is back.`;
  }
  return `${order.symbol}: not closed — ${because} — so nothing was sent and its stop stays in place. Ask again once it is back.`;
}
