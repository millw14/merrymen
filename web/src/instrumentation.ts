/**
 * Next.js calls register() once as each server process starts.
 *
 * On the Node.js server only, never while `next build` prerenders (NEXT_PHASE), and only while this deployment offers
 * Solana (solanaEnabled): the web publishes its live rollout settings at once and every 30 s after, so the Solana worker
 * judges what this web runs, not what it ran before it was redeployed (web/src/lib/solana-rollout-publisher.ts). Best
 * effort: a failure says an [alert] and never stops the server.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { startSolanaWebRolloutPublisher } = await import("./lib/solana-rollout-publisher");
    startSolanaWebRolloutPublisher();
  }
}
