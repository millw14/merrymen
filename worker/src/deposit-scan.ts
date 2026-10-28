/** Receipt-backed capital booking for one completely read scan window. */
import { findTransferFlows, type TransferFlow } from "./deposit-log";
import { matchInferredDelta } from "./flow-inference";
import { errorText } from "./redact-urls";
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

/** What the chain said about one change a look would otherwise book by inference. */
export type InferredReceipt =
  /** The one receipt that is the change, booked as chain-log with both peaks. */
  | { kind: "booked"; flow: TransferFlow }
  /** That receipt was already on the books; its peaks moved when it was booked, and nothing moved now. */
  | { kind: "already"; flow: TransferFlow }
  /** No receipt stands for the change. The caller books it by inference, as before. */
  | { kind: "unmatched"; why: string };

/**
 * THE RECEIPT FOR A CHANGE INFERENCE WOULD BOOK, booked in its place
 * (flow-inference.ts RULE 4).
 *
 * The window is read with the scanner's own reader, so a transfer counts as
 * capital by exactly the rule the scan books by. A transfer whose transaction
 * already has a flow row of any source is then left out: the executor books a
 * transfer home with its tx and no log index, which `knownKeys` cannot see.
 * What remains must be exactly one transfer equal to the change
 * (matchInferredDelta), and only then is anything booked.
 *
 * A READ THAT FAILS IS NOT AN ABSENCE, but here it is not a hold either: the
 * window could not be read, an amount, a receipt or a classification was
 * unreadable, and the caller books by inference as it always has. A booking
 * the store refuses comes back the same way. A database error from the
 * booking itself THROWS, rolled back, and the caller's look is retried whole.
 */
export async function bookInferredReceipt(
  scan: Parameters<typeof findTransferFlows>[0],
  accounting: {
    agentId: string;
    mode: "live" | "paper";
    /** The change to explain, signed raw 6dp USDG: in is positive. */
    deltaUsdg6: bigint;
    /** Does any flow row name this transaction? Null when the ledger did not answer. */
    flowBookedForTx: (txHash: string) => Promise<boolean | null>;
  },
): Promise<InferredReceipt> {
  if (accounting.agentId.toLowerCase() !== scan.smartAccount.toLowerCase()) {
    return { kind: "unmatched", why: "the transfers read are not this ledger's account" };
  }
  // The store admits a real receipt whatever the mode (paper-boundary.ts), but
  // a paper book's change is simulated: no transfer on chain can BE it.
  if (accounting.mode === "paper") return { kind: "unmatched", why: "a paper book's change is simulated" };
  const where = `blocks ${scan.fromBlock}..${scan.toBlock}`;
  let flows: TransferFlow[];
  try {
    flows = await findTransferFlows(scan);
  } catch (e) {
    return { kind: "unmatched", why: `the transfers in ${where} could not be read (${errorText(e)})` };
  }
  const unbooked: TransferFlow[] = [];
  for (const flow of flows) {
    const booked = await accounting.flowBookedForTx(flow.txHash);
    if (booked === null) return { kind: "unmatched", why: `the ledger could not say whether ${flow.txHash} is booked` };
    if (!booked) unbooked.push(flow);
  }
  const found = matchInferredDelta(unbooked, accounting.deltaUsdg6);
  if ("none" in found) return { kind: "unmatched", why: `${found.none} (${where})` };
  const flow = found.match;
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
  if (booked.kind === "refused") return { kind: "unmatched", why: `its receipt ${flow.txHash} could not be booked: ${booked.why}` };
  return { kind: booked.kind, flow };
}
