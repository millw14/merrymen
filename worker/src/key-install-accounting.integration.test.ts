import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from "viem";
import { UserOpReverted, UserOpUnresolved, type AgentExecutor, type UserOpGasProof } from "./executor";
import { installKeyRecorded, settleKeyInstall } from "./key-install-accounting";
import { resolveSubmittedOps, type ReconcileChain } from "./inflight-reconcile";
import { KEY_INSTALL_KIND } from "./telegram/trade-rows";

const home = mkdtempSync(path.join(tmpdir(), "merrymen-key-install-accounting-"));
process.env.MERRYMEN_HOME = home;
const { addTrade, closeStoreForTest, initStore, listSubmittedOps, getOpsToday, getGasPaidUsdg, readJournal } = await import("./store");
const { homePaths } = await import("./home");
const ACCOUNT = "0x1111111111111111111111111111111111111111" as const;
const SPONSOR = "0x5555555555555555555555555555555555555555" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const GAS = 123456789000000n;
const UNITS = 12000000n;
let next = 0;
before(initStore);
after(() => { closeStoreForTest(); rmSync(home, { recursive: true, force: true }); });

type Stored = { kind: string; status: string; tx_hash: string | null; gas_wei: string | null;
  sponsored_gas_wei: string | null; gas_usdg: number | null; gas_units: string | null; user_op_nonce: string | null };
function rows(agent: string): Stored[] {
  const db = new DatabaseSync(homePaths.db());
  try { return db.prepare("SELECT kind,status,tx_hash,gas_wei,sponsored_gas_wei,gas_usdg,gas_units,user_op_nonce FROM trades WHERE agent_id = ?").all(agent) as Stored[]; }
  finally { db.close(); }
}

function scenario(mode: "success" | "revert" | "unresolved", payer: "owner" | "sponsor") {
  const id = ++next;
  const agent = `install-agent-${id}`;
  const hash = h(id);
  const proof: UserOpGasProof = { txHash: h(id + 1000), gasWei: GAS, gasUnits: UNITS, gasPayer: payer };
  const events: Array<{ level: string; message: string }> = [];
  let sends = 0;
  let prices = 0;
  const executor: AgentExecutor = {
    address: ACCOUNT,
    execute: async () => { throw new Error("a trade may never be substituted for an install"); },
    installKey: async (hooks) => {
      assert.ok(hooks?.onSubmitted);
      await hooks.onSubmitted(hash, { nonce: 0n });
      assert.equal(rows(agent)[0]?.status, "submitted", "the real ledger commits before broadcast");
      sends++;
      if (mode === "unresolved") throw new UserOpUnresolved(hash, "receipt unavailable");
      if (mode === "revert") throw new UserOpReverted(hash, "execution reverted", proof);
      return { txHash: proof.txHash, userOpHash: hash, logs: [], blockNumber: 100n, gasWei: GAS, gasUnits: UNITS, gasPayer: payer };
    },
  };
  const deps = {
    addTrade,
    priceGas: async () => { prices++; return 0.25; },
    refreshBudget: async () => { await getOpsToday(agent); },
    event: async (level: "ok" | "warn" | "err", message: string) => { events.push({ level, message }); },
    resolveMinutes: 5,
  };
  return { agent, hash, proof, executor, deps, events, sends: () => sends, prices: () => prices };
}

function chainFor(s: ReturnType<typeof scenario>, success: boolean): ReconcileChain {
  const abi = parseAbi(["event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"]);
  const topics = encodeEventTopics({ abi, eventName: "UserOperationEvent", args: {
    userOpHash: s.hash, sender: ACCOUNT, paymaster: s.proof.gasPayer === "sponsor" ? SPONSOR : ZERO,
  } });
  const data = encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [0n, success, GAS, UNITS]);
  return {
    getBlockNumber: async () => 100n,
    getLogs: async () => [{ topics: topics as readonly Hex[], data, transactionHash: s.proof.txHash, blockNumber: "0x64" }],
    getReceiptLogs: async () => null, // Cost and payer proof survive even an unreadable transaction receipt.
  };
}

describe("key installation expenses survive execution and recovery", () => {
  for (const payer of ["owner", "sponsor"] as const) {
    for (const mode of ["success", "revert"] as const) {
      it(`records the ${payer}'s known cost for a direct ${mode}, keeping one setup row and journal`, async () => {
        const s = scenario(mode, payer);
        await installKeyRecorded(s.deps, s.agent, s.executor);
        const saved = rows(s.agent);
        assert.equal(saved.length, 1);
        assert.equal(saved[0]!.kind, KEY_INSTALL_KIND);
        assert.equal(saved[0]!.status, mode === "success" ? "landed" : "reverted");
        assert.equal(saved[0]!.tx_hash, s.proof.txHash);
        assert.equal(saved[0]!.gas_wei, payer === "owner" ? GAS.toString() : null);
        assert.equal(saved[0]!.sponsored_gas_wei, payer === "sponsor" ? GAS.toString() : null);
        assert.equal(saved[0]!.gas_units, UNITS.toString());
        assert.equal(saved[0]!.gas_usdg, payer === "owner" ? 0.25 : null);
        assert.equal(saved[0]!.user_op_nonce, "0");
        assert.equal(s.prices(), payer === "owner" ? 1 : 0);
        assert.equal(s.sends(), 1);
        assert.equal((await listSubmittedOps(s.agent)).length, 0);
        const journal = await readJournal(s.agent, 1);
        assert.equal(journal.length, 1, "a reverted setup still spent gas and belongs in the financial record");
        const payload = JSON.parse(journal[0]!.payload_json);
        assert.equal(payload.gasWei, saved[0]!.gas_wei);
        assert.equal(payload.sponsoredGasWei, saved[0]!.sponsored_gas_wei);
        assert.equal((await getGasPaidUsdg(s.agent)).usdg, payer === "owner" ? 0.25 : 0);
      });
    }

    for (const success of [true, false]) {
      it(`recovers ${payer} gas after an unread receipt and restart, for ${success ? "landed" : "reverted"} setup without rebroadcast`, async () => {
        const s = scenario("unresolved", payer);
        await installKeyRecorded(s.deps, s.agent, s.executor);
        assert.equal(rows(s.agent)[0]!.status, "submitted");
        assert.equal(s.sends(), 1);
        closeStoreForTest();
        await initStore();
        const pending = await listSubmittedOps(s.agent);
        const settled = await resolveSubmittedOps({ chain: chainFor(s, success), smartAccount: ACCOUNT,
          usdgToken: ZERO, hashes: pending.map((r) => r.userOpHash), lookbackBlocks: 100n });
        assert.equal(settled.length, 1);
        const result = settled[0]!;
        assert.equal(result.gasWei, GAS);
        assert.equal(result.gasUnits, UNITS);
        assert.equal(result.gasPayer, payer);
        assert.equal(await settleKeyInstall({ addTrade }, s.agent, { userOpHash: result.userOpHash, success: result.success,
          proof: { ...result, txHash: result.txHash as Hex } }), true);
        // A delayed receipt waiter observing the same result must not create a
        // second setup row, op count, gas charge or hash-chain entry.
        assert.equal(await settleKeyInstall({ addTrade }, s.agent, { userOpHash: result.userOpHash, success: result.success,
          proof: { ...result, txHash: result.txHash as Hex } }), true);
        const saved = rows(s.agent);
        assert.equal(saved.length, 1);
        assert.equal(saved[0]!.kind, KEY_INSTALL_KIND);
        assert.equal(saved[0]!.status, success ? "landed" : "reverted");
        assert.equal(saved[0]!.gas_wei, payer === "owner" ? GAS.toString() : null);
        assert.equal(saved[0]!.sponsored_gas_wei, payer === "sponsor" ? GAS.toString() : null);
        assert.equal(saved[0]!.gas_usdg, null, "the current ETH price cannot replace the missing execution-time price");
        assert.equal((await getGasPaidUsdg(s.agent)).unpricedTrades, payer === "owner" ? 1 : 0);
        assert.equal((await readJournal(s.agent, 1)).length, 1);
        assert.equal(await getOpsToday(s.agent), success ? 1 : 0);
        assert.equal(s.sends(), 1, "the recovery path has no signer and never resends");
      });
    }
  }

  it("does not broadcast when the pre-broadcast row fails, and does not announce a completed install", async () => {
    const s = scenario("success", "owner");
    await installKeyRecorded({ ...s.deps, addTrade: async () => false }, s.agent, s.executor);
    assert.equal(s.sends(), 0);
    assert.deepEqual(rows(s.agent), []);
    assert.ok(s.events.every((e) => e.level !== "ok"));
  });

  it("a failed landed write stays submitted and recovers its cost later, without a false success or replay", async () => {
    const s = scenario("success", "owner");
    await installKeyRecorded({ ...s.deps, addTrade: async (row) => row.status === "submitted" ? addTrade(row) : false }, s.agent, s.executor);
    assert.equal(rows(s.agent)[0]!.status, "submitted");
    assert.ok(s.events.every((e) => e.level !== "ok"));
    assert.match(s.events.at(-1)!.message, /resolver will settle/);
    assert.equal(s.sends(), 1);
    assert.equal(await settleKeyInstall({ addTrade: async () => false }, s.agent, { userOpHash: s.hash, success: true, proof: s.proof }), false);
    assert.equal(rows(s.agent)[0]!.status, "submitted", "a failed recovery write retains its next opportunity to settle");
    assert.equal(await settleKeyInstall({ addTrade }, s.agent, { userOpHash: s.hash, success: true, proof: s.proof }), true);
    assert.equal(rows(s.agent).length, 1);
    assert.equal(rows(s.agent)[0]!.gas_wei, GAS.toString());
    assert.equal(s.sends(), 1);
  });

  it("an old reverted error with no cost proof stays recoverable rather than erasing its expense", async () => {
    const s = scenario("revert", "owner");
    s.executor.installKey = async (hooks) => {
      await hooks!.onSubmitted!(s.hash, { nonce: 0n });
      throw new UserOpReverted(s.hash, "legacy receipt without gas");
    };
    await installKeyRecorded(s.deps, s.agent, s.executor);
    assert.equal(rows(s.agent)[0]!.status, "submitted");
    assert.ok(s.events.every((e) => e.level !== "ok"));
  });
});
