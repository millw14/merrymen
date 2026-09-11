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

/** `PonsClassVault.ClassBuy(address indexed curve, address indexed token, uint256 quoteIn, uint256 tokensOut)` */
export const CLASS_BUY_TOPIC =
  "0x22d7b1b2469327e9a857412f9937d9be98bec22aafba3bd8d827558841f1ac6e" as const;
/** `ClassSell(address indexed curve, address indexed token, uint256 tokensIn, uint256 quoteOut)` */
export const CLASS_SELL_TOPIC =
  "0xc149ab5326030a654df6bb9e89b0e138934c4520a688ea4d9e7ac8bbe2fcd7f2" as const;
/** `Swept(address indexed token, uint256 amount)` — the owner's own exit. */
export const CLASS_SWEPT_TOPIC =
  "0xc36b5179cb9c303b200074996eab2b3473eac370fdd7eba3bec636fe35109696" as const;

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
    const t0 = log.topics[0]?.toLowerCase();
    if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) continue;
    if (typeof log.data !== "string") continue;

    if (t0 === CLASS_BUY_TOPIC || t0 === CLASS_SELL_TOPIC) {
      if (log.topics.length < 3) continue;
      if (log.data.length < 2 + 64 * 2) continue;
      const a = word(log.data, 0);
      const b = word(log.data, 1);
      const isBuy = t0 === CLASS_BUY_TOPIC;
      out.push({
        kind: isBuy ? "buy" : "sell",
        curve: addressFromTopic(log.topics[1]!),
        token: addressFromTopic(log.topics[2]!),
        // buy: (quoteIn, tokensOut). sell: (tokensIn, quoteOut). The order is
        // reversed between them, which is exactly the kind of thing that reads
        // a memecoin count as USDG if it is got wrong once.
        quoteRaw: isBuy ? a : b,
        tokenRaw: isBuy ? b : a,
        blockNumber: log.blockNumber,
        txHash: log.transactionHash.toLowerCase() as `0x${string}`,
        logIndex: log.logIndex,
      });
      continue;
    }

    if (t0 === CLASS_SWEPT_TOPIC) {
      if (log.topics.length < 2) continue;
      if (log.data.length < 2 + 64) continue;
      out.push({
        kind: "swept",
        curve: null,
        token: addressFromTopic(log.topics[1]!),
        quoteRaw: 0n,
        tokenRaw: word(log.data, 0),
        blockNumber: log.blockNumber,
        txHash: log.transactionHash.toLowerCase() as `0x${string}`,
        logIndex: log.logIndex,
      });
    }
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
        proceedsRaw: 0n,
        openedAtBlock: e.blockNumber,
        entryTx: e.txHash,
        exitTx: null,
        logKeys: [],
      };
      byToken.set(key, entry);
    }
    entry.logKeys.push(`${e.txHash}:${e.logIndex}`);
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
 */
export async function readClassLog(
  client: Pick<PublicClient, "request">,
  vault: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
  chunk = 100_000n,
): Promise<{ events: ClassEvent[]; failed: boolean }> {
  const events: ClassEvent[] = [];
  let failed = false;
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
      events.push(
        ...parseClassLogs(
          logs.map((l) => ({
            topics: l.topics,
            data: l.data,
            blockNumber: l.blockNumber === null ? null : BigInt(l.blockNumber),
            transactionHash: l.transactionHash,
            logIndex: l.logIndex === null ? null : Number(l.logIndex),
          })),
        ),
      );
    } catch {
      // One refused window makes the WHOLE scan incomplete. Reporting the
      // events we did get without saying so would be the silent-partial-answer
      // failure this codebase refuses everywhere else.
      failed = true;
    }
  }
  return { events, failed };
}
