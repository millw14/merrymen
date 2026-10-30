import { requireSolanaLiveSellLimits, requireSolanaLiveTradeMinimum, validateSolanaAccountLimits } from "../../../../../../packages/core/src/solana";
import { getSolanaAppRuntime } from "../../../../../../worker/src/solana-app-runtime";
import { solanaContext, solanaRequestBody, solanaResponse } from "@/lib/solana-api";
import { SolanaWebError } from "@/lib/solana-auth";
import { walletNotSupported } from "@/lib/route-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const walletRefused = walletNotSupported(req);
  if (walletRefused) return walletRefused;
  return solanaResponse(async () => {
    const { principal, store, binding, scope } = await solanaContext(req);
    const body = await solanaRequestBody(req, ["mode", "limits", "revision", "liveConsent"]);
    if ((body.mode !== "paper" && body.mode !== "live") || typeof body.revision !== "number"
      || (body.mode === "live" && body.liveConsent !== true)) throw new SolanaWebError(400, "Review and explicitly confirm your Solana trading mode.");
    // Paper and live alike: at most 96 operations a day and a permission that ends
    // within 168 hours, so nothing saved here is refused later by a trade or setup.
    const limits = validateSolanaAccountLimits(body.limits, Date.now());
    if (body.mode === "live") {
      try { requireSolanaLiveSellLimits(limits); } catch { throw new SolanaWebError(400, "Set how much SOL a live trade and a live day may sell."); }
      // Admission refuses a live trade worth under 1 USDG: a per-trade limit below it would let none through.
      requireSolanaLiveTradeMinimum(limits);
      // The live rollout, decided by the runtime from its own env as everywhere else: only a tenant
      // MERRYMEN_SOLANA_LIVE_TENANTS names saves live mode, with limits within the platform's live caps
      // (an account that already went live may keep live mode to sell its exits). Paper is never asked.
      await getSolanaAppRuntime().checkLiveSettings(scope, limits);
    }
    return { binding: await store.settings(principal.tenant, binding.owner, body.revision, body.mode, limits) };
  });
}
