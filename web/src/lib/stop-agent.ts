import type { GrantPurpose } from "@merrymen/core";
import { walletUrl } from "./wallet-param";

/**
 * Explicitly discard the server permission and agent memory; preserve browser recovery keys.
 *
 * A KILL NAMES NO WALLET, and that is the point of it: DELETE /api/grants with
 * no `?wallet=` stops every wallet the login has (Spot, the Perps half, and
 * Solana), and the route refuses a kill that names one (killNamesWallet). So
 * there is no wallet argument here to get wrong.
 */
export async function deleteAgent(expectedTenant?: string | null): Promise<void> {
  return requestStop("/api/grants", { purpose: "delete-agent", expectedTenant: expectedTenant ?? undefined });
}

/**
 * Retire the old permission while retaining the agent's home and Telegram memory.
 *
 * ONE WALLET'S PERMISSION, the wallet named: a renewal replaces that wallet's
 * grant and leaves the other's alone (the route stops `?wallet=` through that
 * wallet's store). Spot's request is byte for byte the one it always was
 * (walletUrl leaves a Spot URL untouched). REQUIRED, as the stores take it: a
 * Perps renewal that forgot it would stop the Spot agent instead.
 */
export async function stopAgentForReplacement(
  wallet: GrantPurpose,
  expectedTenant: string | null | undefined,
  expectedAccount: string,
  expectedSession?: string,
): Promise<void> {
  return requestStop(walletUrl("/api/grants", wallet), {
    purpose: "permission-replacement",
    expectedTenant: expectedTenant ?? undefined,
    expectedAccount,
    expectedSession,
  });
}

async function requestStop(url: string, body: Record<string, string | undefined>): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("The service did not confirm the stop request. Your wallet and recovery access were kept; try again.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `The service did not confirm the stop request (${response.status}). Your wallet was kept.`);
  }
}
