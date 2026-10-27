/**
 * Start the practice book over — queue it for the worker, which is the only
 * process that can actually do it.
 *
 * "Should positions and trades also become empty when 'starting over' in paper
 * mode? They still appear." They did. Discarding a grant forgets a signed KEY;
 * the book is worker-side state, and the ledger mirror runs strictly child →
 * shared, so anything this service deleted would be rewritten within a minute.
 * The screen could only warn about it. This is the thing that warning stood in
 * for, and it goes through the existing command channel rather than a new one —
 * the same shape as /api/selftest, for the reasons command-files.ts sets out.
 *
 * THE RAIL CHECK THAT MATTERS IS THE WORKER'S, not this one. This route knows
 * what the dashboard believes; the worker knows what rail it is actually on,
 * and it refuses a live agent outright. Between here and there the instruction
 * crosses a shared table, an orchestrator that can see every tenant's home, and
 * a JSON file — so the check that stands between a click and a DELETE has to be
 * the one at the far end. Same argument runOrderCommand makes about orders.
 *
 * WHAT IT IS NOT. Not a delete of anything that could have been real. The
 * worker closes the old rows into a new accounting epoch and clears only the
 * simulated book and the caches derived from it. There is no request shape that
 * reaches a live agent's history.
 *
 * EITHER WALLET'S PRACTICE BOOK, NAMED BY THE REQUEST (`?wallet=`; absent is
 * Spot, exactly as the phones send it), and never the other's: the account is
 * resolved in the SAME wallet the reset is queued for (agent-for.ts and
 * start-over.ts queuePaperReset take the one name), so a Perps reset is a row
 * bound to the Perps account, which only the Perps worker is handed, or a file
 * in the Perps home, which only it drains. That worker clears its practice
 * perp book under its lane's lock (worker index.ts runPaperReset, perps/lane.ts
 * resetPaper), as a Spot worker clears its own book.
 *
 * A PERPS RESET ONLY WHERE A PERPS WORKER RUNS (perps-enabled.ts
 * perpsWorkersRun, D1 and D12). Under any other MERRYMEN_PERPS its worker is
 * stood down and its practice book frozen; a reset queued then would wait for
 * perps to come back. So it is refused, and nothing is read or queued.
 *
 * AND EVERY PERPS RESET CARRIES A DEADLINE: the Perps worker's order window
 * (order-ceiling.ts orderTtlFor, the window its exits wait), because the
 * refusal above only stops a reset asked for while perps are off. One asked
 * for at paper and still waiting when the operator stands perps down would
 * otherwise run whenever they came back, wiping a book days after the owner
 * asked. Past its window the worker answers it expired and touches nothing
 * (start-over.ts queuePaperReset). Spot's reset is queued as it always was.
 *
 * Start over (/api/grants/discard) stays the Spot wallet's: it discards the
 * Spot grant, and the kill (which it is) already stops the Perps wallet.
 */
import { NextResponse } from "next/server";
import { isHostedMode, type GrantPurpose } from "@merrymen/core";
import { hostedAgentFor, diskAgent } from "@/lib/agent-for";
import { orderTtlFor } from "@/lib/order-ceiling";
import { queuePaperReset } from "@/lib/start-over";
import { perpsWalletRefused, perpsWorkersRun } from "@/lib/perps-enabled";
import { walletUnknown } from "@/lib/route-guard";
import { readWalletParam } from "@/lib/wallet-param";

export const dynamic = "force-dynamic";

const agentFor = (req: Request, wallet: GrantPurpose) => (isHostedMode() ? hostedAgentFor(req, wallet) : diskAgent(wallet));

/**
 * The practice reset on its own, as the iOS and Android apps ask for it. The
 * web's Start over does not come here: it discards the grant as well, and the
 * reset has to be queued from the grant before it goes, so it asks
 * /api/grants/discard to do both (lib/start-over.ts).
 */
export async function POST(req: Request) {
  const wallet = readWalletParam(req);
  if (wallet === null) return walletUnknown("No practice reset was queued.");
  if (wallet === "perps" && !perpsWorkersRun()) {
    return perpsWalletRefused(
      "No practice reset was queued: practice perpetuals are not running here, so your Perps wallet's practice book stays exactly as it is until they do.",
    );
  }
  const agent = await agentFor(req, wallet);
  if (!agent) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const hosted = isHostedMode();
  const deadline = wallet === "perps" ? { expiresAt: Date.now() + (await orderTtlFor(req, hosted, wallet)) } : {};
  const queued = await queuePaperReset(hosted, agent, wallet, deadline);
  if (!queued.ok) return NextResponse.json({ error: queued.error }, { status: queued.status ?? 503 });
  return NextResponse.json({ id: queued.id, queued: true, ...(queued.expiresAt !== undefined ? { expiresAt: queued.expiresAt } : {}) });
}
