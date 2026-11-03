/** Client-safe, identity-bound paper account read. No signing material. */
import { parsePerpsReport } from "@merrymen/core";
import type { PerpsReportRead } from "./agent-perps";
export interface PerpsIdentity { owner: string | null; account: { smartAccount: string; chainId: number } | null }
export interface PerpsAccountResponse extends PerpsIdentity {
  state: "ready" | "not-configured" | "unread";
  generatedAtMs: number;
  account: (NonNullable<PerpsIdentity["account"]> & { agentId: string; collateral: { symbol: "USDG"; address: string; decimals: 6 } | null }) | null;
  report: PerpsReportRead;
  activityCounts: { state: "ready" | "unread"; paper: number | null; scope: "recorded-fills-all-epochs" };
}
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const address = (x: unknown): x is string => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x);
export function isPerpsIdentity(raw: Record<string, unknown>): boolean {
  return (raw.owner === null || address(raw.owner)) && (raw.account === null ||
    object(raw.account) && address(raw.account.smartAccount) && typeof raw.account.chainId === "number" && Number.isSafeInteger(raw.account.chainId) && raw.account.chainId > 0);
}
export function readPerpsAccount(raw: unknown): PerpsAccountResponse | null {
  if (!object(raw) || !isPerpsIdentity(raw) || !["ready", "not-configured", "unread"].includes(String(raw.state)) ||
      typeof raw.generatedAtMs !== "number" || !Number.isSafeInteger(raw.generatedAtMs) || raw.generatedAtMs <= 0 || !object(raw.report) || !object(raw.activityCounts)) return null;
  if ((raw.state === "ready") !== (raw.account !== null)) return null;
  if (raw.account !== null) {
    const a = raw.account as Record<string, unknown>;
    if (a.agentId !== String(a.smartAccount).toLowerCase() || !(a.collateral === null || object(a.collateral) &&
        a.collateral.symbol === "USDG" && a.collateral.decimals === 6 && address(a.collateral.address))) return null;
  }
  const r = raw.report;
  if (r.state === "ok") {
    const parsed = parsePerpsReport(r.report);
    if (!parsed || parsed.mode === "live" || !(r.accountMode === null || typeof r.accountMode === "string")) return null;
  } else if (r.state !== "not-said" && r.state !== "unreadable") return null;
  const c = raw.activityCounts;
  if (c.scope !== "recorded-fills-all-epochs" || !(c.state === "unread" && c.paper === null ||
      c.state === "ready" && typeof c.paper === "number" && Number.isSafeInteger(c.paper) && c.paper >= 0)) return null;
  return raw as unknown as PerpsAccountResponse;
}
