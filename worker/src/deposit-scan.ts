/** Receipt-backed capital booking for one completely read scan window. */
import { findTransferFlows, type TransferFlow } from "./deposit-log";
import { bookCapitalFlow } from "./store";

/**
 * Reads before writing, then books each receipt and both peaks in one transaction.
 *
 * A failed read or write throws: the caller must keep the scan cursor and cash
 * baseline and hold the accounting look. Falling back to balance inference here
 * would book a deposit once as a guess and again when its receipt becomes readable.
 * A crash between receipts is safe to retry, including another log in the same
 * block: the store, rather than the reader's cached keys, gates each peak move.
 */
export async function scanAndBookDepositWindow(
  scan: Parameters<typeof findTransferFlows>[0],
  accounting: {
    agentId: string;
    mode: "live" | "paper";
    /** Notifications and the in-memory peak refresh happen only after commit. */
    afterBooked?: (flow: TransferFlow) => Promise<void>;
  },
): Promise<void> {
  if (accounting.agentId.toLowerCase() !== scan.smartAccount.toLowerCase()) {
    throw new Error("deposit scan account does not match the capital ledger account");
  }
  const flows = await findTransferFlows(scan);
  for (const flow of flows) {
    const booked = await bookCapitalFlow({
      agentId: accounting.agentId,
      direction: flow.direction,
      amountUsdg: Number(flow.amountUsdg6) / 1e6,
      source: "chain-log",
      txHash: flow.txHash,
      blockNumber: flow.blockNumber,
      logIndex: flow.logIndex,
      mode: accounting.mode,
      chainId: scan.chainId,
    });
    if (booked.kind === "refused") {
      throw new Error(`deposit scan could not book ${flow.txHash}#${flow.logIndex}: ${booked.why}`);
    }
    if (booked.kind === "booked") await accounting.afterBooked?.(flow);
  }
}
