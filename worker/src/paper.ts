/**
 * Paper trading — the full merrymen loop with zero funds.
 *
 * When the account can't sign (no bundler key), approved intents are FILLED
 * here instead of stubbed: at the live on-chain oracle price (the same
 * Chainlink feeds Robinhood publishes for every stock token), minus the
 * configured slippage as honest friction. Fills land in the real ledger as
 * status "paper" trades, the book lives in SQLite, and everything downstream
 * — equity curve, positions, pings, digests, chat trades — works unchanged.
 *
 * The policy wall is NOT relaxed: intents reach this file only after
 * checkPolicy approves them against the signed grant's caps. Paper mode
 * changes what "execute" means, never what is allowed.
 */

import { isEnergyReserveToken } from "../../packages/core/src/index";
import type { TradeIntent } from "./policy";

export interface PaperBook {
  cashUsdg: number;
  vaultUsdg: number;
  hwmUsdg: number;
}

export interface PaperPosition {
  symbol: string;
  token: `0x${string}`;
  /**
   * SPLIT-INVARIANT shares — the paper equivalent of a raw ERC-20 balance.
   *
   * Real Stock Token balances never rebase: a corporate action moves
   * uiMultiplier() instead, and the reference price moves the opposite way, so
   * value is unchanged (see positions.ts). The paper book has to hold the same
   * invariant or it breaks the moment a stock splits — the oracle price halves,
   * a UI-share count doesn't, and the book reports a 50% loss on an event that
   * cost nobody anything. Paper equity feeds the drawdown breaker, so that is
   * not a display bug; it would retire an agent over a stock split.
   *
   * So this number is shares AT MULTIPLIER 1.0, and the tradeable quantity today
   * is `shares × multiplier`. Every token in the registry currently sits at
   * exactly 1.0, which is why existing books carry over unchanged — the two
   * readings only diverge after the first real split.
   */
  shares: number;
}

/** ERC-8056's 1.0, as a float for the paper book's arithmetic. */
const MULTIPLIER_ONE = 1;

/** What `shares` is worth in tradeable units at the live multiplier. */
export function paperUiShares(shares: number, multiplier: number): number {
  return shares * (multiplier > 0 ? multiplier : MULTIPLIER_ONE);
}

/**
 * The paper holdings the tick VALUES: held (shares > 0) and not the energy reserve.
 *
 * THE RESERVE IS NEVER A POSITION, on paper exactly as on the live path — it
 * sits outside the trading book the way ETH gas does (core energy.ts). Live
 * gets that for free: readPositions only reads the watch set, and the watch set
 * never holds the reserve (watchTokensFor). The paper valuation loop does NOT
 * read the watch set; it walks the stored book, and a symbol it cannot find in
 * the watch set is a MISSING PRICE — which holds the tick. A reserve row in a
 * paper book would therefore have frozen the agent forever: no equity, no
 * breaker, no strategy, and every owner order answered "book unread".
 *
 * DEFENSIVE, not a migration. No paper book can have bought $MERRYMEN: a paper
 * fill refuses without a live price, $MERRYMEN has no feed, and its only depth
 * is a v2 pair against VIRTUAL (measured, core energy.ts) while the worker had
 * no v2 venue before energy. So this drops a row that should not exist, rather
 * than letting its existence stop the book.
 * By ADDRESS, case-insensitively — a coin that merely calls itself MERRYMEN
 * elsewhere is an ordinary holding and is valued (or held) like any other.
 */
export function paperBookPositions(positions: readonly PaperPosition[]): PaperPosition[] {
  return positions.filter((p) => p.shares > 0 && !isEnergyReserveToken(p.token));
}

/** What actually moved on a stock fill — the inputs cost-basis accounting needs. */
export interface PaperFillDetail {
  side: "buy" | "sell";
  symbol: string;
  token: `0x${string}`;
  /** Tradeable shares, for prices and receipts. */
  shares: number;
  /** Split-invariant quantity used by the inventory and cost-basis ledger. */
  rawShares: number;
  priceUsd: number;
  /** USDG actually spent (buy) or received (sell), slippage included. */
  cashUsdg: number;
}

export interface PaperFillResult {
  ok: boolean;
  reason?: string;
  book: PaperBook;
  positions: PaperPosition[];
  /** Human receipt line, e.g. "paper fill: 0.0138 QQQ @ $724.51 (px live)". */
  receipt?: string;
  /** Present only for stock buys/sells — vault moves and no-ops carry no basis. */
  fill?: PaperFillDetail;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Apply one approved intent to the paper book. Pure — persistence is the
 * caller's job. `priceUsdOf` returns the live oracle price for a token
 * address (null = no feed → the fill is refused, never invented).
 */
export function applyPaperIntent(
  intent: TradeIntent,
  book: PaperBook,
  positions: PaperPosition[],
  opts: {
    priceUsdOf: (token: `0x${string}`) => { priceUsd: number; stale: boolean } | null;
    symbolOf: (token: `0x${string}`) => string | null;
    /**
     * Live ERC-8056 multiplier as a plain ratio (1.0 = unsplit). Omitted or
     * null means "couldn't read it", and a stock fill is then REFUSED rather
     * than assumed to be 1.0 — guessing here books the wrong share count
     * permanently, and the position outlives the guess.
     */
    multiplierOf?: (token: `0x${string}`) => number | null;
    usdgAddress: `0x${string}`;
    slippageBps: number;
    notionalUsdg: number;
  },
): PaperFillResult {
  const next: PaperBook = { ...book };
  const pos = positions.map((p) => ({ ...p }));
  const slip = opts.slippageBps / 10_000;
  const n = opts.notionalUsdg;

  if (intent.kind === "vault-deposit") {
    if (n > next.cashUsdg) return { ok: false, reason: "paper cash short of the deposit", book, positions };
    next.cashUsdg = round6(next.cashUsdg - n);
    next.vaultUsdg = round6(next.vaultUsdg + n);
    return { ok: true, book: next, positions: pos, receipt: `paper: ${n} USDG → vault` };
  }
  if (intent.kind === "vault-withdraw") {
    const amt = Math.min(n, next.vaultUsdg);
    next.vaultUsdg = round6(next.vaultUsdg - amt);
    next.cashUsdg = round6(next.cashUsdg + amt);
    return { ok: true, book: next, positions: pos, receipt: `paper: ${amt} USDG ← vault` };
  }
  if (intent.kind === "transfer") {
    if (n > next.cashUsdg) return { ok: false, reason: "paper cash short of the transfer", book, positions };
    next.cashUsdg = round6(next.cashUsdg - n);
    return { ok: true, book: next, positions: pos, receipt: `paper: ${n} USDG sent out` };
  }

  // ── swap ──────────────────────────────────────────────────────────────
  if (intent.kind !== "swap") return { ok: false, reason: `unsupported paper intent ${intent.kind}`, book, positions };
  // The selftest no-op (USDG→USDG) fills as a zero-move success.
  if (intent.sellToken.toLowerCase() === intent.buyToken.toLowerCase()) {
    return { ok: true, book: next, positions: pos, receipt: "paper: pipeline no-op" };
  }
  const usdgAddr = opts.usdgAddress.toLowerCase();
  const sellIsUsdg = intent.sellToken.toLowerCase() === usdgAddr;
  const buyIsUsdg = intent.buyToken.toLowerCase() === usdgAddr;
  // Only USDG-paired swaps are modelled: the cash leg is what debits/credits the
  // book and carries the cost basis. A stock→stock swap has no cash leg, and the
  // old code silently treated it as a SELL of the sell-token — banking cash and
  // never buying the other side. Refuse it instead of inventing a fill.
  if (sellIsUsdg === buyIsUsdg) {
    return { ok: false, reason: "paper models USDG-paired swaps only (no cash leg here)", book, positions };
  }
  const buyingStock = sellIsUsdg;
  const stockToken = (buyingStock ? intent.buyToken : intent.sellToken) as `0x${string}`;
  const px = opts.priceUsdOf(stockToken);
  const symbol = opts.symbolOf(stockToken);
  if (!px || !symbol || px.priceUsd <= 0) {
    return { ok: false, reason: `no live price for ${symbol ?? stockToken} — paper fill refused`, book, positions };
  }
  const staleTag = px.stale ? "px 24/5" : "px live";
  const held = pos.find((p) => p.symbol === symbol);

  // The oracle price is per TRADEABLE share, so every conversion between cash
  // and the stored (split-invariant) quantity goes through the live multiplier.
  // A missing multiplier is refused, not defaulted: a wrong share count written
  // now is wrong for as long as the position is held.
  const mul = opts.multiplierOf ? opts.multiplierOf(stockToken) : MULTIPLIER_ONE;
  if (mul === null || !Number.isFinite(mul) || mul <= 0) {
    return { ok: false, reason: `no ERC-8056 multiplier for ${symbol} — paper fill refused`, book, positions };
  }

  if (buyingStock) {
    if (n > next.cashUsdg) return { ok: false, reason: "paper cash short of the buy", book, positions };
    const uiShares = (n * (1 - slip)) / px.priceUsd; // slippage eats into what you get
    const shares = uiShares / mul; // store split-invariant
    next.cashUsdg = round6(next.cashUsdg - n);
    if (held) held.shares += shares;
    else pos.push({ symbol, token: stockToken, shares });
    return {
      ok: true,
      book: next,
      positions: pos,
      // Receipts and basis speak in TRADEABLE shares — that's what the owner
      // sees quoted and what the price refers to.
      receipt: `paper fill: +${uiShares.toFixed(4)} ${symbol} @ $${px.priceUsd.toFixed(2)} (${staleTag})`,
      // Cost basis takes the CASH SPENT (n), not shares×price: the slippage is a
      // real cost of the position and belongs in its basis.
      fill: { side: "buy", symbol, token: stockToken, shares: uiShares, rawShares: shares, priceUsd: px.priceUsd, cashUsdg: n },
    };
  }

  // selling stock for USDG
  if (!held || held.shares <= 0) return { ok: false, reason: `no paper ${symbol} to sell`, book, positions };
  const heldUi = paperUiShares(held.shares, mul);
  const wantUi = n / px.priceUsd;
  const soldUi = Math.min(wantUi, heldUi);
  const proceeds = soldUi * px.priceUsd * (1 - slip);
  held.shares = round6(held.shares - soldUi / mul);
  next.cashUsdg = round6(next.cashUsdg + proceeds);
  return {
    ok: true,
    book: next,
    positions: pos.filter((p) => p.shares > 1e-9),
    receipt: `paper fill: −${soldUi.toFixed(4)} ${symbol} @ $${px.priceUsd.toFixed(2)} (${staleTag})`,
    // Proceeds are net of slippage — the cash that actually landed.
    fill: { side: "sell", symbol, token: stockToken, shares: soldUi, rawShares: soldUi / mul, priceUsd: px.priceUsd, cashUsdg: round6(proceeds) },
  };
}

/**
 * Mark-to-market the paper book at live prices.
 *
 * `multiplierOf` is optional so existing callers keep compiling, and absent it
 * every multiplier reads as 1.0 — correct for every token in the registry today,
 * and identical to the old behaviour. Pass it and a split becomes value-neutral
 * here too: the multiplier rises by the same factor the price falls.
 */
export function paperEquityUsdg(
  book: PaperBook,
  positions: PaperPosition[],
  priceUsdOf: (token: `0x${string}`) => { priceUsd: number; stale: boolean } | null,
  multiplierOf?: (token: `0x${string}`) => number | null,
): number {
  const posValue = positions.reduce((sum, p) => {
    const px = priceUsdOf(p.token);
    if (!px) return sum;
    const mul = multiplierOf ? multiplierOf(p.token) : MULTIPLIER_ONE;
    const m = mul === null || !Number.isFinite(mul) || mul <= 0 ? MULTIPLIER_ONE : mul;
    return sum + paperUiShares(p.shares, m) * px.priceUsd;
  }, 0);
  return round6(book.cashUsdg + book.vaultUsdg + posValue);
}
