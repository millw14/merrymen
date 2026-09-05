/**
 * In-flight UserOp reconciliation — recover a landed op the ledger never
 * recorded, so an unclean restart can't loosen the daily cap.
 *
 * THE HOLE. processIntent submits a UserOp and waits for its receipt inside
 * `executor.execute`, THEN writes the trade row (index.ts). The spend/ops
 * reservation that guards the cap between those two steps lives in process
 * MEMORY (inFlightSpentUsdg). So if the process dies after the op lands on-chain
 * but before addTrade commits — a Railway redeploy's SIGTERM, an OOM SIGKILL,
 * the watchdog — that op is gone from the counters. On restart the worker seeds
 * its budget from the ledger alone (getSpentTodayUsdg), which never saw the row,
 * and UNDER-counts the day's spend: the daily cap is now looser by that op's
 * notional, the one unsafe direction. index.ts's fail-closed write already
 * covers a ledger write that fails while the process lives; this covers the
 * process not living to attempt it.
 *
 * THE FIX. At arm, before the budget is seeded, ask the chain what this account
 * actually executed: the EntryPoint emits UserOperationEvent(userOpHash, sender,
 * …, success, …) for every op. Any SUCCESSFUL op whose hash the ledger has no
 * row for is an orphan — write the missing 'landed' row (its notional read from
 * the receipt's USDG leg) so the seed that follows counts it. The chain is the
 * authority; the ledger is reconciled up to it.
 *
 * WHY ONLY SUCCESSFUL, WHY THIS NOTIONAL. A reverted op (success=false) moved no
 * funds and — like every 'reverted' row — counts toward neither cap (the live
 * rail is landed+submitted), so an unrecorded revert changes nothing and is
 * skipped. The notional is |USDG leg| from the receipt, matching how the live
 * path books amount_usdg for both buys and sells (the daily cap is a turnover
 * cap, vault-withdraw excepted). An orphan with no readable USDG leg
 * (stock↔stock, or unparseable) is still recorded, at notional 0, so its hash is
 * known and its op counts — it just can't be attributed a spend figure.
 *
 * PURE CORE. findOrphanOps takes a narrow ReconcileChain seam, not a live
 * client, so the decoding and dedup are unit-tested without a chain — the same
 * discipline fills.ts uses. The live wiring (real getLogs/receipts against the
 * Robinhood RPC) is gated on an end-to-end run before any funded deploy, exactly
 * like the Postgres store: this file is correct by test, proven by that run.
 */
import { decodeEventLog, parseAbi, type Hex } from "viem";
import { backoffMs, classifyRpcError } from "./rpc-error";
import { netTokenDeltas, type ReceiptLog } from "./fills";
import { ENTRYPOINT } from "../../packages/core/src/index";

/** EntryPoint 0.7's per-op event — the account uses entryPoint 0.7 (executor.ts). */
const ENTRYPOINT_ABI = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);

/** Topic0 of UserOperationEvent — precomputed so the filter needs no client. */
const USEROP_EVENT_TOPIC = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";

/** A raw log as returned by an eth_getLogs, narrowed to what the reconciler reads. */
export interface RawLog {
  topics: readonly Hex[];
  data: Hex;
  transactionHash: Hex;
  /**
   * Hex, as eth_getLogs returns them — makeReconcileChain passes the raw RPC
   * response through, so both are present on real logs. Optional because the
   * orphan sweep never needed them and its fakes do not supply them; the
   * deposit scanner does need both (a block number to resume from, a log index
   * to tell two transfers in one transaction apart) and checks for itself.
   */
  blockNumber?: Hex;
  logIndex?: Hex;
}

/**
 * The slice of a chain client the reconciler needs — kept narrow so a fake can
 * stand in for a viem PublicClient in tests.
 */
export interface ReconcileChain {
  getBlockNumber(): Promise<bigint>;
  /** EntryPoint UserOperationEvent logs for one sender over a block span. */
  getLogs(args: {
    address: `0x${string}`;
    fromBlock: bigint;
    toBlock: bigint;
    topics: (Hex | Hex[] | null)[];
  }): Promise<RawLog[]>;
  /** The receipt's logs, for reading the op's USDG leg. Null if not found. */
  getReceiptLogs(txHash: Hex): Promise<readonly ReceiptLog[] | null>;
}

export interface OrphanOp {
  userOpHash: string;
  txHash: string;
  /** |USDG leg|, 6dp — the notional for the cap. 0 when it couldn't be attributed. */
  notionalUsdg6: bigint;
  /** Whether a USDG leg was found (false → notional is a floor of 0, logged). */
  attributed: boolean;
}

/** Left-pad a 20-byte address into a 32-byte topic for an indexed-address filter. */
export function addressTopic(addr: string): Hex {
  return `0x${"0".repeat(24)}${addr.toLowerCase().replace(/^0x/, "")}` as Hex;
}

/**
 * Fetch logs matching `filter` over [fromBlock, toBlock], halving the span on a
 * provider range error rather than guessing its limit.
 *
 * Every caller filters by an indexed address topic, so only ONE account's logs
 * come back however wide the window — the span cap is about provider limits,
 * not result volume.
 *
 * EXPORTED AND ADDRESS-AGNOSTIC because the deposit scanner needs exactly this
 * behaviour against the USDG token rather than the EntryPoint. Writing a second
 * halving loop is how the two drift.
 *
 * RETURNS COVERAGE, NOT JUST LOGS. `complete: false` means the window was not
 * fully scanned and the caller must not treat the absence of a log as evidence
 * that no such log exists.
 */
export interface AdaptiveLogs {
  logs: RawLog[];
  /** Did the scan actually cover fromBlock..toBlock? */
  complete: boolean;
  /** The last block genuinely scanned. Equals toBlock when complete. */
  scannedTo: bigint;
}

/** Retries of one span before the sweep gives up and reports short coverage. */
const MAX_RETRIES_PER_SPAN = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getLogsAdaptive(
  chain: ReconcileChain,
  filter: { address: `0x${string}`; topics: (Hex | Hex[] | null)[] },
  fromBlock: bigint,
  toBlock: bigint,
  maxSpan: bigint,
  log?: (m: string) => void,
): Promise<AdaptiveLogs> {
  const out: RawLog[] = [];
  let cursor = fromBlock;
  let span = maxSpan;
  let attempt = 0;
  while (cursor <= toBlock) {
    const end = cursor + span - 1n < toBlock ? cursor + span - 1n : toBlock;
    try {
      const logs = await chain.getLogs({
        address: filter.address,
        fromBlock: cursor,
        toBlock: end,
        topics: filter.topics,
      });
      out.push(...logs);
      cursor = end + 1n;
      // A clean pass earns the retry budget back, so one blip mid-sweep does
      // not doom the rest of a long window.
      attempt = 0;
    } catch (e) {
      // A RATE LIMIT IS NOT A RANGE ERROR, and reading it as one was a fault
      // that could not terminate. The old code halved the span on EVERY
      // failure: under a sustained 429 it walked 10,000 -> 1 in fourteen
      // requests (times four again, because viem retries 429 by default),
      // advanced the cursor by ONE BLOCK, reset the span, and did it again.
      // Traversing 200,000 blocks that way is millions of requests, and the
      // requests were themselves the reason for the rate limit.
      //
      // Worse than the cost: at span 1 it STEPPED OVER the block. This sweep
      // exists so a landed operation cannot go unreconciled and under-count the
      // day’s spend, so silently skipping blocks broke the one property it is
      // for.
      const v = classifyRpcError(e);

      if (v.kind === "range-too-large" && span > 1n) {
        span = span / 2n;
        continue;
      }

      if (v.retryable && attempt < MAX_RETRIES_PER_SPAN) {
        // Same span, same cursor. Nothing about the question was wrong.
        const wait = v.retryAfterMs ?? backoffMs(attempt);
        attempt += 1;
        log?.(`getLogs ${v.kind} at ${cursor}..${end} — retrying the same span in ${wait}ms (${v.detail})`);
        await sleep(wait);
        continue;
      }

      // Out of retries, or a failure retrying cannot fix. STOP, and say the
      // coverage is short. A caller that believes it saw every log in a window
      // it did not actually cover is the failure mode; an explicit gap is not.
      log?.(
        `getLogs gave up at ${cursor} (${v.kind}: ${v.detail}) — scanned ${fromBlock}..${cursor - 1n} of ${fromBlock}..${toBlock}`,
      );
      return { logs: out, complete: false, scannedTo: cursor - 1n };
    }
  }
  return { logs: out, complete: true, scannedTo: toBlock };
}

/**
 * The orphans among this account's on-chain ops: successful, and with no ledger
 * row for their hash. Pure but for the injected chain seam.
 */
export async function findOrphanOps(opts: {
  chain: ReconcileChain;
  smartAccount: `0x${string}`;
  usdgToken: string;
  knownOpHashes: Set<string>;
  /** Blocks back from head to scan. The caller derives it from the 24h cap window. */
  lookbackBlocks: bigint;
  /** Max blocks per getLogs call (adaptive-halved down from here on a range error). */
  maxSpan?: bigint;
  log?: (m: string) => void;
  /**
   * The raw logs this sweep actually used, handed out for comparison.
   *
   * PURELY OBSERVATIONAL. It is called after the fetch and before any decision,
   * it cannot change what this function does, and a throw from it is not caught
   * here because a shadow comparison that throws is a defect in the shadow, not
   * in reconciliation. Exists so shadow mode can compare against the data the
   * AUTHORITATIVE path really saw, rather than paying for a third scan of the
   * same range and comparing against something merely similar.
   */
  onLogs?: (logs: readonly RawLog[], complete: boolean, scannedTo: bigint) => void;
}): Promise<OrphanOp[]> {
  const { chain, smartAccount, usdgToken, knownOpHashes, lookbackBlocks } = opts;
  const head = await chain.getBlockNumber();
  const from = head > lookbackBlocks ? head - lookbackBlocks : 0n;
  const logs = await getLogsAdaptive(
    chain,
    {
      address: ENTRYPOINT.v07 as `0x${string}`,
      // topic1 (the indexed userOpHash) is left null: the sweep does not know
      // the hashes in advance, which is the whole point of it.
      topics: [USEROP_EVENT_TOPIC, null, addressTopic(smartAccount)],
    },
    from,
    head,
    opts.maxSpan ?? 10_000n,
    opts.log,
  );

  opts.onLogs?.(logs.logs, logs.complete, logs.scannedTo);

  // INCOMPLETE COVERAGE IS SAID OUT LOUD. An orphan sweep that scanned half
  // its window and found nothing has not established that there are no orphans.
  if (!logs.complete) {
    opts.log?.(
      `findOrphanOps covered only ${from}..${logs.scannedTo} of ${from}..${head} — ` +
        `any op outside that range is still unreconciled`,
    );
  }

  const orphans: OrphanOp[] = [];
  const seen = new Set<string>(); // guard against the same op appearing twice in a window
  for (const raw of logs.logs) {
    let userOpHash: string;
    let success: boolean;
    try {
      const decoded = decodeEventLog({ abi: ENTRYPOINT_ABI, topics: raw.topics as [Hex, ...Hex[]], data: raw.data });
      userOpHash = String(decoded.args.userOpHash).toLowerCase();
      success = Boolean(decoded.args.success);
    } catch {
      continue; // not a UserOperationEvent we can read — skip
    }
    // A reverted op moved nothing and counts toward no cap; only a successful op
    // the ledger missed can under-count the day.
    if (!success) continue;
    if (knownOpHashes.has(userOpHash) || seen.has(userOpHash)) continue;
    seen.add(userOpHash);

    const txHash = raw.transactionHash;
    let notionalUsdg6 = 0n;
    let attributed = false;
    const receiptLogs = await chain.getReceiptLogs(txHash).catch(() => null);
    if (receiptLogs) {
      const deltas = netTokenDeltas(receiptLogs, smartAccount);
      const usdgDelta = deltas.get(usdgToken.toLowerCase()) ?? 0n;
      if (usdgDelta !== 0n) {
        notionalUsdg6 = usdgDelta < 0n ? -usdgDelta : usdgDelta;
        attributed = true;
      }
    }
    orphans.push({ userOpHash, txHash: String(txHash).toLowerCase(), notionalUsdg6, attributed });
  }
  return orphans;
}
/** What the chain says about one op we submitted and lost track of. */
export interface ResolvedOp {
  userOpHash: string;
  txHash: string;
  /** The chain's verdict. A reverted op moved nothing. */
  success: boolean;
  /** |USDG leg|, 6dp. 0 when unattributable, and only meaningful on success. */
  notionalUsdg6: bigint;
  attributed: boolean;
}

/**
 * RESOLVE OPS WE SUBMITTED AND NEVER HEARD BACK ABOUT.
 *
 * The sibling of findOrphanOps, and deliberately not the same function. An
 * ORPHAN is an op the chain executed that the ledger knows nothing about, found
 * by scanning a window; a STRANDED op is one the ledger already named — we hold
 * its hash — whose outcome is missing. Those want opposite queries:
 *
 *  - findOrphanOps scans a block range and skips `!success`, because a reverted
 *    op moved nothing and counts toward no cap, so an unrecorded revert changes
 *    nothing. Here the row EXISTS and is charging the live rail, so a revert is
 *    exactly as important as a success — it is what releases the charge.
 *  - findOrphanOps cannot filter by hash (it does not know them in advance).
 *    This does: topic1 of UserOperationEvent is the indexed userOpHash and
 *    getLogsAdaptive already leaves that slot null, so passing the hash turns a
 *    window scan into an exact lookup.
 *
 * Reimplemented from the shape of Vex's agent-activity-repair
 * (github.com/Vex-Foundation/Vex), used with its author's permission, and
 * keeping the three properties that make theirs safe: it holds no signer, it
 * NEVER re-broadcasts, and it never terminalizes on ambiguity — an op it cannot
 * find stays 'submitted' rather than being guessed at. A resolver that guesses
 * is worse than none, because the guess would enter a hash-chained journal.
 */
export async function resolveSubmittedOps(opts: {
  chain: ReconcileChain;
  smartAccount: `0x${string}`;
  usdgToken: string;
  /** Hashes of 'submitted' rows, lowercased. */
  hashes: readonly string[];
  lookbackBlocks: bigint;
  maxSpan?: bigint;
  log?: (m: string) => void;
}): Promise<ResolvedOp[]> {
  if (opts.hashes.length === 0) return [];
  const head = await opts.chain.getBlockNumber();
  const from = head > opts.lookbackBlocks ? head - opts.lookbackBlocks : 0n;

  const out: ResolvedOp[] = [];
  for (const hash of opts.hashes) {
    // EXACT LOOKUP, not a scan. topic1 is the indexed userOpHash.
    const logs = await getLogsAdaptive(
      opts.chain,
      {
        address: ENTRYPOINT.v07 as `0x${string}`,
        topics: [USEROP_EVENT_TOPIC, hash as Hex, addressTopic(opts.smartAccount)],
      },
      from,
      head,
      opts.maxSpan ?? 10_000n,
      opts.log,
    );
    // NOT FOUND IS NOT "REVERTED" — and a scan that did not finish has not even
    // established "not found". Both leave the op exactly as it was.
    if (!logs.complete || logs.logs.length === 0) continue;

    let decoded: { success: boolean } | null = null;
    let txHash = "";
    for (const raw of logs.logs) {
      try {
        const d = decodeEventLog({
          abi: ENTRYPOINT_ABI,
          topics: raw.topics as [Hex, ...Hex[]],
          data: raw.data,
        });
        if (String(d.args.userOpHash).toLowerCase() !== hash) continue;
        decoded = { success: Boolean(d.args.success) };
        txHash = String(raw.transactionHash).toLowerCase();
        break;
      } catch {
        // not a UserOperationEvent we can read — keep looking
      }
    }
    if (!decoded) continue;

    let notionalUsdg6 = 0n;
    let attributed = false;
    if (decoded.success) {
      const receiptLogs = await opts.chain.getReceiptLogs(txHash as Hex).catch(() => null);
      if (receiptLogs) {
        const usdgDelta = netTokenDeltas(receiptLogs, opts.smartAccount).get(opts.usdgToken.toLowerCase()) ?? 0n;
        if (usdgDelta !== 0n) {
          notionalUsdg6 = usdgDelta < 0n ? -usdgDelta : usdgDelta;
          attributed = true;
        }
      }
    }
    out.push({ userOpHash: hash, txHash, success: decoded.success, notionalUsdg6, attributed });
  }
  return out;
}
