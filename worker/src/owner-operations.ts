/**
 * OWNER OPERATIONS ARE NOT AGENT TRADES.
 *
 * THE HOLE. The in-flight reconciler (index.ts reconcileInFlightAtArm) asks
 * the chain at arm what the account executed and writes a 'landed' trades row
 * for every successful operation the ledger has no row for: kind 'swap',
 * notional the |USDG| the receipt moved. It never asked WHO signed. So an
 * owner's own root-key operation found inside its lookback — a recoverFunds
 * withdrawal from the web panel, the CLI or the mobile app, an invalidateNonce
 * revocation, a custody vault's sweep(USDG) — became an agent trade:
 *
 *  - counted toward the ops and spend caps (store.ts getOpsToday,
 *    getSpentTodayUsdg) and the shared trailing day (budget-seed.ts);
 *  - shown on the scoreboard, the profile and feed tapes and chat-trades, and
 *    journaled as a fill;
 *  - and, because the deposit scanner skips any USDG log in a transaction the
 *    ledger already holds as a trade (deposit-log.ts tradeTxHashes), an owner's
 *    withdrawal so recorded was never booked as the capital-out flow it is, and
 *    the peak never came down with it.
 *
 * WHAT THIS FILE DOES: READ ONE OPERATION, NOTHING ELSE. Pure: it takes a
 * receipt's logs and says whether this account's operation in it was signed by
 * the ROOT validator (the owner's sudo key: asset-movements.ts
 * validatorOfNonce, from the nonce the EntryPoint's own event carries, which no
 * contract can forge) and, if so, what it moved and what that means for the
 * book. It writes nothing. The reconciler records what it returns in
 * owner_operations instead of trades (store.ts recordOwnerOperation), and
 * admission re-derives it from the receipt before it lets the record answer
 * the operation (ledger-resume.ts chainGapCheck).
 *
 * ONLY A PROVED ROOT LEAVES THE TRADES PATH. A permission (session-key) op, a
 * secondary validator, root in enable mode, an unknown mode or an event that
 * does not decode is null here, and the reconciler keeps today's conservative
 * 'swap' over-count for it.
 *
 * THE DISPOSITION. 'acknowledged' only when the operation leaves nothing for
 * anybody to decide:
 *
 *   (a) every USDG leg of the account is capital-in or capital-out by the
 *       scanner's own classifier and inputs (deposit-log.ts
 *       scannerClassifyContext) — left for the scanner's flow, the ONE live
 *       booker of a capital leg — or internal by the custody-transfer rule,
 *       or moves nothing (a self-transfer, or an amount of zero); the record
 *       answers those last two itself and lists them in `covers`, because no
 *       flow writer books either and admission reads every USDG log of the
 *       account (ledger-resume.ts chainFactsPostgresLacks), so a log left
 *       unanswered would hold an 'acknowledged' operation forever;
 *   (b) no USDG moves between a custody address and an address outside the
 *       book;
 *   (c) no USDG log of the account in the same transaction sits outside this
 *       operation's execution;
 *   (d) no other token moves at any book address, in either direction;
 *   (e) the operation's execution was read (a BeforeExecution precedes it).
 *
 * Anything else is 'review', with its reasons. A token that ARRIVED would sit
 * in the book with no fill behind it, and a token that LEFT is an in-kind
 * withdrawal no flow records (asset-movements.ts: review only) after which a
 * stale position or live basis could be seeded at an admission
 * (ledger-resume.ts planAttestedSeed). Neither is decided here. ETH is fuel and
 * ignored.
 */
import { classifyUsdgMovement, ENTRYPOINT, type CapitalKind } from "../../packages/core/src/index";
import { BEFORE_EXECUTION_TOPIC, segmentReceipt, USER_OPERATION_EVENT_TOPIC, validatorOfNonce } from "./asset-movements";
import type { RawChainLog } from "./chain-capital";
import { legsFromReceiptLogs, scannerClassifyContext, TRANSFER_TOPIC } from "./deposit-log";

export type OwnerReviewReason =
  | "token-arrived"
  | "token-departed"
  | "usdg-not-capital"
  | "usdg-through-custody"
  | "usdg-outside-segment"
  | "segment-unread";

/** The fixed order reasons are listed in, so two readings of one receipt say the same thing. */
const REASON_ORDER: readonly OwnerReviewReason[] = [
  "segment-unread",
  "usdg-outside-segment",
  "usdg-through-custody",
  "usdg-not-capital",
  "token-arrived",
  "token-departed",
];

/** One USDG Transfer at a book address inside the operation's execution. */
export interface OwnerUsdgLeg {
  logIndex: number;
  from: string;
  to: string;
  /** Base units (6dp), decimal string. */
  amountRaw: string;
  /**
   * The scanner's verdict for a leg of the account; 'custody-only' for a leg
   * that never touches it; 'no-movement' for a leg of the account that moves
   * nothing (rule 'self-transfer' or 'zero-amount'), which the classifier
   * never sees.
   */
  kind: CapitalKind | "custody-only" | "no-movement";
  rule: string;
  /**
   * Who answers this leg in admission's check: a 'flow' the scanner books
   * (capital), 'this-record' (custody-internal, or no movement; listed in
   * `covers`), or 'none' — a leg of the account nothing answers (the reason
   * is in the disposition), or a custody leg admission never reads.
   */
  answeredBy: "flow" | "this-record" | "none";
}

/** One non-USDG Transfer at a book address inside the operation's execution. */
export interface OwnerTokenMove {
  token: string;
  logIndex: number;
  from: string;
  to: string;
  amountRaw: string;
  /** Into the book, out of it, or between two of its addresses (an arrival at one and a departure from the other). */
  direction: "arrived" | "departed" | "internal";
}

export interface OwnerOperationReading {
  userOpHash: string;
  txHash: string;
  /** The UserOperationEvent's own log index. */
  logIndex: number;
  /** The 256-bit nonce, 0x-hex: the root proof, re-checkable by anyone. */
  nonce: string;
  validator: "root";
  paymaster: string;
  /** actualGasCost and actualGasUsed, from the event's own data. */
  gasWei: string;
  gasUnits: string;
  disposition: "acknowledged" | "review";
  reasons: OwnerReviewReason[];
  usdgLegs: OwnerUsdgLeg[];
  /** `${tx}:${logIndex}` of every USDG leg of the account this record answers: custody-internal, or moving nothing. */
  covers: string[];
  tokenMoves: OwnerTokenMove[];
}

/** A receipt log as either source hands it: hex strings off the RPC, or viem's numbers and bigints. */
export interface OwnerReceiptLog {
  address: string;
  topics: readonly string[];
  data: string;
  logIndex?: number | string | bigint | null;
  blockNumber?: number | string | bigint | null;
  transactionHash?: string | null;
}

const EP_V07 = String(ENTRYPOINT.v07).toLowerCase();
const HASH = /^0x[0-9a-f]{64}$/;
const lower = (s: unknown) => String(s ?? "").toLowerCase();
const addressOfTopic = (t: string) => `0x${lower(t).slice(-40)}`;

/** A log position as an integer, or null when the log did not carry a usable one. */
function indexOf(v: OwnerReceiptLog["logIndex"]): number | null {
  if (v === null || v === undefined || v === "") return null;
  try {
    const n = typeof v === "number" ? v : Number(BigInt(v as string | bigint));
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * The receipt's logs in the chain-capital shape segmentReceipt reads, or null
 * when any log has no position: an operation's execution cannot be told from
 * its neighbours' without one, and a guess here is a guess about money.
 */
function normalise(logs: readonly OwnerReceiptLog[], txHash: string): RawChainLog[] | null {
  const out: RawChainLog[] = [];
  for (const l of logs) {
    const i = indexOf(l.logIndex);
    if (i === null || !Array.isArray(l.topics)) return null;
    out.push({
      address: lower(l.address),
      topics: l.topics.map(lower),
      data: String(l.data ?? "0x"),
      blockNumber: "0x0",
      transactionHash: txHash,
      logIndex: `0x${i.toString(16)}`,
    });
  }
  return out;
}

/** A Transfer log (exactly three topics: ERC-721 shares the first word and has four), decoded; null otherwise. */
function transferOf(l: RawChainLog): { token: string; from: string; to: string; amount: bigint; logIndex: number } | null {
  if (lower(l.topics?.[0]) !== TRANSFER_TOPIC || l.topics.length !== 3) return null;
  let amount: bigint;
  try {
    amount = BigInt(l.data && l.data !== "0x" ? l.data : "0x0");
  } catch {
    return null;
  }
  return { token: lower(l.address), from: addressOfTopic(l.topics[1]!), to: addressOfTopic(l.topics[2]!), amount, logIndex: Number(BigInt(l.logIndex)) };
}

/**
 * READ ONE OPERATION OF `account` IN ONE RECEIPT, AS AN OWNER OPERATION — or
 * null when it is not one this file vouches for: not in the receipt as the
 * account's own operation through EntryPoint v0.7, not succeeded, or not
 * signed by the root validator. PURE.
 *
 * `custody` is the account's custody contracts (custody.ts custodyAddressesOf
 * of the grant) and `chainId` its chain: with the account they are the book,
 * and they are the scanner's classify inputs (scannerClassifyContext).
 */
export function ownerOperationOf(o: {
  receiptLogs: readonly OwnerReceiptLog[];
  userOpHash: string;
  txHash: string;
  account: string;
  custody: readonly string[];
  usdg: string;
  chainId: number;
}): OwnerOperationReading | null {
  const txHash = lower(o.txHash);
  const userOpHash = lower(o.userOpHash);
  if (!HASH.test(txHash) || !HASH.test(userOpHash)) return null;
  const logs = normalise(o.receiptLogs, txHash);
  if (!logs) return null;
  const account = lower(o.account);
  const usdg = lower(o.usdg);
  const custody = new Set(o.custody.map(lower).filter((a) => a !== account));
  const inBook = (a: string) => a === account || custody.has(a);

  const { segments } = segmentReceipt(logs);
  const seg = segments.find((s) => s.op.userOpHash === userOpHash && s.op.sender === account && s.op.entryPoint === EP_V07);
  if (!seg || !seg.op.success || validatorOfNonce(seg.op.nonce) !== "root") return null;
  const event = logs.find((l) => Number(BigInt(l.logIndex)) === seg.op.logIndex);
  const data = lower(event?.data).replace(/^0x/, "");
  if (data.length !== 256) return null;

  const reasons = new Set<OwnerReviewReason>();
  // (e) WAS THE EXECUTION READ? segmentReceipt gives an op with no
  // BeforeExecution ahead of it an empty segment, which is not the same as an
  // execution that moved nothing.
  const read = logs.some((l) => l.address === EP_V07 && lower(l.topics[0]) === BEFORE_EXECUTION_TOPIC && Number(BigInt(l.logIndex)) < seg.op.logIndex);
  if (!read) reasons.add("segment-unread");

  // The scanner's view of the transaction: every Transfer in the receipt, and
  // its own per-account inputs. A leg left to "the scanner's flow" must be one
  // the scanner books.
  const txLegs = legsFromReceiptLogs(logs);
  const context = scannerClassifyContext({ custodyAddresses: [...custody], chainId: o.chainId });
  const usdgLegs: OwnerUsdgLeg[] = [];
  const covers: string[] = [];
  const tokenMoves: OwnerTokenMove[] = [];
  const inSegment = new Set<number>();
  for (const l of seg.logs) {
    inSegment.add(Number(BigInt(l.logIndex)));
    const t = transferOf(l);
    if (!t) continue;
    // (a) A USDG LOG OF THE ACCOUNT THAT MOVES NOTHING: from the account to
    // itself, or an amount of zero. It changes no balance, the classifier
    // calls a self-transfer ambiguous and no flow writer books either — yet
    // admission reads it as a USDG transfer of the account like any other.
    // So the record answers it (`covers`); left out, an 'acknowledged'
    // reading would sit beside a log admission names missing for good.
    if (t.token === usdg && (t.from === account || t.to === account) && (t.amount === 0n || t.from === t.to)) {
      usdgLegs.push({ logIndex: t.logIndex, from: t.from, to: t.to, amountRaw: t.amount.toString(), kind: "no-movement",
        rule: t.from === t.to ? "self-transfer" : "zero-amount", answeredBy: "this-record" });
      covers.push(`${txHash}:${t.logIndex}`);
      continue;
    }
    if (t.amount === 0n || t.from === t.to) continue;
    if (!inBook(t.from) && !inBook(t.to)) continue;
    if (t.token === usdg) {
      if (t.from === account || t.to === account) {
        const v = classifyUsdgMovement({
          account,
          usdg: { token: usdg, from: t.from, to: t.to, amountRaw: t.amount.toString() },
          txLegs,
          usdgToken: usdg,
          custodyAddresses: context.custodyAddresses,
          reserveTokens: context.reserveTokens,
        });
        let answeredBy: OwnerUsdgLeg["answeredBy"] = "none";
        if (v.kind === "capital-in" || v.kind === "capital-out") answeredBy = "flow";
        else if (v.kind === "internal" && v.evidence.rule === "custody-transfer") {
          answeredBy = "this-record";
          covers.push(`${txHash}:${t.logIndex}`);
        } else reasons.add("usdg-not-capital");
        usdgLegs.push({ logIndex: t.logIndex, from: t.from, to: t.to, amountRaw: t.amount.toString(), kind: v.kind, rule: v.evidence.rule, answeredBy });
      } else {
        // (b) A custody contract's own USDG: between two book addresses it
        // never crosses the edge; to or from anywhere else it is capital
        // moving through a vault, which no reader here can answer.
        const outside = !inBook(t.from) || !inBook(t.to);
        if (outside) reasons.add("usdg-through-custody");
        usdgLegs.push({ logIndex: t.logIndex, from: t.from, to: t.to, amountRaw: t.amount.toString(), kind: "custody-only",
          rule: outside ? "custody-to-outside" : "custody-internal", answeredBy: "none" });
      }
      continue;
    }
    // (d) ANY OTHER TOKEN AT A BOOK ADDRESS.
    const direction: OwnerTokenMove["direction"] = inBook(t.from) && inBook(t.to) ? "internal" : inBook(t.to) ? "arrived" : "departed";
    if (direction !== "departed") reasons.add("token-arrived");
    if (direction !== "arrived") reasons.add("token-departed");
    tokenMoves.push({ token: t.token, logIndex: t.logIndex, from: t.from, to: t.to, amountRaw: t.amount.toString(), direction });
  }
  // (c) A USDG LOG OF THE ACCOUNT ELSEWHERE IN THE TRANSACTION: another op's,
  // or validation's. Not this record's to answer, and not to be left beside it.
  for (const l of logs) {
    const t = transferOf(l);
    if (!t || t.token !== usdg || (t.from !== account && t.to !== account) || inSegment.has(t.logIndex)) continue;
    reasons.add("usdg-outside-segment");
  }

  const listed = REASON_ORDER.filter((r) => reasons.has(r));
  return {
    userOpHash,
    txHash,
    logIndex: seg.op.logIndex,
    nonce: `0x${seg.op.nonce.toString(16)}`,
    validator: "root",
    paymaster: seg.op.paymaster,
    gasWei: BigInt(`0x${data.slice(128, 192)}`).toString(),
    gasUnits: BigInt(`0x${data.slice(192, 256)}`).toString(),
    disposition: listed.length === 0 ? "acknowledged" : "review",
    reasons: listed,
    usdgLegs: usdgLegs.sort((a, b) => a.logIndex - b.logIndex),
    covers: covers.sort(),
    tokenMoves: tokenMoves.sort((a, b) => a.logIndex - b.logIndex),
  };
}

/**
 * IS THIS UserOperationEvent LOG, BY ITS OWN DATA, A SUCCESSFUL ROOT OPERATION
 * OF `account`? The pure half of admission's proof: the nonce (word 0) names
 * the root validator, the success word (word 1) is 1, and the indexed sender
 * (topic 2) is the account. Nothing from a database row enters it.
 */
export function isRootSuccessOf(log: { topics: readonly string[]; data: string }, account: string): boolean {
  const data = lower(log.data).replace(/^0x/, "");
  if (!/^[0-9a-f]{256}$/.test(data) || log.topics.length !== 4 || lower(log.topics[0]) !== USER_OPERATION_EVENT_TOPIC) return false;
  if (addressOfTopic(String(log.topics[2])) !== lower(account)) return false;
  if (BigInt(`0x${data.slice(64, 128)}`) !== 1n) return false;
  return validatorOfNonce(BigInt(`0x${data.slice(0, 64)}`)) === "root";
}

// ── the durable record ───────────────────────────────────────────────────────

/** One owner_operations row, as the child writes it and the mirror carries it (store.ts SQLITE_SCHEMA). */
export interface OwnerOperationRow {
  agent_id: string;
  chain_id: number;
  user_op_hash: string;
  tx_hash: string;
  block_number: number;
  block_time: number;
  log_index: number;
  nonce: string;
  validator: "root";
  disposition: "acknowledged" | "review";
  review_reason: string | null;
  usdg_legs_json: string;
  covers_logs_json: string;
  token_moves_json: string;
  paymaster: string;
  gas_wei: string | null;
  source: "arm-reconcile";
  recorded_epoch: number;
}

/** The columns every writer and the mirror name, in one order. `id`, `tenant` and `created_at` are not among them. */
export const OWNER_OPERATION_COLUMNS = [
  "agent_id", "chain_id", "user_op_hash", "tx_hash", "block_number", "block_time", "log_index", "nonce", "validator", "disposition",
  "review_reason", "usdg_legs_json", "covers_logs_json", "token_moves_json", "paymaster", "gas_wei", "source", "recorded_epoch",
] as const satisfies readonly (keyof OwnerOperationRow)[];

/** Sorted keys, bigints as decimal strings: the JSON columns are evidence a reviewer compares byte for byte. */
function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(norm(value));
}

/** The row a reading is recorded as. `recordedEpoch` is the epoch when it was RECORDED, not when it landed: block_time says that. */
export function ownerOperationRow(r: OwnerOperationReading, o: {
  agentId: string; chainId: number; blockNumber: bigint | number; blockTime: number; recordedEpoch: number;
}): OwnerOperationRow {
  return {
    agent_id: o.agentId,
    chain_id: o.chainId,
    user_op_hash: r.userOpHash,
    tx_hash: r.txHash,
    block_number: Number(o.blockNumber),
    block_time: Math.floor(o.blockTime),
    log_index: r.logIndex,
    nonce: r.nonce,
    validator: "root",
    disposition: r.disposition,
    review_reason: r.disposition === "review" ? r.reasons.join(",") : null,
    usdg_legs_json: canonicalJson(r.usdgLegs),
    covers_logs_json: canonicalJson(r.covers),
    token_moves_json: canonicalJson(r.tokenMoves),
    paymaster: r.paymaster,
    gas_wei: r.gasWei,
    source: "arm-reconcile",
    recorded_epoch: o.recordedEpoch,
  };
}

// ── what the owner is told ───────────────────────────────────────────────────

const usdg6 = (raw: string) => {
  const v = BigInt(raw);
  return `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, "0")}`;
};

/**
 * One event for everything an arm recorded. 'ok' when every operation was
 * acknowledged; 'warn' when any needs review, naming each token that arrived
 * or left. `symbolOf` names a token the worker knows, or null.
 *
 * WHAT IT MAY CLAIM ABOUT A BASIS. A token the owner's key brought in gets no
 * basis from this record — but the live tick's receipt recovery
 * (receipt-basis-recovery.ts) replays a token's own Transfer history whoever
 * signed it, so a purchase paid in USDG in the same receipt can still get its
 * cost from that receipt. Only a token that arrived with no USDG paid has no
 * cost on record. The text says exactly that, never "no rule can exit it".
 */
export function ownerOperationsNotice(readings: readonly OwnerOperationReading[], symbolOf: (token: string) => string | null = () => null): {
  level: "ok" | "warn"; text: string;
} | null {
  if (readings.length === 0) return null;
  const name = (t: string) => symbolOf(t) ?? `${t.slice(0, 10)}…`;
  const review = readings.filter((r) => r.disposition === "review");
  const capital = readings.flatMap((r) => r.usdgLegs.filter((l) => l.answeredBy === "flow"));
  const head = `recorded ${readings.length} operation(s) your own key signed (the owner's root key) — not agent trades: they count toward no trading ` +
    "limit and do not appear as trades" +
    (capital.length ? `; the USDG they moved in or out of the account (${capital.map((l) => usdg6(l.amountRaw)).join(", ")} USDG) is your capital, not performance` : "");
  if (!review.length) return { level: "ok", text: head };
  const arrived = [...new Set(review.flatMap((r) => r.tokenMoves.filter((m) => m.direction !== "departed").map((m) => m.token)))];
  const departed = [...new Set(review.flatMap((r) => r.tokenMoves.filter((m) => m.direction !== "arrived").map((m) => m.token)))];
  const parts: string[] = [];
  if (arrived.length) {
    parts.push(`your own key brought ${arrived.map(name).join(", ")} into the account. If you paid USDG for it in that transaction, I will recover its cost ` +
      "from the receipt; a token that arrived without a USDG payment has no cost on record, so stop-loss and take-profit cannot act on it");
  }
  if (departed.length) parts.push(`${departed.map(name).join(", ")} left the account under your own key: a withdrawal in kind, not a loss`);
  const other = review.some((r) => r.reasons.some((x) => x !== "token-arrived" && x !== "token-departed"));
  if (other) parts.push("one of them moved USDG in a way I cannot read as a plain deposit or withdrawal, and it is kept for review");
  return { level: "warn", text: `${head}. ${parts.join(". ")}` };
}
