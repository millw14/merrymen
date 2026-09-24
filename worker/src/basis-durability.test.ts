/**
 * A BASIS THAT DOES NOT SURVIVE A REDEPLOY IS A P&L THAT NEVER GETS WRITTEN.
 *
 * The child's ledger lives in its container's own sqlite with no volume, so
 * every redeploy destroys `cost_basis`. The mirror carries it UP to shared
 * Postgres and nothing carried it back — so a position bought before a redeploy
 * sold with no basis at all, `applyFill` reported `basisUnknown` (correctly, for
 * a sell with nothing on the books), and the realised figure was dropped.
 *
 * This drives the REAL round trip over real sqlite: buy → basis exists → mirror
 * up → child rebuilt → seed back down → sell → realised written → basis
 * consumed → and the result survives a further restart. Nothing is hand-seeded
 * after the restart; the seed plan is the thing under test.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { applyFill } from "./basis";
import { realisedForFill } from "./basis-order";
import { basisSeedLine, planBasisSeed, type BasisSeedRow } from "./basis-seed";
import { wrapSqlite } from "./db";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";

const AGENT = "0xa96bf429888e1aab4255762d17d29c53f6a0370d";

const SCHEMA = [
  "CREATE TABLE cost_basis (agent_id TEXT, mode TEXT, symbol TEXT, qty_raw TEXT, cost_usdg TEXT," +
    " updated_at INTEGER, PRIMARY KEY (agent_id, mode, symbol));",
  "CREATE TABLE agents (smart_account TEXT PRIMARY KEY, name TEXT, owner_address TEXT," +
    " session_key_address TEXT, chain_id INTEGER, caps TEXT, granted_at INTEGER, expires_at INTEGER," +
    " status TEXT, created_at INTEGER, mode TEXT, beat_at INTEGER, sponsor_gas INTEGER, live_blocker TEXT," +
    " x_handle TEXT, x_verified INTEGER DEFAULT 0, epoch INTEGER DEFAULT 1, hwm_usdg REAL DEFAULT 0," +
    " hwm_withdrawn_usdg REAL NOT NULL DEFAULT 0, accrued_fee_usdg REAL DEFAULT 0," +
    " contributions_known INTEGER, contributions_why TEXT, gas_accounting TEXT, quality_at INTEGER);",
  "CREATE TABLE positions (agent_id TEXT, symbol TEXT, token TEXT, raw_balance TEXT, ui_multiplier TEXT," +
    " price_usd REAL, price_stale INTEGER, price_source TEXT DEFAULT 'chainlink', value_usdg REAL," +
    " updated_at INTEGER, PRIMARY KEY (agent_id, symbol));",
  "CREATE TABLE position_floors (agent_id TEXT, mode TEXT, symbol TEXT, stop_bps INTEGER, rung INTEGER," +
    " why TEXT, at INTEGER, PRIMARY KEY (agent_id, mode, symbol));",
  "CREATE TABLE class_positions (agent_id TEXT, token TEXT, symbol TEXT, decimals INTEGER DEFAULT 18," +
    " curve TEXT, quote_token TEXT, first_seen INTEGER, vault TEXT, entry_tx TEXT, exit_tx TEXT," +
    " cost_usdg TEXT, qty_raw TEXT, proceeds_usdg TEXT, opened_at_block TEXT, state TEXT DEFAULT 'open'," +
    " swept_raw TEXT, PRIMARY KEY (agent_id, token));",
  "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, level TEXT," +
    " message TEXT, created_at INTEGER);",
  "CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, kind TEXT, target TEXT," +
    " sell_token TEXT, buy_token TEXT, amount_usdg REAL, user_op_hash TEXT, tx_hash TEXT, status TEXT," +
    " reject_rule TEXT, decision_id TEXT, fill_side TEXT, fill_qty_raw TEXT, fill_price_usd REAL," +
    " realized_pnl_usdg REAL, basis_source TEXT, gas_wei TEXT, sponsored_gas_wei TEXT, gas_usdg REAL," +
    " gas_units TEXT, fill_cash_usdg REAL, fill_symbol TEXT, epoch INTEGER DEFAULT 1, created_at INTEGER);",
  "CREATE TABLE equity (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, eth_wei TEXT, cash_usdg REAL," +
    " vault_usdg REAL, positions_usdg REAL, equity_usdg REAL, epoch INTEGER DEFAULT 1, mode TEXT, at INTEGER);",
  "CREATE TABLE flows (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, direction TEXT," +
    " amount_usdg REAL, tx_hash TEXT, block_number INTEGER, log_index INTEGER, source TEXT," +
    " epoch INTEGER DEFAULT 1, chain_id INTEGER, at INTEGER);",
  "CREATE TABLE fee_accruals (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, profit_usdg REAL," +
    " fee_usdg REAL, hwm_before_usdg REAL, hwm_after_usdg REAL, epoch INTEGER DEFAULT 1, at INTEGER);",
  "CREATE TABLE decisions (id TEXT PRIMARY KEY, agent_id TEXT, source TEXT, strategy TEXT, provider TEXT," +
    " model TEXT, symbol TEXT, action TEXT, size_usdg REAL, reason TEXT, dropped_rule TEXT," +
    " signals_json TEXT, hold_kind TEXT, at INTEGER);",
].join("\n");

const fresh = () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SCHEMA);
  return { raw, db: wrapSqlite(raw) };
};

const sharedDb = () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SCHEMA + MIRROR_STATE_DDL);
  return { raw, db: wrapSqlite(raw) };
};

const readBasis = (raw: DatabaseSync, symbol: string) =>
  raw.prepare(`SELECT qty_raw, cost_usdg FROM cost_basis WHERE symbol = ?`).get(symbol) as
    | { qty_raw: string; cost_usdg: string }
    | undefined;

const sharedRows = (raw: DatabaseSync): BasisSeedRow[] =>
  (raw.prepare(`SELECT mode, symbol, qty_raw, cost_usdg FROM cost_basis`).all() as Record<string, unknown>[]).map(
    (r) => ({
      mode: String(r.mode),
      symbol: String(r.symbol),
      qtyRaw: String(r.qty_raw),
      costUsdg: String(r.cost_usdg),
    }),
  );

/** What `seedBasisForChild` does, driven through the real plan. */
const seed = (child: DatabaseSync, shared: DatabaseSync) => {
  const have = child.prepare(`SELECT COUNT(*) AS n FROM cost_basis`).get() as { n: number };
  const held = (shared.prepare(`SELECT symbol FROM positions WHERE raw_balance <> '0'`).all() as Record<string, unknown>[]).map((r) => String(r.symbol));
  const plan = planBasisSeed({ childRowCount: Number(have.n), shared: sharedRows(shared), heldSymbols: held });
  for (const r of plan.rows) {
    child
      .prepare(
        `INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at)
         VALUES (?, ?, ?, ?, ?, unixepoch()) ON CONFLICT(agent_id, mode, symbol) DO NOTHING`,
      )
      .run(AGENT, r.mode, r.symbol, r.qtyRaw, r.costUsdg);
  }
  return plan;
};

describe("a swap basis survives the redeploy that destroys the child", () => {
  it("BUY → mirror → child rebuilt → seeded back → SELL writes realised P&L", async () => {
    const shared = sharedDb();
    shared.raw
      .prepare(`INSERT INTO agents (smart_account, epoch) VALUES (?, 1)`)
      .run(AGENT);

    // ── the buy, in the child's own ledger ────────────────────────────────
    const first = fresh();
    const bought = applyFill({ qtyRaw: 0n, costUsdg: 0n }, { side: "buy", qtyRaw: 4n * 10n ** 18n, cashUsdg: 40_000_000n });
    first.raw
      .prepare(
        `INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at)
         VALUES (?, 'live', 'PEPE', ?, ?, unixepoch())`,
      )
      .run(AGENT, bought.basis.qtyRaw.toString(), bought.basis.costUsdg.toString());
    assert.ok(readBasis(first.raw, "PEPE"), "the buy must put a basis on the books");
    // The position itself, which is what makes the cost restorable: a basis is
    // only restored for something the book still says is held.
    first.raw
      .prepare(`INSERT INTO positions (agent_id, symbol, token, raw_balance, value_usdg) VALUES (?, 'PEPE', '0xp', ?, 40.0)`)
      .run(AGENT, (4n * 10n ** 18n).toString());

    // ── the mirror carries it up, through the REAL mirror ─────────────────
    first.raw.prepare(`INSERT INTO agents (smart_account, epoch) VALUES (?, 1)`).run(AGENT);
    await mirrorTenant({ tenant: "t1", child: first.db, shared: shared.db, nowSec: 1000 });
    assert.ok(readBasis(shared.raw, "PEPE"), "the shared ledger must hold the basis");

    // ── the redeploy: a brand-new, empty child ────────────────────────────
    const rebuilt = fresh();
    assert.equal(readBasis(rebuilt.raw, "PEPE"), undefined, "a rebuilt child starts with nothing");

    const plan = seed(rebuilt.raw, shared.raw);
    assert.equal(plan.skipped, null);
    assert.equal(plan.rows.length, 1);
    assert.match(basisSeedLine("t1", plan), /restored 1 cost basis row/);

    const back = readBasis(rebuilt.raw, "PEPE");
    assert.ok(back, "THE BASIS MUST BE BACK — this is what was missing");
    assert.equal(back!.qty_raw, (4n * 10n ** 18n).toString());
    assert.equal(back!.cost_usdg, "40000000");

    // ── the sell, against the restored basis ──────────────────────────────
    const prev = { qtyRaw: BigInt(back!.qty_raw), costUsdg: BigInt(back!.cost_usdg) };
    const sold = applyFill(prev, { side: "sell", qtyRaw: 4n * 10n ** 18n, cashUsdg: 33_000_000n });
    assert.equal(sold.basisUnknown, false, "the sell must find its basis");
    assert.equal(realisedForFill("sell", sold.basisUnknown, sold.realizedUsdg), -7_000_000n);

    // ── consumed by the fill, and the result survives another restart ─────
    rebuilt.raw.prepare(`DELETE FROM cost_basis WHERE symbol = 'PEPE'`).run(); // setBasis deletes at zero
    // And the position is gone from the book too — the account sold it.
    rebuilt.raw.prepare(`INSERT INTO agents (smart_account, epoch) VALUES (?, 1)`).run(AGENT);
    rebuilt.raw
      .prepare(
        `INSERT INTO trades (agent_id, kind, tx_hash, status, fill_side, basis_source, realized_pnl_usdg, created_at)
         VALUES (?, 'swap', '0xsell', 'landed', 'sell', 'receipt', -7.0, 2000)`,
      )
      .run(AGENT);
    await mirrorTenant({ tenant: "t1", child: rebuilt.db, shared: shared.db, nowSec: 2000 });

    const onShared = shared.raw
      .prepare(`SELECT realized_pnl_usdg, fill_side FROM trades WHERE tx_hash = '0xsell'`)
      .get() as { realized_pnl_usdg: number; fill_side: string };
    assert.equal(onShared.fill_side, "sell");
    assert.equal(onShared.realized_pnl_usdg, -7.0, "the P&L survives to the shared ledger");

    // And a further rebuild does not resurrect the consumed basis.
    const third = fresh();
    const again = seed(third.raw, shared.raw);
    assert.equal(again.rows.length, 0, "a consumed basis must not come back");
    assert.equal(readBasis(third.raw, "PEPE"), undefined);
  });
});

describe("the seed refuses to overwrite a child that has its own book", () => {
  it("a child with rows is the authority on itself", () => {
    const plan = planBasisSeed({
      childRowCount: 2,
      shared: [{ mode: "live", symbol: "PEPE", qtyRaw: "1", costUsdg: "1" }],
      heldSymbols: ["PEPE"],
    });
    assert.equal(plan.rows.length, 0);
    assert.match(plan.skipped ?? "", /child already holds 2 basis row/);
  });

  it("an empty shared ledger seeds nothing rather than inventing a zero", () => {
    const plan = planBasisSeed({ childRowCount: 0, shared: [] });
    assert.equal(plan.rows.length, 0);
    assert.match(plan.skipped ?? "", /shared ledger holds no basis/);
  });

  it("A ZERO ROW IS NOT A BASIS — unknown must never become a confident zero", () => {
    // `setBasis` deletes at zero, so a zero row is one the child would never
    // have written. Restoring it would claim a tracked position with no cost,
    // which is a different and worse statement than "unknown".
    const plan = planBasisSeed({
      childRowCount: 0,
      shared: [
        { mode: "live", symbol: "GONE", qtyRaw: "0", costUsdg: "0" },
        { mode: "live", symbol: "PEPE", qtyRaw: "5", costUsdg: "50" },
      ],
      heldSymbols: ["GONE", "PEPE"],
    });
    assert.deepEqual(plan.rows.map((r) => r.symbol), ["PEPE"]);
  });

  it("and an unreadable quantity is dropped, not guessed", () => {
    const plan = planBasisSeed({
      childRowCount: 0,
      shared: [{ mode: "live", symbol: "ODD", qtyRaw: "not-a-number", costUsdg: "1" }],
      heldSymbols: ["ODD"],
    });
    assert.equal(plan.rows.length, 0);
  });
});

describe("and it never restores the cost of something already sold", () => {
  /**
   * The shared `cost_basis` copy goes stale in one specific way: the mirror
   * skips its own `DELETE FROM cost_basis` while the child reads `rebuilt`, so
   * a basis the child consumed on a sell can still be sitting in shared.
   * Restoring it would hand the next buy a cost it never paid and make the next
   * sell report a loss that already happened.
   *
   * This case failed on its first run — the seed DID resurrect it — which is
   * why the held check exists at all.
   */
  it("a stale shared basis for a position no longer held is NOT seeded", () => {
    const plan = planBasisSeed({
      childRowCount: 0,
      shared: [{ mode: "live", symbol: "SOLD", qtyRaw: "4000000000000000000", costUsdg: "40000000" }],
      heldSymbols: [], // the book says the account holds nothing
    });
    assert.equal(plan.rows.length, 0);
    assert.match(plan.skipped ?? "", /no held position on record/);
  });

  it("an UNKNOWN holding set restores nothing — it is not a licence", () => {
    // Omitted, rather than empty. Both must refuse: not knowing what is held is
    // the state in which restoring a cost is least defensible.
    const plan = planBasisSeed({
      childRowCount: 0,
      shared: [{ mode: "live", symbol: "PEPE", qtyRaw: "1", costUsdg: "1" }],
    });
    assert.equal(plan.rows.length, 0);
  });

  it("but a still-held position DOES get its cost back", () => {
    const plan = planBasisSeed({
      childRowCount: 0,
      shared: [
        { mode: "live", symbol: "SOLD", qtyRaw: "1", costUsdg: "10" },
        { mode: "live", symbol: "HELD", qtyRaw: "2", costUsdg: "20" },
      ],
      heldSymbols: ["HELD"],
    });
    assert.deepEqual(plan.rows.map((r) => r.symbol), ["HELD"]);
  });
});
