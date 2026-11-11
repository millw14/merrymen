import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from "viem";
import { ENTRYPOINT } from "../../packages/core/src/chain.ts";
import { recoverGasProof, type GasRecoveryChain, type GasRecoveryRow, type GasReceipt } from "./receipt-proof.ts";

const account = `0x${"a".repeat(40)}` as Hex;
const tx = `0x${"1".repeat(64)}` as Hex;
const op = `0x${"2".repeat(64)}` as Hex;
const blockHash = `0x${"3".repeat(64)}` as Hex;
const zero = `0x${"0".repeat(40)}` as Hex;
const at = 1_790_000_000;
const abi = parseAbi(["event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"]);

function fixture(payer: "owner" | "sponsor" = "sponsor", status: "landed" | "reverted" = "landed", cost = 1_000_000_000_000_000n) {
  const row: GasRecoveryRow = { id: 1, agent_id: account, epoch: 2, status, tx_hash: tx, user_op_hash: op,
    user_op_nonce: "7", gas_wei: null, sponsored_gas_wei: null, gas_units: null, gas_usdg: null, gas_recorded_at: null };
  const receipt: GasReceipt = { transactionHash: tx, blockHash, blockNumber: 100n, status: "success", logs: [{
    address: ENTRYPOINT.v07,
    topics: encodeEventTopics({ abi, eventName: "UserOperationEvent", args: {
      userOpHash: op, sender: account, paymaster: payer === "owner" ? zero : `0x${"b".repeat(40)}`,
    } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
      [7n, status === "landed", cost, 200_000n]),
  }] };
  const chain: GasRecoveryChain = {
    chainId: async () => 4663, head: async () => 200n, receipt: async () => receipt,
    block: async () => ({ hash: blockHash, timestamp: BigInt(at) }),
    latestRound: async () => ({ roundId: 3n, priceUsd: 3000, updatedAt: at + 100 }),
    round: async id => ({ roundId: id, priceUsd: 2500,
      updatedAt: id === 1n ? at - 1000 : id === 2n ? at - 60 : at + 100 }),
  };
  return { row, receipt, chain };
}

describe("standalone receipt proof", () => {
  it("proves sponsored zero owner expense without calling a price feed", async () => {
    const f = fixture();
    f.chain.latestRound = async () => { throw new Error("must not read a price"); };
    const proof = await recoverGasProof(f.row, f.chain, 4663, 200n);
    assert.equal(proof?.payer, "sponsor"); assert.equal(proof?.usdg, 0);
    assert.equal(proof?.gasWei, "1000000000000000"); assert.equal(proof?.at, at);
  });
  it("prices owner fees from the historical in-force round, including reverted operations", async () => {
    for (const status of ["landed", "reverted"] as const) {
      const f = fixture("owner", status);
      const proof = await recoverGasProof(f.row, f.chain, 4663, 200n);
      assert.equal(proof?.usdg, 2.5); assert.equal(proof?.price?.roundId, "2");
    }
  });
  it("preserves unpriced raw owner gas when feed or immediate successor is unavailable", async () => {
    const f = fixture("owner");
    f.chain.round = async id => id === 3n ? null : ({ roundId: id, priceUsd: 2500, updatedAt: at - 60 });
    assert.equal((await recoverGasProof(f.row, f.chain, 4663, 200n))?.usdg, null);
    f.chain.latestRound = async () => { throw new Error("unavailable"); };
    assert.equal((await recoverGasProof(f.row, f.chain, 4663, 200n))?.gasWei, "1000000000000000");
  });
  it("refuses future and stale price rounds, or prices from another chain", async () => {
    const f = fixture("owner");
    f.chain.latestRound = async () => ({ roundId: 1n, priceUsd: 2500, updatedAt: at - 7 * 3600 });
    assert.equal((await recoverGasProof(f.row, f.chain, 4663, 200n))?.usdg, null);
    f.chain.latestRound = async () => ({ roundId: 1n, priceUsd: 2500, updatedAt: at + 100 });
    f.chain.round = async () => null;
    assert.equal((await recoverGasProof(f.row, f.chain, 4663, 200n))?.usdg, null);
    assert.equal((await recoverGasProof(f.row, f.chain, 46630, 200n))?.usdg, null);
  });
  it("refuses wrong operation, sender, EntryPoint, nonce, tx, verdict, block hash and insufficient finality", async () => {
    const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
      f => { f.row.user_op_hash = `0x${"4".repeat(64)}`; },
      f => { f.row.agent_id = `0x${"c".repeat(40)}`; },
      f => { f.receipt.logs = [{ ...f.receipt.logs[0]!, address: account }]; },
      f => { f.row.user_op_nonce = "8"; }, f => { f.receipt.transactionHash = blockHash; },
      f => { f.row.status = "reverted"; }, f => { f.receipt.status = "reverted"; },
      f => { f.chain.block = async () => ({ hash: op, timestamp: BigInt(at) }); },
      f => { f.receipt.blockNumber = 150n; }, f => { f.receipt.logs = [...f.receipt.logs, ...f.receipt.logs]; },
      f => { f.row.gas_wei = "1"; }, f => { f.row.sponsored_gas_wei = "1"; },
      f => { f.row.gas_recorded_at = at + 1; },
    ];
    for (const mutate of mutations) {
      const f = fixture(); mutate(f);
      assert.equal(await recoverGasProof(f.row, f.chain, 4663, 200n), null);
    }
  });
  it("refuses conflicts with stored money while corroborating matching evidence", async () => {
    for (const [payer, amount, expected] of [
      ["owner", 0, false], ["owner", 2.4, false], ["owner", 2.5, true],
      ["sponsor", 2.5, false], ["sponsor", 0, true],
    ] as const) {
      const f = fixture(payer); f.row.gas_usdg = amount;
      assert.equal(Boolean(await recoverGasProof(f.row, f.chain, 4663, 200n)), expected);
    }
  });
});
