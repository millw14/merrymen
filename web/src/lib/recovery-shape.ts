/**
 * IS THIS CALLDATA A WITHDRAWAL, OR JUST SOMETHING THE HOUSE WOULD PAY TO RELAY?
 *
 * Validating the method, the entryPoint, the paymaster fields and the sender does
 * not make a relay "a recovery submit path" — none of those look at what the
 * operation DOES. Without this check, anyone holding a ticket can push arbitrary
 * UserOperations for their own account through app.merrymen.dev: swaps,
 * approvals, any contract call on the chain, as a free transaction-submission
 * service running on the house's bundler account. Refusing that structurally is
 * cheaper than defending it with quotas.
 *
 * THE SHAPE recover.ts BUILDS: N ERC-20 `transfer(to, amount)` calls with zero
 * value, optionally followed by ONE bare value transfer with empty calldata, and
 * every leg paying the SAME destination. That last part is what makes it a
 * withdrawal rather than a payment — money leaves for one address the caller
 * nominated and nothing else happens on the way.
 *
 * DECODED THE WAY KERNEL ENCODES IT, read out of the installed SDK rather than
 * assumed. `execute(bytes32 execMode, bytes executionCalldata)`, where execMode's
 * first byte is the call type:
 *
 *   0x00 SINGLE — executionCalldata is PACKED: to(20) ++ value(32) ++ data
 *   0x01 BATCH  — executionCalldata is abi.encode((address,uint256,bytes)[])
 *   0xFF DELEGATE — refused outright; a delegatecall is not a withdrawal
 *
 * The single form matters and is easy to miss: encodeCallData switches on
 * `calls.length > 1`, so a recovery that sweeps ONE token is not a batch at all.
 * A decoder that only understood batches would strand exactly the simplest case.
 *
 * FAIL CLOSED, BUT PINNED. A false reject here strands somebody's money, so the
 * test feeds this the output of the SDK's OWN encoders — a Kernel encoding change
 * then fails a test rather than quietly turning this into an escape hatch or a
 * wall.
 */

import { decodeAbiParameters, decodeFunctionData, erc20Abi, type Hex } from "viem";

/** Kernel v3 `execute(bytes32,bytes)`. */
const EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    inputs: [
      { name: "execMode", type: "bytes32" },
      { name: "executionCalldata", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

/** `executeUserOp(PackedUserOperation,bytes32)` — the hook-enabled wrapper's selector. */
const EXECUTE_USER_OP_SELECTOR = "0x8dd7712f";

const BATCH_TUPLE = [
  {
    name: "executionBatch",
    type: "tuple[]",
    components: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "callData", type: "bytes" },
    ],
  },
] as const;

export type ShapeVerdict =
  | { ok: true; to: `0x${string}`; tokenLegs: number; nativeLeg: boolean; classSweep?: boolean }
  | { ok: false; why: string };

interface Leg {
  to: `0x${string}`;
  value: bigint;
  data: Hex;
}

function legsOf(callData: Hex): Leg[] | { why: string } {
  // A hook-enabled account wraps the whole thing behind executeUserOp; the
  // execute() call follows immediately after that selector.
  let data = callData;
  if (data.toLowerCase().startsWith(EXECUTE_USER_OP_SELECTOR)) {
    data = (`0x${data.slice(EXECUTE_USER_OP_SELECTOR.length)}`) as Hex;
  }

  let mode: Hex;
  let exec: Hex;
  try {
    const d = decodeFunctionData({ abi: EXECUTE_ABI, data });
    [mode, exec] = d.args as unknown as [Hex, Hex];
  } catch {
    return { why: "this operation is not a Kernel execute() call, so it cannot be a withdrawal" };
  }

  const callType = mode.slice(0, 4).toLowerCase(); // "0x" + first byte
  if (callType === "0xff") return { why: "a delegatecall is never a withdrawal" };

  if (callType === "0x01") {
    try {
      const [batch] = decodeAbiParameters(BATCH_TUPLE, exec);
      return (batch as readonly { target: `0x${string}`; value: bigint; callData: Hex }[]).map((c) => ({
        to: c.target,
        value: c.value,
        data: c.callData,
      }));
    } catch {
      return { why: "the batch could not be decoded" };
    }
  }

  if (callType === "0x00") {
    // PACKED, not abi-encoded: to(20 bytes) ++ value(32 bytes) ++ data.
    const body = exec.slice(2);
    if (body.length < 104) return { why: "the single call is too short to be well-formed" };
    return [
      {
        to: `0x${body.slice(0, 40)}` as `0x${string}`,
        value: BigInt(`0x${body.slice(40, 104)}`),
        data: (`0x${body.slice(104)}` || "0x") as Hex,
      },
    ];
  }

  return { why: `unrecognised Kernel call type ${callType}` };
}

/** Is this the withdrawal shape, and where is the money going? */
/**
 * `PonsClassVault.sweep(address token)`.
 *
 * WHY A RELAY MAY CARRY THIS AT ALL, when it carries nothing else that is not a
 * plain transfer. `sweep` takes NO recipient: it pushes the token's whole
 * balance to `owner`, fixed at construction to the smart account, and it is
 * gated by `only`. So the most a relayed sweep can do is move tokens the owner
 * already controls from one address they control into another. It cannot name a
 * destination, cannot carry value, and cannot be pointed at a third party.
 *
 * That is a strictly smaller power than the `transfer()` legs this file already
 * admits — those DO name a destination. The vault leg is the conservative one.
 *
 * It is still PINNED to the caller's own vault (see `classVault`), because
 * "some other contract also has a sweep(address)" is a cheaper thing to exclude
 * than to reason about.
 */
const SWEEP_SELECTOR = "0x01681a62";

export interface ShapeOptions {
  /**
   * The vault this ticket blesses, from the ticket's own signed body. A sweep
   * leg is admitted only when its target equals this, case-insensitively.
   * Absent or null means no sweep may be relayed at all.
   */
  classVault?: `0x${string}` | null;
}

export function isRecoveryShape(callData: Hex, opts: ShapeOptions = {}): ShapeVerdict {
  const legs = legsOf(callData);
  if (!Array.isArray(legs)) return { ok: false, why: legs.why };
  if (legs.length === 0) return { ok: false, why: "nothing is being withdrawn" };
  if (legs.length > 64) return { ok: false, why: "too many legs for a withdrawal" };

  /**
   * THE CLASS SWEEP IS ITS OWN OPERATION, never mixed with transfers.
   *
   * `planClassSweep` says why the path is two operations rather than one: a
   * Kernel batch cannot thread call N's return into call N+1's arguments, so
   * the amount arriving at the account is not known until the sweep has
   * executed. The shapes therefore never legitimately appear together, and
   * requiring that keeps this function a pair of narrow allowances instead of
   * one wide one.
   */
  const vault = opts.classVault ?? null;
  const sweepLegs = legs.filter((l) => l.data.slice(0, 10).toLowerCase() === SWEEP_SELECTOR);
  if (sweepLegs.length > 0) {
    if (sweepLegs.length !== legs.length) {
      return { ok: false, why: "a vault sweep cannot be mixed with transfers in one operation" };
    }
    if (!vault) {
      return { ok: false, why: "this ticket does not name a class vault, so no vault sweep may be relayed" };
    }
    for (const leg of sweepLegs) {
      if (leg.value !== 0n) return { ok: false, why: "a vault sweep carrying native value" };
      if (leg.to.toLowerCase() !== vault.toLowerCase()) {
        return { ok: false, why: "a sweep aimed at something other than this account's own class vault" };
      }
      // 4-byte selector plus exactly one address word. Anything longer is a
      // different call wearing the same first four bytes.
      if (leg.data.length !== 10 + 64) return { ok: false, why: "a vault sweep with unexpected arguments" };
    }
    return { ok: true, to: vault, tokenLegs: sweepLegs.length, nativeLeg: false, classSweep: true };
  }

  let dest: `0x${string}` | null = null;
  let tokenLegs = 0;
  let nativeLeg = false;

  const sameDest = (to: `0x${string}`): boolean => {
    if (dest && dest.toLowerCase() !== to.toLowerCase()) return false;
    dest = to;
    return true;
  };

  for (const leg of legs) {
    // The bare value transfer — at most one.
    if (leg.data === "0x") {
      if (nativeLeg) return { ok: false, why: "more than one native transfer in one operation" };
      if (leg.value === 0n) return { ok: false, why: "a value leg that moves nothing" };
      nativeLeg = true;
      if (!sameDest(leg.to)) return { ok: false, why: "the legs do not all pay one destination" };
      continue;
    }

    // Everything else must be an ERC-20 transfer carrying no value.
    if (leg.value !== 0n) return { ok: false, why: "a token call carrying native value" };
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: erc20Abi, data: leg.data });
    } catch {
      return { ok: false, why: "a call this relay cannot decode as an ERC-20 transfer" };
    }
    if (decoded.functionName !== "transfer") {
      return { ok: false, why: `only transfer() may be relayed, not ${String(decoded.functionName)}` };
    }
    const to = (decoded.args as readonly unknown[])[0] as `0x${string}`;
    if (!sameDest(to)) return { ok: false, why: "the legs do not all pay one destination" };
    tokenLegs++;
  }

  if (!dest) return { ok: false, why: "nothing is being withdrawn" };
  // Explicitly false, not absent: a caller distinguishing the two shapes should
  // not have to know that `undefined` means "the transfer one".
  return { ok: true, to: dest, tokenLegs, nativeLeg, classSweep: false };
}
