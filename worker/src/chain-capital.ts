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
  const span = args.maxSpan ?? 1_000_000n;
  const wanted = new Map(args.accounts.map((a) => [pad32(a), a]));
  const topicList = [...wanted.keys()];
  const usdg = args.usdgToken.toLowerCase();

  const result = new Map<string, AccountCapital>();
  for (const a of args.accounts) {
    result.set(a.toLowerCase(), { account: a, movements: [], totals: totalCapital([]), complete: true, notes: [] });
  }

  const hits: RawChainLog[] = [];
  let short = false;

  for (const [pos, dir] of [
    [1, "out"],
    [2, "in"],
  ] as const) {
    for (let from = args.fromBlock; from <= args.toBlock; from += span) {
      const to = from + span - 1n > args.toBlock ? args.toBlock : from + span - 1n;
      const topics: (string | string[] | null)[] = [TRANSFER_TOPIC, null, null];
      topics[pos] = topicList;
      let ok = false;
      for (let attempt = 0; attempt < 4 && !ok; attempt++) {
        try {
          const logs = (await rpc("eth_getLogs", [
            {
              address: args.usdgToken,
              fromBlock: "0x" + from.toString(16),
              toBlock: "0x" + to.toString(16),
              topics: topics.slice(0, pos + 1),
            },
          ])) as RawChainLog[];
          for (const l of logs) hits.push(l);
          ok = true;
        } catch (e) {
          if (attempt === 3) {
            short = true;
            args.log?.(`window ${from}-${to} (${dir}) UNREAD after 4 attempts — coverage is short`);
          } else {
            await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
          }
        }
      }
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
