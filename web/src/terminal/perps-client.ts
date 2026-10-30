import { parsePerpsReport, type PerpsReport } from "@merrymen/core";
import type { AccountState } from "./HostedControls";
import { RequestError, requestJson } from "./request-json";
import { walletUrl } from "../lib/wallet-param";

export interface PerpsIdentity { owner: string | null; account: { smartAccount: string; chainId: number } | null }
export function samePerpsIdentity(value: PerpsIdentity, account: AccountState): boolean {
  const owner = account.session.hosted ? account.session.address?.toLowerCase() ?? null : null;
  if (value.owner?.toLowerCase() !== owner && !(value.owner === null && owner === null)) return false;
  const grant = account.status.exists ? account.status.grant : null;
  if (!grant) return value.account === null;
  return !!value.account && value.account.smartAccount.toLowerCase() === grant.smartAccount.toLowerCase() && value.account.chainId === grant.chainId;
}

/** Unknown monetary values stay unknown; large integer amounts never pass through Number. */
export function perpsMoney(value: string | null | undefined): string {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return "Not reported";
  const amount = BigInt(value), negative = amount < 0n, magnitude = negative ? -amount : amount;
  return `${negative ? "−" : ""}${magnitude / 1_000_000n}.${(magnitude % 1_000_000n).toString().padStart(6, "0")} USDG`;
}
export function paperReport(raw: unknown): PerpsReport | null {
  const report = parsePerpsReport(raw);
  return report && report.mode !== "live" ? report : null;
}

export interface PerpsCommand { id?: string; state?: string; result?: string | null; queued?: boolean; expiresAt?: number }
export async function submitPerpsAction(account: AccountState, action: { kind: "close"; market: string } | { kind: "close-all"; unread: boolean } | { kind: "reset" }): Promise<PerpsCommand> {
  const grant = account.status.grant;
  if (!account.status.exists || !grant || grant.purpose !== "perps") throw new Error("Reload your Perps wallet before confirming. Nothing was sent.");
  const body = { expectedAccount: grant.smartAccount, owner: account.session.hosted ? account.session.address : undefined, expectedTenant: account.session.hosted ? account.session.address : undefined,
    ...(action.kind === "reset" ? {} : { side: "sell", usdgAmount: 0, purpose: action.kind === "close" ? "close-perp" : "flatten-perps", symbol: action.kind === "close" ? action.market : "ALL-PERPS", ...(action.kind === "close-all" && action.unread ? {} : { book: "paper" }) }) };
  // Exit ids are unique for each ask. Never retry this write, including a lost reply.
  try {
    const result = await requestJson<PerpsCommand>(walletUrl(action.kind === "reset" ? "/api/paper-reset" : "/api/orders", "perps"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (typeof result?.id !== "string" || !result.id) throw new Error("The request returned no receipt. It may have been queued. Check the book and command status before asking again.");
    return result;
  } catch (error) {
    if (error instanceof RequestError && error.status > 0 && error.status < 500) throw error;
    throw new Error("The request was sent, but its outcome could not be confirmed. It may still run. It was not sent again; refresh the book and check command status before asking again.");
  }
}


/** Protect every signing method, including provider additions, across wallet
 * prompts. A late signature must never become authority for a closed screen. */
export function guardPerpsSigner<T extends object>(account: T, assertCurrent: () => void): T {
  return new Proxy(account, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof key !== "string" || !key.startsWith("sign") || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        assertCurrent();
        const result = await Reflect.apply(value, target, args);
        assertCurrent();
        return result;
      };
    },
  });
}
