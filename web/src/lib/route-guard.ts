/**
 * WHAT EVERY API ROUTE SHARES BEFORE IT DOES ANYTHING ITS OWN.
 *
 * Three small things, in one neutral module so no route has to import another
 * route's library to get them (a route file exports only its handlers, and
 * the perps branch kept two of these in its custody module, which every route
 * that wanted a header would then have dragged in):
 *
 * - NO_STORE_HEADERS: per-user answers are never stored by anything between
 *   the server and the owner.
 * - perRouteLimiter: a rolling-minute budget per caller, for a route whose
 *   every call is expensive.
 * - walletNotSupported: the refusal every route that is not wallet-aware gives
 *   a request naming a wallet it does not serve.
 */
import { NextResponse } from "next/server";
// Relative, not `@/lib/…`: a route the worker's tests reach (decision/[id])
// is typechecked under worker/tsconfig.json, which has no `@/` alias.
import { readWalletParam, WALLET_PARAM } from "./wallet-param";

/** `Cache-Control` for a per-user answer: private, and never stored. */
export const NO_STORE_HEADERS = Object.freeze({ "Cache-Control": "private, no-store" });

/**
 * A rolling-minute budget per caller (the tenant hosted, the install
 * self-hosted). In memory and per process ON PURPOSE: it exists to keep one
 * signed-in tab from turning an expensive route into a loop, not to be a
 * distributed quota — the repo has no shared limiter, and a restart forgetting
 * the window is harmless for a budget this short.
 */
export function perRouteLimiter(perMinute: number, now: () => number = Date.now) {
  const seen = new Map<string, number[]>();
  return (key: string): { ok: true } | { ok: false; retryAfterSec: number } => {
    const t = now();
    const log = (seen.get(key) ?? []).filter((x) => x > t - 60_000);
    if (log.length >= perMinute) {
      seen.set(key, log);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(((log[0] ?? t) + 60_000 - t) / 1000)) };
    }
    log.push(t);
    seen.set(key, log);
    // Bounded: a caller that went away is forgotten on its next miss or never.
    if (seen.size > 10_000) {
      for (const [k, v] of seen) if (!v.some((x) => x > t - 60_000)) seen.delete(k);
    }
    return { ok: true };
  };
}

/**
 * A ROUTE THAT SERVES ONE WALLET REFUSES A REQUEST FOR ANOTHER, before it reads
 * or writes anything.
 *
 * A login has two wallets (Spot and Perps), and a client names the one it
 * means with `?wallet=` (wallet-param.ts; absent is Spot). Almost every route
 * answers for Spot alone. Without this, `GET /api/pnl?wallet=perps` would be
 * answered with the SPOT wallet's P&L, and `POST /api/paper-reset?wallet=perps`
 * would reset the Spot book: one wallet's request served with the other's
 * money, which is the one thing two wallets per login must never do. So a
 * route that is not wallet-aware answers 400 `wallet-not-supported` for any
 * `?wallet=` but Spot, an unreadable one included, and absent or `spot` reach
 * it exactly as they always did.
 *
 * Every route handler under app/api starts with it, or reads the wallet itself
 * through readWalletParam (the wallet-aware ones: /api/grants), and
 * route-guard.test.ts walks every route file to hold that, so a route added
 * later cannot forget. A route becomes wallet-aware by replacing this call
 * with readWalletParam and answering for each wallet it names.
 *
 * Null when the request may go on.
 */
export function walletNotSupported(req: Pick<Request, "url">): NextResponse | null {
  if (readWalletParam(req) === "spot") return null;
  return NextResponse.json(
    {
      error: `This request is answered for your Spot wallet only (${WALLET_PARAM}=spot, or no ${WALLET_PARAM}). Nothing was read or changed.`,
      code: "wallet-not-supported",
    },
    { status: 400, headers: NO_STORE_HEADERS },
  );
}
