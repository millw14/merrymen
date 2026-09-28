import { effectiveHolder, isHolderProof } from "@merrymen/core";
import { getSettingsStore } from "@merrymen/settings-store";

/**
 * Whose wallet counts: an address and how it earned that, or — signed in, but
 * every candidate is another account's — no wallet at all.
 */
export type HolderWallet =
  | { address: `0x${string}`; source: "linked" | "login" }
  | { address: null; source: null };

/**
 * WHOSE $MERRYMEN BALANCE COUNTS FOR THIS ACCOUNT — decided once, here.
 *
 * There were two answers and they had already begun to disagree. The worker
 * resolves the tier from a wallet the orchestrator writes into the child's
 * settings: a signature-proven one if there is one, otherwise the session
 * wallet. /api/alpha computes its own tier straight from `tenantOf(req)` and
 * knows nothing about the proof.
 *
 * So the moment somebody links a second wallet, their Circle STRATEGIES start
 * running and /alpha still tells them they do not hold enough — two surfaces,
 * two answers, both confident, on the same question about the same person. A
 * tester found the strategy half by sending 100,000 tokens and watching it
 * start; nobody would ever have found the other half except as a contradiction.
 *
 * One rule, both callers: `effectiveHolder` (packages/core/src/holder-proof.ts),
 * which the orchestrator applies to the same claims before it writes the
 * child's settings.json:
 *
 *   A PROVEN WALLET FIRST — ONLY IF ITS CLAIM NAMES THIS ACCOUNT. Written only
 *   by /api/holder after recovering a signature over a message naming both the
 *   wallet and this account, and claimed there — or moved there from another
 *   account by that fresh signature, at most once per wallet in any rolling
 *   24 hours, the wallet's own sign-in account exempt — so one wallet powers
 *   one agent rather than every account that ever linked it.
 *
 *   THE SESSION WALLET OTHERWISE — ONLY IF NO OTHER ACCOUNT CLAIMS IT. Linked
 *   into another account, it counts there and not here.
 *
 *   OTHERWISE NO WALLET ({ address: null }). The agent's own account is still
 *   read beside it by the caller, so this is not "holds nothing".
 *
 *   AND NEVER `settings.holderAddress`. That one is typed in, so it is a claim
 *   about somebody else's balance as easily as your own — which is precisely
 *   why /api/alpha refuses it, in as many words, and why the orchestrator
 *   overwrites it.
 *
 * AN UNREADABLE STORE THROWS. It used to fall back to the login wallet, on the
 * reasoning that a verified address can never grant a tier nobody earned. With
 * claims that stopped being true — the login wallet may be powering another
 * account — so a store we cannot read is a standing we could not read, the way
 * a grant store outage already is for the agent's account: callers answer
 * "unreadable", never a guess in either direction.
 *
 * IT DOES NOT ASK WHETHER THIS IS THE HOSTED SERVICE, and that is deliberate
 * rather than an omission. `isHostedMode()` reads process.env, which Next does
 * not inline into the browser bundle — so it is ALWAYS false there, and
 * client-env.test.ts refuses it anywhere outside app/api for exactly that
 * reason. Both callers live in app/api and have already resolved their own
 * session; a null tenant is the only thing this needs to know, and self-hosted
 * has no tenant to pass.
 */
export async function holderWalletFor(tenant: `0x${string}` | null): Promise<HolderWallet | null> {
  if (!tenant) return null;
  const store = getSettingsStore();
  const proof = (await store.get(tenant))?.holderProof;
  // The two wallets that could count, and nothing else: one small read.
  const claims = await store.holderClaims(isHolderProof(proof) ? [tenant, proof.address] : [tenant]);
  return effectiveHolder(tenant, proof ?? null, (w) => claims.get(w)) ?? { address: null, source: null };
}
