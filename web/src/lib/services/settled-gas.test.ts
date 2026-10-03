import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { wrapSqlite, type Db } from "../../../../worker/src/db";
import { applyLedgerSchema } from "../../../../worker/src/store";
import { ledgerScope, readPerformance } from "./portfolio";
import { buildExport, readReportSummary } from "./reports";

const ACCOUNT = "0xa6e17a1b2c3d4e5f60718293a4b5c6d7e8f90123";
const OTHER = "0xb6e17a1b2c3d4e5f60718293a4b5c6d7e8f90123";
const NOW = 1_800_000_000;
const SINCE = NOW - 86_400;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const clean = (s: string | null | undefined) => s == null ? null : String(s);

async function ledger(): Promise<{ raw: DatabaseSync; db: Db }> {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  await db.prepare(`INSERT INTO agents
    (smart_account,name,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,status,mode,beat_at,epoch)
    VALUES (?, 'Agent', '0x1', '0x2', 4663, '{}', 0, 4102444800, 'active', 'live', ?, 2)`)
    .run(ACCOUNT, NOW - 30);
  return { raw, db };
}

async function operation(db: Db, id: number, status: string, o: {
  gas?: number; wei?: string; sponsor?: string; account?: string; at?: number; epoch?: number;
  hash?: string; proof?: boolean; kind?: string;
} = {}): Promise<void> {
  await db.prepare(`INSERT INTO trades
    (id,agent_id,kind,target,amount_usdg,status,tx_hash,user_op_hash,gas_usdg,gas_wei,sponsored_gas_wei,epoch,created_at)
    VALUES (?, ?, ?, '0x1', 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, o.account ?? ACCOUNT, o.kind ?? "key-install", status, o.proof === false ? null : tx(id),
      o.hash ?? null, o.gas ?? null, o.wei ?? null, o.sponsor ?? null, o.epoch ?? 2, o.at ?? NOW - 100 + id);
}

async function summary(db: Db) {
  return readReportSummary(db, { accounts: [ACCOUNT], currentAccount: ACCOUNT, since: SINCE, until: NOW,
    now: NOW, permissionExpiresAt: null, settings: null }, clean);
}

async function seedMixed(db: Db): Promise<void> {
  await operation(db, 1, "landed", { gas: 2, wei: "200" });
  await operation(db, 2, "reverted", { gas: 0.5, wei: "50", hash: tx(200).toUpperCase() });
  await operation(db, 3, "reverted", { wei: "70" });
  await operation(db, 4, "reverted", { sponsor: "80" });
  await operation(db, 5, "reverted", { proof: false });
  // Stray expense fields on unsettled/refused/simulated rows are not proof of a paid operation.
  await operation(db, 6, "submitted", { gas: 666, wei: "666" });
  await operation(db, 7, "rejected", { gas: 777, wei: "777" });
  await operation(db, 8, "paper", { kind: "swap", gas: 888, wei: "888" });
  await operation(db, 9, "reverted", { kind: "swap", hash: tx(200) });
  await operation(db, 10, "reverted", { account: OTHER, gas: 999, wei: "999" });
  await operation(db, 11, "reverted", { epoch: 1, at: SINCE - 1, gas: 111, wei: "111" });
  await operation(db, 12, "reverted", { at: NOW + 1, gas: 222, wei: "222" });
}

test("report and portfolio include proved reverted expenses without changing operation outcomes or scope", async () => {
  const { raw, db } = await ledger();
  try {
    await seedMixed(db);
    const report = await summary(db);
    assert.deepEqual({ ...report.live.gas, notes: [] }, {
      usdg: 2.5, complete: false, priced_ops: 2, unpriced_ops: 1, sponsored_ops: 1, unrecorded_ops: 1, notes: [],
    });
    assert.equal(report.live.trades.confirmed_count, 1);
    assert.equal(report.live.trades.submitted_count, 1);
    assert.equal(report.live.trades.reverted_count, 4);
    assert.equal(report.paper.trades.paper_fill_count, 1);
    assert.ok(report.live.gas.notes.some((n) => /settled.*paid gas.*could not be priced/.test(n)));
    assert.ok(report.live.gas.notes.some((n) => /sponsor paid their gas, not the owner/.test(n)));
    assert.ok(report.live.gas.notes.some((n) => /floor/.test(n)));

    const performance = await readPerformance(db, ledgerScope([ACCOUNT], ACCOUNT, 4663), "day", NOW);
    assert.equal(performance.live.gas_usdg, 2.5);
    assert.equal(performance.live.gas_unpriced_ops, 1);
    assert.equal(performance.live.gas_unrecorded_ops, 1);
    assert.equal(performance.live.gas_sponsored_ops, 1);
    assert.equal(performance.live.gas_complete, false);
    assert.equal(performance.live.ops.confirmed, 1);
    assert.equal(performance.live.ops.failed, 4);
    assert.equal(performance.live.ops.submitted, 1);
    assert.equal(performance.paper.ops.paper_fills, 1);
    assert.equal(performance.paper.gas_usdg, 0);
    assert.ok(performance.live.caveats.some((n) => /settled.*paid gas.*could not be priced/.test(n)));
  } finally { raw.close(); }
});

test("a reverted expense with no USDG price or no proof stays unknown; sponsor-paid reverted gas is zero owner expense", async () => {
  for (const [record, unpriced, missing, sponsored, expected] of [
    [{ wei: "70" }, 1, 0, 0, null],
    [{ proof: false }, 0, 1, 0, null],
    [{ sponsor: "80" }, 0, 0, 1, 0],
  ] as const) {
    const { raw, db } = await ledger();
    try {
      await operation(db, 1, "reverted", record);
      const report = await summary(db);
      assert.equal(report.live.gas.usdg, expected);
      assert.equal(report.live.gas.complete, expected === 0);
      assert.equal(report.live.gas.unpriced_ops, unpriced);
      assert.equal(report.live.gas.unrecorded_ops, missing);
      assert.equal(report.live.gas.sponsored_ops, sponsored);
      assert.equal(report.live.trades.confirmed_count, 0);
      assert.equal(report.live.trades.reverted_count, 1);
      const live = (await readPerformance(db, ledgerScope([ACCOUNT], ACCOUNT, 4663), "day", NOW)).live;
      assert.equal(live.gas_usdg, expected);
      assert.equal(live.gas_complete, expected === 0);
      assert.equal(live.gas_unpriced_ops, unpriced);
      assert.equal(live.gas_unrecorded_ops, missing);
      assert.equal(live.gas_sponsored_ops, sponsored);
      assert.equal(live.ops.confirmed, 0);
      assert.equal(live.ops.failed, 1);
    } finally { raw.close(); }
  }
});

test("CSV retains reverted priced, unpriced and sponsor gas while pending, refused and paper costs stay excluded", async () => {
  const { raw, db } = await ledger();
  try {
    await seedMixed(db);
    const csv = await buildExport(db, { kind: "trades", format: "csv", agentSlug: "agent", accounts: [ACCOUNT],
      since: SINCE, until: NOW, now: NOW, includeRefusals: true }, clean);
    const [head, ...lines] = csv.content.trim().split("\r\n");
    const columns = head!.split(",");
    const rows = lines.map((line) => Object.fromEntries(line.split(",").map((cell, i) => [columns[i]!, cell])));
    const row = (id: number) => rows.find((r) => r.tx_hash === tx(id));
    assert.equal(csv.rows, 8, "no foreign, out-of-window or canonical copy rows");
    assert.equal(row(2)?.status, "reverted");
    assert.equal(row(2)?.confirmed, "false");
    assert.equal(row(2)?.gas_usdg, "0.5");
    assert.equal(row(2)?.gas_status, "priced");
    assert.equal(row(3)?.gas_usdg, "");
    assert.equal(row(3)?.gas_status, "unpriced");
    assert.equal(row(4)?.gas_usdg, "");
    assert.equal(row(4)?.gas_status, "sponsored");
    assert.equal(rows.find((r) => r.tx_hash === "" && r.status === "reverted")?.gas_status, "not_recorded");
    for (const id of [6, 7, 8]) {
      assert.equal(row(id)?.gas_usdg, "");
      assert.equal(row(id)?.gas_status, "none");
    }
    assert.ok(csv.notes.some((n) => /revert can pay gas without confirming a trade/.test(n)));
  } finally { raw.close(); }
});
