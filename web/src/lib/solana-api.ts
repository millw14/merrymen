import { NextResponse } from "next/server";
import { SolanaPaperValidationError } from "../../../packages/core/src/solana";
import { SolanaPaperStoreError } from "../../../worker/src/solana-paper-store";
import { SolanaMarketError } from "../../../worker/src/solana-market";
import { SolanaRpcError } from "../../../worker/src/solana-rpc";
import { SolanaAppRuntimeError } from "../../../worker/src/solana-app-runtime";
import { SolanaTradingStoreError } from "../../../worker/src/solana-trading-store";
import { SolanaExecutionError } from "../../../worker/src/solana-executor";
import { SolanaLiveMarketError } from "../../../worker/src/solana-live-market";
import { SolanaPaperPriceMovedError, SolanaPaperServiceError } from "../../../worker/src/solana-paper-service";
import { SolanaSettlementError } from "../../../worker/src/solana-settlement";
import { authenticateSolana, SolanaWebError } from "./solana-auth";
import { getSolanaBindingStore, SolanaBindingError } from "./solana-binding-store";
import { SOLANA_OTHER_SIGN_IN } from "./solana-sign-in";
import { solanaEnabled } from "./solana-enabled";

export async function solanaRequestBody(req: Request, allowed: readonly string[]): Promise<Record<string, unknown>> {
  if (!req.body) throw new SolanaWebError(400, "A JSON request is required.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 16_384) { await reader.cancel(); throw new SolanaWebError(413, "The Solana request is too large."); }
    chunks.push(value);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new SolanaWebError(400, "Invalid JSON request."); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) throw new SolanaWebError(400, "Unsupported Solana request fields.");
  return body as Record<string, unknown>;
}
export async function solanaContext(req: Request) {
  const principal = await authenticateSolana(req);
  const store = getSolanaBindingStore();
  const binding = await store.get(principal.tenant);
  if (!binding) throw new SolanaWebError(409, "Connect and verify a Solana wallet first.");
  if (binding.did !== principal.did) throw new SolanaWebError(403, SOLANA_OTHER_SIGN_IN);
  return { principal, store, binding, scope: { tenant: principal.tenant, owner: binding.owner } };
}
const NOT_AVAILABLE = "Solana trading is not available.";

/**
 * An error about this deployment's setup rather than the request: missing or
 * invalid Jupiter, RPC, vault, fee-payer or key settings. The owner can do
 * nothing about it, and its text names settings (MERRYMEN_JUPITER_API_KEY is
 * required…), so it is answered as plainly unavailable.
 */
function setupError(error: unknown): boolean {
  if (error instanceof SolanaMarketError) return error.code === "missing-jupiter-key" || error.code === "invalid-jupiter-key";
  if (error instanceof SolanaLiveMarketError) return error.code === "configuration";
  if (error instanceof SolanaRpcError) return ["missing-config", "invalid-config", "invalid-fallback", "invalid-timeout"].includes(error.code);
  // The deployed program does not match the audited binary hash this deployment pins.
  if (error instanceof SolanaExecutionError) return error.code === "unsafe-program";
  if (error instanceof SolanaPaperServiceError) return PAPER_SETUP.has(error.message);
  return error instanceof SolanaAppRuntimeError && error.code === "configuration";
}

/**
 * REFUSALS THE OWNER CAN ACT ON, IN THE OWNER'S WORDS.
 *
 * These used to fall through to the 503 "temporarily unavailable" answer, so a
 * trade above the on-chain cap, over the fee limit or failing simulation read
 * as an outage and invited the same refused retry. Each text is fixed here:
 * the worker's own messages stay out of responses because they can name
 * providers or settings. Every live refusal below is raised before the trade
 * is signed or recorded, which is why each one can say nothing was sent.
 * Unknown codes (invalid-state, cancelled) keep the cautious 503 answer.
 */
/**
 * The trade carried the minimum the owner previewed, and the fresh quote it
 * would be placed at guarantees less: live price-moved, or the paper service's
 * fixed message. Refused before anything was signed, sent or recorded.
 */
const PRICE_MOVED = "The price moved. Preview again; nothing was sent.";
/**
 * What the fresh route or quote guarantees, carried with a price-moved 409 as
 * freshMinOutAmount (base units of the output token), so the page can show it
 * and let the owner place the same trade at it after reviewing it: a new
 * request whose floor is that amount. The server never applies it by itself,
 * and the owner's floor stays exact (no tolerance). Only a canonical positive
 * integer is passed on.
 */
function freshMinimum(error: unknown): string | undefined {
  const value = error instanceof SolanaExecutionError && error.code === "price-moved" ? error.freshMinOutAmount
    : error instanceof SolanaPaperPriceMovedError ? error.freshMinOutAmount : undefined;
  return typeof value === "string" && /^[1-9][0-9]{0,38}$/.test(value) ? value : undefined;
}
const EXECUTION_REFUSALS: Partial<Record<SolanaExecutionError["code"], readonly [number, string]>> = {
  "price-moved": [409, PRICE_MOVED],
  "invalid-intent": [400, "This trade request is not supported. Nothing was sent."],
  risk: [409, "This trade is outside your trading limits, or the independent SOL price check could not confirm it. Nothing was sent. Try a smaller amount, or try again shortly."],
  "fee-cap": [409, "Solana network fees are above this account's fee limit right now. Nothing was sent. Try again later."],
  simulation: [409, "This trade failed its pre-flight check on Solana. Nothing was sent. Preview again or try a smaller amount."],
  "unsafe-route": [409, "No safe route is available for this trade right now. Nothing was sent. Preview again or try another amount."],
  conflict: [409, "This request conflicts with a trade or setting that was just recorded. Nothing new was sent. Refresh before trying again."],
  // One code for every reason the account is unusable; the remedy differs (a closed account is reopened, a delegate is
  // revoked, a frozen one cannot be fixed here), so the owner is pointed at status, which says which (refundBlocker).
  "owner-refund": [409, "Tokens someone sent to your vault are waiting to be returned to your own token account for this asset, which is closed or not safe to use. Nothing was sent. Your Solana status says what to fix in that account; then try again."],
};
/**
 * The live route builder (solana-live-market) says why it built no route, by
 * code. The route is built before anything is signed, so nothing was sent.
 * - configuration (a missing or unusable Jupiter key): this deployment's setup,
 *   answered as unavailable (setupError).
 * - route (a route shape the vault does not take): a 409 the owner can act on,
 *   by previewing again or trying another amount.
 * - provider (an unusable answer, a quote outside the RPC's slot window) and
 *   any code this file does not know: a neutral 503 that neither claims there
 *   is no route nor asks for another amount.
 */
const NO_LIVE_ROUTE = "A route for this trade could not be prepared right now. Nothing was sent. Preview again shortly.";
const NO_SUPPORTED_ROUTE = "No supported route is available for this trade right now. Nothing was sent. Preview again or try another amount.";
/** SolanaMarketError zero-output: no route returns anything for this amount (dust). */
const TOO_SMALL = "This amount is too small to trade: no route returns anything for it. Nothing was sent or recorded. Try a larger amount.";
/**
 * GA1's 'not-saved': THIS request saved and sent nothing; the owner or
 * permission bytes were refused before anything was written. The answer
 * carries notSaved: true so the page can stop resubmitting them (that cannot
 * help) and prepare again. Bytes that are malformed or not the reviewed
 * transaction are a 400; refusals because of the server's state (nothing
 * prepared, another transaction saved, the prepare window expired, settings
 * changed) are a 409.
 *
 * notSaved says nothing about earlier requests. Bytes an earlier request saved,
 * broadcast and even finalized are refused this way once a later prepare has
 * replaced their setup. The page must keep deciding retries from whether it
 * sent the bytes itself plus the server's record (outcomeAfterRefusal), and
 * must never tell the owner that nothing was sent on notSaved alone.
 */
const NOT_SAVED_MALFORMED: ReadonlySet<string> = new Set([
  "Invalid encoded Solana transaction.",
  "The owner signature or reviewed transaction does not match.",
]);
const SETTLEMENT_MISMATCH = "The on-chain result of a recorded trade does not match its record. That trade stays held for review and nothing new was sent.";
/** Paper refusals by the worker's fixed message; the test pins that every message thrown is listed. */
const PAPER_REFUSALS: ReadonlyMap<string, readonly [number, string]> = new Map(Object.entries({
  "Create the Solana paper book before requesting a trade.": [409, "Create your paper portfolio before trading."],
  "The Solana paper book's limits have expired.": [409, "Your saved trading limits have expired. Save new limits, then preview again."],
  "Insufficient simulated USDG for this buy.": [409, "Your paper portfolio does not hold enough simulated USDG for this buy."],
  "Insufficient simulated token balance for this sell.": [409, "Your paper portfolio does not hold enough of this token for this sale."],
  "Buying is blocked by the current token safety checks.": [409, "Buying is blocked by this token's current safety checks."],
  "This request ID already belongs to a different paper trade.": [409, "This request was already used for a different trade. Start a new trade."],
  "The fresh quote's minimum output is below the previewed minimum.": [409, PRICE_MOVED],
  "The Solana paper owner does not match this authenticated account.": [403, "Your sign-in does not match this Solana account."],
  "Solana mint evidence is missing, stale or inconsistent.": [503, "Token safety data is temporarily unavailable. Nothing was recorded. Try again shortly."],
} satisfies Record<string, readonly [number, string]>));
/**
 * SOLANA'S ANSWER ABOUT A SAVED OWNER TRANSACTION COULD NOT BE USED: AN UNKNOWN OUTCOME.
 *
 * The page resubmits signed owner and permission bytes to learn their outcome,
 * and the server answers that retry from the transaction it already saved and
 * broadcast: ownerStatus reading the RPC's confirmation, finishSetup booking
 * the outcome. These failures happen after the broadcast and say nothing about
 * the bytes, which may still finalize. Answered as a 4xx they read as a
 * refusal of the owner's request ("not accepted"); they are an unknown outcome,
 * so they keep the cautious 503 with a fixed text. "Invalid Solana confirmation
 * data." also covers a malformed RPC answer before anything is saved, where
 * unavailable is just as true. The test pins that the worker still raises each.
 *
 * ownerStatus marks every such failure with the code 'outcome-unknown', which
 * is answered this way whatever its message: a receipt with no vault effect,
 * or account data that cannot be read while checking it, is no refusal either.
 * This list stays for the same messages raised without that code (finishSetup
 * through the store, and the confirmation checks before anything is saved).
 */
export const OWNER_OUTCOME_UNKNOWN: ReadonlySet<string> = new Set([
  "Invalid Solana confirmation data.",
  "Invalid owner transaction confirmation.",
  "Invalid owner expiry evidence.",
  "Owner confirmation does not match the saved transaction.",
  "Owner transaction confirmations disagree.",
  "Finalized owner transaction outcomes cannot be changed.",
  "Finalized owner expiry evidence cannot be changed.",
  "Invalid owner transaction expiry evidence.",
  "Invalid finalized withdrawal accounting.",
  "Finalized withdrawal slot is required for durable accounting.",
  "Finalized withdrawal exceeds the recorded cash balance.",
  "Finalized withdrawal exceeds the recorded SOL position.",
  "Withdrawal evidence was already accounted.",
]);
const OUTCOME_UNKNOWN = "Solana's answer about your owner transaction could not be confirmed or recorded yet. Nothing new was sent. A transaction you already submitted stays saved and may still complete, so its outcome is unknown: refresh to check it before signing anything else.";
/** Deployment problems, answered as plainly unavailable. */
const PAPER_SETUP = new Set([
  "Solana paper trading is local-only until hosted tenant binding is implemented.",
  "The USDG mint does not match the configured cash asset.",
  "This Solana paper ledger has no owner write-off.",
]);
/**
 * PAPER BOOK RULES THE OWNER CAN ACT ON, BY CODE: 409 WITH FIXED TEXT.
 *
 * All seven codes below are answered 409 with the text beside them, from any
 * paper route, whichever the request:
 * - not_dust (a route still buys the lot), no_position, invalid_quote and
 *   stale_safety (the zero-output answer is unusable or too old): the write-off
 *   route's (POST /api/solana/paper/write-off) refusals, also raised by a paper
 *   trade's commit when a quote or safety read went stale under the lock;
 * - remainder_unquoted (a paper sale would leave a remainder no route buys
 *   back), book_missing (no paper book yet) and version_conflict (the book
 *   changed while the request was prepared): raised by paper trade commits,
 *   the write-off and the book's other updates. These used to answer 400 with
 *   the store's message; they are the book's state, not a malformed request.
 * Every other book code keeps 400 with the store's own fixed message.
 */
const PAPER_BOOK_REFUSALS: Partial<Record<SolanaPaperStoreError["code"], string>> = {
  not_dust: "A route still buys this position back, so it cannot be written off. Sell it instead. Nothing was changed.",
  no_position: "Your paper portfolio holds no position in that token. Nothing was changed.",
  invalid_quote: "The market's answer for this request could not be used. Nothing was recorded. Try again shortly.",
  stale_safety: "The market data for this request was too old by the time it could be recorded. Nothing was recorded. Try again.",
  remainder_unquoted: "This sale would leave a remainder that no route buys back. Sell the whole position, or less of it. Nothing was recorded.",
  book_missing: "Create your paper portfolio first.",
  version_conflict: "Your paper portfolio changed while this request was prepared. Refresh and try again. Nothing was recorded.",
};

/**
 * Every /api/solana route answers through this. With Solana off for this
 * deployment (solanaEnabled) it refuses before the action runs: no sign-in,
 * no body, no database.
 */
export async function solanaResponse(action: () => Promise<unknown>) {
  const headers = { "Cache-Control": "private, no-store" };
  if (!solanaEnabled()) return NextResponse.json({ error: NOT_AVAILABLE, ownerFacing: true }, { status: 404, headers });
  try { return NextResponse.json(await action(), { headers }); }
  catch (error) {
    let status = 503, message = "Solana is temporarily unavailable. Nothing was confirmed; refresh to check existing requests before retrying.", notSaved = false;
    if (setupError(error)) message = NOT_AVAILABLE;
    else if (error instanceof SolanaWebError) { status = error.status; message = error.message; }
    else if (error instanceof SolanaBindingError) { status = error.code === "invalid" ? 400 : 409; message = error.message; }
    else if (error instanceof SolanaPaperStoreError && Object.hasOwn(PAPER_BOOK_REFUSALS, error.code)) { status = 409; message = PAPER_BOOK_REFUSALS[error.code]!; }
    else if (error instanceof SolanaPaperValidationError || error instanceof SolanaPaperStoreError) { status = 400; message = error.message; }
    // Before the unknown-outcome check: nothing was saved, whatever the message says.
    else if (error instanceof SolanaAppRuntimeError && error.code === "not-saved") { status = NOT_SAVED_MALFORMED.has(error.message) ? 400 : 409; message = error.message; notSaved = true; }
    else if (error instanceof SolanaAppRuntimeError && error.code === "outcome-unknown") message = OUTCOME_UNKNOWN;
    else if ((error instanceof SolanaAppRuntimeError || error instanceof SolanaTradingStoreError) && OWNER_OUTCOME_UNKNOWN.has(error.message)) message = OUTCOME_UNKNOWN;
    else if (error instanceof SolanaAppRuntimeError) { status = error.code === "invalid" ? 400 : 409; message = error.message; }
    else if (error instanceof SolanaTradingStoreError) { status = 409; message = error.message; }
    else if (error instanceof SolanaExecutionError && Object.hasOwn(EXECUTION_REFUSALS, error.code)) [status, message] = EXECUTION_REFUSALS[error.code]!;
    else if (error instanceof SolanaLiveMarketError && error.code === "route") { status = 409; message = NO_SUPPORTED_ROUTE; }
    else if (error instanceof SolanaLiveMarketError) message = NO_LIVE_ROUTE;
    else if (error instanceof SolanaSettlementError) { status = 409; message = SETTLEMENT_MISMATCH; }
    else if (error instanceof SolanaPaperServiceError && PAPER_REFUSALS.has(error.message)) [status, message] = PAPER_REFUSALS.get(error.message)!;
    else if (error instanceof SolanaMarketError && error.code === "zero-output") { status = 400; message = TOO_SMALL; }
    else if (error instanceof SolanaMarketError || error instanceof SolanaRpcError) message = error.message;
    // Unknown provider/storage errors are never reflected: they may contain
    // endpoints, API keys, sealed session keys, SQL values or wallet material.
    const fresh = status === 409 && message === PRICE_MOVED ? freshMinimum(error) : undefined;
    return NextResponse.json({ error: message, ownerFacing: true, ...(notSaved ? { notSaved: true } : {}), ...(fresh ? { freshMinOutAmount: fresh } : {}) }, { status, headers });
  }
}
