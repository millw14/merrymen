/**
 * The answer while the tenant's Solana wallet was verified by another sign-in
 * (its binding's DID is not the signed-in one): the bind route's 409, and the
 * 403 of solanaContext (every account route) and the status route. The remedy
 * for an app-created owner is the original login (solana-binding-store.ts,
 * SOLANA OWNER KEY RECOVERY). Its own module, with no store behind it, so the
 * page can recognise the answer and stop offering a wallet to create or verify.
 */
export const SOLANA_OTHER_SIGN_IN = "This account's Solana wallet was verified with a different sign-in. Sign in with the login you used when you verified it.";
