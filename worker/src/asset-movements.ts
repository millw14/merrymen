/**
 * READING NON-USDG MOVEMENTS OFF THE CHAIN, AND WHO AUTHORISED EACH ONE.
 *
 * chain-capital.ts answers "how much USDG did the owner put in". It cannot see
 * an owner who funds or drains a book IN KIND — TSLA sent to the account, a
 * memecoin swept home with the owner key — and those move equity by the
 * asset's whole value with no flow row behind them. This is the read that
 * names them, for a human to review. It writes nothing and books nothing.
 *
 * A SEPARATE FILE ON PURPOSE. chain-capital.ts feeds the live repairs, and a
 * second scanner folded into it would change what they read. This one only
 * borrows its pure helpers (the Transfer decode and the refusal reading).
 *
 * THE SIGNER IS READ FROM THE OPERATION, NEVER FROM THE DATABASE. The Shogun
 * case is a session-key swap whose trades row went missing; a scanner that
 * asked "is there a trades row?" would book that purchase as an owner deposit.
 * So the question here is asked of the chain:
 *
 *   1. The EntryPoint emits UserOperationEvent for every operation, carrying
 *      its sender and its NONCE — and Kernel v3 packs the validator that
 *      authorised the op into the nonce key (executor.ts isFirstEnable). A
 *      contract cannot forge a log at the EntryPoint's address, so this is a
 *      structural proof of who signed.
 *   2. The handleOps calldata carries each op's callData, and Kernel's
 *      `execute` encodes the ETH each call sent. That is the only place a
 *      curve buy paid in native ETH shows its other half.
 *
 * Coverage is part of the answer, as it is in chain-capital: anything that
 * could not be read leaves `complete: false` and the movements it touched
 * `ambiguous`, never guessed into capital.
 *
 * WHAT IS NOT VISIBLE AT ALL: native ETH arriving outside a UserOperation of
 * this account. A plain ETH transfer emits no log, and this public node has no
 * traces. Every result says so in its notes rather than reporting "none".
 */
import { decodeAbiParameters, decodeFunctionData, parseAbi, type Hex } from "viem";
import {
  classifyAssetMovement,
  ENTRYPOINT,
  NATIVE_ASSET,
  type AssetClassification,
  type AssetMovementKind,
  type OperationProvenance,
  type TransferLeg,
} from "../../packages/core/src/index";
import { classifyRpcError, legsFromReceipt, TRANSFER_TOPIC, type RawChainLog, type RpcCall } from "./chain-capital";

/** `UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)` — the same in v0.6 and v0.7. */
export const USER_OPERATION_EVENT_TOPIC = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
/** `BeforeExecution()` — the EntryPoint's line between validation and execution. */
export const BEFORE_EXECUTION_TOPIC = "0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972";

/** The EntryPoint every hosted Kernel v3 account runs on. Another one is not decoded. */
const ENTRYPOINT_V07 = ENTRYPOINT.v07.toLowerCase();

/** `executeUserOp` — the hook-plugin prefix Kernel puts in front of `execute`. */
const EXECUTE_USER_OP_SELECTOR = "0x8dd7712f";

const HANDLE_OPS_ABI = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function handleOps(PackedUserOperation[] ops, address beneficiary)",
]);
const KERNEL_EXECUTE_ABI = parseAbi(["function execute(bytes32 execMode, bytes executionCalldata)"]);

/** Same patience as chain-capital: 1s, 2s, 4s, 8s, 16s before a read is called unread. */
const RATE_LIMIT_ATTEMPTS = 6;
const RATE_LIMIT_BASE_MS = 1_000;
/** How far a too-large range may be halved, as in chain-capital. */
const MAX_SPLIT_DEPTH = 24;

const lower = (a: string) => String(a ?? "").toLowerCase();
const pad32 = (a: string) => "0x" + lower(a).replace(/^0x/, "").padStart(64, "0");
const addrOfTopic = (t: string) => "0x" + lower(t).slice(-40);
const hexNum = (h: string) => Number(BigInt(h));

// ── who signed ───────────────────────────────────────────────────────────

/**
 * The validator a Kernel v3 nonce names, or null when it is not one this
 * preview will vouch for.
 *
 * `nonce = mode(1) ‖ vType(1) ‖ identifier(20) ‖ key(2) ‖ seq(8)`. vType 0x00 is
 * the ROOT validator — the owner's sudo key — 0x01 a secondary validator, 0x02
 * a permission (the session key). Mode 0x00 is a plain op and 0x01 an op that
 * enables its validator first; an enable still EXECUTES as that validator, so a
 * session key's first op is a session-key op.
 *
 * Root in enable mode is not something @zerodev/sdk produces (it sets ENABLE
 * only for a regular validator), and any other mode or type is not something
 * this file has measured. Both are refused rather than read as the nearest
 * thing, because the nearest thing to "root" is a capital candidate.
 */
export function validatorOfNonce(nonce: bigint): "root" | "permission" | "secondary" | null {
  if (nonce < 0n || nonce >> 256n !== 0n) return null;
  const mode = (nonce >> 248n) & 0xffn;
  const vType = (nonce >> 240n) & 0xffn;
  if (mode !== 0x00n && mode !== 0x01n) return null;
  if (vType === 0x00n) return mode === 0x00n ? "root" : null;
  if (vType === 0x01n) return "secondary";
  if (vType === 0x02n) return "permission";
  return null;
}

/** One UserOperationEvent, decoded. Null for anything that is not one. */
export interface UserOpRecord {
  /** The EntryPoint that emitted it, lowercased. */
  entryPoint: string;
  userOpHash: string;
  sender: string;
  paymaster: string;
  nonce: bigint;
  success: boolean;
  logIndex: number;
}

export function decodeUserOperationEvent(log: RawChainLog): UserOpRecord | null {
  if (lower(log.topics?.[0] ?? "") !== USER_OPERATION_EVENT_TOPIC || log.topics.length !== 4) return null;
  const data = lower(log.data ?? "").replace(/^0x/, "");
  // nonce, success, actualGasCost, actualGasUsed — four words, nothing else.
  if (!/^[0-9a-f]*$/.test(data) || data.length !== 64 * 4) return null;
  const word = (i: number) => BigInt("0x" + data.slice(i * 64, (i + 1) * 64));
  const success = word(1);
  if (success !== 0n && success !== 1n) return null;
  return {
    entryPoint: lower(log.address),
    userOpHash: lower(log.topics[1]!),
    sender: addrOfTopic(log.topics[2]!),
    paymaster: addrOfTopic(log.topics[3]!),
    nonce: word(0),
    success: success === 1n,
    logIndex: hexNum(log.logIndex),
  };
}

/** What a handleOps call carried, per op. Null when the input is not one. */
export function opsOfHandleOps(input: string): { sender: string; nonce: bigint; callData: Hex }[] | null {
  try {
    const d = decodeFunctionData({ abi: HANDLE_OPS_ABI, data: input as Hex });
    if (d.functionName !== "handleOps") return null;
    return d.args[0].map((op) => ({ sender: lower(op.sender), nonce: op.nonce, callData: op.callData }));
  } catch {
    return null;
  }
}

/**
 * The calls a Kernel v3 `execute` made, with the ETH each one sent. Null when
 * the callData is anything else — and null is UNREAD, not "sent nothing".
 *
 * Only the DEFAULT exec type is read. In TRY mode a failed call does not revert
 * the batch, so "the calldata asked to send 0.1 ETH" stops being "0.1 ETH was
 * sent", and a delegatecall can move anything at all. Neither is guessed.
 */
export function kernelExecutions(callData: string): { target: string; value: bigint }[] | null {
  let data = lower(callData);
  if (data.startsWith(EXECUTE_USER_OP_SELECTOR)) data = "0x" + data.slice(EXECUTE_USER_OP_SELECTOR.length);
  try {
    const d = decodeFunctionData({ abi: KERNEL_EXECUTE_ABI, data: data as Hex });
    const mode = lower(d.args[0]).replace(/^0x/, "");
    const callType = mode.slice(0, 2);
    const execType = mode.slice(2, 4);
    if (execType !== "00") return null;
    const exec = lower(d.args[1]).replace(/^0x/, "");
    if (callType === "00") {
      // abi.encodePacked(target, value, callData)
      if (exec.length < 104) return null;
      return [{ target: "0x" + exec.slice(0, 40), value: BigInt("0x" + exec.slice(40, 104)) }];
    }
    if (callType === "01") {
      const [batch] = decodeAbiParameters(
        [{ type: "tuple[]", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }],
        d.args[1],
      );
      return batch.map(([target, value]) => ({ target: lower(target), value }));
    }
    return null;
  } catch {
    return null;
  }
}

// ── which op produced which log ──────────────────────────────────────────

/** A run of receipt logs that one operation's execution produced. */
export interface OpSegment {
  op: UserOpRecord;
  logs: RawChainLog[];
}

/**
 * Split a receipt's logs into the operations that produced them.
 *
 * EntryPoint v0.7 validates every op, emits BeforeExecution, then executes the
 * ops in order — and each op's UserOperationEvent comes at the END of its own
 * execution. So the logs between BeforeExecution (or the previous op's event)
 * and an op's event are that op's, and nothing else is anybody's: validation
 * logs, and anything after the last event, land in `unattributed`.
 *
 * This is what lets a bundle carrying an owner sweep AND an agent swap be read
 * as two operations rather than one transaction where everything pairs with
 * everything.
 */
export function segmentReceipt(logs: readonly RawChainLog[]): {
  segments: OpSegment[];
  unattributed: RawChainLog[];
  /** UserOperationEvents from an EntryPoint other than v0.7. Not decoded. */
  foreign: UserOpRecord[];
} {
  const ordered = [...logs].sort((a, b) => hexNum(a.logIndex) - hexNum(b.logIndex));
  const segments: OpSegment[] = [];
  const unattributed: RawChainLog[] = [];
  const foreign: UserOpRecord[] = [];
  let executing = false;
  let pending: RawChainLog[] = [];
  for (const log of ordered) {
    const fromEp = lower(log.address) === ENTRYPOINT_V07;
    if (fromEp && lower(log.topics?.[0] ?? "") === BEFORE_EXECUTION_TOPIC) {
      // A second handleOps in one transaction: whatever came since the last op
      // event was the next batch's validation, not anybody's execution.
      unattributed.push(...pending);
      pending = [];
      executing = true;
      continue;
    }
    const op = decodeUserOperationEvent(log);
    if (op && !fromEp) {
      foreign.push(op);
      continue;
    }
    if (op) {
      // An op event with no BeforeExecution ahead of it is not a shape this
      // file knows. The op is still recorded, with no logs, so its sender
      // counts as having acted and nothing near it reads as "nobody acted".
      segments.push({ op, logs: executing ? pending : [] });
      pending = [];
      continue;
    }
    if (executing) pending.push(log);
    else unattributed.push(log);
  }
  unattributed.push(...pending);
  return { segments, unattributed, foreign };
}

// ── the scan ─────────────────────────────────────────────────────────────

/** One movement of a non-USDG asset across this account's book, classified. */
export interface AssetMovement {
  txHash: string;
  blockNumber: number;
  /** The Transfer's log index. Null for native ETH an execution sent, which has no log. */
  logIndex: number | null;
  /** Lowercased token address, or NATIVE_ASSET. */
  asset: string;
  from: string;
  to: string;
  /** Base units, decimal string. Never a float. */
  amountRaw: string;
  /** This account's operation that produced it, when one did. */
  userOpHash: string | null;
  provenance: OperationProvenance;
  classification: AssetClassification;
  /** Confirmed block time, only for movements a reviewer must look at. */
  at?: number;
}

export interface AccountAssetMovements {
  account: string;
  movements: AssetMovement[];
  /** Operations of this account the EntryPoint recorded in the scanned range. */
  operations: number;
  counts: Record<AssetMovementKind, number>;
  /** False when any window, receipt, transaction or block time could not be read. */
  complete: boolean;
  notes: string[];
}

export interface AssetScanAccount {
  account: string;
  /** Contracts holding this account's own assets — custody.ts custodyAddressesOf(grant). */
  custody?: readonly string[];
  /** The grant's owner key and the signed-in tenant wallet. */
  owners?: readonly string[];
}

/** The kinds a reviewer must read: the candidates, and everything that refused to decide. */
export const REVIEW_KINDS: readonly AssetMovementKind[] = Object.freeze(["asset-in", "asset-out", "ambiguous", "internal"]);

const emptyCounts = (): Record<AssetMovementKind, number> => ({
  "asset-in": 0,
  "asset-out": 0,
  "trade-leg": 0,
  reserve: 0,
  fuel: 0,
  custody: 0,
  internal: 0,
  protocol: 0,
  ambiguous: 0,
});

interface ReceiptShape {
  status?: string;
  blockNumber?: string;
  blockHash?: string;
  from?: string;
  to?: string | null;
  logs?: RawChainLog[];
}

/**
 * Scan and classify every non-USDG movement for a set of accounts. READ ONLY:
 * the only RPC methods it calls are eth_getLogs, eth_getTransactionReceipt,
 * eth_getTransactionByHash and eth_getBlockByNumber.
 *
 * Two sweeps, each one call for the whole range on the node's say-so (see
 * chain-capital for why it starts wide): every ERC-20 Transfer touching a book
 * address — any token, so no `address` filter — and every UserOperationEvent
 * this account sent, which is how an op that moved only native ETH is found.
 */
export async function scanAssetMovements(
  rpc: RpcCall,
  args: {
    accounts: readonly AssetScanAccount[];
    usdgToken: string;
    fromBlock: bigint;
    toBlock: bigint;
    reserveTokens?: readonly string[];
    protocolAddresses?: readonly string[];
    systemAddresses?: readonly string[];
    /** Other hosted accounts. Defaults to the scanned accounts themselves. */
    knownAccounts?: readonly string[];
    /** Read the block time of every movement in REVIEW_KINDS. */
    includeReviewTimestamps?: boolean;
    log?: (m: string) => void;
    /** Injected so tests do not wait out real backoffs. */
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<Map<string, AccountAssetMovements>> {
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const usdg = lower(args.usdgToken);
  const scope = args.accounts.map((a) => ({
    account: lower(a.account),
    custody: (a.custody ?? []).map(lower),
    owners: (a.owners ?? []).map(lower),
  }));
  const knownAccounts = (args.knownAccounts ?? scope.map((s) => s.account)).map(lower);
  const result = new Map<string, AccountAssetMovements>();
  for (const s of scope) {
    result.set(s.account, {
      account: s.account,
      movements: [],
      operations: 0,
      counts: emptyCounts(),
      complete: true,
      notes: ["native ETH received outside an operation of this account emits no log and is not visible to this read"],
    });
  }
  const all = [...result.values()];
  const short = (why: string, only?: AccountAssetMovements) => {
    for (const r of only ? [only] : all) {
      r.complete = false;
      if (!r.notes.includes(why)) r.notes.push(why);
    }
    args.log?.(why);
  };

  /**
   * Wait out a refusal, exactly as chain-capital's sweep does. "Too many
   * results" is the one refusal waiting cannot fix, so it goes straight back
   * to the caller to split; anything still failing after the last wait is the
   * caller's to call unread.
   */
  const patiently = async <T>(call: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (e) {
        if (classifyRpcError(e) === "too-many-results" || attempt >= RATE_LIMIT_ATTEMPTS - 1) throw e;
        await sleep(RATE_LIMIT_BASE_MS * 2 ** attempt);
      }
    }
  };

  /** One getLogs question over a range, narrowed only when the node says it was too big. */
  const sweep = async (filter: { address?: string; topics: (string | string[] | null)[] }, what: string): Promise<RawChainLog[]> => {
    const hits: RawChainLog[] = [];
    const ask = async (from: bigint, to: bigint, depth: number): Promise<void> => {
      try {
        const logs = (await patiently(() =>
          rpc("eth_getLogs", [{ ...filter, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]),
        )) as RawChainLog[];
        hits.push(...(logs ?? []));
      } catch (e) {
        if (classifyRpcError(e) === "too-many-results" && from < to && depth < MAX_SPLIT_DEPTH) {
          const mid = from + (to - from) / 2n;
          await ask(from, mid, depth + 1);
          await ask(mid + 1n, to, depth + 1);
          return;
        }
        short(`${what} range ${from}-${to} UNREAD (${classifyRpcError(e)}) — coverage is short`);
      }
    };
    await ask(args.fromBlock, args.toBlock, 0);
    return hits;
  };

  const bookTopics = [...new Set(scope.flatMap((s) => [s.account, ...s.custody]))].map(pad32);
  const senderTopics = scope.map((s) => pad32(s.account));
  const found = [
    // TRIMMED topic lists, never padded with a trailing null — chain-capital
    // measured that a fourth position matches nothing at all.
    ...(await sweep({ topics: [TRANSFER_TOPIC, bookTopics] }, "outbound transfers")),
    ...(await sweep({ topics: [TRANSFER_TOPIC, null, bookTopics] }, "inbound transfers")),
    ...(await sweep({ address: ENTRYPOINT.v07, topics: [USER_OPERATION_EVENT_TOPIC, null, senderTopics] }, "operations")),
  ];

  const byTx = new Map<string, number>();
  for (const l of found) {
    const k = lower(l.transactionHash);
    const n = hexNum(l.blockNumber);
    if (!byTx.has(k) || byTx.get(k)! > n) byTx.set(k, n);
  }
  const txs = [...byTx.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  const blockHashOf = new Map<string, string>();

  for (const [txHash, sweptBlock] of txs) {
    let receipt: ReceiptShape | null = null;
    try {
      receipt = (await patiently(() => rpc("eth_getTransactionReceipt", [txHash]))) as ReceiptShape | null;
    } catch {
      receipt = null;
    }
    if (!receipt || !Array.isArray(receipt.logs)) {
      // UNREADABLE MAKES IT AMBIGUOUS, NOT CAPITAL — and makes the account's
      // answer incomplete. The swept logs are all that is known; one log can
      // be swept twice (account → vault matches both directions), so by index.
      const swept = [...new Map(found.filter((l) => lower(l.transactionHash) === txHash).map((l) => [hexNum(l.logIndex), l])).values()];
      for (const s of scope) {
        const entry = result.get(s.account)!;
        const book = new Set([s.account, ...s.custody]);
        const legs = legsWithIndex(swept).filter(({ leg }) => (book.has(leg.from) || book.has(leg.to)) && leg.token !== usdg);
        const ops = swept.map(decodeUserOperationEvent).filter((o) => o && o.sender === s.account);
        if (!legs.length && !ops.length) continue;
        short(`unreadable receipt ${txHash}`, entry);
        const provenance: OperationProvenance = { source: "unknown", why: `the receipt for ${txHash} could not be read` };
        for (const { leg, logIndex } of legs) {
          record(entry, s, { txHash, blockNumber: sweptBlock, logIndex, leg, opLegs: [leg], nativeLegs: null, provenance, userOpHash: null });
        }
      }
      continue;
    }
    if (receipt.status !== undefined && BigInt(receipt.status) !== 1n) continue; // reverted: nothing moved
    const blockNumber = receipt.blockNumber ? hexNum(receipt.blockNumber) : sweptBlock;
    if (receipt.blockHash) blockHashOf.set(txHash, lower(receipt.blockHash));
    const actorTx = lower(receipt.from ?? "");
    const { segments, unattributed, foreign } = segmentReceipt(receipt.logs);

    // The calldata, fetched only when one of OUR accounts acted — it is where
    // the ETH each call sent is written, and nothing else here needs it.
    let decoded: { sender: string; nonce: bigint; callData: Hex }[] | null | undefined;
    const handleOps = async () => {
      if (decoded !== undefined) return decoded;
      decoded = null;
      if (lower(receipt!.to ?? "") !== ENTRYPOINT_V07) return decoded;
      try {
        const tx = (await patiently(() => rpc("eth_getTransactionByHash", [txHash]))) as { input?: string } | null;
        if (tx?.input) decoded = opsOfHandleOps(tx.input);
      } catch {
        decoded = null;
      }
      return decoded;
    };

    for (const s of scope) {
      const entry = result.get(s.account)!;
      const book = new Set([s.account, ...s.custody]);
      const touches = (l: TransferLeg) => book.has(l.from) || book.has(l.to);
      const own = segments.filter((g) => g.op.sender === s.account);
      entry.operations += own.length;

      if (foreign.some((o) => o.sender === s.account)) {
        // An op of this account through an EntryPoint this file does not
        // decode. Its logs cannot be told from anybody else's.
        short(`operation through an undecoded EntryPoint in ${txHash}`, entry);
        const provenance: OperationProvenance = { source: "unknown", why: "an operation of this account ran through an EntryPoint other than v0.7" };
        for (const { leg, logIndex } of legsWithIndex(receipt.logs).filter(({ leg }) => touches(leg) && leg.token !== usdg)) {
          record(entry, s, { txHash, blockNumber, logIndex, leg, opLegs: [leg], nativeLegs: null, provenance, userOpHash: null });
        }
        continue;
      }

      for (const seg of segments) {
        const legs = legsWithIndex(seg.logs);
        const mine = seg.op.sender === s.account;
        if (mine && !seg.op.success) continue; // a reverted op moved nothing
        if (!mine && !legs.some(({ leg }) => touches(leg))) continue;

        let provenance: OperationProvenance;
        let nativeLegs: TransferLeg[] | null = [];
        if (mine) {
          const validator = validatorOfNonce(seg.op.nonce);
          provenance = validator
            ? { source: "user-op", validator, userOpHash: seg.op.userOpHash, nonce: seg.op.nonce.toString() }
            : { source: "unknown", why: `nonce key 0x${(seg.op.nonce >> 64n).toString(16)} names no validator this preview reads` };
          // Fetched for EVERY successful op of ours, legs or not: an op that
          // swept only native ETH has no Transfer log at all, and this calldata
          // is the only place it shows.
          const ops = await handleOps();
          const call = ops?.find((o) => o.sender === s.account && o.nonce === seg.op.nonce);
          if (!call) short(`the calldata carrying operation ${seg.op.userOpHash} could not be read — native ETH it sent is unknown`, entry);
          const executions = call ? kernelExecutions(call.callData) : null;
          if (call && !executions) {
            // Not a plain Kernel execute — an install, a delegatecall, a TRY
            // batch. Its ETH is unknown and the classifier is told so (null).
            // Coverage is short exactly as for calldata that could not be
            // found: ETH such an op sent produces no movement at all here, so
            // a clean account would be a claim nothing supports.
            short(`operation ${seg.op.userOpHash} is not a plain Kernel execute — native ETH it sent is unknown`, entry);
          }
          nativeLegs = executions
            ? executions
                .filter((e) => e.value > 0n && lower(e.target) !== s.account)
                .map((e) => ({ token: NATIVE_ASSET, from: s.account, to: lower(e.target), amountRaw: e.value.toString() }))
            : null;
        } else {
          provenance = { source: "none", actors: [actorTx, seg.op.sender].filter(Boolean) };
        }
        const opLegs = legs.map((l) => l.leg);
        // The op's own paymaster is infrastructure for THIS op — a token
        // paymaster's charge is gas, not a sweep. The zero address is "no
        // paymaster", not a paymaster, and must not quietly make every mint
        // and burn in the op read as infrastructure.
        const system = [...(args.systemAddresses ?? []), ...(/^0x0{40}$/.test(seg.op.paymaster) ? [] : [seg.op.paymaster])];
        for (const { leg, logIndex } of legs) {
          if (!touches(leg) || leg.token === usdg) continue;
          record(entry, s, { txHash, blockNumber, logIndex, leg, opLegs, nativeLegs, provenance, userOpHash: mine ? seg.op.userOpHash : null, system });
        }
        for (const leg of mine ? (nativeLegs ?? []) : []) {
          record(entry, s, { txHash, blockNumber, logIndex: null, leg, opLegs, nativeLegs, provenance, userOpHash: seg.op.userOpHash, system, sortAfter: seg.op.logIndex });
        }
      }

      const loose = legsWithIndex(unattributed);
      if (loose.some(({ leg }) => touches(leg))) {
        // Outside every operation's execution. If this account acted anywhere
        // in the transaction, these cannot be placed — so they are not read
        // as "nobody acted" either.
        const provenance: OperationProvenance = own.length
          ? { source: "unknown", why: `this movement sits outside every operation's execution in ${txHash}` }
          : { source: "none", actors: [actorTx].filter(Boolean) };
        const opLegs = loose.map((l) => l.leg);
        for (const { leg, logIndex } of loose) {
          if (!touches(leg) || leg.token === usdg) continue;
          record(entry, s, { txHash, blockNumber, logIndex, leg, opLegs, nativeLegs: own.length ? null : [], provenance, userOpHash: null });
        }
      }
    }
  }

  // ── block times, only where a reviewer needs them ──────────────────────
  const blockTimes = new Map<number, { at: number; hash: string } | null>();
  for (const entry of all) {
    entry.movements.sort(
      (a, b) => a.blockNumber - b.blockNumber || a.txHash.localeCompare(b.txHash) || order(a) - order(b),
    );
    for (const m of entry.movements) {
      entry.counts[m.classification.kind] += 1;
      if (!args.includeReviewTimestamps || !REVIEW_KINDS.includes(m.classification.kind)) continue;
      if (!blockTimes.has(m.blockNumber)) {
        let read: { at: number; hash: string } | null = null;
        try {
          const block = (await patiently(() => rpc("eth_getBlockByNumber", [`0x${m.blockNumber.toString(16)}`, false]))) as
            | { number?: unknown; timestamp?: unknown; hash?: unknown }
            | null;
          if (typeof block?.number !== "string" || typeof block.timestamp !== "string" || typeof block.hash !== "string" ||
              !/^0x[0-9a-f]+$/i.test(block.number) || !/^0x[0-9a-f]+$/i.test(block.timestamp) ||
              BigInt(block.number) !== BigInt(m.blockNumber)) throw new Error("wrong or unreadable block");
          const at = Number(BigInt(block.timestamp));
          if (!Number.isSafeInteger(at) || at <= 0) throw new Error("invalid block time");
          read = { at, hash: lower(block.hash) };
        } catch {
          // An unread block must not be replaced by the time of this read.
        }
        blockTimes.set(m.blockNumber, read);
      }
      const read = blockTimes.get(m.blockNumber)!;
      const expected = blockHashOf.get(m.txHash);
      if (read === null || (expected !== undefined && read.hash !== expected)) {
        short(`unreadable or non-canonical block ${m.blockNumber} for ${m.txHash}`, entry);
      } else {
        m.at = read.at;
      }
    }
  }
  return result;

  function record(
    entry: AccountAssetMovements,
    s: { account: string; custody: string[]; owners: string[] },
    m: {
      txHash: string;
      blockNumber: number;
      logIndex: number | null;
      leg: TransferLeg;
      opLegs: TransferLeg[];
      nativeLegs: TransferLeg[] | null;
      provenance: OperationProvenance;
      userOpHash: string | null;
      system?: readonly string[];
      sortAfter?: number;
    },
  ) {
    if (BigInt(m.leg.amountRaw || "0") === 0n) return; // address poisoning moves nothing
    const classification = classifyAssetMovement({
      account: s.account,
      leg: m.leg,
      opLegs: m.opLegs,
      nativeLegs: m.nativeLegs,
      provenance: m.provenance,
      usdgToken: usdg,
      ownerAddresses: s.owners,
      knownAccounts: knownAccounts.filter((a) => a !== s.account),
      protocolAddresses: args.protocolAddresses,
      systemAddresses: m.system ?? args.systemAddresses,
      custodyAddresses: s.custody,
      reserveTokens: args.reserveTokens,
    });
    const movement: AssetMovement = {
      txHash: m.txHash,
      blockNumber: m.blockNumber,
      logIndex: m.logIndex,
      asset: lower(m.leg.token),
      from: lower(m.leg.from),
      to: lower(m.leg.to),
      amountRaw: m.leg.amountRaw,
      userOpHash: m.userOpHash,
      provenance: m.provenance,
      classification,
    };
    // A native leg has no log; it sorts just after the op that sent it.
    sortKey.set(movement, m.logIndex ?? (m.sortAfter ?? 0) + 0.5);
    entry.movements.push(movement);
  }
}

/** Order within a transaction, kept off the movement so the result is data only. */
const sortKey = new WeakMap<AssetMovement, number>();
const order = (m: AssetMovement) => sortKey.get(m) ?? 0;

/**
 * legsFromReceipt, one log at a time so each Transfer keeps its log index, and
 * lowercased throughout — every comparison here is against lowercased sets.
 */
function legsWithIndex(logs: readonly RawChainLog[]): { leg: TransferLeg; logIndex: number }[] {
  const out: { leg: TransferLeg; logIndex: number }[] = [];
  for (const log of logs) {
    const [leg] = legsFromReceipt([log]);
    if (leg) out.push({ leg: { ...leg, from: lower(leg.from), to: lower(leg.to) }, logIndex: hexNum(log.logIndex) });
  }
  return out;
}
