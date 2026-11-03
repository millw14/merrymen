/**
 * One opt-in exception to the owner recovery relay: an atomic USDG withdrawal
 * into the pinned Gloam pool, with its encrypted recovery memo published in the
 * same transaction. Nothing here grants the agent a new permission.
 *
 * This checks transport scope, not proof validity or note ownership. Gloam
 * checks the proof on chain; the owner reviews and signs the browser-built
 * recipient note. The relay cannot determine who can decrypt a ciphertext.
 */
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, hexToBytes, type Hex } from "viem";
import {
  GLOAM_MEMO_BOARD_ABI,
  GLOAM_SHIELD_BOUND_ABI,
  GLOAM_WITHDRAWAL_CHAIN_ID,
  GLOAM_WITHDRAWAL_MAX_AMOUNT,
  GLOAM_WITHDRAWAL_MAX_MEMO_BYTES,
  GLOAM_WITHDRAWAL_MEMO_BOARD,
  GLOAM_WITHDRAWAL_POOL,
  GLOAM_WITHDRAWAL_USDG,
} from "./gloam-withdrawal-contracts";

const EXECUTE_ABI = [{
  type: "function", name: "execute", stateMutability: "payable",
  inputs: [{ name: "mode", type: "bytes32" }, { name: "execution", type: "bytes" }],
  outputs: [],
}] as const;
const BATCH_ABI = [{
  name: "calls", type: "tuple[]",
  components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }],
}] as const;
const ATOMIC_BATCH_MODE = `0x01${"00".repeat(31)}` as Hex;

export type GloamWithdrawalVerdict =
  | { ok: true; amount: bigint; commitment: Hex; memo: Hex }
  | { ok: false; why: string };

/** Exactly the root/default validator namespace the owner SDK selects. */
export function isGloamOwnerNonce(nonce: unknown): boolean {
  if (typeof nonce !== "string" || !/^0x[0-9a-f]{1,64}$/i.test(nonce)) return false;
  // Kernel v3: mode(1) | validator type(1) | validator id(20) | key(2) | seq(8).
  // Both high bytes must be zero: no secondary validator, permission or enable.
  return BigInt(nonce) >> 240n === 0n;
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/** The SDK's encrypted receive-tag envelope; plaintext recovery notes are refused. */
function sealedMemo(data: Hex): boolean {
  const bytes = hexToBytes(data);
  if (bytes.length === 0 || bytes.length > GLOAM_WITHDRAWAL_MAX_MEMO_BYTES) return false;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!/^gloam2t\.[A-Za-z0-9_-]+$/.test(text)) return false;
  const body = text.slice("gloam2t.".length);
  const decoded = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
  const canonical = btoa(decoded).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (canonical !== body || decoded.length < 2) return false;
  const envelope = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  const publicKeyLength = envelope[0]! * 256 + envelope[1]!;
  // Two length bytes, a P-256 SPKI key, 12-byte IV and a GCM authentication
  // tag plus encrypted note. This is only structural; decryption is private.
  const spkiHeader = hexToBytes("0x3059301306072a8648ce3d020106082a8648ce3d03010703420004");
  return publicKeyLength === 91 && envelope.length > 2 + publicKeyLength + 12 + 16
    && spkiHeader.every((byte, index) => envelope[index + 2] === byte);
}

/**
 * Strictly decode the four-call batch the client prepares. Re-encoding both ABI
 * layers rejects aliases, appended bytes and noncanonical dynamic offsets.
 */
export function isGloamWithdrawalShape(
  callData: Hex,
  opts: { chainId: number; enabled?: boolean; nonce?: unknown },
): GloamWithdrawalVerdict {
  const no = (why: string): GloamWithdrawalVerdict => ({ ok: false, why });
  if (opts.enabled !== true) return no("Gloam withdrawals are not enabled");
  if (opts.chainId !== GLOAM_WITHDRAWAL_CHAIN_ID) return no("Gloam withdrawals require Robinhood mainnet");
  if (!isGloamOwnerNonce(opts.nonce)) return no("Gloam withdrawals require the owner's root validator");
  return parseGloamWithdrawalShape(callData);
}

/** Shared with the browser's persisted-operation checks; no environment or authority checks here. */
export function parseGloamWithdrawalShape(callData: Hex): GloamWithdrawalVerdict {
  const no = (why: string): GloamWithdrawalVerdict => ({ ok: false, why });
  try {
    if (!/^0x(?:[0-9a-f]{2})+$/i.test(callData)) return no("malformed Gloam withdrawal calldata");
    const decoded = decodeFunctionData({ abi: EXECUTE_ABI, data: callData });
    const [mode, execution] = decoded.args;
    if (!same(mode, ATOMIC_BATCH_MODE)) return no("Gloam withdrawals require an atomic default-mode batch");
    if (!same(encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [mode, execution] }), callData)) {
      return no("noncanonical Kernel execution");
    }
    const [calls] = decodeAbiParameters(BATCH_ABI, execution);
    if (!same(encodeAbiParameters(BATCH_ABI, [calls]), execution)) return no("noncanonical Gloam batch");
    if (calls.length !== 4) return no("Gloam withdrawals require exactly four calls");
    if (calls.some((call) => call.value !== 0n)) return no("Gloam withdrawals cannot carry native value");
    const [approve, shield, memo, reset] = calls;
    if (!same(approve!.target, GLOAM_WITHDRAWAL_USDG) || !same(reset!.target, GLOAM_WITHDRAWAL_USDG)
      || !same(shield!.target, GLOAM_WITHDRAWAL_POOL) || !same(memo!.target, GLOAM_WITHDRAWAL_MEMO_BOARD)) {
      return no("Gloam withdrawal targets or order do not match the pinned deployment");
    }

    const deposit = decodeFunctionData({ abi: GLOAM_SHIELD_BOUND_ABI, data: shield!.callData });
    const [asset, amount, commitment, proof] = deposit.args;
    if (!same(asset, GLOAM_WITHDRAWAL_USDG)) return no("only the pinned USDG token may be withdrawn to Gloam");
    if (amount <= 0n || amount > GLOAM_WITHDRAWAL_MAX_AMOUNT) return no("Gloam withdrawal amount is outside the beta limit");
    if (BigInt(commitment) === 0n) return no("Gloam withdrawal commitment must be nonzero");
    if (proof.length !== 2 + 256 * 2) return no("Gloam withdrawal proof must be 256 bytes");
    if (!same(encodeFunctionData({ abi: GLOAM_SHIELD_BOUND_ABI, functionName: "shieldBound", args: [asset, amount, commitment, proof] }), shield!.callData)) {
      return no("noncanonical shieldBound call");
    }
    for (const [call, allowance] of [[approve!, amount], [reset!, 0n]] as const) {
      const exact = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [GLOAM_WITHDRAWAL_POOL, allowance] });
      if (!same(call.callData, exact)) return no("Gloam approval must match the withdrawal exactly and reset to zero");
    }

    const posted = decodeFunctionData({ abi: GLOAM_MEMO_BOARD_ABI, data: memo!.callData });
    const [memoCommitment, encryptedMemo] = posted.args;
    if (!same(memoCommitment, commitment)) return no("Gloam recovery memo must identify the same commitment");
    if (!same(encodeFunctionData({ abi: GLOAM_MEMO_BOARD_ABI, functionName: "postMemo", args: [memoCommitment, encryptedMemo] }), memo!.callData)) {
      return no("noncanonical recovery memo call");
    }
    if (!sealedMemo(encryptedMemo)) return no("Gloam recovery memo must be a bounded encrypted receive-tag envelope");
    return { ok: true, amount, commitment, memo: encryptedMemo };
  } catch {
    return no("Gloam withdrawal batch could not be decoded");
  }
}
