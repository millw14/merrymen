import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, encodeFunctionData, erc20Abi, stringToHex, type Hex } from "viem";
import { isGloamOwnerNonce, isGloamWithdrawalShape, parseGloamWithdrawalShape } from "./gloam-withdrawal-shape";
import {
  GLOAM_MEMO_BOARD_ABI, GLOAM_SHIELD_BOUND_ABI, GLOAM_WITHDRAWAL_MAX_AMOUNT,
  GLOAM_WITHDRAWAL_POOL, GLOAM_WITHDRAWAL_USDG,
} from "./gloam-withdrawal-contracts";
import { FIXTURE_GLOAM_COMMITMENT, FIXTURE_GLOAM_MEMO, FIXTURE_GLOAM_PROOF, fixtureGloamBatch, fixtureGloamCalls } from "./gloam-withdrawal-fixture";

const OTHER = `0x${"99".repeat(20)}` as const;
const opts = { enabled: true, chainId: 4663, nonce: "0x0" };
const EXECUTE_ABI = [{ type: "function", name: "execute", stateMutability: "payable", inputs: [{ type: "bytes32" }, { type: "bytes" }], outputs: [] }] as const;

describe("Gloam owner withdrawal relay shape", () => {
  it("accepts the installed Kernel encoder's atomic four-call batch and reports the persisted intent", async () => {
    const cd = await fixtureGloamBatch();
    const verdict = isGloamWithdrawalShape(cd, opts);
    assert.deepEqual(verdict, { ok: true, amount: 20_000_000n, commitment: FIXTURE_GLOAM_COMMITMENT, memo: FIXTURE_GLOAM_MEMO });
    assert.deepEqual(parseGloamWithdrawalShape(cd), verdict);
    assert.equal(isGloamWithdrawalShape(await fixtureGloamBatch(fixtureGloamCalls(GLOAM_WITHDRAWAL_MAX_AMOUNT)), opts).ok, true);
  });

  it("fails closed when disabled, on another chain, or using any session/secondary/enable nonce", async () => {
    const cd = await fixtureGloamBatch();
    for (const override of [
      { enabled: false }, { enabled: undefined }, { chainId: 46630 }, { chainId: 1 },
      { nonce: undefined }, { nonce: "0x" }, { nonce: "0xg" }, { nonce: 0 },
      { nonce: `0x${(2n << 240n).toString(16)}` }, { nonce: `0x${(1n << 240n).toString(16)}` },
      { nonce: `0x${(1n << 248n).toString(16)}` }, { nonce: `0x${(1n << 256n).toString(16)}` },
    ]) assert.equal(isGloamWithdrawalShape(cd, { ...opts, ...override }).ok, false, JSON.stringify(override));
    assert.equal(isGloamOwnerNonce(`0x${((BigInt(OTHER) << 80n) | 100n).toString(16)}`), true, "an owner validator identifier and sequence remain valid");
  });

  it("rejects wrong targets, native value, reordering, missing and extra calls", async () => {
    for (let index = 0; index < 4; index++) {
      for (const replacement of [{ to: OTHER }, { value: 1n }]) {
        const calls = fixtureGloamCalls();
        calls[index] = { ...calls[index]!, ...replacement };
        assert.equal(parseGloamWithdrawalShape(await fixtureGloamBatch(calls)).ok, false);
      }
    }
    const calls = fixtureGloamCalls();
    for (const altered of [calls.slice(0, 3), [...calls, calls[3]!], [calls[1]!, calls[0]!, calls[2]!, calls[3]!], [calls[0]!, calls[2]!, calls[1]!, calls[3]!]]) {
      assert.equal(parseGloamWithdrawalShape(await fixtureGloamBatch(altered)).ok, false);
    }
  });

  it("rejects partial execution, delegatecall, hooks, unexpected mode bits and noncanonical wrapper bytes", async () => {
    const cd = await fixtureGloamBatch();
    const { args: [, execution] } = decodeFunctionData({ abi: EXECUTE_ABI, data: cd });
    for (const mode of [`0x0101${"00".repeat(30)}`, `0xff${"00".repeat(31)}`, `0x00${"00".repeat(31)}`, `0x01${"00".repeat(30)}01`] as Hex[]) {
      assert.equal(parseGloamWithdrawalShape(encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [mode, execution] })).ok, false);
    }
    for (const altered of ["0x", "0x123", "0xgg", `${cd}00`, `${cd.slice(0, -2)}`, `0x8dd7712f${cd.slice(2)}`] as Hex[]) {
      assert.equal(parseGloamWithdrawalShape(altered).ok, false);
    }
    const trailingBatch = encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [`0x01${"00".repeat(31)}`, `${execution}00`] });
    assert.equal(parseGloamWithdrawalShape(trailingBatch).ok, false, "inner trailing bytes are rejected even with a canonical outer wrapper");
  });

  it("requires a positive bounded exact allowance, correct spender and a final zero reset", async () => {
    for (const amount of [0n, GLOAM_WITHDRAWAL_MAX_AMOUNT + 1n]) {
      assert.equal(parseGloamWithdrawalShape(await fixtureGloamBatch(fixtureGloamCalls(amount))).ok, false);
    }
    for (const [index, spender, amount] of [[0, OTHER, 20_000_000n], [0, GLOAM_WITHDRAWAL_POOL, 20_000_001n], [0, GLOAM_WITHDRAWAL_POOL, 2n ** 256n - 1n], [3, GLOAM_WITHDRAWAL_POOL, 1n]] as const) {
      const calls = fixtureGloamCalls();
      calls[index]!.data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
      assert.equal(parseGloamWithdrawalShape(await fixtureGloamBatch(calls)).ok, false);
    }
  });

  it("rejects alternate assets/selectors, malformed proofs, empty commitments and extra leg arguments", async () => {
    const cases = [
      [OTHER, 20_000_000n, FIXTURE_GLOAM_COMMITMENT, FIXTURE_GLOAM_PROOF],
      [GLOAM_WITHDRAWAL_USDG, 20_000_000n, `0x${"00".repeat(32)}`, FIXTURE_GLOAM_PROOF],
      [GLOAM_WITHDRAWAL_USDG, 20_000_000n, FIXTURE_GLOAM_COMMITMENT, "0x"],
      [GLOAM_WITHDRAWAL_USDG, 20_000_000n, FIXTURE_GLOAM_COMMITMENT, `${FIXTURE_GLOAM_PROOF}00`],
    ] as const;
    for (const args of cases) {
      const calls = fixtureGloamCalls();
      calls[1]!.data = encodeFunctionData({ abi: GLOAM_SHIELD_BOUND_ABI, functionName: "shieldBound", args });
      assert.equal(parseGloamWithdrawalShape(await fixtureGloamBatch(calls)).ok, false);
    }
    for (let index = 0; index < 4; index++) {
      for (const alter of [(data: Hex) => `${data}00` as Hex, (data: Hex) => `0xdeadbeef${data.slice(10)}` as Hex]) {
        const calls = fixtureGloamCalls();
        calls[index]!.data = alter(calls[index]!.data);
        assert.equal(parseGloamWithdrawalShape(await fixtureGloamBatch(calls)).ok, false);
      }
    }
  });

  it("requires the matching encrypted memo and refuses plaintext, malformed or excessive envelopes", async () => {
    for (const [commitment, memo] of [
      [`0x${"02".repeat(32)}`, FIXTURE_GLOAM_MEMO],
      [FIXTURE_GLOAM_COMMITMENT, "0x"],
      [FIXTURE_GLOAM_COMMITMENT, stringToHex("gloam1.secret")],
      [FIXTURE_GLOAM_COMMITMENT, stringToHex("gloam2t.e30")],
      [FIXTURE_GLOAM_COMMITMENT, stringToHex(`gloam2t.${"A".repeat(8192)}`)],
      [FIXTURE_GLOAM_COMMITMENT, `${FIXTURE_GLOAM_MEMO}3d`],
      [FIXTURE_GLOAM_COMMITMENT, "0xff"],
    ] as const) {
      const calls = fixtureGloamCalls();
      calls[2]!.data = encodeFunctionData({ abi: GLOAM_MEMO_BOARD_ABI, functionName: "postMemo", args: [commitment, memo] });
      assert.equal(parseGloamWithdrawalShape(await fixtureGloamBatch(calls)).ok, false);
    }
  });
});
