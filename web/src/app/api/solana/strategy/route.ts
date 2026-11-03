import { SOLANA_LIVE_MIN_TRADE_USDG_RAW, SOLANA_LIVE_STRATEGY_BELOW_MINIMUM } from "../../../../../../packages/core/src/solana";
import { solanaContext, solanaRequestBody, solanaResponse } from "@/lib/solana-api";
import { validateSolanaStrategy } from "@/lib/solana-binding-store";
import { SolanaWebError } from "@/lib/solana-auth";
import { walletNotSupported } from "@/lib/route-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const walletRefused = walletNotSupported(req);
  if (walletRefused) return walletRefused;
  return solanaResponse(async () => {
    const { principal, store, binding } = await solanaContext(req);
    const body = await solanaRequestBody(req, ["strategy", "revision"]);
    if (typeof body.revision !== "number") throw new SolanaWebError(400, "Refresh before saving your Solana strategy.");
    const strategy = validateSolanaStrategy(body.strategy);
    if (strategy.enabled && (!binding.limits || BigInt(strategy.tradeUsdgRaw) > BigInt(binding.limits.perTradeUsdg))) {
      throw new SolanaWebError(400, "Save trading limits first and keep each strategy trade within the per-trade limit.");
    }
    // Admission refuses a live trade worth under 1 USDG: a live strategy that small could only be refused.
    if (strategy.enabled && binding.requestedMode === "live" && BigInt(strategy.tradeUsdgRaw) < SOLANA_LIVE_MIN_TRADE_USDG_RAW) {
      throw new SolanaWebError(400, SOLANA_LIVE_STRATEGY_BELOW_MINIMUM);
    }
    return { binding: await store.strategy(principal.tenant, binding.owner, body.revision, strategy) };
  });
}
