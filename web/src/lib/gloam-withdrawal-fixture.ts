/** Offline fixtures only: neither the proof nor ciphertext authorizes a payment. */
import { encodeCallDataEpV07 } from "@zerodev/sdk";
import { encodeFunctionData, erc20Abi, stringToHex, type Hex } from "viem";
import {
  GLOAM_MEMO_BOARD_ABI, GLOAM_SHIELD_BOUND_ABI, GLOAM_WITHDRAWAL_MEMO_BOARD,
  GLOAM_WITHDRAWAL_POOL, GLOAM_WITHDRAWAL_USDG, type GloamWithdrawalCall,
} from "./gloam-withdrawal-contracts";

export const FIXTURE_GLOAM_COMMITMENT = `0x${"01".repeat(32)}` as Hex;
export const FIXTURE_GLOAM_PROOF = `0x${"00".repeat(256)}` as Hex;
const spki = "3059301306072a8648ce3d020106082a8648ce3d03010703420004"
  + "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"
  + "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5";
export const FIXTURE_GLOAM_MEMO = stringToHex(`gloam2t.${Buffer.from(`005b${spki}${"00".repeat(12 + 512 + 16)}`, "hex").toString("base64url")}`);

export function fixtureGloamCalls(amount = 20_000_000n): GloamWithdrawalCall[] {
  return [
    { to: GLOAM_WITHDRAWAL_USDG, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [GLOAM_WITHDRAWAL_POOL, amount] }) },
    { to: GLOAM_WITHDRAWAL_POOL, value: 0n, data: encodeFunctionData({ abi: GLOAM_SHIELD_BOUND_ABI, functionName: "shieldBound", args: [GLOAM_WITHDRAWAL_USDG, amount, FIXTURE_GLOAM_COMMITMENT, FIXTURE_GLOAM_PROOF] }) },
    { to: GLOAM_WITHDRAWAL_MEMO_BOARD, value: 0n, data: encodeFunctionData({ abi: GLOAM_MEMO_BOARD_ABI, functionName: "postMemo", args: [FIXTURE_GLOAM_COMMITMENT, FIXTURE_GLOAM_MEMO] }) },
    { to: GLOAM_WITHDRAWAL_USDG, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [GLOAM_WITHDRAWAL_POOL, 0n] }) },
  ];
}

/** Use Kernel's installed encoder, so tests notice SDK encoding changes. */
export const fixtureGloamBatch = (calls = fixtureGloamCalls()) => encodeCallDataEpV07(calls);
