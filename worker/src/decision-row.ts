/**
 * THE ROW ensureDecision STAMPS A TRADE WITH, built where a test can run it.
 *
 * ensureDecision (index.ts) writes a decision row for every trade the tick
 * sends — a strategy's, the class route's, the Brain's, the owner's — and the
 * trade may execute only once that row is in the ledger. The row was assembled
 * inline in main(), which no test boots: the checker put its name back on the
 * ledger alone, with no chain step, and every test in the repo still passed.
 * index.ts now hands this the intent's description, what the producer knows,
 * and the one namer (decision-name.ts), and writes what comes back.
 */
import { provenanceOf, type Provenance } from "./provenance";
import type { DecisionRow } from "./store";

/**
 * WHAT THE PRODUCER KNOWS AND describeIntent CANNOT DERIVE: a class token's
 * symbol (it is in no watch list), which side of the trade it is on (a
 * recovered class position need not be USDG-quoted), its evidence, and the why
 * code that tells a stop-loss sell from an ordinary one under the same source.
 */
export interface KnownFacts {
  action?: string;
  symbol?: string;
  evidence?: string | null;
  provenance?: Provenance;
  whyCode?: string;
}

export async function intentDecisionRow(args: {
  id: string;
  agentId: string;
  source: string;
  reason?: string;
  /** describeIntent's reading of the intent. */
  described: { action: string; symbol?: string; sizeUsdg: number };
  known?: KnownFacts;
  /** makeDecisionNamer's resolver: what is already known, never a wait on the chain. */
  name: (agentId: string, symbol: string) => Promise<string | null>;
}): Promise<DecisionRow> {
  const { known, described } = args;
  const symbol = known?.symbol ?? described.symbol;
  let displayName: string | null;
  try {
    // A SELL IS A ROW TOO. The mechanical exits — stop, take, drain, aged —
    // never pass through the Brain, so they were the one side of a Trencher
    // round trip the feed could not name: "buy AI (T3AD…)" and then "sell
    // T3AD…" for the same coin, minutes apart. Asked for THIS row's symbol —
    // the producer's when it knows one — and a no-op for the issuer-backed
    // tickers these strategies mostly trade (coin-name.ts).
    //
    // AND THE BUY'S NAME WHEN THE TAPE HAS FORGOTTEN THE COIN, or the coin's
    // own contract's when a redeploy wiped the buy (decision-name.ts). A name
    // is display only: one that fails costs the name, never the trade.
    displayName = await args.name(args.agentId, symbol ?? "");
  } catch {
    displayName = null;
  }
  return {
    id: args.id,
    agent_id: args.agentId,
    source: args.source,
    symbol,
    display_name: displayName,
    action: known?.action ?? described.action,
    size_usdg: described.sizeUsdg,
    reason: args.reason,
    evidence_json: known?.evidence ?? null,
    // RECORDED, NOT INFERRED LATER. `source` cannot answer this on its own:
    // an even-keel buy and an even-keel stop-floor sell publish under the
    // same source and are different kinds of decision. See provenance.ts.
    provenance: known?.provenance ?? provenanceOf(args.source, known?.whyCode),
  };
}
