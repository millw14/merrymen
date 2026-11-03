import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, zeroAddress, type Address, type Hex } from "viem";
import { getEntryPoint } from "@zerodev/sdk/constants";
import { GLOAM_RECEIPT_EVENTS, verifyGloamWithdrawalReceipt, type GloamChainReceipt } from "./gloam-withdrawal-receipt";
import { FIXTURE_GLOAM_COMMITMENT, FIXTURE_GLOAM_MEMO } from "./gloam-withdrawal-fixture";
import { GLOAM_WITHDRAWAL_MEMO_BOARD, GLOAM_WITHDRAWAL_POOL, GLOAM_WITHDRAWAL_USDG } from "./gloam-withdrawal-contracts";

const ACCOUNT = `0x${"11".repeat(20)}` as Address;
const OTHER = `0x${"22".repeat(20)}` as Address;
const HASH = `0x${"33".repeat(32)}` as Hex;
const OTHER_HASH = `0x${"44".repeat(32)}` as Hex;
const TRANSACTION = `0x${"55".repeat(32)}` as Hex;
const ENTRYPOINT = getEntryPoint("0.7").address;
const record = { account: ACCOUNT, hash: HASH, amount: "20000000", commitment: FIXTURE_GLOAM_COMMITMENT,
  memo: FIXTURE_GLOAM_MEMO, operation: { nonce: "0x7" as Hex } };
type Log = GloamChainReceipt["logs"][number];

const before = (): Log => ({ address: ENTRYPOINT, logIndex: 0, data: "0x", topics: encodeEventTopics({ abi: GLOAM_RECEIPT_EVENTS, eventName: "BeforeExecution" }) as Hex[] });
const userOp = (opts: { hash?: Hex; sender?: Address; nonce?: bigint; paymaster?: Address; success?: boolean; emitter?: Address } = {}): Log => ({
  address: opts.emitter ?? ENTRYPOINT, logIndex: 0,
  topics: encodeEventTopics({ abi: GLOAM_RECEIPT_EVENTS, eventName: "UserOperationEvent", args: {
    userOpHash: opts.hash ?? HASH, sender: opts.sender ?? ACCOUNT, paymaster: opts.paymaster ?? zeroAddress,
  } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [opts.nonce ?? 7n, opts.success ?? true, 100n, 10n]),
});
const transfer = (value = 20_000_000n): Log => ({
  address: GLOAM_WITHDRAWAL_USDG, logIndex: 0,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: ACCOUNT, to: GLOAM_WITHDRAWAL_POOL } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint256" }], [value]),
});
const shield = (commitment = FIXTURE_GLOAM_COMMITMENT): Log => ({
  address: GLOAM_WITHDRAWAL_POOL, logIndex: 0,
  topics: encodeEventTopics({ abi: GLOAM_RECEIPT_EVENTS, eventName: "Shielded", args: { commitment, asset: GLOAM_WITHDRAWAL_USDG, from: ACCOUNT } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [20_000_000n, 8n]),
});
const memo = (bytes = FIXTURE_GLOAM_MEMO): Log => ({
  address: GLOAM_WITHDRAWAL_MEMO_BOARD, logIndex: 0,
  topics: encodeEventTopics({ abi: GLOAM_RECEIPT_EVENTS, eventName: "PaymentMemo", args: { paymentCommitment: FIXTURE_GLOAM_COMMITMENT } }) as Hex[],
  data: encodeAbiParameters([{ type: "bytes" }], [bytes]),
});
const chainReceipt = (logs: Log[] = [before(), transfer(), shield(), memo(), userOp()]): GloamChainReceipt => ({
  status: "success", transactionHash: TRANSACTION, logs: logs.map((log, index) => ({ ...log, logIndex: index })),
});

describe("Gloam withdrawal on-chain receipt evidence", () => {
  it("confirms only the exact EntryPoint operation with its USDG transfer, note and encrypted memo", () => {
    assert.deepEqual(verifyGloamWithdrawalReceipt(record, chainReceipt()), { success: true, transactionHash: TRANSACTION });
    const reversed = chainReceipt();
    assert.equal(verifyGloamWithdrawalReceipt(record, { ...reversed, logs: [...reversed.logs].reverse() }).success, true, "chain log indices establish order");
  });

  it("trusts an exact failed on-chain operation without requiring deposit events", () => {
    assert.deepEqual(verifyGloamWithdrawalReceipt(record, chainReceipt([before(), userOp({ success: false })])), { success: false, transactionHash: TRANSACTION });
    assert.throws(() => verifyGloamWithdrawalReceipt(record, { ...chainReceipt(), status: "reverted" }), /not confirmed/);
  });

  it("rejects another hash, account, nonce, paymaster or event emitter, even when failure is claimed", () => {
    for (const overrides of [{ hash: OTHER_HASH }, { sender: OTHER }, { nonce: 8n }, { paymaster: OTHER }, { emitter: OTHER }]) {
      for (const success of [true, false]) {
        assert.throws(() => verifyGloamWithdrawalReceipt(record, chainReceipt([before(), transfer(), shield(), memo(), userOp({ ...overrides, success })])));
      }
    }
  });

  it("does not borrow deposit evidence from earlier or later operations in the same bundle", () => {
    for (const logs of [
      [before(), transfer(), shield(), memo(), userOp({ hash: OTHER_HASH }), userOp()],
      [before(), userOp(), transfer(), shield(), memo(), userOp({ hash: OTHER_HASH })],
      [transfer(), shield(), memo(), before(), userOp()],
      [before(), transfer(), shield(), before(), memo(), userOp()],
    ]) assert.throws(() => verifyGloamWithdrawalReceipt(record, chainReceipt(logs)), /does not confirm/);
  });

  it("requires every exact deposit leg in the successful operation", () => {
    for (const events of [
      [transfer(), shield()], [transfer(), memo()], [shield(), memo()],
      [transfer(1n), shield(), memo()], [transfer(), shield(OTHER_HASH), memo()],
      [transfer(), shield(), memo("0x1234")],
      [{ ...transfer(), address: OTHER }, shield(), memo()],
      [transfer(), { ...shield(), address: OTHER }, memo()],
      [transfer(), shield(), { ...memo(), address: OTHER }],
    ]) assert.throws(() => verifyGloamWithdrawalReceipt(record, chainReceipt([before(), ...events, userOp()])), /does not confirm/);
  });

  it("rejects ambiguous, removed or incomplete receipt histories", () => {
    assert.throws(() => verifyGloamWithdrawalReceipt(record, chainReceipt([transfer(), shield(), memo(), userOp()])), /does not match/);
    assert.throws(() => verifyGloamWithdrawalReceipt(record, chainReceipt([before(), transfer(), shield(), memo(), userOp(), userOp()])), /does not match/);
    for (const malformed of [{ logIndex: null }, { logIndex: -1 }, { removed: true }, { logIndex: 0 }]) {
      const receipt = chainReceipt();
      const logs = [...receipt.logs];
      logs[1] = { ...logs[1]!, ...malformed };
      assert.throws(() => verifyGloamWithdrawalReceipt(record, { ...receipt, logs }), /ordered log history/);
    }
  });
});
