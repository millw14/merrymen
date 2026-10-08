/** Private account contract. Fill records are not trades or completed positions. */
import type { FeedPerpRow, FeedPerpsAccount } from "./perps-view";
export interface PerpsAccountResponse {
  state: "ready" | "not-configured" | "unread";
  owner: string | null;
  generatedAtMs: number;
  account: null | {
    agentId: string; smartAccount: string; chainId: number;
    collateral: null | { symbol: "USDG"; address: string; decimals: 6 };
    profile?: { name?: string; slug?: string };
  };
  perps: FeedPerpRow[] | null;
  perpsAccount: FeedPerpsAccount | null;
  activityCounts: { state: "ready" | "unread"; paper: number | null; live: number | null; unknown: number | null; scope: "recorded-fills-all-epochs" };
}
