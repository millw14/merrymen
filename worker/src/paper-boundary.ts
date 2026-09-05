/**
 * PAPER MONEY MAY NOT WRITE REAL CAPITAL RECORDS. EVER.
 *
 * This is where the −59,000 / −26,000 / −7,900 USDG "contributions" came from,
 * and the mechanism is worth stating exactly because it is not the redeploy bug
 * wearing a different hat:
 *
 *   A paper agent's cash is SIMULATED. It moves when a simulated fill spends it.
 *   `reconcileFlows` books an external flow whenever cash moved and no ledger row
 *   explains it — a rule written for a real account, where the only thing that
 *   can move cash without a fill is the owner. On a paper book the simulated
 *   balance moves for simulated reasons, so the rule fired on trades: hence rows
 *   of exactly 58.335, 41.670, 25.005 and 8.340 USDG sitting in `flows` as
 *   though an owner had withdrawn them, and repeated round 1000s and 500s from
 *   the paper book being reset and re-run.
 *
 * Those rows are indistinguishable from real capital AFTER the fact — same
 * table, same columns, same `inferred` source a live agent also writes. The only
 * place the distinction still exists is at the moment of writing, so that is
 * where it has to be enforced, permanently, rather than cleaned up later.
 *
 * WHAT COUNTS AS ADMISSIBLE FOR A PAPER AGENT is narrower than "evidenced". A
 * paper agent's SMART ACCOUNT is a real address that can really be funded, so a
 * chain-log flow naming an actual Transfer is real capital and must be kept. But
 * `epoch-carry` — the deterministic bridge that writes a closing equity forward
 * as an opening balance — derives from the SIMULATED book, and carrying it would
 * launder a paper equity into a real contribution figure across a boundary. It
 * is checkable, which is why it is evidenced enough for a live agent; it is not
 * a receipt, which is why it is not enough for a paper one.
 *
 * So: for a paper agent, only a chain-log flow with a transaction hash.
 */
import type { FlowSource } from "./store";

/** What the agent is actually doing. `unknown` is a real answer, not a default. */
export type TradingMode = "paper" | "live" | "unknown";

export type FlowAdmission =
  | { admit: true }
  | {
      admit: false;
      /** The sentence written to the event log, so a refusal is never silent. */
      why: string;
    };

/**
 * May this flow be written? PURE.
 *
 * Separated from both call sites so the rule can be tested against the exact
 * corrupt shapes production produced, rather than inferred from the behaviour of
 * a tick loop that needs an RPC and a database to run.
 */
export function admitCapitalFlow(input: {
  mode: TradingMode;
  source: FlowSource;
  txHash?: string | null;
}): FlowAdmission {
  if (input.mode !== "paper") return { admit: true };

  if (input.source === "chain-log" && input.txHash) return { admit: true };

  if (input.source === "chain-log") {
    // A chain-log source with no transaction is a contradiction — the source
    // means "read off a Transfer log" and the log is what carries the hash — so
    // it is refused on the paper side rather than trusted for its label.
    return {
      admit: false,
      why: "a chain-log flow with no transaction hash is not a receipt, and a paper book may not write one",
    };
  }

  return {
    admit: false,
    why:
      `this agent is trading on paper, so a '${input.source}' flow is derived from a SIMULATED balance — ` +
      `it would enter the ledger indistinguishable from real contributed capital`,
  };
}

/** Read a stored mode string without inventing one. */
export function tradingModeOf(mode: string | null | undefined): TradingMode {
  return mode === "paper" ? "paper" : mode === "live" ? "live" : "unknown";
}
