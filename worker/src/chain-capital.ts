/**
 * READING CONTRIBUTED CAPITAL OFF THE CHAIN, for every hosted account at once.
 *
 * This is the evidence source the ledger should always have had. `chain-log` has
 * no producer in production — the deposit scan defaults off — so every one of the
 * 363 flow rows in the shared database is `inferred` with no transaction, and a
 * quarantine-only repair would leave every agent at zero contributions. The rows
 * that SHOULD be there have to come from somewhere, and this is where.
 *
 * TWO PASSES, AND THE SECOND IS THE EXPENSIVE ONE.
 *
 *   1. One `eth_getLogs` sweep for the whole fleet. Topic positions accept an
 *      OR-list, so twenty-four accounts cost what one costs.
 *   2. One receipt per DISTINCT transaction the sweep touched. That is what
 *      `classifyUsdgMovement` needs: a swap is two tokens moving opposite ways in
 *      one transaction, and the second leg is only visible in the receipt.
 *
 * The receipts are what make this correct rather than merely cheap. Without them
 * the canary's four router outflows read as a 6.666 USDG withdrawal, and its
 * contributed capital comes out at 3.334 instead of 10.
 *
 * COVERAGE IS PART OF THE ANSWER. A sweep that could not read a window returns
 * `complete: false`, and a caller that writes rows on an incomplete scan would
 * be inserting a contribution history with holes in it — which is worse than the
 * inferred rows it replaces, because it would look authoritative.
 */
import { classifyUsdgMovement, totalCapital, type CapitalTotals, type Classification, type TransferLeg } from "../../packages/core/src/index";

/** `Transfer(address,address,uint256)`. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface RawChainLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

/** The JSON-RPC seam, injected so this is testable without a node. */
export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

/**
 * WHY A WINDOW WAS REFUSED, WHICH DECIDES WHAT TO DO ABOUT IT.
 *
 * The first version of this sweep retried every failure four times at the same
 * size, on the reasoning that "a rate limit is not a hint about the question".
 * That reasoning is sound and it is also only half the story: there are TWO
 * failures here and they want opposite responses.
 *
 *   too-many-results  the node found more logs than it will return. The window
 *                     IS the question, and the answer is to ask a smaller one.
 *                     Retrying the same range cannot ever succeed.
 *   rate-limited      the node will not answer right now. The window is fine;
 *                     splitting it makes MORE calls and makes things worse.
 *                     Wait longer and ask again.
 *
 * Run against the live chain the fleet sweep failed every one of its 110
 * windows with 429 Too Many Requests, while the identical query for a single
 * account over the WHOLE history succeeded in 1.6s — the endpoint was never
 * refusing the range, it was refusing the rate, and four retries 700ms apart
 * (against a node 24 children are also using) never outlasted it.
 */
export type SweepRefusal = "too-many-results" | "rate-limited" | "unknown";

export function classifyRpcError(e: unknown): SweepRefusal {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (m.includes("exceeds limit") || m.includes("too many results") || m.includes("query returned more than"))
    return "too-many-results";
  if (m.includes("429") || m.includes("too many requests") || m.includes("rate limit")) return "rate-limited";
  return "unknown";
}

/** One classified USDG movement, with everything a durable row needs. */
export interface CapitalMovement {
  txHash: string;
  blockNumber: number;
  logIndex: number;
  direction: "in" | "out";
  /** Base units, decimal string. Never a float. */
  amountRaw: string;
  counterparty: string;
  classification: Classification;
}

export interface AccountCapital {
  account: string;
  movements: CapitalMovement[];
  totals: CapitalTotals;
  /** False when any window or receipt could not be read. */
  complete: boolean;
  notes: string[];
}

/** How many times to wait out a rate limit before calling the window unread. */
const RATE_LIMIT_ATTEMPTS = 6;
/** First backoff, doubling each attempt: 1s, 2s, 4s, 8s, 16s — 31s in total. */
const RATE_LIMIT_BASE_MS = 1_000;
/** Courtesy pause between top-level ranges, so the fleet's children still get served. */
const INTER_RANGE_MS = 250;
/**
 * How far a too-large range may be halved. 54.7M blocks reaches a single block
 * in 26 splits; this stops a pathological node turning one query into thousands.
 */
const MAX_SPLIT_DEPTH = 24;

const pad32 = (a: string) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const addrOfTopic = (t: string) => "0x" + t.slice(-40);
const hexNum = (h: string) => Number(BigInt(h));

/** Every ERC-20 Transfer in a receipt, as classification legs. */
export function legsFromReceipt(logs: readonly RawChainLog[]): TransferLeg[] {
  const out: TransferLeg[] = [];
  for (const l of logs) {
    if ((l.topics?.[0] ?? "").toLowerCase() !== TRANSFER_TOPIC) continue;
    // A Transfer has exactly three topics; anything else is a different event
    // that happens to share the signature's first word (ERC-721 has four).
    if (l.topics.length !== 3) continue;
    out.push({
      token: l.address.toLowerCase(),
      from: addrOfTopic(l.topics[1]!),
      to: addrOfTopic(l.topics[2]!),
      amountRaw: BigInt(l.data || "0x0").toString(),
    });
  }
  return out;
}

/**
 * Scan and classify every USDG movement for a set of accounts.
 *
 * `maxSpan` matches what the chain's public RPC actually serves; a window it
 * refuses is retried at the same size rather than halved, because a rate limit
 * is not a hint about the question (see inflight-reconcile for the incident that
 * rule came from).
 */
export async function scanFleetCapital(
  rpc: RpcCall,
  args: {
    accounts: readonly string[];
    usdgToken: string;
    fromBlock: bigint;
    toBlock: bigint;
    maxSpan?: bigint;
    protocolAddresses?: readonly string[];
    log?: (m: string) => void;
  },
): Promise<Map<string, AccountCapital>> {
  // NO DEFAULT WINDOWING. The node filters server-side on the topic OR-list, so
  // the whole history in one call is both correct and cheaper than slicing it —
  // and the slicing is what earned the rate limits. A caller may still cap the
  // opening bid; the sweep narrows from there on the node's say-so.
  const span = args.maxSpan ?? args.toBlock - args.fromBlock + 1n;
  const wanted = new Map(args.accounts.map((a) => [pad32(a), a]));
  const topicList = [...wanted.keys()];
  const usdg = args.usdgToken.toLowerCase();

  const result = new Map<string, AccountCapital>();
  for (const a of args.accounts) {
    result.set(a.toLowerCase(), { account: a, movements: [], totals: totalCapital([]), complete: true, notes: [] });
  }

  const hits: RawChainLog[] = [];
  let short = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * Read one block range, and let the node tell us how to ask.
   *
   * ONE CALL FOR THE WHOLE HISTORY IS THE OPENING BID, not 55 windowed ones.
   * Topic OR-lists work on this endpoint and filter server-side, so a fleet-wide
   * query over all of history returns a handful of logs — measured: 6 logs, 1.6s
   * for one account across 54.7M blocks. Windowing up front turned that into 110
   * calls against a node 24 children are already using, which is what earned the
   * 429s. So it starts wide and narrows ONLY when the node says the answer was
   * too big, which is the one refusal that splitting can fix.
   */
  const sweep = async (
    from: bigint,
    to: bigint,
    pos: number,
    dir: string,
    depth: number,
  ): Promise<void> => {
    const topics: (string | string[] | null)[] = [TRANSFER_TOPIC, null, null];
    topics[pos] = topicList;

    for (let attempt = 0; attempt < RATE_LIMIT_ATTEMPTS; attempt++) {
      try {
        const logs = (await rpc("eth_getLogs", [
          {
            address: args.usdgToken,
            fromBlock: "0x" + from.toString(16),
            toBlock: "0x" + to.toString(16),
            // TRIMMED, never padded. A trailing null adds a FOURTH topic
            // position, and Transfer has three — so the filter matches nothing
            // and the sweep reports an empty history for a funded account.
            // Confirmed against the live node while diagnosing this.
            topics: topics.slice(0, pos + 1),
          },
        ])) as RawChainLog[];
        for (const l of logs) hits.push(l);
        return;
      } catch (e) {
        const why = classifyRpcError(e);

        if (why === "too-many-results") {
          if (from >= to || depth >= MAX_SPLIT_DEPTH) {
            short = true;
            args.log?.(
              `range ${from}-${to} (${dir}) holds more logs than the node will return and cannot be split ` +
                `further — coverage is short`,
            );
            return;
          }
          const mid = from + (to - from) / 2n;
          args.log?.(`range ${from}-${to} (${dir}) too large — splitting at ${mid}`);
          await sweep(from, mid, pos, dir, depth + 1);
          await sweep(mid + 1n, to, pos, dir, depth + 1);
          return;
        }

        if (attempt === RATE_LIMIT_ATTEMPTS - 1) {
          short = true;
          args.log?.(
            `range ${from}-${to} (${dir}) UNREAD after ${RATE_LIMIT_ATTEMPTS} attempts (${why}) — coverage is short`,
          );
          return;
        }
        // EXPONENTIAL, IN SECONDS. The old backoff topped out at 2.1s, which
        // against this endpoint is not a wait at all — it is four requests in
        // quick succession dressed as patience.
        const wait = RATE_LIMIT_BASE_MS * 2 ** attempt;
        args.log?.(`range ${from}-${to} (${dir}) ${why} — waiting ${wait}ms before asking again`);
        await sleep(wait);
      }
    }
  };

  for (const [pos, dir] of [
    [1, "out"],
    [2, "in"],
  ] as const) {
    // `maxSpan` is now a CEILING rather than a stride: it caps the opening bid
    // for a caller who knows their node is stricter, and is otherwise ignored
    // because the node's own refusal is a better guide than a guess.
    for (let from = args.fromBlock; from <= args.toBlock; from += span) {
      const to = from + span - 1n > args.toBlock ? args.toBlock : from + span - 1n;
      await sweep(from, to, pos, dir, 0);
      // A courtesy pause between top-level ranges. The fleet's 24 children share
      // this endpoint, and a reconstruction that rate-limits them is a
      // reconstruction that breaks the thing it is measuring.
      if (to < args.toBlock) await sleep(INTER_RANGE_MS);
    }
  }

  if (short) for (const v of result.values()) v.complete = false;

  // ONE RECEIPT PER TRANSACTION, not per log. A swap puts both legs in the same
  // receipt, and several accounts can appear in one batched transaction.
  const byTx = new Map<string, RawChainLog[]>();
  for (const l of hits) {
    const k = l.transactionHash.toLowerCase();
    const list = byTx.get(k);
    if (list) list.push(l);
    else byTx.set(k, [l]);
  }

  for (const [txHash, logsForTx] of byTx) {
    let legs: TransferLeg[] = [];
    let readable = true;
    try {
      const receipt = (await rpc("eth_getTransactionReceipt", [txHash])) as { logs?: RawChainLog[] } | null;
      legs = legsFromReceipt(receipt?.logs ?? []);
      if (!receipt) readable = false;
    } catch {
      readable = false;
    }

    for (const l of logsForTx) {
      const fromAddr = addrOfTopic(l.topics[1]!);
      const toAddr = addrOfTopic(l.topics[2]!);
      for (const [padded, account] of wanted) {
        const isOut = pad32(fromAddr) === padded;
        const isIn = pad32(toAddr) === padded;
        if (!isOut && !isIn) continue;
        const entry = result.get(account.toLowerCase())!;
        const usdgLeg: TransferLeg = {
          token: l.address.toLowerCase(),
          from: fromAddr,
          to: toAddr,
          amountRaw: BigInt(l.data || "0x0").toString(),
        };
        if (usdgLeg.token !== usdg) continue;

        // A RECEIPT WE COULD NOT READ MAKES THE MOVEMENT AMBIGUOUS, not capital.
        // Classifying on the single log we have would book every trade leg as a
        // withdrawal, which is the exact error this module exists to avoid.
        const classification: Classification = readable
          ? classifyUsdgMovement({
              account,
              usdg: usdgLeg,
              txLegs: legs.length ? legs : [usdgLeg],
              usdgToken: usdg,
              knownAccounts: args.accounts,
              protocolAddresses: args.protocolAddresses,
            })
          : {
              kind: "ambiguous",
              why: `the receipt for ${txHash} could not be read, so the other half of this transaction is unknown`,
              evidence: {
                counterparty: isOut ? toAddr : fromAddr,
                direction: isOut ? "out" : "in",
                txLegCount: 0,
                rule: "not-this-account",
              },
            };
        if (!readable) {
          entry.complete = false;
          entry.notes.push(`unreadable receipt ${txHash}`);
        }

        entry.movements.push({
          txHash,
          blockNumber: hexNum(l.blockNumber),
          logIndex: hexNum(l.logIndex),
          direction: isOut ? "out" : "in",
          amountRaw: usdgLeg.amountRaw,
          counterparty: isOut ? toAddr : fromAddr,
          classification,
        });
      }
    }
  }

  for (const entry of result.values()) {
    entry.movements.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    entry.totals = totalCapital(
      entry.movements.map((m) => ({ amountRaw: m.amountRaw, classification: m.classification })),
    );
  }
  return result;
}
