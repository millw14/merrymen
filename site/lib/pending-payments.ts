/**
 * Payments this browser sent, or was given a hash for, that the gateway has
 * not answered for good yet.
 *
 * The gateway credits a transfer only when its hash is submitted, and records
 * nothing for one that is not creditable yet (a 202). A hash the page loses is
 * a payment nobody credits, and payments are not returned. So every hash is
 * kept, per wallet, until it is credited or refused: a newer payment, a reload,
 * a sign-out or the passing of a day never drops one. Only the developer can
 * forget one, after a warning that it is not credited.
 *
 * Browser storage can be missing or refuse writes (private mode, blocked site
 * data), so every access is guarded and the console also keeps its own list.
 */
import { txHash } from "./developer-billing";

/** The localStorage key: one list for every wallet signed in on this browser. */
export const PENDING_KEY = "mm_developer_pending_payments";
/**
 * Unanswered hashes a wallet may have at once. The console starts a wallet
 * payment only when none is unanswered, so more than one comes only from
 * pasting; past this many, a paste is refused (never another one dropped).
 */
export const MAX_PENDING = 5;

type Saved = { wallet: string; hash: string; at: number };
const storage = (): Storage | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };
function read(): Saved[] {
  try {
    const list: unknown = JSON.parse(storage()?.getItem(PENDING_KEY) || "[]");
    return Array.isArray(list) ? list.filter((s): s is Saved => {
      const r = s as Partial<Saved> | null;
      return typeof r?.wallet === "string" && txHash(r.hash) !== null && typeof r.at === "number";
    }) : [];
  } catch { return []; }
}
function write(list: Saved[]) { try { storage()?.setItem(PENDING_KEY, JSON.stringify(list)); } catch { /* The console's own list still has it, and it is on screen. */ } }

/** This wallet's unanswered hashes, oldest first. */
export function pendingPayments(wallet: string): string[] {
  const w = wallet.toLowerCase();
  return [...new Set(read().filter(s => s.wallet.toLowerCase() === w).map(s => txHash(s.hash)!))];
}
export function rememberPayment(wallet: string, hash: string) {
  const w = wallet.toLowerCase(), h = txHash(hash), list = read();
  if (h && !list.some(s => s.wallet.toLowerCase() === w && txHash(s.hash) === h)) write([...list, { wallet: w, hash: h, at: Date.now() }]);
}
/** Only for an answer that is final (credited or refused), or when the developer asks after the warning. */
export function forgetPayment(wallet: string, hash: string) {
  const w = wallet.toLowerCase(), h = txHash(hash);
  write(read().filter(s => !(s.wallet.toLowerCase() === w && txHash(s.hash) === h)));
}
