import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from "viem";
import { ENTRYPOINT } from "../../packages/core/src/index";
import { wrapSqlite } from "./db";
import { GAS_RECOVERY_SCHEMA, gasRecoveryAccounts, recordRecoveredGas, recoverGasProof, recoverSettledGas,
  type GasRecoveryChain, type GasRecoveryRow, type GasReceipt } from "./receipt-gas-recovery";

const account = `0x${"a".repeat(40)}` as Hex;
const tx = `0x${"1".repeat(64)}` as Hex;
const op = `0x${"2".repeat(64)}` as Hex;
const blockHash = `0x${"3".repeat(64)}` as Hex;
const abi = parseAbi(["event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"]);
const at = 1_790_000_000;
const zero = `0x${"0".repeat(40)}` as Hex;

function fixture(payer: "owner" | "sponsor" = "sponsor", status: "landed" | "reverted" = "landed",
  actualGasCost = 1_000_000_000_000_000n) {
  const row: GasRecoveryRow = { id: 1, agent_id: account, epoch: 2, status, tx_hash: tx, user_op_hash: op,
    user_op_nonce: "7", gas_wei: null, sponsored_gas_wei: null, gas_units: null, gas_usdg: null, gas_recorded_at: null };
  const receipt: GasReceipt = { transactionHash: tx, blockHash, blockNumber: 100n, status: "success", logs: [{
    address: ENTRYPOINT.v07,
    topics: encodeEventTopics({ abi, eventName: "UserOperationEvent", args: {
      userOpHash: op, sender: account, paymaster: payer === "owner" ? zero : `0x${"b".repeat(40)}`,
    } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
      [7n, status === "landed", actualGasCost, 200_000n]),
  }] };
  const chain: GasRecoveryChain = {
    chainId: async () => 4663, head: async () => 200n, receipt: async () => receipt,
    block: async () => ({ hash: blockHash, timestamp: BigInt(at) }),
    latestRound: async () => ({ roundId: 3n, priceUsd: 3000, updatedAt: at + 100 }),
    round: async id => ({ roundId: id, priceUsd: 2500, updatedAt: id === 1n ? at - 1000 : id === 2n ? at - 60 : at + 100 }),
  };
  return { row, receipt, chain };
}
function ledger(row: GasRecoveryRow) {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`CREATE TABLE agents (smart_account TEXT PRIMARY KEY, epoch INTEGER, chain_id INTEGER, beat_at INTEGER, created_at INTEGER);
    CREATE TABLE trades (id INTEGER PRIMARY KEY, agent_id TEXT, epoch INTEGER, status TEXT, tx_hash TEXT, user_op_hash TEXT,
      user_op_nonce TEXT, gas_wei TEXT, sponsored_gas_wei TEXT, gas_units TEXT, gas_usdg REAL, gas_recorded_at INTEGER,
      budget_settled_at INTEGER, amount_usdg REAL, decision_id TEXT, fill_cash_usdg REAL);
    ${GAS_RECOVERY_SCHEMA}`);
  raw.prepare("INSERT INTO agents VALUES (?,2,4663,100,1)").run(account);
  raw.prepare("INSERT INTO trades VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,9,'decision',8)")
    .run(row.id, row.agent_id, row.epoch, row.status, row.tx_hash, row.user_op_hash, row.user_op_nonce,
      row.gas_wei, row.sponsored_gas_wei, row.gas_units, row.gas_usdg, row.gas_recorded_at);
  return { raw, db: wrapSqlite(raw) };
}

describe("receipt-backed historical gas", () => {
  it("proves sponsored owner expense is zero without calling any price feed", async () => {
    const f = fixture();
    f.chain.latestRound = async () => { throw new Error("must not read a price"); };
    const p = await recoverGasProof(f.row, f.chain, 4663, 200n);
    assert.equal(p?.payer, "sponsor"); assert.equal(p?.usdg, 0); assert.equal(p?.at, at);
    assert.equal(p?.gasWei, "1000000000000000"); assert.equal(p?.gasUnits, "200000");
  });
  it("prices owner gas from the round actually in force, including reverted operations", async () => {
    const f = fixture("owner", "reverted");
    const p = await recoverGasProof(f.row, f.chain, 4663, 200n);
    assert.equal(p?.payer, "owner"); assert.equal(p?.usdg, 2.5);
    assert.equal(p?.price?.roundId, "2"); assert.equal(p?.price?.updatedAt, at - 60);
  });
  it("independently corroborates an existing owner cost before filling missing receipt evidence", async () => {
    const f = fixture("owner"); f.row.gas_usdg = 2.5;
    let priceReads = 0;
    const latestRound = f.chain.latestRound;
    f.chain.latestRound = async () => { priceReads++; return latestRound(); };
    const { raw, db } = ledger(f.row);
    try {
      const proof = await recoverGasProof(f.row, f.chain, 4663, 200n);
      assert.equal(priceReads, 1);
      assert.equal(proof?.usdg, 2.5);
      assert.equal(proof?.price?.roundId, "2");
      assert.equal(await recordRecoveredGas(db, f.row, proof!), true);
      assert.deepEqual({ ...raw.prepare("SELECT gas_usdg,gas_wei,gas_recorded_at FROM trades").get()! },
        { gas_usdg: 2.5, gas_wei: "1000000000000000", gas_recorded_at: at });
      const audit = raw.prepare("SELECT proof_json FROM gas_recovery_receipts").get() as { proof_json: string };
      assert.equal(JSON.parse(audit.proof_json).price.roundId, "2");
    } finally { raw.close(); }
  });
  it("refuses a conflicting recorded owner cost without enriching the row or writing an audit proof", async () => {
    for (const status of ["landed", "reverted"] as const) for (const stored of [0, 2.4, 2.500001]) {
      const f = fixture("owner", status); f.row.gas_usdg = stored;
      let priceReads = 0;
      const latestRound = f.chain.latestRound;
      f.chain.latestRound = async () => { priceReads++; return latestRound(); };
      const { raw, db } = ledger(f.row);
      try {
        const before = raw.prepare("SELECT * FROM trades").get();
        const result = await recoverSettledGas({ db, chain: f.chain, account, epoch: 2, chainId: 4663,
          record: (row, proof) => recordRecoveredGas(db, row, proof) });
        assert.equal(priceReads, 1, `${status}/${stored}: stored money cannot skip pricing`);
        assert.equal(result.recovered, 0);
        assert.deepEqual(raw.prepare("SELECT * FROM trades").get(), before);
        assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM gas_recovery_receipts").get() as { n: number }).n, 0);
      } finally { raw.close(); }
    }
  });
  it("refuses enrichment of a stored owner cost when its historical price cannot be corroborated", async () => {
    const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
      f => { f.chain.latestRound = async () => null; },
      f => { f.chain.latestRound = async () => { throw new Error("feed unavailable"); }; },
      f => { f.chain.latestRound = async () => ({ roundId: 1n, priceUsd: 2500, updatedAt: at - 7 * 3600 }); },
      f => { f.chain.round = async id => id === 3n ? null : ({ roundId: id, priceUsd: 2500, updatedAt: at - 60 }); },
    ];
    for (const mutate of mutations) {
      const f = fixture("owner"); f.row.gas_usdg = 2.5; mutate(f);
      assert.equal(await recoverGasProof(f.row, f.chain, 4663, 200n), null);
    }
    const f = fixture("owner"); f.row.gas_usdg = 2.5;
    f.chain.latestRound = async () => { throw new Error("another chain cannot use this feed"); };
    assert.equal(await recoverGasProof(f.row, f.chain, 46630, 200n), null);
  });
  it("proves a zero actual owner fee without a feed and refuses a conflicting stored expense", async () => {
    for (const stored of [null, 0, 2.5]) {
      const f = fixture("owner", "landed", 0n); f.row.gas_usdg = stored;
      let priceReads = 0;
      f.chain.latestRound = async () => { priceReads++; throw new Error("zero owner expense needs no price"); };
      const proof = await recoverGasProof(f.row, f.chain, 4663, 200n);
      if (stored === 2.5) assert.equal(proof, null);
      else { assert.equal(proof?.usdg, 0); assert.equal(proof?.gasWei, "0"); }
      assert.equal(priceReads, 0);
    }
  });
  it("corroborates sponsored zero owner expense without pricing while refusing stored owner costs", async () => {
    for (const stored of [0, 2.5]) {
      const f = fixture("sponsor"); f.row.gas_usdg = stored;
      let priceReads = 0;
      f.chain.latestRound = async () => { priceReads++; throw new Error("sponsored owner expense needs no price"); };
      const proof = await recoverGasProof(f.row, f.chain, 4663, 200n);
      if (stored === 0) { assert.equal(proof?.usdg, 0); assert.equal(proof?.payer, "sponsor"); }
      else assert.equal(proof, null);
      assert.equal(priceReads, 0);
    }
  });
  it("retains raw gas when historical pricing or its publication boundary is unavailable", async () => {
    const f = fixture("owner");
    f.chain.round = async id => id === 3n ? null : ({ roundId: id, priceUsd: 2500, updatedAt: at - 60 });
    assert.equal((await recoverGasProof(f.row, f.chain, 4663, 200n))?.usdg, null);
    f.chain.latestRound = async () => { throw new Error("RPC unavailable"); };
    assert.equal((await recoverGasProof(f.row, f.chain, 4663, 200n))?.gasWei, "1000000000000000");
  });
  it("retains an unpriced raw receipt with NULL owner cost and prices it on a later recovery pass", async () => {
    const f = fixture("owner"); const { raw, db } = ledger(f.row);
    try {
      const latestRound = f.chain.latestRound;
      f.chain.latestRound = async () => null;
      const opts = { db, chain: f.chain, account, epoch: 2, chainId: 4663,
        record: (row: GasRecoveryRow, proof: Parameters<typeof recordRecoveredGas>[2]) => recordRecoveredGas(db, row, proof) };
      assert.equal((await recoverSettledGas(opts)).recovered, 1);
      assert.deepEqual({ ...raw.prepare("SELECT gas_usdg,gas_wei,gas_recorded_at FROM trades").get()! },
        { gas_usdg: null, gas_wei: "1000000000000000", gas_recorded_at: at });
      const audit = raw.prepare("SELECT proof_json FROM gas_recovery_receipts").get() as { proof_json: string };
      assert.equal(JSON.parse(audit.proof_json).usdg, null);
      f.chain.latestRound = latestRound;
      assert.equal((await recoverSettledGas(opts)).recovered, 1);
      assert.equal((raw.prepare("SELECT gas_usdg FROM trades").get() as { gas_usdg: number }).gas_usdg, 2.5);
      assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM gas_recovery_receipts").get() as { n: number }).n, 2);
    } finally { raw.close(); }
  });
  it("never prices an old owner cost at a stale or future round", async () => {
    const f = fixture("owner");
    f.chain.latestRound = async () => ({ roundId: 1n, priceUsd: 2500, updatedAt: at - 7 * 3600 });
    assert.equal((await recoverGasProof(f.row, f.chain, 4663, 200n))?.usdg, null);
    f.chain.latestRound = async () => ({ roundId: 1n, priceUsd: 2500, updatedAt: at + 100 });
    f.chain.round = async () => null;
    assert.equal((await recoverGasProof(f.row, f.chain, 4663, 200n))?.usdg, null);
  });
  it("refuses wrong operation, sender, EntryPoint, nonce, tx, verdict, block hash and low finality", async () => {
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
    for (const mutate of mutations) { const f = fixture(); mutate(f); assert.equal(await recoverGasProof(f.row, f.chain, 4663, 200n), null); }
  });
  it("atomically preserves receipt proof without changing budget timestamps, verdicts, fills or attribution", async () => {
    const f = fixture(); const { raw, db } = ledger(f.row);
    try {
      const before = raw.prepare("SELECT status,budget_settled_at,amount_usdg,decision_id,fill_cash_usdg FROM trades").get();
      const proof = (await recoverGasProof(f.row, f.chain, 4663, 200n))!;
      assert.equal(await recordRecoveredGas(db, f.row, proof), true);
      assert.deepEqual(raw.prepare("SELECT status,budget_settled_at,amount_usdg,decision_id,fill_cash_usdg FROM trades").get(), before);
      assert.deepEqual({ ...raw.prepare("SELECT gas_wei,sponsored_gas_wei,gas_units,gas_usdg,gas_recorded_at FROM trades").get()! },
        { gas_wei: null, sponsored_gas_wei: "1000000000000000", gas_units: "200000", gas_usdg: 0, gas_recorded_at: at });
      assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM gas_recovery_receipts").get() as {n:number}).n, 1);
      assert.equal(await recordRecoveredGas(db, f.row, proof), false);
      assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM gas_recovery_receipts").get() as {n:number}).n, 1);
    } finally { raw.close(); }
  });
  it("rolls back enrichment if its durable audit proof cannot be committed", async () => {
    const f = fixture(); const { raw, db } = ledger(f.row);
    try {
      raw.exec("DROP TABLE gas_recovery_receipts");
      await assert.rejects(recordRecoveredGas(db, f.row, (await recoverGasProof(f.row, f.chain, 4663, 200n))!));
      assert.equal((raw.prepare("SELECT gas_usdg FROM trades").get() as {gas_usdg:null}).gas_usdg, null);
    } finally { raw.close(); }
  });
  it("refuses a concurrent evidence change, epoch reset, chain switch or changed operation", async () => {
    for (const sql of ["UPDATE trades SET gas_wei='12'", "UPDATE agents SET epoch=3", "UPDATE agents SET chain_id=46630",
      "UPDATE trades SET status='submitted'", "UPDATE trades SET epoch=3", "UPDATE trades SET user_op_nonce='99'"]) {
      const f = fixture(); const { raw, db } = ledger(f.row);
      try { const proof = (await recoverGasProof(f.row, f.chain, 4663, 200n))!; raw.exec(sql);
        assert.equal(await recordRecoveredGas(db, f.row, proof), false);
        assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM gas_recovery_receipts").get() as {n:number}).n, 0);
      } finally { raw.close(); }
    }
  });
  it("scans current idle and case-alias books and resets its cursor after the batch", async () => {
    const f = fixture(); const { raw, db } = ledger(f.row);
    try {
      raw.prepare("INSERT INTO agents VALUES (?,1,4663,1,1)").run(account.toUpperCase());
      assert.deepEqual(await gasRecoveryAccounts(db), [{ account, epoch: 2, chainId: 4663 }]);
      let calls = 0;
      const result = await recoverSettledGas({ db, chain: f.chain, account, epoch: 2, chainId: 4663, limit: 1,
        record: (row, proof) => { calls++; return recordRecoveredGas(db, row, proof); } });
      assert.equal(result.afterId, 1); assert.equal(result.recovered, 1); assert.equal(calls, 1);
      assert.equal((await recoverSettledGas({ db, chain: f.chain, account, epoch: 2, chainId: 4663, afterId: 1,
        record: () => { throw new Error("no writes"); } })).afterId, 0);
    } finally { raw.close(); }
  });
  it("an unavailable first receipt does not starve the next operation on a later pass", async () => {
    const f = fixture(); const { raw, db } = ledger(f.row);
    try {
      const nextTx = `0x${"4".repeat(64)}` as Hex;
      raw.prepare("INSERT INTO trades SELECT 2,agent_id,epoch,status,?,user_op_hash,user_op_nonce,gas_wei,sponsored_gas_wei,gas_units,gas_usdg,gas_recorded_at,budget_settled_at,amount_usdg,decision_id,fill_cash_usdg FROM trades WHERE id=1").run(nextTx);
      f.chain.receipt = async hash => {
        if (hash === tx) throw new Error("old receipt unavailable");
        return { ...f.receipt, transactionHash: nextTx };
      };
      const opts = { db, chain: f.chain, account, epoch: 2, chainId: 4663, limit: 1,
        record: (row: GasRecoveryRow, proof: Parameters<typeof recordRecoveredGas>[2]) => recordRecoveredGas(db, row, proof) };
      const first = await recoverSettledGas(opts);
      assert.equal(first.afterId, 1); assert.equal(first.recovered, 0);
      const second = await recoverSettledGas({ ...opts, afterId: first.afterId });
      assert.equal(second.afterId, 2); assert.equal(second.recovered, 1);
      assert.equal((raw.prepare("SELECT gas_usdg FROM trades WHERE id=1").get() as {gas_usdg:null}).gas_usdg, null);
      assert.equal((raw.prepare("SELECT gas_usdg FROM trades WHERE id=2").get() as {gas_usdg:number}).gas_usdg, 0);
    } finally { raw.close(); }
  });
  it("checks actual RPC chain and bounds a hanging receipt before any write", async () => {
    const f = fixture(); const { raw, db } = ledger(f.row);
    try {
      let wrote = false;
      const opts = { db, chain: f.chain, account, epoch: 2, chainId: 4663, record: async () => { wrote = true; return true; } };
      f.chain.chainId = async () => 46630;
      assert.equal((await recoverSettledGas(opts)).recovered, 0);
      f.chain.chainId = async () => 4663;
      f.chain.receipt = () => new Promise(() => {});
      assert.equal((await recoverSettledGas({ ...opts, budgetMs: 10 })).recovered, 0);
      assert.equal(wrote, false);
    } finally { raw.close(); }
  });
});
