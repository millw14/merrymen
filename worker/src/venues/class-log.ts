/**
 * WHAT A CLASS VAULT HAS DONE, READ FROM THE CHAIN.
 *
 * The class route kept its book in `class_positions`, a table in the CHILD's
 * sqlite — which the orchestrator rebuilds on every redeploy (it strips
 * DATABASE_URL, so the child opens a local file that does not survive). So an
 * open position's entire record could vanish while the tokens sat in the vault,
 * and the worker would read the empty table as "nothing held". A missing row
 * would have meant flat.
 *
 * That is the wrong shape of truth for money. This module makes the chain the
 * source of truth, because it is the only participant that cannot be redeployed:
 *
 *   THE BALANCE      `balanceOf(vault)` says what is there NOW.
 *   THE EVENTS       `ClassBuy` / `ClassSell` / `Swept` say how it got there,
 *                    what it actually cost, and when.
 *
 * A local table can then be a CACHE — useful, rebuildable, and never the thing
 * a decision rests on.
 *
 * ── WHY THE EVENTS AND NOT THE LOCAL RECORD, FOR COST ───────────────────────
 *
 * `ClassBuy` carries `quoteIn` and `tokensOut` as the CONTRACT measured them:
 * `tokensOut` is a balance delta on the vault, not a number the curve reported
 * (PonsClassVault.sol measures rather than trusts). So the basis reconstructed
 * here is the actual fill, which is the figure the scout budget is supposed to
 * accrue and the only one a realised P&L can be computed against. The proposed
 * size — `classPerEntryUsdg` — is a request, and a request is not a cost.
 *
 * ── AND WHY IDENTITY IS THE LOG, NOT THE OPERATION ──────────────────────────
 *
 * Every accrual keyed off `(txHash, logIndex)`. That pair is unique on chain and
 * stable across restarts, so replaying the same range — which reconciliation
 * does by design — cannot double-count. A UserOp hash would not do: one op can
 * carry several calls, and a batch that deploys, approves and buys emits one
 * ClassBuy but shares its op hash with the legs around it.
 */
import type { PublicClient } from "viem";
import { toEventSelector } from "viem";

/**
 * ── TWO VAULT VERSIONS EMIT THESE, AND THEY DO NOT AGREE ────────────────────
 *
 * PonsClassVaultV2 added the quote asset as a third INDEXED argument, so its
 * ClassBuy and ClassSell hash to different topics than v1's. A reader that knew
 * only v1's would not error on a v2 trade — `decodeClassLog` would return null
 * and `parseClassLogs` would skip it — so the tape would come back COMPLETE AND
 * EMPTY. A bought position would present with no entry at all.
 *
 * `Swept` is byte-identical in both, which is what makes the failure worse
 * rather than better: the sweeps would still decode, so a real position would
 * appear as an exit from nothing.
 *
 * DERIVED, NOT PASTED. Every constant below is `toEventSelector` of the
 * signature in its own docstring — the idiom v4-keys.ts:40 already uses — so a
 * signature that drifts from the .sol is a diff in the string beside the hash
 * rather than a hash nobody can check by eye.
 */
const CLASS_BUY_SIG_V1 = "ClassBuy(address,address,uint256,uint256)" as const;
const CLASS_SELL_SIG_V1 = "ClassSell(address,address,uint256,uint256)" as const;
const CLASS_BUY_SIG_V2 = "ClassBuy(address,address,address,uint256,uint256)" as const;
const CLASS_SELL_SIG_V2 = "ClassSell(address,address,address,uint256,uint256)" as const;
const CLASS_SWEPT_SIG = "Swept(address,uint256)" as const;

/** v1: `ClassBuy(address indexed curve, address indexed token, uint256 quoteIn, uint256 tokensOut)` */
export const CLASS_BUY_TOPIC = toEventSelector(CLASS_BUY_SIG_V1);
/** v1: `ClassSell(address indexed curve, address indexed token, uint256 tokensIn, uint256 quoteOut)` */
export const CLASS_SELL_TOPIC = toEventSelector(CLASS_SELL_SIG_V1);
/** v2: the same, plus `address indexed quoteAsset` in third position. */
export const CLASS_BUY_TOPIC_V2 = toEventSelector(CLASS_BUY_SIG_V2);
/** v2: the same, plus `address indexed quoteAsset` in third position. */
export const CLASS_SELL_TOPIC_V2 = toEventSelector(CLASS_SELL_SIG_V2);
/** `Swept(address indexed token, uint256 amount)` — the owner's own exit. Same in both. */
export const CLASS_SWEPT_TOPIC = toEventSelector(CLASS_SWEPT_SIG);

/** One thing the vault did, in the order the chain put it. */
export interface ClassEvent {
  kind: "buy" | "sell" | "swept";
  token: `0x${string}`;
  /** Absent for `swept`, which names no curve. */
  curve: `0x${string}` | null;
  /** buy: USDG in. sell: USDG out. swept: zero — a sweep moves no quote. */
  quoteRaw: bigint;
  /** buy: tokens received. sell: tokens sold. swept: tokens moved out. */
  tokenRaw: bigint;
  /**
   * WHAT `quoteRaw` IS DENOMINATED IN, when the chain said so.
   *
   * `null` for every v1 event and for every sweep, because those logs do not
   * carry it — and null here means UNKNOWN, never USDG. The distinction is the
   * whole reason v2 puts the asset on the event: every figure downstream treats
   * `quoteRaw` as micro-USDG, so a second denomination folded in silently would
   * book an 18-decimal entry at roughly a trillion times its cost. An amount
   * whose unit is unknown can be refused; an amount assumed to be dollars cannot.
   */
  quoteAsset: `0x${string}` | null;
  blockNumber: bigint;
  txHash: `0x${string}`;
  logIndex: number;
}

/** An indexed address topic carries the address in its low 20 bytes. */
function addressFromTopic(topic: string): `0x${string}` {
  return `0x${topic.slice(-40)}`.toLowerCase() as `0x${string}`;
}

function word(data: string, i: number): bigint {
  return BigInt(`0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
}

/** What a class log says happened, before anything positional is attached. */
export type ClassEventBody = Pick<
  ClassEvent,
  "kind" | "curve" | "token" | "quoteRaw" | "tokenRaw" | "quoteAsset"
>;

/**
 * Decode ONE class log. The only place these fields are read off the wire.
 *
 * Split out of `parseClassLogs` so an EXECUTION RECEIPT can be decoded by the
 * same code that decodes a historical scan. A receipt's logs carry no block
 * number or log index — the transaction has not been indexed yet, it is the
 * thing that just happened — and the scan path needs both. Without this split
 * the executor either grows a second decoder, which is free to drift from this
 * one, or invents positional values to satisfy a signature that does not use
 * them. Both are worse than a function that returns exactly what a log says.
 *
 * The buy/sell word order is the trap this centralises: `ClassBuy` is
 * (quoteIn, tokensOut) and `ClassSell` is (tokensIn, quoteOut). Reversed, a
 * memecoin count reads as USDG.
 */
export function decodeClassLog(log: { topics: readonly string[]; data: string }): ClassEventBody | null {
  const t0 = log.topics[0]?.toLowerCase();
  if (typeof log.data !== "string") return null;

  // BOTH the dispatch and the buy/sell test widen together. They are the same
  // comparison, and widening only the first would decode every v2 sell as a buy
  // — with the words transposed, so a token count would read as USDG.
  const isBuy = t0 === CLASS_BUY_TOPIC || t0 === CLASS_BUY_TOPIC_V2;
  const isSell = t0 === CLASS_SELL_TOPIC || t0 === CLASS_SELL_TOPIC_V2;
  if (isBuy || isSell) {
    const isV2 = t0 === CLASS_BUY_TOPIC_V2 || t0 === CLASS_SELL_TOPIC_V2;
    // v2 adds a THIRD indexed word, so it needs four topics where v1 needs
    // three. The two data words keep their meaning and their order in both,
    // which is why nothing below this line moves.
    if (log.topics.length < (isV2 ? 4 : 3)) return null;
    if (log.data.length < 2 + 64 * 2) return null;
    const a = word(log.data, 0);
    const b = word(log.data, 1);
    return {
      kind: isBuy ? "buy" : "sell",
      curve: addressFromTopic(log.topics[1]!),
      token: addressFromTopic(log.topics[2]!),
      quoteRaw: isBuy ? a : b,
      tokenRaw: isBuy ? b : a,
      quoteAsset: isV2 ? addressFromTopic(log.topics[3]!) : null,
    };
  }

  if (t0 === CLASS_SWEPT_TOPIC) {
    if (log.topics.length < 2) return null;
    if (log.data.length < 2 + 64) return null;
    return {
      kind: "swept",
      curve: null,
      token: addressFromTopic(log.topics[1]!),
      quoteRaw: 0n,
      tokenRaw: word(log.data, 0),
      // A sweep moves no quote, so there is no denomination to name — which is
      // a different fact from v1's "the log did not say", and both are null.
      quoteAsset: null,
    };
  }
  return null;
}
/**
 * Parse raw logs into events, skipping anything malformed.
 *
 * SKIPPED, NEVER DEFAULTED — the same rule `parseLaunchLogs` keeps. A ClassBuy
 * missing its amounts is not a cheaper buy; it is a log this code does not
 * understand, and inventing a zero cost for it would hand the scout budget a
 * free position and the P&L an infinite return.
 */
export function parseClassLogs(
  logs: readonly {
    topics: readonly string[];
    data: string;
    blockNumber: bigint | null;
    transactionHash: string | null;
    logIndex: number | null;
  }[],
): ClassEvent[] {
  const out: ClassEvent[] = [];
  for (const log of logs) {
    // POSITION FIRST. A log with no place in the chain cannot be folded — the
    // fold converges on (txHash, logIndex) and orders on blockNumber.
    if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) continue;
    const body = decodeClassLog(log);
    if (body === null) continue;
    out.push({
      ...body,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash.toLowerCase() as `0x${string}`,
      logIndex: log.logIndex,
    });
  }
  // Chain order, so a replay folds identically every time.
  return out.sort((x, y) =>
    x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1,
  );
}

/** A position rebuilt from the tape, before the balance is consulted. */
export interface ClassLedgerEntry {
  token: `0x${string}`;
  /** The curve of the most recent BUY. Null if only sweeps were seen. */
  curve: `0x${string}` | null;
  /** Actual USDG spent across every buy, minus nothing. */
  costRaw: bigint;
  /** Actual tokens received across every buy. */
  boughtRaw: bigint;
  /** Tokens sold back through the curve. */
  soldRaw: bigint;
  /** Tokens swept out to the owner's account. */
  sweptRaw: bigint;
  /**
   * The LAST sweep's transaction and log position, or null if none was seen.
   *
   * Carried so the withdrawal this implies can be booked exactly once. `flows`
   * is uniquely indexed on (chain_id, agent_id, tx_hash, log_index), so a flow
   * row stamped with these is idempotent by construction — a re-read of the
   * same vault log cannot book the owner's money as leaving twice.
   */
  lastSweptTx: `0x${string}` | null;
  lastSweptLogIndex: number | null;
  /** USDG returned by sells. Realised proceeds. */
  proceedsRaw: bigint;
  /** Block of the FIRST buy — the hold clock, and it cannot be reset. */
  openedAtBlock: bigint;
  /** Transaction of the first buy, for the audit trail. */
  entryTx: `0x${string}`;
  /** Transaction of the last sell, when there is one. */
  exitTx: `0x${string}` | null;
  /** Every (txHash, logIndex) folded in, so a caller can dedupe accruals. */
  logKeys: string[];
  /**
   * EVERY DENOMINATION THIS POSITION WAS FUNDED IN, lowercased.
   *
   * Empty for a v1 position, whose events do not name the asset. ONE entry is
   * the ordinary case and the only one anything downstream can price.
   *
   * MORE THAN ONE MEANS costRaw AND proceedsRaw ARE NOT NUMBERS. Every figure
   * built on them treats a raw quote amount as micro-USDG — the price line
   * divides by a literal 1e6, the column is named cost_usdg — so adding an
   * 18-decimal amount to a 6-decimal one produces a cost roughly a trillion
   * times what was actually spent, and nothing downstream could tell.
   *
   * That is exactly why PonsClassVaultV2 puts the quote asset on the event: so
   * the book can REFUSE to add two denominations rather than add them wrongly.
   */
  quoteAssets: string[];
  /**
   * True when this entry's buys were funded in more than one asset.
   *
   * CANNOT FIRE UNDER TODAY'S PRODUCER, which funds every class entry in USDG
   * and refuses any candidate quoted in anything else. That is what makes this
   * cheap to carry now — and it is what makes the multi-quote deferral honest
   * rather than merely postponed: the day that filter is lifted, the ledger
   * says so instead of quietly booking nonsense.
   */
  mixedDenomination: boolean;
}

/**
 * Fold events into one entry per token.
 *
 * Deliberately does NOT decide what is open — that needs the balance, and the
 * balance is a different read. A token whose buys and sells net to zero may
 * still hold dust, and a token the tape says nothing about may still hold a
 * balance somebody transferred in. The chain decides; this only explains.
 */
export function foldClassEvents(events: readonly ClassEvent[]): Map<string, ClassLedgerEntry> {
  const byToken = new Map<string, ClassLedgerEntry>();
  for (const e of events) {
    const key = e.token.toLowerCase();
    let entry = byToken.get(key);
    if (!entry) {
      entry = {
        token: e.token,
        curve: null,
        costRaw: 0n,
        boughtRaw: 0n,
        soldRaw: 0n,
        sweptRaw: 0n,
        lastSweptTx: null,
        lastSweptLogIndex: null,
        proceedsRaw: 0n,
        openedAtBlock: e.blockNumber,
        entryTx: e.txHash,
        exitTx: null,
        logKeys: [],
        quoteAssets: [],
        mixedDenomination: false,
      };
      byToken.set(key, entry);
    }
    entry.logKeys.push(`${e.txHash}:${e.logIndex}`);
    // A sweep moves no quote, so it names no denomination and must not add one.
    if (e.quoteAsset && e.kind !== "swept") {
      const q = e.quoteAsset.toLowerCase();
      if (!entry.quoteAssets.includes(q)) entry.quoteAssets.push(q);
      entry.mixedDenomination = entry.quoteAssets.length > 1;
    }
    if (e.kind === "buy") {
      // THE CLOCK STARTS AT THE FIRST BUY AND NEVER MOVES. Recorded before the
      // totals are touched, so "have I seen a buy yet" is answered by
      // `boughtRaw === 0n` rather than by a min() that a re-ordered replay
      // could get wrong. A top-up must not rejuvenate a position past its own
      // exit window — that is the same rule `upsertClassPosition` keeps by
      // refusing to take a clock from its caller.
      if (entry.boughtRaw === 0n) {
        entry.openedAtBlock = e.blockNumber;
        entry.entryTx = e.txHash;
      }
      entry.costRaw += e.quoteRaw;
      entry.boughtRaw += e.tokenRaw;
      entry.curve = e.curve;
    } else if (e.kind === "sell") {
      entry.soldRaw += e.tokenRaw;
      entry.proceedsRaw += e.quoteRaw;
      entry.exitTx = e.txHash;
      if (!entry.curve) entry.curve = e.curve;
    } else {
      entry.sweptRaw += e.tokenRaw;
      // THE LAST ONE WINS, because the booking is per POSITION, not per event:
      // what leaves is a share of a cost basis the position holds as a whole,
      // and that share can only be computed once every sweep is folded in. The
      // last sweep's log is a stable, unique key for that one booking.
      entry.lastSweptTx = e.txHash;
      entry.lastSweptLogIndex = e.logIndex;
    }
  }
  return byToken;
}

/**
 * Read the vault's whole history in bounded windows.
 *
 * `failed` is carried rather than thrown, and it is the difference between
 * "this vault has done nothing" and "we could not ask". The caller must not
 * reconcile a book against a scan that did not answer — an empty result from a
 * refused query would close every open position.
 *
 * `unreadable` IS THE THIRD ANSWER, and it exists because the first two were
 * not enough. `failed` only ever meant "the RPC refused", so a log the vault
 * really did emit and this code could not decode was dropped in silence and the
 * scan reported complete. That is not hypothetical: PonsClassVaultV2 changed
 * the ClassBuy and ClassSell topics, and until the constants above were widened
 * a v2 vault's whole history read as COMPLETE AND EMPTY — no error, no warning,
 * an answer indistinguishable from an agent that never traded.
 *
 * The filter is address-only, so every log counted here was emitted BY THIS
 * VAULT. A non-zero count therefore means exactly one thing: this vault speaks
 * a dialect this code does not parse. It is deliberately NOT folded into
 * `failed` — a caller may reasonably reconcile through an unrecognised log it
 * can see and count, and may not reconcile through a window it never received —
 * but a caller that treats it as nothing is making the same mistake again.
 */
export async function readClassLog(
  client: Pick<PublicClient, "request">,
  vault: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
  chunk = 100_000n,
): Promise<{ events: ClassEvent[]; failed: boolean; unreadable: number }> {
  const events: ClassEvent[] = [];
  let failed = false;
  let unreadable = 0;
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = start + chunk - 1n > toBlock ? toBlock : start + chunk - 1n;
    try {
      const logs = (await client.request({
        method: "eth_getLogs",
        params: [
          {
            address: vault,
            fromBlock: `0x${start.toString(16)}`,
            toBlock: `0x${end.toString(16)}`,
          },
        ],
      } as never)) as {
        topics: string[];
        data: string;
        blockNumber: string | null;
        transactionHash: string | null;
        logIndex: string | null;
      }[];
      const normalised = logs.map((l) => ({
        topics: l.topics,
        data: l.data,
        blockNumber: l.blockNumber === null ? null : BigInt(l.blockNumber),
        transactionHash: l.transactionHash,
        logIndex: l.logIndex === null ? null : Number(l.logIndex),
      }));
      const parsed = parseClassLogs(normalised);
      // Counted by DIFFERENCE rather than by re-testing each log, so the count
      // can never disagree with what was actually folded. Every skip belongs
      // here — an unknown topic, a truncated log, a log with no position in the
      // chain — because from the caller's side they are one fact: the vault
      // said something this scan did not put in the book.
      unreadable += normalised.length - parsed.length;
      events.push(...parsed);
    } catch {
      // One refused window makes the WHOLE scan incomplete. Reporting the
      // events we did get without saying so would be the silent-partial-answer
      // failure this codebase refuses everywhere else.
      failed = true;
    }
  }
  return { events, failed, unreadable };
}
