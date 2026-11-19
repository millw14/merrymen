/**
 * The answer while the tenant's Solana wallet was verified by another sign-in
 * (its binding's DID is not the signed-in one): the bind route's 409, and the
 * 403 of solanaContext (every account route) and the status route. The remedy
 * for an app-created owner is the original login (solana-binding-store.ts,
 * SOLANA OWNER KEY RECOVERY). Its own module, with no store behind it, so the
 * page can recognise the answer and stop offering a wallet to create or verify.
 */
export const SOLANA_OTHER_SIGN_IN = "This account's Solana wallet was verified with a different sign-in. Sign in with the login you used when you verified it.";

/**
 * WHY A SOLANA ROUTE REFUSED THE SIGN-IN ITSELF, BY CODE (authenticateSolana).
 *
 * Every Solana route needs two sign-ins that agree: the Merrymen session (the
 * cookie) and the wallet sign-in (a Privy token), whose login must map to the
 * same account. The refusal is the server's and stays exactly as it is. The
 * code only lets the page offer the way out, where it used to print the
 * refusal with nothing to press:
 * - signed-out: this browser has no Merrymen session, while its wallet
 *   sign-in is live (a session cookie lasts a week; a Privy login longer). The
 *   page finishes the sign-in, as PrivySignIn does anywhere: the session it
 *   mints is for that login's own account, and no session is replaced.
 * - expired: the wallet sign-in's token did not verify. The page signs the
 *   wallet sign-in out, so the owner can sign in again.
 * - mismatch: the session and the wallet sign-in are different logins (an
 *   account made with X, and "Continue with email" on the Solana screen). The
 *   page names both and lets the owner choose. It never switches the account
 *   someone is signed in to by itself.
 */
export type SolanaSignInProblem = "signed-out" | "expired" | "mismatch";

/** How the signed-in Merrymen account signs in, as the identity store records it. Display only, never authorization. */
export interface SolanaAccountLogin {
  provider: "twitter" | "google" | "email" | "wallet";
  /** The X username, for an X login only. Never an email address. */
  handle: string | null;
}

export interface SolanaSignInRefusal {
  problem: SolanaSignInProblem;
  /** A mismatch only: the login of the account the Merrymen session is for, when the store knows it. */
  account: SolanaAccountLogin | null;
  /** A mismatch only: whether the wallet sign-in's own login has a Merrymen account of its own. */
  loginHasAccount: boolean;
}

/** The mismatch in words that stand alone, for a page that predates the code. */
export const SOLANA_SIGN_IN_MISMATCH = "Your Merrymen sign-in and your wallet sign-in are different logins. Sign in again with the login you use for this account.";

const PROBLEMS: ReadonlySet<string> = new Set<SolanaSignInProblem>(["signed-out", "expired", "mismatch"]);
const PROVIDERS: ReadonlySet<string> = new Set<SolanaAccountLogin["provider"]>(["twitter", "google", "email", "wallet"]);
/** An X username as X allows one, with room to spare. Anything else is not shown. */
const HANDLE = /^[A-Za-z0-9_]{1,50}$/;

/** The identity store's record of how a tenant signs in, as display words. No record: null; a record with no social login: a wallet. */
export function solanaAccountLogin(identity: { social?: { provider: string; handle?: string | null } | null } | null): SolanaAccountLogin | null {
  if (!identity) return null;
  if (!identity.social) return { provider: "wallet", handle: null };
  const { provider, handle } = identity.social;
  if (!PROVIDERS.has(provider)) return null;
  return { provider: provider as SolanaAccountLogin["provider"], handle: provider === "twitter" && handle && HANDLE.test(handle) ? handle : null };
}

/** An answer's `signIn` field, validated; anything malformed reads as absent. */
export function solanaSignInRefusal(value: unknown): SolanaSignInRefusal | null {
  if (!value || typeof value !== "object") return null;
  const fields = value as { problem?: unknown; account?: unknown; loginHasAccount?: unknown };
  if (typeof fields.problem !== "string" || !PROBLEMS.has(fields.problem)) return null;
  const account = fields.account && typeof fields.account === "object" ? fields.account as { provider?: unknown; handle?: unknown } : null;
  return {
    problem: fields.problem as SolanaSignInProblem,
    account: account && typeof account.provider === "string" && PROVIDERS.has(account.provider)
      ? { provider: account.provider as SolanaAccountLogin["provider"], handle: account.provider === "twitter" && typeof account.handle === "string" && HANDLE.test(account.handle) ? account.handle : null }
      : null,
    loginHasAccount: fields.loginHasAccount === true,
  };
}

/** The account's login in words: "X (@name)", "email", "Google", "a wallet", or "another login" when unknown. */
export function solanaAccountLoginText(login: SolanaAccountLogin | null): string {
  if (!login) return "another login";
  if (login.provider === "twitter") return login.handle ? `X (@${login.handle})` : "X";
  return login.provider === "google" ? "Google" : login.provider === "email" ? "email" : "a wallet";
}
