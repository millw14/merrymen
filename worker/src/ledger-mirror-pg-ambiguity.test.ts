/**
 * THE MIRROR'S OWN TEST SUITE USES SQLITE, AND THAT IS WHY THIS SHIPPED BROKEN.
 *
 * `ledger-mirror.test.ts` builds its destination with `wrapSqlite`, inserts a
 * `class_positions` row, and asserts the copy lands. It passed every run. But
 * production's destination is POSTGRES, and the two disagree about one thing:
 *
 *     ON CONFLICT (...) DO UPDATE SET symbol = COALESCE(excluded.symbol, symbol)
 *
 * Inside `DO UPDATE SET`, Postgres has TWO relations in scope — the target table
 * and the `excluded` pseudo-relation — and both expose `symbol`. So the bare
 * reference is ambiguous and Postgres refuses to PARSE the statement. sqlite
 * resolves it to the target row and says nothing.
 *
 * MEASURED, 2026-09-12. The first class position the fleet ever opened (Shogun,
 * Doggos, tx 0xd860ac46…, 5.000000 USDG) produced:
 *
 *     ledger mirror: 0x8e93ba… STALLED — snapshots: column reference "symbol" is ambiguous
 *
 * `symbol` only because it was FIRST in the SET list. Every COALESCE line under
 * it was equally wrong. The owner's dashboard showed $25.00 cash and 0 positions
 * while the chain held $20.00 and 1,063,408 DOGGOS in the vault.
 *
 * AND IT COULD NOT SELF-HEAL. `PgDb.prepare` sends nothing to the server
 * (db.ts:181-186) — the statement is parsed on its first `.run()`, which runs
 * only when there IS a class row. So the defect lay dormant from the day it was
 * written until the day the capability was first used, then failed on every
 * attempt: a parse error rejects a brand-new non-conflicting row exactly as it
 * rejects a conflicting one.
 *
 * So this file supplies the ONE THING the sqlite fixture cannot: Postgres's
 * scoping rule. `pgScoped` wraps a destination and refuses the same statements
 * the server refuses, with the same message. The fixture below is deliberately
 * the shape the operator asked for — A NORMAL POSITION PLUS A CLASS POSITION —
 * because the bug needs a class row to be reachable at all, and the normal row
 * proves the rest of the snapshot pass is healthy either way.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { wrapSqlite, type Db } from "./db";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";

/**
 * POSTGRES'S RULE, APPLIED TO THE SQL WE ACTUALLY SEND.
 *
 * An identifier on the right of an assignment inside `DO UPDATE SET` is
 * ambiguous when it is unqualified AND names a column both relations expose.
 * Every name assigned in the same SET clause is such a column by definition —
 * it is a column of the target table, and `excluded` mirrors the target's
 * columns exactly — so the SET clause carries its own list of what may not
 * appear bare. Names reached through `excluded.` are counted too.
 *
 * Deliberately narrow: it models the COALESCE-preserve idiom that broke, not
 * all of Postgres name resolution. A bare column that appears nowhere else in
 * the SET clause would slip past — worth knowing, not worth a SQL parser.
 */
function ambiguousColumn(sql: string): string | null {
  const m = /\bDO\s+UPDATE\s+SET\b/i.exec(sql);
  if (!m) return null;
  const target = /\bINSERT\s+INTO\s+([a-z_][a-z0-9_]*)/i.exec(sql)?.[1]?.toLowerCase() ?? "";
  let set = sql.slice(m.index + m[0].length);
  const where = /\bWHERE\b/i.exec(set);
  if (where) set = set.slice(0, where.index);
  set = set.replace(/--[^\n]*/g, " ");

  // Split assignments on top-level commas.
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of set) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);

  const assigned = new Set<string>();
  const rhs: string[] = [];
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const lhs = p.slice(0, eq).trim().toLowerCase();
    if (/^[a-z_][a-z0-9_]*$/.test(lhs)) assigned.add(lhs);
    rhs.push(p.slice(eq + 1));
  }
  // Columns `excluded.` reaches are the target's columns too.
  for (const r of rhs) {
    for (const em of r.matchAll(/\bexcluded\.([a-z_][a-z0-9_]*)/gi)) {
      assigned.add(em[1]!.toLowerCase());
    }
  }

  const KEYWORDS = new Set([
    "coalesce", "case", "when", "then", "else", "end", "null", "and", "or", "not",
    "greatest", "least", "excluded", "true", "false", "cast", "as", "nullif", target,
  ]);
  for (const r of rhs) {
    // Unqualified identifiers only: not preceded by a dot, not a function call.
    for (const im of r.matchAll(/(^|[^.\w])([a-z_][a-z0-9_]*)\s*(\(?)/gi)) {
      const name = im[2]!.toLowerCase();
      if (im[3] === "(") continue; // function name
      if (KEYWORDS.has(name)) continue;
      if (assigned.has(name)) return name;
    }
  }
  return null;
}

/**
 * A destination that refuses what Postgres refuses, with Postgres's message —
 * AND AT THE MOMENT POSTGRES REFUSES IT.
 *
 * The timing is load-bearing, not decoration. `PgDb.prepare` sends nothing to
 * the server (db.ts:181-186): the statement reaches Postgres on its first
 * `.run()`. That is the whole reason this defect slept from the day it was
 * written until the day the first class position existed — with no rows, the
 * insert loop never executes and the bad SQL is never parsed. Guarding in
 * `prepare` would be stricter than production and would destroy the control
 * test below, which has to be able to pass on the BROKEN code.
 */
function pgScoped(inner: Db): Db {
  const guard = (sql: string) => {
    const bad = ambiguousColumn(sql);
    if (bad) throw new Error(`column reference "${bad}" is ambiguous`);
  };
  const wrap = (db: Db): Db => ({
    prepare(sql: string) {
      const st = db.prepare(sql);
      return {
        run: async (...p: never[]) => {
          guard(sql);
          return st.run(...p);
        },
        get: async (...p: never[]) => {
          guard(sql);
          return st.get(...p);
        },
        all: async (...p: never[]) => {
          guard(sql);
          return st.all(...p);
        },
      } as ReturnType<Db["prepare"]>;
    },
    exec: (sql: string) => db.exec(sql),
    tx: <T>(fn: (d: Db) => Promise<T>) => db.tx((d) => fn(wrap(d))),
  });
  return wrap(inner);
}

/**
 * The child's schema. Copied rather than imported because store.ts does not
 * export its DDL — so a control test below proves the fixture itself is sound
 * before any assertion trusts a failure message from it.
 */
const SRC = [
  "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, level TEXT, message TEXT, created_at INTEGER);",
  "CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, kind TEXT, target TEXT, sell_token TEXT, buy_token TEXT, amount_usdg REAL, user_op_hash TEXT, tx_hash TEXT, status TEXT, reject_rule TEXT, decision_id TEXT, fill_side TEXT, fill_qty_raw TEXT, fill_price_usd REAL, realized_pnl_usdg REAL, basis_source TEXT, gas_wei TEXT, sponsored_gas_wei TEXT, gas_usdg REAL, gas_units TEXT, fill_cash_usdg REAL, epoch INTEGER DEFAULT 1, created_at INTEGER);",
  "CREATE TABLE equity (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, eth_wei TEXT, cash_usdg REAL, vault_usdg REAL, positions_usdg REAL, equity_usdg REAL, epoch INTEGER DEFAULT 1, mode TEXT, at INTEGER);",
  "CREATE TABLE flows (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, direction TEXT, amount_usdg REAL, tx_hash TEXT, block_number INTEGER, log_index INTEGER, source TEXT, epoch INTEGER DEFAULT 1, chain_id INTEGER, at INTEGER);",
  "CREATE TABLE fee_accruals (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, profit_usdg REAL, fee_usdg REAL, hwm_before_usdg REAL, hwm_after_usdg REAL, epoch INTEGER DEFAULT 1, at INTEGER);",
  "CREATE TABLE decisions (id TEXT PRIMARY KEY, agent_id TEXT, source TEXT, strategy TEXT, provider TEXT, model TEXT, symbol TEXT, action TEXT, size_usdg REAL, reason TEXT, dropped_rule TEXT, signals_json TEXT, hold_kind TEXT, at INTEGER);",
  "CREATE TABLE agents (smart_account TEXT PRIMARY KEY, name TEXT, owner_address TEXT, session_key_address TEXT, chain_id INTEGER, caps TEXT, granted_at INTEGER, expires_at INTEGER, status TEXT, created_at INTEGER, mode TEXT, beat_at INTEGER, sponsor_gas INTEGER, live_blocker TEXT, x_handle TEXT, x_verified INTEGER DEFAULT 0, epoch INTEGER DEFAULT 1, hwm_usdg REAL DEFAULT 0, accrued_fee_usdg REAL DEFAULT 0, contributions_known INTEGER, contributions_why TEXT, gas_accounting TEXT, quality_at INTEGER);",
  "CREATE TABLE positions (agent_id TEXT, symbol TEXT, token TEXT, raw_balance TEXT, ui_multiplier TEXT, price_usd REAL, price_stale INTEGER, price_source TEXT DEFAULT 'chainlink', value_usdg REAL, updated_at INTEGER, PRIMARY KEY (agent_id, symbol));",
  "CREATE TABLE cost_basis (agent_id TEXT, mode TEXT, symbol TEXT, qty_raw TEXT, cost_usdg TEXT, updated_at INTEGER, PRIMARY KEY (agent_id, mode, symbol));",
  "CREATE TABLE position_floors (agent_id TEXT, mode TEXT, symbol TEXT, stop_bps INTEGER, rung INTEGER, why TEXT, at INTEGER, PRIMARY KEY (agent_id, mode, symbol));",
  "CREATE TABLE class_positions (agent_id TEXT, token TEXT, symbol TEXT, decimals INTEGER DEFAULT 18, curve TEXT, quote_token TEXT, first_seen INTEGER, vault TEXT, entry_tx TEXT, exit_tx TEXT, cost_usdg TEXT, qty_raw TEXT, proceeds_usdg TEXT, opened_at_block TEXT, state TEXT DEFAULT 'open', PRIMARY KEY (agent_id, token));",
].join("\n");

const DEST = SRC + MIRROR_STATE_DDL;

const mem = (ddl: string) => {
  const db = new DatabaseSync(":memory:");
  db.exec(ddl);
  return wrapSqlite(db);
};

/** A NORMAL POSITION PLUS A CLASS POSITION — the shape that reproduces it. */
const seedChild = (withClass: boolean) => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SRC);
  raw.exec(
    `INSERT INTO agents (smart_account, name, owner_address, chain_id, caps, granted_at, expires_at, status, created_at, mode, epoch)
     VALUES ('0x05a198','shogun','0x8e93ba',4663,'{}',1,2,'armed',3,'live',1)`,
  );
  // The ordinary book: an account-held position with a cost basis and a floor.
  raw.exec("INSERT INTO positions VALUES ('0x05a198','QQQ','0xqqq','1','1',713.0,0,'chainlink',25.0,9)");
  raw.exec("INSERT INTO cost_basis VALUES ('0x05a198','live','QQQ','1','25.0',9)");
  raw.exec("INSERT INTO position_floors VALUES ('0x05a198','live','QQQ',1500,0,'entry',9)");
  if (withClass) {
    // Shogun's real Doggos entry, to the digit.
    raw.exec(
      `INSERT INTO class_positions (agent_id, token, symbol, decimals, curve, quote_token, first_seen,
         vault, entry_tx, cost_usdg, qty_raw, opened_at_block, state)
       VALUES ('0x05a198','0x15e498ff2dbca95e8648a1f025cbbd12c2525461','0x15e4…5461',18,
               '0x2f0c6e73936c87c633135d3cb4876e2c2d680332','0x5fc5360d0400a0fd4f2af552add042d716f1d168',
               1757686776,'0x3fcdde6e011769ca05f0115f1543290862473216',
               '0xd860ac4695f693912944425538d165f81d550439340d2b08861e7ec9d4a31cc3',
               '5000000','1063408141815259059579834','61171816','open')`,
    );
  }
  return wrapSqlite(raw);
};

describe("the mirror under Postgres's scoping rule", () => {
  it("THE CONTROL: without a class row the snapshot pass is clean", async () => {
    // Proves the fixture is sound. Without this, a stale fixture column would
    // surface as `failed.snapshots` too and could be mistaken for the bug —
    // or could hide it.
    const r = await mirrorTenant({ tenant: "0xten", child: seedChild(false), shared: pgScoped(mem(DEST)) });
    assert.equal(JSON.stringify(r.failed ?? {}), "{}", "the fixture itself must mirror cleanly");
    assert.equal(r.copied.positions, 1, "the ordinary position copies");
    assert.equal(r.copied.class_positions, 0, "and there is no class row yet");
  });

  it("A NORMAL POSITION PLUS A CLASS POSITION MIRRORS — this is what was broken", async () => {
    const shared = pgScoped(mem(DEST));
    const r = await mirrorTenant({ tenant: "0xten", child: seedChild(true), shared });

    // Before the fix this was: { snapshots: 'column reference "symbol" is ambiguous' }
    assert.equal(
      JSON.stringify(r.failed ?? {}),
      "{}",
      "an unqualified existing-row column in DO UPDATE SET is a Postgres PARSE error",
    );
    assert.equal(r.copied.class_positions, 1, "the class row must reach the shared ledger");
    assert.equal(r.copied.positions, 1, "and the ordinary book must still copy");

    // The money, reconciled to the landed ClassBuy.
    const row = (await shared
      .prepare(
        "SELECT cost_usdg, qty_raw, vault, entry_tx, curve, quote_token, opened_at_block, state FROM class_positions WHERE agent_id = ?",
      )
      .get("0x05a198")) as Record<string, string>;
    assert.equal(String(row.cost_usdg), "5000000", "5.000000 USDG, exact");
    assert.equal(String(row.qty_raw), "1063408141815259059579834", "1,063,408.141815 DOGGOS, exact");
    assert.equal(
      String(row.entry_tx),
      "0xd860ac4695f693912944425538d165f81d550439340d2b08861e7ec9d4a31cc3",
    );
    assert.equal(String(row.vault), "0x3fcdde6e011769ca05f0115f1543290862473216");
    assert.equal(String(row.opened_at_block), "61171816");
    assert.equal(String(row.state), "open");
    // `quote_token` is one of only two fields a restart CANNOT recover from
    // chain, and the exit producer requires it — so the mirror carrying it is
    // what keeps the position exitable across a redeploy.
    assert.equal(String(row.quote_token), "0x5fc5360d0400a0fd4f2af552add042d716f1d168");
  });

  it("the SECOND mirror of the same row takes the conflict path and still parses", async () => {
    // The first .run() is an INSERT; only a repeat exercises DO UPDATE SET with
    // a real conflict. Both must parse, and the preserved values must survive.
    const child = seedChild(true);
    const shared = pgScoped(mem(DEST));
    await mirrorTenant({ tenant: "0xten", child, shared });
    const again = await mirrorTenant({ tenant: "0xten", child, shared });
    assert.equal(JSON.stringify(again.failed ?? {}), "{}", "the conflict path must parse too");
    const row = (await shared
      .prepare("SELECT cost_usdg, qty_raw, state FROM class_positions WHERE agent_id = ?")
      .get("0x05a198")) as Record<string, string>;
    assert.equal(String(row.cost_usdg), "5000000", "COALESCE must preserve, not blank");
    assert.equal(String(row.qty_raw), "1063408141815259059579834");
    assert.equal(String(row.state), "open");
  });
});

describe("the rule itself, so the guard cannot rot", () => {
  it("flags the exact statement that broke production, naming `symbol` first", () => {
    const broken =
      `INSERT INTO class_positions (agent_id, token, symbol, curve) VALUES (?, ?, ?, ?)
       ON CONFLICT(agent_id, token) DO UPDATE SET
         symbol = COALESCE(excluded.symbol, symbol),
         curve = COALESCE(excluded.curve, curve)`;
    assert.equal(ambiguousColumn(broken), "symbol", "and `symbol` because it is FIRST in the SET list");
  });

  it("accepts the qualified form, and the excluded-only and CASE forms already in the mirror", () => {
    assert.equal(
      ambiguousColumn(
        `INSERT INTO class_positions (a) VALUES (?) ON CONFLICT(a) DO UPDATE SET
           symbol = COALESCE(excluded.symbol, class_positions.symbol),
           state = excluded.state`,
      ),
      null,
    );
    // `agents` — the in-repo precedent the fix was matched to.
    assert.equal(
      ambiguousColumn(
        `INSERT INTO agents (smart_account, epoch) VALUES (?, ?) ON CONFLICT(smart_account) DO UPDATE SET
           epoch = CASE WHEN excluded.epoch > agents.epoch THEN excluded.epoch ELSE agents.epoch END`,
      ),
      null,
    );
    // No ON CONFLICT at all, like `positions`.
    assert.equal(ambiguousColumn("INSERT INTO positions (agent_id) VALUES (?)"), null);
  });

  it("EVERY upsert the mirror actually sends is unambiguous", () => {
    // The whole point: not just the one statement that was caught, but every
    // ON CONFLICT in the file — so the next COALESCE-preserve block cannot
    // reintroduce this on a table nobody has exercised yet.
    const src = readFileSync(new URL("./ledger-mirror.ts", import.meta.url), "utf8");
    const stmts = src.match(/INSERT\s+INTO[\s\S]*?`/gi) ?? [];
    assert.ok(stmts.length >= 4, `expected several upserts, found ${stmts.length}`);
    for (const s of stmts) {
      const bad = ambiguousColumn(s);
      assert.equal(bad, null, `unqualified existing-row column \`${bad}\` in: ${s.slice(0, 90)}…`);
    }
  });
});
