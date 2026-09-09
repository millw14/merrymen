import { isHolderProof } from "@merrymen/core";
import { getSettingsStore } from "@merrymen/settings-store";

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
 * One function, both callers. The rule it encodes is the same rule the
 * orchestrator applies, in the same order, for the same reason:
 *
 *   A PROVEN WALLET FIRST. Written only by /api/holder after recovering a
 *   signature over a message naming both the wallet and this account.
 *
 *   THE SESSION WALLET OTHERWISE. Always available, always verified, and the
 *   reason the tier is earnable at all.
 *
 *   AND NEVER `settings.holderAddress`. That one is typed in, so it is a claim
 *   about somebody else's balance as easily as your own — which is precisely
 *   why /api/alpha refuses it, in as many words, and why the orchestrator
 *   overwrites it.
 *
 * IT DOES NOT ASK WHETHER THIS IS THE HOSTED SERVICE, and that is deliberate
 * rather than an omission. `isHostedMode()` reads process.env, which Next does
 * not inline into the browser bundle — so it is ALWAYS false there, and
 * client-env.test.ts refuses it anywhere outside app/api for exactly that
 * reason. Both callers live in app/api and have already resolved their own
 * session; a null tenant is the only thing this needs to know, and self-hosted
 * has no tenant to pass.
 */
export async function holderWalletFor(
  tenant: `0x${string}` | null,
): Promise<{ address: `0x${string}`; source: "linked" | "login" } | null> {
  if (!tenant) return null;
  try {
    const stored = await getSettingsStore().get(tenant);
    const proof = stored?.holderProof;
    if (isHolderProof(proof)) return { address: proof.address as `0x${string}`, source: "linked" };
  } catch {
    /**
     * AN UNREADABLE SETTINGS STORE FALLS BACK TO THE LOGIN WALLET, and that is
     * the safe direction in both senses: it is a real, verified address, so
     * nobody is granted a tier they did not earn — and nobody is thrown out of
     * one they did, because the login wallet is what everyone had before
     * linking existed.
     */
  }
  return { address: tenant, source: "login" };
}
