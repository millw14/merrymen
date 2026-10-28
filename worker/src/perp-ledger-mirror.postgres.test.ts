/**
 * THE PAPER PERP BOOK'S DURABLE PATH, ON A REAL POSTGRES — opt-in, disposable
 * and LOCAL (MERRYMEN_TEST_PG_URL / MERRYMEN_TEST_POSTGRES_URL). Never reads
 * DATABASE_URL.
 *
 * What sqlite cannot show and these do:
 *   mirror      the keyset cursor's CASE upsert, the qualified rank CASE in
 *               every guarded UPDATE, the transfer SAVEPOINT (a unique
 *               violation rolled back alone, where Postgres would otherwise
 *               abort the batch), hasMore, the own-account filter, and a
 *               missing perps_grants asked of the catalogue inside a
 *               transaction without aborting it; and the snapshots' tie
 *               rule, IS DISTINCT FROM against typed columns.
 *   checkpoint  perp_json added by applyLedgerMigrations' bounded ADD
 *               COLUMN, upserted with NULL and without; the restore's
 *               staleness check against the mirrored tape; the upgrade path's
 *               perp identity and paperPeakBasis's double-precision cast;
 *               the held reset's perp clauses inside its transaction.
 *   import      a Perps worker's book captured, staged and restored, bound to
 *               perps_grants (xmin, FOR SHARE) through its catalogue probe.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { wrapSqlite, translateQuery, translateSchema, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL, mirrorTenant, tenantGrantAccount } from "./ledger-mirror";
import { ensurePaperCheckpointSchema, mirrorPaperCheckpoints, resetBlockedPaperBook, restorePaperCheckpoint } from "./paper-checkpoint";
import { leaseKey, type TenantLease } from "./tenant-lease";
import { captureLedgerImport, restoreLedgerImport, stageLedgerImport, verifyRestoredLedgerImport, type LedgerImportVolume } from "./ledger-import";
import { workerKey } from "./worker-key";

interface Client {
  connect(): Promise<void>; end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  on(event: "error" | "end", fn: () => void): void;
}
const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
const pg = url ? createRequire(import.meta.url)("pg") as {
  Client: new (config: { connectionString: string }) => Client;
  types: { setTypeParser(id: number, fn: (s: string) => unknown): void };
} : null;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const dek = Buffer.alloc(32, 81);

test("Postgres: the paper perp book's mirror, checkpoint and import", { skip: !url, timeout: 60_000 }, async (t) => {
  const target = new URL(url!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "only a disposable LOCAL PostgreSQL is allowed");
  pg!.types.setTypeParser(20, Number);
  const schema = `mm_perp_ledger_${randomBytes(8).toString("hex")}`;
  const admin = new pg!.Client({ connectionString: target.toString() });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(target);
  scoped.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=8000`);
  const clients: Client[] = [], raws: DatabaseSync[] = [], tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mm-perp-pg-")));
  const connect = async () => {
    const c = new pg!.Client({ connectionString: scoped.toString() });
    await c.connect();
    clients.push(c);
    return c;
  };
  const main = await connect();
  const wrap = (client: Client, scopedTransaction = false): Db => ({
    prepare(sql) {
      return {
        async run(...args) { const r = await client.query(translateQuery(sql), args.map((a) => (typeof a === "bigint" ? String(a) : a))); return { changes: r.rowCount ?? 0, lastInsertRowid: 0 }; },
        async get(...args) { return (await client.query(translateQuery(sql), args)).rows[0]; },
        async all(...args) { return (await client.query(translateQuery(sql), args)).rows; },
      };
    },
    async exec(sql) { await client.query(translateSchema(sql)); },
    async tx(fn) {
      if (scopedTransaction) throw new Error("nested transaction");
      const c = await connect();
      await c.query("BEGIN");
      try { const result = await fn(wrap(c, true)); await c.query("COMMIT"); return result; }
      catch (e) { await c.query("ROLLBACK"); throw e; }
    },
  });
  const shared = wrap(main);
  await applyLedgerSchema(shared);
  await shared.exec(MIRROR_STATE_DDL);
  t.after(async () => {
    for (const raw of raws) raw.close();
    await Promise.allSettled(clients.map((c) => c.end()));
    try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); rmSync(tmp, { recursive: true, force: true }); }
  });
  const q = async (sql: string, params: unknown[] = []) => (await main.query(sql, params)).rows;
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
  /** A child ledger: the worker's own sqlite, with the real schema. */
  async function childLedger(): Promise<{ raw: DatabaseSync; db: Db }> {
    const raw = new DatabaseSync(":memory:");
    raws.push(raw);
    const db = wrapSqlite(raw);
    await applyLedgerSchema(db);
    return { raw, db };
  }
  const walletTable = (table: string) => `CREATE TABLE IF NOT EXISTS ${table} (tenant TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, grant_json JSONB NOT NULL,
    sealed_session_key TEXT NOT NULL, updated_at BIGINT NOT NULL)`;
  let n = 0;

  await t.test("a missing perps_grants is no account, asked of the catalogue: the caller's transaction carries on", async () => {
    const key = workerKey(address(0xa0001), "perps");
    const answer = await shared.tx(async (db) => {
      const account = await tenantGrantAccount(db, key);
      // Would throw "current transaction is aborted" had the read above failed.
      const after = await db.prepare("SELECT 1 AS ok").get() as { ok: number };
      return { account, ok: after.ok };
    });
    assert.deepEqual(answer, { account: null, ok: 1 });
  });

  // From here on the Perps wallets' table exists, as the first Perps put makes it.
  await main.query(walletTable("grants"));
  await main.query(walletTable("perps_grants"));
  const putGrant = (table: string, owner: string, account: string) =>
    main.query(`INSERT INTO ${table} (tenant, chain_id, grant_json, sealed_session_key, updated_at) VALUES ($1, 4663, $2, 'sealed', $3)`,
      [owner, JSON.stringify({ smartAccount: account, owner, chainId: 4663 }), Date.now()]);

  await t.test("the mirror: keyset and hasMore, the rank guard, the transfer savepoint, the own account and the flatten", async () => {
    const id = ++n, owner = address(0xb000 + id), account = address(0xc000 + id), other = address(0xd000 + id);
    const tenant = workerKey(owner, "perps");
    await putGrant("perps_grants", owner, account);
    const child = await childLedger();
    // A funding burst past PERP_MAX_PAGES × batch.
    for (let i = 0; i < 101; i++) {
      child.raw.prepare("INSERT INTO perp_funding (agent_id, mode, epoch, market_id, funding_id, funding_hour, payment_micro, created_at) VALUES (?, 'paper', 1, 1, ?, ?, '-1', ?)")
        .run(account, `f${i}`, 3600 * (i + 1), 6000 + i);
    }
    child.raw.prepare("INSERT INTO perp_funding (agent_id, mode, epoch, market_id, funding_id, funding_hour, payment_micro, created_at) VALUES (?, 'paper', 1, 1, 'theirs', 3600, '-1', 6000)").run(other);
    child.raw.prepare(`INSERT INTO perp_orders (id, agent_id, mode, epoch, nonce, status, effect, reduce_only, market_id, worst_notional_micro, created_at, updated_at)
      VALUES ('o1', ?, 'paper', 1, 1, 'submitted', 'open', 0, 1, '100', 6000, 6000)`).run(account);
    child.raw.prepare(`INSERT INTO perp_positions (agent_id, mode, market_id, side, base, entry_price, allocated_margin_micro, imf_bp, margin_mode,
        stop_trigger, stop_price, recorded_stop_trigger, recorded_stop_price, funding_hour_applied, opened_at, updated_at, source)
      VALUES (?, 'paper', 1, 'long', '20', '800000', '8000000', 5000, 'isolated', NULL, NULL, '760000', '744800', 3600, 6000, 6000, 'paper')`).run(account);
    child.raw.prepare("INSERT INTO perp_accounts (agent_id, mode, nonce_high_water, paper_collateral_micro, updated_at) VALUES (?, 'paper', '1790000000001', '0', 6000)").run(account);

    const first = await mirrorTenant({ tenant, child: child.db, shared, batch: 5, nowSec: 7000 });
    assert.equal(first.failed, undefined, JSON.stringify(first.failed));
    assert.equal(first.hasMore, true, "a burst past the pass's pages says so");
    assert.equal(first.copied.perp_funding_foreign, 1);
    const second = await mirrorTenant({ tenant, child: child.db, shared, batch: 5, nowSec: 7001 });
    assert.equal(second.failed, undefined, JSON.stringify(second.failed));
    assert.equal(second.hasMore, undefined);
    assert.equal((await one("SELECT COUNT(*) AS n FROM perp_funding WHERE agent_id = $1", [account]))!.n, 101);
    assert.equal((await one("SELECT COUNT(*) AS n FROM perp_funding WHERE agent_id = $1", [other]))!.n, 0, "never another account's");
    const mark = await one("SELECT last_id, last_stamp FROM mirror_state WHERE tenant = $1 AND table_name = 'perp_funding'", [tenant]);
    assert.equal(mark!.last_id, 6100);
    assert.deepEqual(await one("SELECT recorded_stop_trigger, recorded_stop_price FROM perp_positions WHERE agent_id = $1", [account]), { recorded_stop_trigger: "760000", recorded_stop_price: "744800" });

    // The rank guard, through its qualified CASE: forward, and never back.
    child.raw.exec("UPDATE perp_orders SET status = 'filled', filled_base = '20', updated_at = 6200");
    await mirrorTenant({ tenant, child: child.db, shared, nowSec: 7002 });
    child.raw.exec("UPDATE perp_orders SET status = 'submitted', updated_at = 6300");
    await mirrorTenant({ tenant, child: child.db, shared, nowSec: 7003 });
    assert.equal((await one("SELECT status FROM perp_orders WHERE id = 'o1'"))!.status, "filled");

    // The savepoint: a unique violation the resolution did not foresee is rolled back ALONE.
    await main.query("CREATE UNIQUE INDEX test_only_order ON perp_transfers (order_id) WHERE order_id IS NOT NULL");
    const transfer = (row: Record<string, string | number>) => {
      const cols = Object.keys(row);
      child.raw.prepare(`INSERT INTO perp_transfers (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(Object.values(row) as never[]));
    };
    const base = { agent_id: account, mode: "paper", epoch: 1, direction: "deposit", initiator: "agent" };
    transfer({ ...base, id: "ta", amount_micro: "5000000", state: "credited", order_id: "x1", created_at: 7000, updated_at: 7000 });
    transfer({ ...base, id: "tb", amount_micro: "7000000", state: "landed", created_at: 7001, updated_at: 7001 });
    await mirrorTenant({ tenant, child: child.db, shared, nowSec: 7010 });
    child.raw.exec("UPDATE perp_transfers SET order_id = 'x1', state = 'credited', updated_at = 7100 WHERE id = 'tb'");
    transfer({ ...base, id: "tc", amount_micro: "3000000", state: "credited", created_at: 7101, updated_at: 7101 });
    const savepoint = await mirrorTenant({ tenant, child: child.db, shared, nowSec: 7110 });
    assert.equal(savepoint.failed, undefined, JSON.stringify(savepoint.failed));
    assert.equal(savepoint.copied.perp_transfers_conflict, 1, "counted, never failed");
    assert.equal((await one("SELECT state FROM perp_transfers WHERE id = 'tb'"))!.state, "landed", "rolled back alone");
    assert.ok(await one("SELECT 1 AS ok FROM perp_transfers WHERE id = 'tc'"), "and the batch after it committed");

    // The flatten, on evidence, recorded stop and all.
    child.raw.exec("DELETE FROM perp_positions");
    child.raw.exec("UPDATE perp_accounts SET updated_at = 7200");
    await mirrorTenant({ tenant, child: child.db, shared, nowSec: 7201 });
    assert.deepEqual(await one("SELECT base, side, recorded_stop_trigger, recorded_stop_price FROM perp_positions WHERE agent_id = $1", [account]),
      { base: "0", side: null, recorded_stop_trigger: null, recorded_stop_price: null });
    assert.equal((await one("SELECT nonce_high_water FROM perp_accounts WHERE agent_id = $1", [account]))!.nonce_high_water, "1790000000001");
  });

  await t.test("a tie goes to the child: a position closed in the second a pass copied it open goes flat, and its account learns the credit", async () => {
    const id = ++n, owner = address(0xb000 + id), account = address(0xc000 + id);
    const tenant = workerKey(owner, "perps");
    await putGrant("perps_grants", owner, account);
    const child = await childLedger();
    child.raw.prepare(`INSERT INTO perp_positions (agent_id, mode, market_id, side, base, entry_price, allocated_margin_micro, imf_bp, margin_mode,
        stop_trigger, stop_price, recorded_stop_trigger, recorded_stop_price, funding_hour_applied, opened_at, updated_at, source)
      VALUES (?, 'paper', 1, 'long', '20', '800000', '8000000', 5000, 'isolated', '760000', '744800', '760000', '744800', 3600, 8000, 8100, 'paper')`).run(account);
    child.raw.prepare("INSERT INTO perp_accounts (agent_id, mode, nonce_high_water, paper_collateral_micro, updated_at) VALUES (?, 'paper', '1790000000001', '0', 8100)").run(account);
    const open = await mirrorTenant({ tenant, child: child.db, shared, nowSec: 8100 });
    assert.equal(open.failed, undefined, JSON.stringify(open.failed));
    // The stop fires within second 8100: flat in place, its loss realised
    // (NULL → a value, and levels → NULL: IS DISTINCT FROM against typed
    // columns, both ways), the collateral credited, every stamp unmoved.
    child.raw.exec(`UPDATE perp_positions SET side = NULL, base = '0', allocated_margin_micro = '0', entry_price = NULL, stop_trigger = NULL,
      stop_price = NULL, recorded_stop_trigger = NULL, recorded_stop_price = NULL, opened_at = NULL, realized_micro = '-1200000'`);
    child.raw.exec("UPDATE perp_accounts SET paper_collateral_micro = '6800000'");
    const closed = await mirrorTenant({ tenant, child: child.db, shared, nowSec: 8115 });
    assert.equal(closed.failed, undefined, JSON.stringify(closed.failed));
    assert.equal(closed.copied.perp_positions, 1);
    assert.equal(closed.copied.perp_accounts, 1);
    assert.deepEqual(await one("SELECT side, base, stop_trigger, recorded_stop_trigger, recorded_stop_price, realized_micro, updated_at FROM perp_positions WHERE agent_id = $1", [account]),
      { side: null, base: "0", stop_trigger: null, recorded_stop_trigger: null, recorded_stop_price: null, realized_micro: "-1200000", updated_at: 8100 });
    assert.equal((await one("SELECT paper_collateral_micro FROM perp_accounts WHERE agent_id = $1", [account]))!.paper_collateral_micro, "6800000");
    const again = await mirrorTenant({ tenant, child: child.db, shared, nowSec: 8130 });
    assert.equal(again.failed, undefined, JSON.stringify(again.failed));
    assert.equal(again.copied.perp_positions, undefined, "a tie that says nothing new is not rewritten");
    assert.equal(again.copied.perp_accounts, undefined);
  });

  await t.test("a Spot child beside it: no shared perp table is read or written", async () => {
    const id = ++n, owner = address(0xb000 + id), account = address(0xc000 + id);
    await putGrant("grants", owner, account);
    const child = await childLedger();
    child.raw.prepare("INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at) VALUES (?, ?, 's', 4663, '{}', 0, 0)").run(account, owner);
    const seen: string[] = [];
    const recording = (db: Db): Db => ({
      prepare(sql) { seen.push(sql); return db.prepare(sql); },
      exec(sql) { seen.push(sql); return db.exec(sql); },
      tx(fn) { return db.tx((inner) => fn(recording(inner))); },
    });
    const r = await mirrorTenant({ tenant: workerKey(owner, "spot"), child: child.db, shared: recording(shared) });
    assert.equal(r.failed, undefined, JSON.stringify(r.failed));
    assert.deepEqual(seen.filter((s) => /\bperp_(orders|order_legs|fills|funding|transfers|positions|accounts|carries)\b|\bperps_grants\b/.test(s)), []);
  });

  await t.test("the checkpoint: perp_json by the bounded migration, the staleness check, the upgrade path's perp identity and peak, the held reset", async () => {
    const id = ++n, owner = address(0xb000 + id), account = address(0xc000 + id);
    const tenant = workerKey(owner, "perps");
    await putGrant("perps_grants", owner, account);
    const child = await childLedger();
    child.raw.prepare("INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, mode) VALUES (?, ?, 's', 4663, '{}', 0, 0, 'paper')").run(account, owner);
    child.raw.prepare("INSERT INTO paper_book (agent_id, cash_usdg, vault_usdg, hwm_usdg, shares, updated_at) VALUES (?, 92, 0, 100, '{}', 1000)").run(account);
    child.raw.prepare(`INSERT INTO perp_positions (agent_id, mode, market_id, side, base, entry_price, allocated_margin_micro, imf_bp, margin_mode,
        stop_trigger, stop_price, recorded_stop_trigger, recorded_stop_price, funding_hour_applied, opened_at, updated_at, source)
      VALUES (?, 'paper', 1, 'long', '20', '800000', '7999808', 5000, 'isolated', NULL, NULL, '760000', '744800', 3600, 900, 1100, 'paper')`).run(account);
    child.raw.prepare("INSERT INTO perp_accounts (agent_id, mode, nonce_high_water, paper_collateral_micro, updated_at) VALUES (?, 'paper', '1790000000001', '0', 1100)").run(account);
    // A funding hour after the cash last moved: only the book's tape time holds it.
    child.raw.prepare("INSERT INTO perp_funding (agent_id, mode, epoch, market_id, funding_id, funding_hour, payment_micro, created_at) VALUES (?, 'paper', 1, 1, 'paper:funding:1:3600', 3600, '-192', 1100)").run(account);
    // A mark with its venue terms, which the equity copy carries as optional columns.
    child.raw.prepare(`INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, at,
        perp_collateral_micro, perp_isolated_margin_micro, perp_unrealized_micro, perp_unrealized_gain_micro, perp_in_transit_micro, perp_snapshot_time, cash_read_block)
      VALUES (?, '0', 92, 0, 0, 99.999808, 1, 'paper', 1100, '0', '7999808', '0', '0', '0', NULL, NULL)`).run(account);

    const r = await mirrorTenant({ tenant, child: child.db, shared });
    assert.equal(r.failed, undefined, JSON.stringify(r.failed));
    assert.equal(r.copied.paper_checkpoints, 1);
    assert.deepEqual(await one("SELECT perp_isolated_margin_micro, perp_collateral_micro FROM equity WHERE agent_id = $1", [account]),
      { perp_isolated_margin_micro: "7999808", perp_collateral_micro: "0" }, "the equity row's perp terms travel with it");
    const cp = await one("SELECT updated_at, perp_json FROM paper_checkpoints WHERE agent_id = $1", [account]);
    const state = JSON.parse(String(cp!.perp_json)) as { tape_at: number; nonce_high_water: string; positions: Record<string, unknown>[] };
    assert.equal(cp!.updated_at, 1000);
    assert.equal(state.tape_at, 1100);
    assert.deepEqual(state.positions.map((p) => [p.recorded_stop_trigger, p.recorded_stop_price]), [["760000", "744800"]]);

    const fresh = await childLedger();
    assert.match(await restorePaperCheckpoint(fresh.db, shared, account), /restored, with the paper perp book/);
    assert.deepEqual({ ...(fresh.raw.prepare("SELECT recorded_stop_trigger, funding_hour_applied FROM perp_positions").get() as Record<string, unknown>) }, { recorded_stop_trigger: "760000", funding_hour_applied: 3600 });
    assert.equal((fresh.raw.prepare("SELECT nonce_high_water FROM perp_accounts").get() as { nonce_high_water: string }).nonce_high_water, "1790000000001");
    // A fill on the shared tape the book never held refuses it.
    await main.query(`INSERT INTO perp_fills (agent_id, mode, epoch, venue_trade_id, side_role, market_id, side, base, price, quote_micro, fee_micro,
        trade_type, attribution, venue_ts_ms, created_at) VALUES ($1, 'paper', 1, 'paper:close:1:9', 'ask', 1, 'long', '20', '1', '1', '0', 'trade', 'venue-stop', 1, 1101)`, [account]);
    await assert.rejects(restorePaperCheckpoint((await childLedger()).db, shared, account), /newer than the durable checkpoint/);
    await main.query("DELETE FROM perp_fills WHERE agent_id = $1", [account]);

    // NULL replaces a perp book: the child's is gone, and so is the checkpoint's.
    child.raw.exec("DELETE FROM perp_positions; DELETE FROM perp_accounts; DELETE FROM perp_funding");
    child.raw.exec("UPDATE paper_book SET updated_at = 1200");
    await mirrorPaperCheckpoints(child.db, shared);
    assert.equal((await one("SELECT perp_json FROM paper_checkpoints WHERE agent_id = $1", [account]))!.perp_json, null);

    // THE UPGRADE PATH: no checkpoint for the epoch, a valuation whose perp term is in its identity.
    await main.query("DELETE FROM paper_checkpoints WHERE agent_id = $1", [account]);
    await main.query("DELETE FROM perp_funding WHERE agent_id = $1", [account]);
    await main.query("DELETE FROM equity WHERE agent_id = $1", [account]);
    const mark = `INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, at,
        perp_collateral_micro, perp_isolated_margin_micro, perp_unrealized_micro, perp_unrealized_gain_micro, perp_in_transit_micro)
      VALUES ($1, '0', $2, 0, 0, $3, 1, 'paper', $4, $5, $6, $7, $8, '0')`;
    await main.query(mark, [account, 900, 1100, 5, "50000000", "0", "150000000", "150000000"]);
    await main.query(mark, [account, 900, 975, 10, "50000000", "20000000", "5000000", "5000000"]);
    const upgraded = await childLedger();
    assert.match(await restorePaperCheckpoint(upgraded.db, shared, account), /closed into paper collateral/);
    const book = upgraded.raw.prepare("SELECT cash_usdg, hwm_usdg FROM paper_book").get() as { cash_usdg: number; hwm_usdg: number };
    assert.deepEqual({ ...book }, { cash_usdg: 900, hwm_usdg: 975 }, "paperPeakBasis on Postgres: the wick never lifted the peak");
    assert.equal((upgraded.raw.prepare("SELECT paper_collateral_micro FROM perp_accounts").get() as { paper_collateral_micro: string }).paper_collateral_micro, "75000000");

    // THE HELD RESET, inside its transaction, over the perp tables.
    await main.query("INSERT INTO perp_positions (agent_id, mode, market_id, side, base, allocated_margin_micro, source) VALUES ($1, 'paper', 2, 'short', '3', '1', 'paper')", [account]);
    await main.query("INSERT INTO perp_accounts (agent_id, mode, paper_collateral_micro, nonce_high_water) VALUES ($1, 'paper', '9', '42') ON CONFLICT (agent_id, mode) DO UPDATE SET paper_collateral_micro = '9', nonce_high_water = '42'", [account]);
    await main.query(`INSERT INTO perp_carries (agent_id, mode, epoch, market_id, side, base, mark_price, entry_quote_micro) VALUES ($1, 'paper', 5, 2, 'short', '3', '1', '3')`, [account]);
    const reset = await resetBlockedPaperBook(shared, account, Number((await one("SELECT epoch FROM agents WHERE smart_account = $1", [account]))!.epoch));
    assert.deepEqual(reset, { ok: true, epoch: 6 }, "one past the perp tape's epoch");
    assert.equal((await one("SELECT COUNT(*) AS n FROM perp_positions WHERE agent_id = $1 AND mode = 'paper'", [account]))!.n, 0);
    assert.deepEqual(await one("SELECT paper_collateral_micro, nonce_high_water FROM perp_accounts WHERE agent_id = $1 AND mode = 'paper'", [account]),
      { paper_collateral_micro: "0", nonce_high_water: "42" });
    // The migration ran once for this Db, and the column is the catalogue's.
    await ensurePaperCheckpointSchema(shared);
    assert.ok(await one("SELECT 1 AS ok FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'paper_checkpoints' AND column_name = 'perp_json'", [schema]));
  });

  await t.test("the import: a Perps worker's paper book, bound to perps_grants through its catalogue probe, captured, staged and restored", async () => {
    const id = ++n, owner = address(0xb000 + id), account = address(0xc000 + id);
    const tenant = workerKey(owner, "perps");
    const homeBase = path.join(tmp, String(id)), original = path.join(homeBase, "original"), mountPath = path.join(homeBase, "volume"), homeRoot = path.join(mountPath, "fleet");
    mkdirSync(original, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });
    const raw = new DatabaseSync(path.join(original, "merrymen.db"));
    raws.push(raw);
    const local = wrapSqlite(raw);
    await applyLedgerSchema(local);
    raw.prepare("INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,mode) VALUES(?,?,'s',4663,'{}',1,9999999999,'paper')").run(account, owner);
    raw.prepare(`INSERT INTO perp_positions (agent_id, mode, market_id, side, base, entry_price, allocated_margin_micro, imf_bp, margin_mode,
        stop_trigger, stop_price, recorded_stop_trigger, recorded_stop_price, funding_hour_applied, opened_at, updated_at, source)
      VALUES (?, 'paper', 1, 'long', '20', '800000', '7999808', 5000, 'isolated', NULL, NULL, '760000', '744800', 3600, 900, 1100, 'paper')`).run(account);
    raw.prepare("INSERT INTO perp_accounts (agent_id, mode, nonce_high_water, paper_collateral_micro, created_at, updated_at) VALUES (?, 'paper', '1790000000001', '0', 900, 1100)").run(account);
    raw.prepare("INSERT INTO perp_funding (agent_id, mode, epoch, market_id, funding_id, funding_hour, payment_micro, created_at) VALUES (?, 'paper', 1, 1, 'paper:funding:1:3600', 3600, '-192', 1100)").run(account);
    const lock = await connect();
    await lock.query("SELECT pg_advisory_lock($1::bigint)", [leaseKey(tenant).toString()]);
    let healthy = true;
    lock.on("error", () => { healthy = false; });
    lock.on("end", () => { healthy = false; });
    const lease: TenantLease = { tenant, backend: "postgres", healthy: () => healthy, async release() { healthy = false; await lock.query("SELECT pg_advisory_unlock($1::bigint)", [leaseKey(tenant).toString()]); } };
    const st = lstatSync(mountPath, { bigint: true });
    const volume: LedgerImportVolume = { id: `vol_pg_perps_${id}`, mountPath, homeRoot, device: String(st.dev), inode: String(st.ino) };
    const home = path.join(homeRoot, "children-perps", owner);
    const options = { tenant, smartAccount: account, chainId: 4663, home, volume, shared, dek, lease };
    const sourceAt = { deploymentId: "quiescent-source", gitCommit: "a".repeat(40), orchestratorPid: 999, orchestratorStart: "source-start", quiescent: true, singleReplicaConfirmed: true };
    const capture = () => captureLedgerImport({ ...options, home: original, source: sourceAt, assertSource() {} });

    // Before the Perps wallets' table exists, and before the owner's row does,
    // there is nothing to bind to: refused, cleanly — the absent table asked
    // of the catalogue inside the capture's transaction, never read.
    await main.query("ALTER TABLE perps_grants RENAME TO perps_grants_away");
    await assert.rejects(capture(), /Original ledger import refused/);
    await main.query("ALTER TABLE perps_grants_away RENAME TO perps_grants");
    await assert.rejects(capture(), /Original ledger import refused/);
    await putGrant("perps_grants", owner, account);
    const mirrored = await mirrorTenant({ tenant, child: local, shared });
    assert.equal(mirrored.failed, undefined, JSON.stringify(mirrored.failed));
    const artifact = await capture();
    await stageLedgerImport({ artifact, targetVolumeId: volume.id, shared, dek, lease, assertSource() {} });
    assert.equal(await restoreLedgerImport(options), "restored");
    const verified = await verifyRestoredLedgerImport({ ...options, artifact, assertSource() {} });
    assert.equal(verified.tables, 21 + 3);
    const imported = new DatabaseSync(path.join(home, "merrymen.db"));
    raws.push(imported);
    assert.deepEqual(imported.prepare("SELECT * FROM perp_positions").all(), raw.prepare("SELECT * FROM perp_positions").all());
    const receipt = await one("SELECT tenant, state FROM tenant_ledger_import WHERE tenant = $1", [tenant]);
    assert.deepEqual(receipt, { tenant, state: "consumed" });
    await lease.release();
  });
});
