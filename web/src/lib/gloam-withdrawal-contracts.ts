import type { Address, Hex } from "viem";

/** Pinned Robinhood mainnet beta deployment; other chains are not supported. */
export const GLOAM_WITHDRAWAL_CHAIN_ID = 4663;
export const GLOAM_WITHDRAWAL_POOL = "0x39e28cde55cab798874746ac52cb4b5cc99a0194" as const;
export const GLOAM_WITHDRAWAL_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
export const GLOAM_WITHDRAWAL_MEMO_BOARD = "0x01B3172d9900Cb26d57E986429b9b23854c74598" as const;
/** USDG has six decimals. This is a per-operation beta ceiling, not a daily allowance. */
export const GLOAM_WITHDRAWAL_MAX_AMOUNT = 500_000_000n;
export const GLOAM_WITHDRAWAL_MAX_MEMO_BYTES = 8192;

export const GLOAM_SHIELD_BOUND_ABI = [{
  type: "function",
  name: "shieldBound",
  stateMutability: "payable",
  inputs: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "commitment", type: "bytes32" },
    { name: "proof", type: "bytes" },
  ],
  outputs: [],
}] as const;

export const GLOAM_MEMO_BOARD_ABI = [{
  type: "function",
  name: "postMemo",
  stateMutability: "nonpayable",
  inputs: [
    { name: "paymentCommitment", type: "bytes32" },
    { name: "memo", type: "bytes" },
  ],
  outputs: [],
}] as const;

export interface GloamWithdrawalCall {
  to: Address;
  value: bigint;
  data: Hex;
}
