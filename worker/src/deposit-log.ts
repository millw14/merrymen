/**
 * Deposits and withdrawals read from the chain, so a flow is evidence rather
 * than a guess.
 *
 * THE HOLE. `FlowSource` has always declared three sources — 'chain-log',
 * 'transfer-intent' and 'inferred' — and 'chain-log' had NO PRODUCER anywhere in
 * the worker. Only `transfer-intent` (an outbound transfer the agent itself
 * signed) and `inferred` were ever written, so every inbound deposit was an
 * inference with no transaction hash behind it.
 *
 * WHAT INFERENCE CANNOT DO. reconcileFlows books a flow in exactly two cases:
 * the first funded observation, and a cash change with no ledger row written in
 * between. Its own comment records the limit — a deposit landing in the same
 * tick as a fill is deliberately NOT inferred, because separating the two would
 * mean trusting fill economics taken from a pre-trade bound rather than a
 * receipt. So an owner who topped up while the agent was trading had that
 * deposit silently folded into performance, and the fix named in that comment is
 * this file: read the USDG Transfer logs.
 *
 * WHY IT MATTERS BEYOND TIDINESS. Contributions are what P&L is measured
 * against. A deposit that is never recorded is arithmetically indistinguishable
 * from a gain — the flows table exists because /pnl once reported +999.48 on a
 * book that was down 0.52 and charged a performance fee on the owner's own
 * principal. An inferred flow at least says so in its `source` and an audit can
 * drop it on sight; a missing one cannot be seen at all.
 *
 * PURE CORE. Like findOrphanOps, this takes the narrow ReconcileChain seam
 * rather than a live client, so decoding, direction and dedup are unit-tested
 * without a chain. It reuses that module's `getLogsAdaptive` and `addressTopic`
 * rather than growing a second halving loop — that one already knows a failure
 * at span 1 is a bad block to step over rather than a range error to halve
 * again, and two copies of that rule would drift.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not write. The caller books the
 * flows AND moves the high-water mark with them, because a deposit that lifts
 * equity without lifting the peak it is measured against is the original bug
 * wearing a tx hash.
 */
import { decodeEventLog, parseAbi, type Hex } from "viem";
import { addressTopic, getLogsAdaptive, type RawLog, type ReconcileChain } from "./inflight-reconcile";
// The one rule that decides whether a USDG movement is the owner's capital or
// the agent trading. Imported rather than restated so the scanner and the
// accounting backfill cannot reach different answers about the same transfer.
import { classifyUsdgMovement, type TransferLeg } from "../../packages/core/src/index";
import type { ReceiptLog } from "./fills";

/** Every ERC-20 Transfer in a receipt, as classification legs. */
function legsFromReceiptLogs(logs: readonly ReceiptLog[]): TransferLeg[] {
  const out: TransferLeg[] = [];
  for (const l of logs) {
    if ((l.topics?.[0] ?? "").toLowerCase() !== TRANSFER_TOPIC) continue;
    // A Transfer has exactly three topics; ERC-721 has four and shares the
    // signature's first word, so a token id would otherwise read as an amount.
    if (l.topics.length !== 3) continue;
    out.push({
      token: l.address.toLowerCase(),
      from: `0x${l.topics[1]!.slice(-40)}`.toLowerCase(),
      to: `0x${l.topics[2]!.slice(-40)}`.toLowerCase(),
      amountRaw: BigInt(l.data || "0x0").toString(),
    });
  }
  return out;
}

/** The ERC-20 event. `value` is not indexed, so it is read from `data`. */
const TRANSFER_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** Topic0 of Transfer(address,address,uint256) — precomputed, so no client is needed. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;

/** One USDG movement across the account boundary, as the chain recorded it. */
export interface TransferFlow {
  direction: "in" | "out";
  /** Raw 6dp USDG, always positive — `direction` carries the sign. */
  amountUsdg6: bigint;
  txHash: string;
  blockNumber: number;
  /** Position within the block: two transfers can share a transaction. */
  logIndex: number;
}

/** The dedup key. A transaction alone is not unique — one tx can carry several. */
export function flowKey(txHash: string, logIndex: number): string {
  return `${txHash.toLowerCase()}#${logIndex}`;
}

/** Hex or decimal string/number to a JS number, or null when unusable. */
function num(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  try {
    const n = typeof v === "number" ? v : Number(BigInt(v as string));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * USDG movements in or out of `smartAccount` over [fromBlock, toBlock] that the
 * ledger does not already explain.
 *
 * Two scans rather than one: `from` and `to` are separate indexed topics, and
 * there is no single filter that means "either side is this account".
 */
export async function findTransferFlows(opts: {
  chain: ReconcileChain;
  smartAccount: `0x${string}`;
  usdgToken: `0x${string}`;
  fromBlock: bigint;
  toBlock: bigint;
  /**
   * Flow keys already recorded, from `flows`. The scan resumes from the LAST
   * block it recorded rather than the one after, so that a crash part-way
   * through a block cannot lose the rest of it — which means the final block is
   * always re-read and this set is what stops it being booked twice.
   */
  knownKeys: Set<string>;
  /**
   * Transaction hashes the ledger already explains as trades. A swap moves USDG
   * too, and its Transfer log is a FILL, not a deposit — booking it as capital
   * would inflate contributions by the whole turnover of the account and drive
   * P&L steadily negative. Vault moves are covered by the same rule: they are
   * trade rows with transaction hashes.
   */
  tradeTxHashes: Set<string>;
  /** Other accounts this system controls — a movement between them is internal. */
  knownAccounts?: readonly string[];
  /** Trading venues. A WEAK signal: a venue with no paired leg is ambiguous, never a trade. */
  protocolAddresses?: readonly string[];
  /** Chain infrastructure — EntryPoints, Permit2. Never a source of capital. */
  systemAddresses?: readonly string[];
  maxSpan?: bigint;
  log?: (m: string) => void;
}): Promise<TransferFlow[]> {
  const { chain, smartAccount, usdgToken, fromBlock, toBlock, knownKeys, tradeTxHashes } = opts;
  if (toBlock < fromBlock) return [];
  const span = opts.maxSpan ?? 10_000n;
  const me = addressTopic(smartAccount);

  // A SHORT SCAN MUST NOT LOOK LIKE AN EMPTY ONE.
  //
  // getLogsAdaptive no longer loops forever on a rate limit; it returns what it
  // covered and says so. That is better, but it moves a decision here: this
  // caller advances a deposit cursor, and treating a half-scanned window as
  // "no deposits found" would step the cursor past money that arrived.
  //
  // So incomplete coverage is raised, because the ONE caller
  // (index.ts scanChainFlows) already catches and does exactly the right thing
  // with it: "An RPC that will not answer is not evidence of no deposits. Leave
  // the cursor where it is so the same window is retried."
  const scanOrRefuse = async (
    c: typeof chain,
    address: `0x${string}`,
    topics: (Hex | Hex[] | null)[],
    lo: bigint,
    hi: bigint,
    sp: bigint,
    log?: (m: string) => void,
  ): Promise<RawLog[]> => {
    const r = await getLogsAdaptive(c, { address, topics }, lo, hi, sp, log);
    if (!r.complete) {
      throw new Error(
        `deposit scan covered only ${lo}..${r.scannedTo} of ${lo}..${hi} — refusing to advance the cursor past blocks nobody read`,
      );
    }
    return r.logs;
  };

  const raw: RawLog[] = [];
  for (const topics of [
    [TRANSFER_TOPIC, null, me], // inbound: to = us
    [TRANSFER_TOPIC, me, null], // outbound: from = us
  ] as (Hex | Hex[] | null)[][]) {
    raw.push(
      ...(await scanOrRefuse(chain, usdgToken, topics, fromBlock, toBlock, span, opts.log)),
    );
  }

  /** A USDG movement that touches this account, before the receipt decides what it IS. */
  const candidates: (TransferFlow & { from: string; to: string })[] = [];
  const seen = new Set<string>();
  for (const l of raw) {
    const blockNumber = num(l.blockNumber);
    const logIndex = num(l.logIndex);
    // Without both, this flow can neither be resumed from nor deduplicated, and
    // a flow that could be booked twice is worse than one booked late.
    if (blockNumber === null || logIndex === null) {
      opts.log?.(`deposit scan: skipping a log with no block number or index (${l.transactionHash})`);
      continue;
    }

    let from: string;
    let to: string;
    let value: bigint;
    try {
      const d = decodeEventLog({ abi: TRANSFER_ABI, topics: l.topics as [Hex, ...Hex[]], data: l.data });
      from = String(d.args.from).toLowerCase();
      to = String(d.args.to).toLowerCase();
      value = d.args.value as bigint;
    } catch {
      continue; // not a Transfer we can read
    }

    const key = flowKey(l.transactionHash, logIndex);
    // The two scans overlap on a self-transfer, and a window can be re-read.
    if (seen.has(key) || knownKeys.has(key)) continue;
    seen.add(key);

    // A transfer to itself moves nothing across the boundary. It appears in both
    // scans and would otherwise be booked as a deposit of its own size.
    if (from === to) continue;
    if (value === 0n) continue;
    // A SECONDARY skip, kept because it is free and sometimes right, but it is
    // no longer what decides the question. See the classification below.
    if (tradeTxHashes.has(l.transactionHash.toLowerCase())) continue;

    const mine = smartAccount.toLowerCase();
    if (to !== mine && from !== mine) continue; // neither leg is ours
    candidates.push({
      direction: to === mine ? "in" : "out",
      amountUsdg6: value,
      txHash: l.transactionHash,
      blockNumber,
      logIndex,
      from,
      to,
    });
  }

  // ── WHICH OF THESE IS ACTUALLY THE OWNER'S CAPITAL ────────────────────────
  //
  // THIS USED TO BE DECIDED BY LEDGER MEMBERSHIP, and that is not evidence. The
  // only thing separating a contribution from a trade leg was whether the
  // transaction hash appeared in `recentTradeTxHashes` — this worker's OWN
  // sqlite, bounded by row recency rather than block range, living in an
  // ephemeral container that a redeploy empties. Any trade that set missed —
  // older than the bound, from a previous container, made by the owner's own
  // wallet — had its USDG leg written as a `chain-log` flow, the highest-trust
  // source in the schema, with the sign taken from direction alone.
  //
  // On the canary that is not hypothetical: its four 1.6665 USDG outflows to
  // 0xf4acdaee… are TSLA purchases, and after the redeploys that emptied the
  // child ledger nothing here could tell. They would have been booked as a
  // 6.666 USDG withdrawal — contributed capital 3.334 instead of 10.000000,
  // stamped chain-log, hash-chained into the journal and mirrored up. Strictly
  // worse than the inferred rows this file exists to replace, because it would
  // look authoritative.
  //
  // So the receipt decides. A swap moves two tokens in opposite directions
  // within ONE transaction, and that test needs no address list and cannot go
  // stale — see capital-classify.ts.
  const out: TransferFlow[] = [];
  const legsByTx = new Map<string, TransferLeg[]>();
  for (const c of candidates) {
    const k = c.txHash.toLowerCase();
    if (legsByTx.has(k)) continue;
    const receipt = await chain.getReceiptLogs(c.txHash as Hex).catch(() => null);
    if (!receipt) {
      // AN UNREADABLE RECEIPT IS NOT AN ABSENT SECOND LEG. Booking on the one
      // log we can see is exactly the error above, so the whole pass refuses
      // and the caller leaves the cursor where it is — the same handling a
      // window nobody could read already gets.
      throw new Error(
        `deposit scan: the receipt for ${c.txHash} could not be read, so the other half of that transaction is ` +
          `unknown — refusing to classify its USDG leg as capital`,
      );
    }
    legsByTx.set(k, legsFromReceiptLogs(receipt));
  }

  for (const c of candidates) {
    const legs = legsByTx.get(c.txHash.toLowerCase()) ?? [];
    const usdgLeg: TransferLeg = {
      token: usdgToken.toLowerCase(),
      from: c.from,
      to: c.to,
      amountRaw: c.amountUsdg6.toString(),
    };
    const v = classifyUsdgMovement({
      account: smartAccount,
      usdg: usdgLeg,
      txLegs: legs.length ? legs : [usdgLeg],
      usdgToken: usdgToken.toLowerCase(),
      knownAccounts: opts.knownAccounts,
      protocolAddresses: opts.protocolAddresses,
      systemAddresses: opts.systemAddresses,
    });

    if (v.kind === "capital-in" || v.kind === "capital-out") {
      out.push({
        direction: c.direction,
        amountUsdg6: c.amountUsdg6,
        txHash: c.txHash,
        blockNumber: c.blockNumber,
        logIndex: c.logIndex,
      });
      continue;
    }

    if (v.kind === "ambiguous") {
      // UNKNOWN MEANS BLOCKED, never "probably a contribution". Refusing the
      // whole pass leaves the cursor where it is, so an operator sees the same
      // message every tick until they resolve it — which is the point. A
      // permanently ambiguous movement should stop this scanner for this agent
      // rather than quietly become a number in someone's P&L.
      throw new Error(`deposit scan: ${c.txHash}#${c.logIndex} could not be classified — ${v.why}`);
    }

    // trade-in / trade-out / internal / protocol: real movements, not capital.
    opts.log?.(`not capital: ${c.txHash.slice(0, 10)}…#${c.logIndex} is ${v.kind} — ${v.why}`);
  }

  // Chronological, so the flows are booked in the order they happened and the
  // high-water mark moves through the same sequence the account did.
  out.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  return out;
}

/**
 * Where the next scan starts.
 *
 * INCLUSIVE of the last recorded block, not the one after it. A block can carry
 * several transfers, and a crash between two of them would otherwise strand the
 * rest permanently — the watermark would have moved past a block that was only
 * partly read. Re-reading one block each pass is cheap; `knownKeys` makes it
 * free of consequence.
 *
 * `null` means nothing has been scanned yet, and the caller decides where to
 * open: at arm that is the head, so history stays with the single `inferred`
 * opening-balance row rather than being re-litigated transfer by transfer.
 */
export function resumeFrom(lastRecordedBlock: number | null, head: bigint, maxLookback: bigint): bigint {
  if (lastRecordedBlock === null) return head;
  const floor = head > maxLookback ? head - maxLookback : 0n;
  const at = BigInt(lastRecordedBlock);
  return at < floor ? floor : at;
}
