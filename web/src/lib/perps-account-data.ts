import { LIGHTER_ROUTE_V1 } from "@merrymen/core";
import type { Db } from "../../../worker/src/db";
import { readAgentPerpsFrom } from "./agent-perps";
import { perpsFeedOf } from "./perps-view";
import type { PerpsAccountResponse } from "./perps-account";
export function emptyPerpsAccount(owner: string | null, nowMs: number): PerpsAccountResponse {
  return { state: "unread", owner, generatedAtMs: nowMs, account: null, perps: null, perpsAccount: null,
    activityCounts: { state: "unread", paper: null, live: null, unknown: null, scope: "recorded-fills-all-epochs" } };
}
/** Whitelist the grant; keys and signing material must never cross this boundary. */
export function perpsAccountIdentity(grant: unknown): NonNullable<PerpsAccountResponse["account"]> | null {
  if (!grant || typeof grant !== "object") return null;
  const g = grant as Record<string, unknown>;
  if (typeof g.smartAccount !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(g.smartAccount) || typeof g.chainId !== "number" || !Number.isSafeInteger(g.chainId) || g.chainId < 1) return null;
  return { agentId: g.smartAccount.toLowerCase(), smartAccount: g.smartAccount, chainId: g.chainId,
    collateral: g.chainId === LIGHTER_ROUTE_V1.chainId ? { symbol: "USDG", address: LIGHTER_ROUTE_V1.usdg, decimals: 6 } : null };
}
export async function readPerpsAccountData(db: Db | null, answer: PerpsAccountResponse): Promise<PerpsAccountResponse> {
  if (!db || !answer.account) return answer;
  const account = answer.account;
  const report = await readAgentPerpsFrom(db, account.smartAccount);
  const view = perpsFeedOf(report, answer.generatedAtMs);
  answer.perps = view.perps; answer.perpsAccount = view.perpsAccount;
  try {
    const row = await db.prepare("SELECT name FROM agents WHERE smart_account = ?").get(account.smartAccount) as { name?: unknown } | undefined;
    if (typeof row?.name === "string" && row.name.trim()) account.profile = { ...account.profile, name: row.name };
  } catch { /* Missing profile never changes financial read quality. */ }
  try {
    const rows = await db.prepare("SELECT mode, COUNT(*) AS n FROM perp_fills WHERE agent_id = ? GROUP BY mode").all(account.agentId) as { mode: unknown; n: unknown }[];
    const counts = { paper: 0, live: 0, unknown: 0 };
    for (const row of rows) {
      const n = Number(row.n);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid fill count");
      const key = row.mode === "paper" || row.mode === "live" ? row.mode : "unknown";
      counts[key] += n;
      if (!Number.isSafeInteger(counts[key])) throw new Error("fill count overflow");
    }
    answer.activityCounts = { ...counts, state: "ready", scope: "recorded-fills-all-epochs" };
  } catch { /* Unread is not zero fills. */ }
  answer.state = report.state === "unreadable" || answer.activityCounts.state === "unread" ? "unread" : "ready";
  return answer;
}
