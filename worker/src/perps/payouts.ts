/**
 * LIGHTER PAYOUTS, RECOGNISED FROM THE CHAIN (docs/perps.md rule 12; review
 * notes payout-settlement-must-be-chain-derived and
 * margin-in-transit-double-count).
 *
 * THE PROBLEM THIS FILE EXISTS FOR. A secure withdrawal comes home in SOMEONE
 * ELSE'S transaction: Lighter's relayer calls withdrawPendingBalance(owner, 3,
 * a), batching many owners, minutes after our L2 Withdraw executed. No UserOp
 * of ours, no receipt we asked for — just USDG appearing in the account. The
 * flow inference would read that as the owner depositing capital (a peak
 * raised by money that was ours all along), and an in-memory "expected
 * settlement" dies with the process that registered it. So a payout is
 * recognised the only way that survives a restart, a wipe and a hosted
 * re-home: from the proxy's own `WithdrawPending(owner = this account, asset
 * 3, amount)` logs, between two block-pinned reads.
 *
 * THREE PIECES, each pure but for its injected seam:
 *
 *   foldPayouts   — every WithdrawPending to this account over
 *                   (fromBlockExclusive, toBlockInclusive], paged ≤ 10,000,000
 *                   blocks through inflight-reconcile's getLogsAdaptive.
 *                   `removed` logs dropped, other assets dropped, anything
 *                   malformed or a scan that did not cover the window is
 *                   `complete: false` — unknown, never zero.
 *   recordPayouts — the ledger: open withdraw rows marked `paid` oldest first
 *                   in AGGREGATE (a payout carries no withdrawal id, and the
 *                   relayer pays a whole pending balance in one log), any
 *                   excess booked as an owner-initiated withdrawal and
 *                   alerted, each row in one db.tx with its `margin` journal
 *                   entry (store.ts upsertPerpTransfer), idempotent on the
 *                   payout's chain identity.
 *   inTransit     — rule 12b's T_in and T_out from the open rows, and the
 *                   gap check against getPendingBalance at the same block.
 *
 * THE CALL ORDER (index.ts wires it; the block-pinned read is integration's):
 *
 *   1. Once at arm, addressToAccountIndex(self). While it is 0 there is no
 *      Lighter account and nothing to fold (rule 11's known 0). Once it is
 *      not, fold every look — even with the perps marker gone, because a
 *      payout after a recover or a revoked grant is still this account's
 *      margin coming home, never capital.
 *   2. Read the cash and its block N in ONE Multicall aggregate
 *      (getBlockNumber beside balanceOf), and getPendingBalance(self, 3) AT N.
 *   3. cursor = the baseline's `cash_read_block` (store.ts
 *      lastKnownCashReadBlock) or the hosted anchor's. No cursor while the
 *      account has an index → infer nothing: the look holds (a first look
 *      doubts contributions). Never "no payouts".
 *   4. fold = foldPayouts({ getLogs, proxy, account, fromBlockExclusive:
 *      cursor, toBlockInclusive: N }). `complete: false` → the look holds,
 *      exactly as for an unread balance.
 *   5. Add fold.sumMicro to the baseline the look compares cash against (the
 *      steady state, prior.cashUsdg on a restart look, anchorCashUsdg on a
 *      hosted first look). Keep an in-process set of folded
 *      `${txHash}:${logIndex}` so a held look followed by a settling one folds
 *      each payout once. On a scan-covered look the scan's `venue-margin` arm
 *      already explains the payout; the cursor still advances.
 *   6. rec = store.recordPerpPayouts(agent, fold.payouts): allocate the logs,
 *      partial remainder, paid transfers and margin journal entries in one
 *      transaction. Recover the remainder from the ledger on every look;
 *      process memory is never the accounting authority. Alert on rec.alert.
 *   7. t = inTransit({ openTransfers: listOpenPerpTransfers(agent, 'live')
 *      (read AFTER step 6), pendingBalanceMicro: pending@N, carriedPayoutMicro:
 *      rec.carryMicro }). t.gap → rule 11 book gap: no equity row, no
 *      ratchet, no fee, opens refused. Otherwise T_in / T_out feed view.ts
 *      (depositsInTransitMicro / withdrawalsInTransitMicro), and any open row
 *      or pending > 0 holds the ratchets (rule 12c).
 *   8. Write the equity row with cash_read_block = N: the next look's cursor.
 */

import { decodeEventLog, type Hex } from "viem";
import { LIGHTER_EVENTS_ABI, LIGHTER_ROUTE_V1 } from "../../../packages/core/src/index";
import { addressTopic, getLogsAdaptive, type RawLog, type ReconcileChain } from "../inflight-reconcile";
import type { PerpTransferInput, PerpTransferOutcome, PerpTransferRow } from "../store";

// ── the fold ────────────────────────────────────────────────────────────────

/** The widest getLogs page; the filter names one owner, so this bounds provider work, not result volume. */
export const PAYOUT_MAX_SPAN = 10_000_000n;

/** One payout to this account: a WithdrawPending(self, 3, baseAmount) log, in micro-USDG. */
export interface Payout {
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  /** baseAmount × tickSize. */
  amountMicro: bigint;
}

export type PayoutFold =
  | { complete: true; payouts: Payout[]; sumMicro: bigint; scannedTo: bigint }
  /** Not every block of the window was read, or an answer did not parse: NOTHING may be inferred from it. */
  | { complete: false; detail: string; scannedTo: bigint | null };

/** A log as eth_getLogs returns it: RawLog plus the two fields reorg-safety and the filter check read. */
type PayoutRawLog = RawLog & { removed?: unknown; address?: unknown };

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function hexQuantity(v: unknown): bigint | null {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v)) return BigInt(v);
  return null;
}

export const payoutKey = (p: { txHash: string; logIndex: number }): string => `${p.txHash.toLowerCase()}:${p.logIndex}`;

/**
 * EVERY PAYOUT TO THIS ACCOUNT in (fromBlockExclusive, toBlockInclusive].
 *
 * The filter is the proxy, topic0 WithdrawPending and topic1 = pad32(self) —
 * `owner` is the one indexed field — so only this account's payouts come
 * back however wide the window, and the 10,000,000-block page bounds only
 * the provider's work. getLogsAdaptive halves on a range error and reports
 * coverage; a window it did not fully read is `complete: false`.
 *
 * EVERY LOG IS CHECKED AGAINST THE QUESTION ASKED. A log from another
 * address, with other topics, outside the window, or with an unreadable
 * position or body means the provider answered something else — the fold is
 * `complete: false`, never "those logs did not count". Two things are
 * DROPPED rather than refused, because they are well-formed answers that are
 * simply not payouts of ours: a log the node marks `removed` (reorged out),
 * and a payout of another asset (asset ≠ 3 — not USDG). A zero amount moved
 * nothing and is dropped too.
 */
export async function foldPayouts(args: {
  /** ReconcileChain.getLogs — raw eth_getLogs (index.ts makeReconcileChain). */
  getLogs: ReconcileChain["getLogs"];
  /** LIGHTER_ROUTE_V1.proxy — and nothing else. */
  proxy: `0x${string}`;
  /** This account: the payouts' `owner`. */
  account: `0x${string}`;
  /** The previous reading's block (its cash already saw every payout up to it). */
  fromBlockExclusive: bigint;
  /** This reading's block N (inclusive: the read saw the state after N). */
  toBlockInclusive: bigint;
  /** assetConfigs(3).tickSize — LIGHTER_ROUTE_V1.usdgTickSize (1). */
  tickSize?: number | bigint;
  /** ≤ PAYOUT_MAX_SPAN. */
  maxSpan?: bigint;
  log?: (m: string) => void;
}): Promise<PayoutFold> {
  // CALLER BUGS THROW, before anything is read: a fold of another contract's
  // "WithdrawPending" would be a fold of whatever that contract says.
  if (typeof args.proxy !== "string" || args.proxy.toLowerCase() !== LIGHTER_ROUTE_V1.proxy) {
    throw new RangeError(`foldPayouts: ${String(args.proxy)} is not the Lighter proxy`);
  }
  if (typeof args.account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(args.account)) {
    throw new RangeError(`foldPayouts: ${String(args.account)} is not an account address`);
  }
  const tick = BigInt(args.tickSize ?? LIGHTER_ROUTE_V1.usdgTickSize);
  if (tick <= 0n) throw new RangeError(`foldPayouts: tick size ${tick} is not positive`);
  const span = args.maxSpan ?? PAYOUT_MAX_SPAN;
  if (span < 1n || span > PAYOUT_MAX_SPAN) throw new RangeError(`foldPayouts: a page of ${span} blocks is outside 1…${PAYOUT_MAX_SPAN}`);
  const from = args.fromBlockExclusive;
  const to = args.toBlockInclusive;
  if (typeof from !== "bigint" || typeof to !== "bigint" || from < 0n) throw new RangeError("foldPayouts: blocks are non-negative bigints");
  // A reading BEHIND the cursor is a node that answered from an older block
  // (load-balanced RPCs do). Not a bug of ours and not "no payouts": unknown.
  if (to < from) return { complete: false, detail: `the reading's block ${to} is behind the cursor ${from}`, scannedTo: null };
  if (to === from) return { complete: true, payouts: [], sumMicro: 0n, scannedTo: to };

  const proxy = LIGHTER_ROUTE_V1.proxy;
  const topic0 = LIGHTER_ROUTE_V1.topics.withdrawPending.toLowerCase() as Hex;
  const topic1 = addressTopic(args.account).toLowerCase() as Hex;
  // getLogsAdaptive only ever calls getLogs; the rest of the seam is never
  // reached, and fails loudly if a refactor ever reaches it.
  const chain: ReconcileChain = {
    getLogs: args.getLogs,
    getBlockNumber: () => Promise.reject(new Error("foldPayouts: getBlockNumber is not part of this seam")),
    getReceiptLogs: () => Promise.reject(new Error("foldPayouts: getReceiptLogs is not part of this seam")),
  };
  let scan;
  try {
    scan = await getLogsAdaptive(chain, { address: proxy, topics: [topic0, topic1] }, from + 1n, to, span, args.log);
  } catch (e) {
    return { complete: false, detail: `getLogs failed: ${e instanceof Error ? e.message : String(e)}`, scannedTo: null };
  }
  if (!scan.complete) {
    return { complete: false, detail: `the payout scan stopped at block ${scan.scannedTo} of ${to}`, scannedTo: scan.scannedTo };
  }

  const seen = new Map<string, Payout>();
  for (const l of scan.logs as PayoutRawLog[]) {
    const bad = (why: string): PayoutFold => ({ complete: false, detail: `a WithdrawPending answer did not parse (${why})`, scannedTo: scan.scannedTo });
    // Reorged out: the node says this log is no longer on the chain.
    if (l.removed === true) continue;
    if (l.removed !== undefined && l.removed !== false) return bad("its `removed` flag is not a boolean");
    if (l.address !== undefined && (typeof l.address !== "string" || l.address.toLowerCase() !== proxy)) return bad("a log from another address");
    if (!Array.isArray(l.topics) || l.topics.length !== 2 || String(l.topics[0]).toLowerCase() !== topic0 || String(l.topics[1]).toLowerCase() !== topic1) {
      return bad("a log with other topics than the filter asked for");
    }
    if (typeof l.transactionHash !== "string" || !HASH_RE.test(l.transactionHash)) return bad("no transaction hash");
    const block = hexQuantity(l.blockNumber);
    const index = hexQuantity(l.logIndex);
    if (block === null || index === null || index > BigInt(Number.MAX_SAFE_INTEGER)) return bad("no block number or log index");
    if (block <= from || block > to) return bad(`a log at block ${block}, outside ${from + 1n}…${to}`);
    if (typeof l.data !== "string" || !/^0x[0-9a-fA-F]{128}$/.test(l.data)) return bad("a body that is not two words");
    let assetIndex: number;
    let baseAmount: bigint;
    try {
      // Decoded from the forms already checked (hex case is not meaning).
      const d = decodeEventLog({ abi: LIGHTER_EVENTS_ABI, eventName: "WithdrawPending", topics: [topic0, topic1], data: l.data.toLowerCase() as Hex, strict: true });
      assetIndex = Number(d.args.assetIndex);
      baseAmount = d.args.baseAmount;
    } catch {
      return bad("a body that does not decode as WithdrawPending");
    }
    // The words must fit their declared types. The decoder reads each whole
    // word, so a dirty high byte would come out as another asset (and be
    // dropped as "not USDG") or a vast amount — a body nobody emitted, which
    // is a bad answer, not a payout of something else.
    const [w0, w1] = [BigInt(`0x${l.data.slice(2, 66)}`), BigInt(`0x${l.data.slice(66, 130)}`)];
    if (w0 >> 16n !== 0n || w1 >> 128n !== 0n) return bad("a word wider than its type");
    if (assetIndex !== LIGHTER_ROUTE_V1.assetIndex) continue; // not USDG: not margin of ours
    if (baseAmount === 0n) continue; // moved nothing
    const p: Payout = {
      txHash: l.transactionHash.toLowerCase() as `0x${string}`,
      logIndex: Number(index),
      blockNumber: block,
      amountMicro: baseAmount * tick,
    };
    const k = payoutKey(p);
    const prior = seen.get(k);
    if (prior !== undefined && (prior.amountMicro !== p.amountMicro || prior.blockNumber !== p.blockNumber)) {
      return bad(`two different logs at one position (${k})`);
    }
    seen.set(k, p);
  }
  const payouts = [...seen.values()].sort(byChainOrder);
  return { complete: true, payouts, sumMicro: payouts.reduce((s, p) => s + p.amountMicro, 0n), scannedTo: scan.scannedTo };
}

function byChainOrder(a: Payout, b: Payout): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
}

// ── the ledger ──────────────────────────────────────────────────────────────

/**
 * The slice of the store recordPayouts writes through, bound to one agent's
 * LIVE rail (payouts exist only there). `payoutStoreFor` builds it from
 * store.ts; tests can hand it anything with the same meaning.
 */
export interface PayoutStore {
  /** Withdraw rows still owed — `submitted` or `executed` — OLDEST FIRST. */
  owedWithdrawals(): Promise<readonly PerpTransferRow[]>;
  /** store.ts upsertPerpTransfer on this agent's live rail: the row and its `margin` journal entry in one db.tx. */
  upsertTransfer(t: Omit<PerpTransferInput, "agentId" | "mode">): Promise<PerpTransferOutcome>;
}

/** payoutStoreFor(agentId, { listOpenPerpTransfers, upsertPerpTransfer }) from store.ts. */
export function payoutStoreFor(
  agentId: string,
  s: {
    listOpenPerpTransfers(agentId: string, mode: "live"): Promise<PerpTransferRow[]>;
    upsertPerpTransfer(t: PerpTransferInput): Promise<PerpTransferOutcome>;
  },
): PayoutStore {
  return {
    async owedWithdrawals() {
      return (await s.listOpenPerpTransfers(agentId, "live")).filter((r) => r.direction === "withdraw" && (r.state === "submitted" || r.state === "executed"));
    },
    upsertTransfer: (t) => s.upsertPerpTransfer({ ...t, agentId, mode: "live" }),
  };
}

/** Part of a payout that arrived but has not yet completed a request: recordPayouts' `carry`, handed back next time. */
export interface CarriedPayout {
  payout: Payout;
  /** What of it is not yet attributed (≤ payout.amountMicro). */
  remainingMicro: bigint;
}

export interface RecordPayoutsResult {
  /** Requested withdrawals now `paid`, oldest first, each with the payout that completed it. */
  paid: { transferId: string; amountMicro: bigint; by: string }[];
  /** Money paid to this account that no request of ours explains — booked initiator `owner`. */
  excess: { transferId: string; amountMicro: bigint; by: string }[];
  excessMicro: bigint;
  /** Excess was booked: an owner recover, or a stand-down whose request row was lost. Tell the owner. */
  alert: boolean;
  /** Payouts already booked by an earlier call (a re-read), skipped whole. */
  alreadyBooked: string[];
  /** Payouts whose booking the store refused for a reason other than a re-read — logged, never retried blind. */
  refused: { by: string; why: string }[];
  /** Arrived, not yet attributed: hand back as `carry` next call. */
  carry: CarriedPayout[];
  carryMicro: bigint;
}

interface Portion {
  payout: Payout;
  key: string;
  remaining: bigint;
  /** Handed back from a previous call's carry. */
  carried: boolean;
}

/** A claim write the store answered as "that payout identity is already a row's": the payout was booked before. */
const IDENTITY_TAKEN = /already another transfer's|different rows|its (amount|tx hash|log index|chain id|paid tx|paid log index) is/;

/**
 * BOOK THESE PAYOUTS against the withdrawals we requested (the
 * margin-in-transit amendment, 12a–12b).
 *
 * IN AGGREGATE, OLDEST FIRST. WithdrawPending names no withdrawal, and the
 * relayer pays a whole pending balance — several of our requests — in one
 * log. So payouts and owed rows are two running sums: row i is paid once the
 * payouts reach the requests up to and including it, and it is paid BY the
 * payout at which that happened (`paid_tx_hash`, the receipt `verify` checks
 * the row against). A payout that covers one row and part of the next leaves
 * the rest CARRIED, not guessed: returned in `carry`, to be handed back, and
 * subtracted in inTransit so it is not also counted as still on its way.
 *
 * EXCESS IS THE OWNER'S. Once every owed row is paid, whatever more arrived
 * no request of ours explains: the owner's recover withdrew it, or a
 * stand-down's request row was lost. It is booked as its own `withdraw` row,
 * initiator `owner`, state `paid`, identified by the payout's chain log —
 * still venue margin, never capital — and `alert` says to tell the owner.
 *
 * IDEMPOTENT ON THE PAYOUT'S CHAIN IDENTITY, which is UNIQUE in perp_transfers.
 * The FIRST write for each payout CLAIMS it: the payout's (4663, tx, log)
 * becomes the chain identity of its excess row, or — with no excess — of the
 * first row it completes. A re-read of the payout finds the claim taken
 * (upsertPerpTransfer answers `unchanged`, or refuses: the identity names
 * another row) and the payout is skipped WHOLE, so it is never counted twice
 * however often it is re-folded. The claim goes FIRST so that a crash between
 * writes can only leave rows still owed (the ratchets hold, the in-transit
 * alert fires) — never a re-read that pays a later request with money that
 * already paid an earlier one.
 *
 * Each row is its own db.tx with its `margin` journal entry
 * (upsertPerpTransfer). A write that fails THROWS: the caller's look holds,
 * and the next look re-reads.
 *
 * `carry` MUST BE REPLACED by each result's carry, never merged: a carried
 * portion is money already counted once.
 *
 * This allocator is the pure planning/writing seam. Production MUST call it
 * through store.recordPerpPayouts (payout-ledger.ts), which supplies durable
 * carry and commits the entire allocation with its transfer/journal writes.
 * Using the returned carry only in process memory would overstate transit
 * after a restart and is not a valid live integration.
 */
export async function recordPayouts(
  store: PayoutStore,
  payouts: readonly Payout[],
  opts: { carry?: readonly CarriedPayout[]; chainId?: number } = {},
): Promise<RecordPayoutsResult> {
  const chainId = opts.chainId ?? LIGHTER_ROUTE_V1.chainId;
  const out: RecordPayoutsResult = { paid: [], excess: [], excessMicro: 0n, alert: false, alreadyBooked: [], refused: [], carry: [], carryMicro: 0n };

  // The work list: what was carried, then the new payouts not already in it,
  // in chain order. A carried payout re-supplied by an overlapping fold is the
  // same money, counted once (as the carry).
  const portions: Portion[] = [];
  const keys = new Set<string>();
  for (const c of opts.carry ?? []) {
    validatePayout(c.payout);
    if (typeof c.remainingMicro !== "bigint" || c.remainingMicro <= 0n || c.remainingMicro > c.payout.amountMicro) {
      throw new RangeError(`recordPayouts: a carry of ${String(c.remainingMicro)} from ${payoutKey(c.payout)} is not part of that payout`);
    }
    const key = payoutKey(c.payout);
    if (keys.has(key)) throw new RangeError(`recordPayouts: ${key} is carried twice`);
    keys.add(key);
    portions.push({ payout: c.payout, key, remaining: c.remainingMicro, carried: true });
  }
  for (const p of payouts) {
    validatePayout(p);
    const key = payoutKey(p);
    if (keys.has(key)) continue;
    keys.add(key);
    portions.push({ payout: p, key, remaining: p.amountMicro, carried: false });
  }
  portions.sort((a, b) => byChainOrder(a.payout, b.payout));

  const owed = [...(await store.owedWithdrawals())];
  for (const r of owed) {
    if (r.direction !== "withdraw" || typeof r.amountMicro !== "bigint" || r.amountMicro <= 0n) {
      throw new RangeError(`recordPayouts: owed row ${r.id} is not a withdrawal owed money`);
    }
  }
  /** What the head row still lacks after earlier portions' part-payments. */
  let headLacks = owed[0]?.amountMicro ?? 0n;
  /** Those part-payments: money home toward the head row, attributed once the head row completes. */
  let partPaid: CarriedPayout[] = [];
  const carryOut = (list: readonly CarriedPayout[]) => {
    out.carry = [...list];
    out.carryMicro = list.reduce((sum, c) => sum + c.remainingMicro, 0n);
  };

  for (const [at, portion] of portions.entries()) {
    // PLAN this portion before writing anything: the rows it completes, and
    // what is left over — excess when no owed row remains, else a carry.
    const completes: PerpTransferRow[] = [];
    let left = portion.remaining;
    let lacks = headLacks;
    while (completes.length < owed.length && left >= lacks) {
      left -= lacks;
      completes.push(owed[completes.length]!);
      lacks = owed[completes.length]?.amountMicro ?? 0n;
    }
    const allPaid = completes.length === owed.length;
    const excess = allPaid ? left : 0n;
    const carry = allPaid ? 0n : left;

    const by = portion.key;
    const identity = { chainId, txHash: portion.payout.txHash, logIndex: portion.payout.logIndex } as const;
    const paidBy = { paidTxHash: portion.payout.txHash, paidLogIndex: portion.payout.logIndex } as const;
    const payRow = (row: PerpTransferRow, withIdentity: boolean) =>
      store.upsertTransfer({
        id: row.id,
        direction: "withdraw",
        amountMicro: row.amountMicro,
        initiator: row.initiator,
        state: "paid",
        ...(withIdentity ? identity : {}),
        ...paidBy,
      });
    const bookExcess = (withIdentity: boolean) =>
      store.upsertTransfer({ direction: "withdraw", amountMicro: excess, initiator: "owner", state: "paid", ...(withIdentity ? identity : {}), ...paidBy });

    // THE CLAIM: the first write carries the payout's chain identity.
    let rowsFrom = 0;
    if (excess > 0n || completes.length > 0) {
      const claimExcess = excess > 0n;
      const first = claimExcess ? await bookExcess(true) : await payRow(completes[0]!, true);
      const taken = first.outcome === "unchanged" || (first.outcome === "refused" && IDENTITY_TAKEN.test(first.why));
      if (first.outcome === "inserted" || first.outcome === "advanced") {
        if (claimExcess) {
          out.excess.push({ transferId: first.id, amountMicro: excess, by });
          out.excessMicro += excess;
          out.alert = true;
        } else {
          out.paid.push({ transferId: first.id, amountMicro: completes[0]!.amountMicro, by });
          rowsFrom = 1;
        }
      } else if (taken && !portion.carried) {
        // A re-read: this payout was booked by an earlier call. Skip it whole —
        // including its place in the running sums, which that call already took.
        out.alreadyBooked.push(by);
        continue;
      } else if (taken && portion.carried) {
        // A carried remainder whose payout claimed a row in an earlier call:
        // the identity is spent, and rightly — write this share without it.
        const again = claimExcess ? await bookExcess(false) : await payRow(completes[0]!, false);
        if (again.outcome === "inserted" || again.outcome === "advanced") {
          if (claimExcess) {
            out.excess.push({ transferId: again.id, amountMicro: excess, by });
            out.excessMicro += excess;
            out.alert = true;
          } else {
            out.paid.push({ transferId: again.id, amountMicro: completes[0]!.amountMicro, by });
            rowsFrom = 1;
          }
        } else if (again.outcome === "refused") {
          out.refused.push({ by, why: again.why });
          if (claimExcess) out.alert = true;
          else rowsFrom = 1;
        } else if (!claimExcess) {
          rowsFrom = 1;
        }
      } else {
        // A refusal that is not a re-read: the row contradicts what the store
        // holds. STOP HERE. Attributing the payouts after this one to the rows
        // this one should have paid would misbook every one of them; instead
        // this portion and every later one go back whole as carry — money
        // that is home (so not in transit) and not yet booked — and the next
        // call tries again. Reported, and alerted: someone has to look.
        out.refused.push({ by, why: first.outcome === "refused" ? first.why : "unexpected answer" });
        out.alert = true;
        carryOut([...partPaid, ...portions.slice(at).map((rest) => ({ payout: rest.payout, remainingMicro: rest.remaining }))]);
        return out;
      }
    }

    // The other rows this portion completes: paid BY it, no identity (the
    // claim holds that). With excess, the claim was the excess row and every
    // completed row is written here.
    for (const row of completes.slice(rowsFrom)) {
      const r = await payRow(row, false);
      if (r.outcome === "advanced" || r.outcome === "inserted") out.paid.push({ transferId: row.id, amountMicro: row.amountMicro, by });
      else if (r.outcome === "refused") out.refused.push({ by, why: `row ${row.id}: ${r.why}` });
      // `unchanged`: already paid — a concurrent writer got there first.
    }

    // Move the running sums on: completed rows leave (and with the head, the
    // part-payments toward it are attributed); the new head lacks what this
    // portion's remainder did not cover, and that remainder is carried.
    owed.splice(0, completes.length);
    if (completes.length > 0) partPaid = [];
    headLacks = owed.length > 0 ? lacks - carry : 0n;
    if (carry > 0n) partPaid.push({ payout: portion.payout, remainingMicro: carry });
  }
  carryOut(partPaid);
  return out;
}

function validatePayout(p: Payout): void {
  if (
    p === null ||
    typeof p !== "object" ||
    typeof p.txHash !== "string" ||
    !HASH_RE.test(p.txHash) ||
    !Number.isSafeInteger(p.logIndex) ||
    p.logIndex < 0 ||
    typeof p.blockNumber !== "bigint" ||
    p.blockNumber < 0n ||
    typeof p.amountMicro !== "bigint" ||
    p.amountMicro <= 0n
  ) {
    throw new RangeError("recordPayouts: a payout is not a (tx, log, block, positive amount)");
  }
}

// ── in transit (rule 12b) ───────────────────────────────────────────────────

export interface InTransit {
  /** Σ our deposits that LANDED on chain and the venue has not credited. */
  tInMicro: bigint;
  /** Σ our withdrawals the venue EXECUTED that have not come home, less what already arrived toward them (carry). */
  tOutMicro: bigint;
  /**
   * A book gap (rule 11): the pending balance is unread, or larger than every
   * withdrawal we know is on its way — a withdrawal the ledger never recorded.
   * No equity row, no ratchet, no fee, opens refused. Never guessed around.
   */
  gap: boolean;
  why: "pending-unread" | "pending-exceeds-transit" | null;
}

/**
 * T_in and T_out at block N, and whether the chain's pending balance at the
 * same N agrees with them.
 *
 *   T_in  = Σ deposit rows `landed` (our UserOp carried the proxy's Deposit)
 *           and not yet `credited`.
 *   T_out = Σ withdraw rows `executed` (the venue ran our L2 Withdraw) and not
 *           yet `paid` — less `carriedPayoutMicro`, the part of them already
 *           home in cash (recordPayouts' carry), so no micro is counted both
 *           at home and in transit. Never below 0.
 *   gap   = getPendingBalance(self, 3)@N > T_out. Everything pending on the
 *           contract is a withdrawal that executed, so it must be one of
 *           ours in transit; more than that is one we never recorded (an
 *           owner's recover with no row). The comparison errs toward a gap:
 *           a withdrawal that executed while its row still reads `submitted`
 *           is a gap until the resolver moves the row — unknown is not zero.
 *
 * `openTransfers` is listOpenPerpTransfers(agent, 'live'), read AFTER
 * recordPayouts so a payout that just paid a row has taken it out.
 */
export function inTransit(a: {
  openTransfers: readonly Pick<PerpTransferRow, "direction" | "state" | "amountMicro">[];
  pendingBalanceMicro: bigint | null;
  carriedPayoutMicro?: bigint;
}): InTransit {
  let tIn = 0n;
  let executed = 0n;
  for (const t of a.openTransfers) {
    if (typeof t.amountMicro !== "bigint" || t.amountMicro <= 0n) throw new RangeError(`inTransit: a transfer of ${String(t.amountMicro)} is not money`);
    if (t.direction === "deposit" && t.state === "landed") tIn += t.amountMicro;
    else if (t.direction === "withdraw" && t.state === "executed") executed += t.amountMicro;
  }
  const carried = a.carriedPayoutMicro ?? 0n;
  if (typeof carried !== "bigint" || carried < 0n) throw new RangeError(`inTransit: a carry of ${String(carried)} is not money`);
  const tOut = executed > carried ? executed - carried : 0n;
  const p = a.pendingBalanceMicro;
  if (p === null || typeof p !== "bigint" || p < 0n) return { tInMicro: tIn, tOutMicro: tOut, gap: true, why: "pending-unread" };
  if (p > tOut) return { tInMicro: tIn, tOutMicro: tOut, gap: true, why: "pending-exceeds-transit" };
  return { tInMicro: tIn, tOutMicro: tOut, gap: false, why: null };
}
