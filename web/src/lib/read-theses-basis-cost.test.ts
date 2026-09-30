/**
 * A SELL'S BASIS IS CHECKED ONCE PER READ, NOT ONCE PER SELL.
 *
 * FD5 made a receipt-read sell publish its realized return only when no
 * quote-booked buy of the same coin, by the same account, came before it. It
 * asked that as a correlated EXISTS per sell copy, and with no quote buy to
 * find — the common case — each one walked the account's whole earlier
 * history: refusals are trade rows, a basket writes hundreds a day, and the
 * review measured 40 sells over 200k rows at five seconds a read (SQLite) and
 * two over 50k (Postgres), on the feed, the profile and every tenant's peer
 * file. The answer was right; the cost grew with sells × history.
 *
 * Measured here on the real schema and indexes by counting every trade row
 * the engine visits: `trades` is swapped for a view over the real table that
 * counts each row it hands out. The figures must not change — 40 sells, 40
 * percents — and forty sells must cost what one does, give or take the forty.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { applyLedgerSchema } from "../../../worker/src/store";
import { readPeerTheses } from "../../../worker/src/peer-theses";
import { readTheses } from "./read-theses";

const NOW = Math.floor(Date.now() / 1000);
const A = "0xAaAa000000000000000000000000000000000001";
const SLUG = "ems76d3cncwbt3dz";
const USDG = "0x05d0000000000000000000000000000000000005";
const TSLA = "0x7e5a000000000000000000000000000000007e5a";
const HISTORY = 6_000;

/**
 * One live agent with `history` earlier refused trades and `sells` landed,
 * receipt-read sells in the last day. `quoteAt` adds a quote-booked buy of
 * the coin at that time. `sellWrittenAt` moves the sells' trade rows (not
 * their decisions) to another time.
 */
async function ledger(o: { history: number; sells: number; quoteAt?: number; sellWrittenAt?: number; holds?: number }) {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  raw
    .prepare(
      `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, created_at, name, mode, beat_at)
       VALUES (?, '0x0000000000000000000000000000000000000abc', '0x0000000000000000000000000000000000000def', 4663, '{}', ?, ?, 'armed', ?, 'Shogun', 'live', ?)`,
    )
    .run(A, NOW - 86400 * 40, NOW + 86400, NOW - 86400 * 40, NOW - 30);
  raw.exec("BEGIN");
  const refused = raw.prepare(
    `INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, status, reject_rule, created_at)
     VALUES (?, 'swap', '0x0', ?, ?, 5, 'rejected', 'per-trade-cap', ?)`,
  );
  for (let i = 0; i < o.history; i++) refused.run(A, USDG, TSLA, NOW - 86400 * 30 + Math.floor((i * 86400 * 29) / o.history));
  if (o.quoteAt !== undefined) {
    raw
      .prepare(
        `INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, status, fill_side, fill_price_usd, fill_cash_usdg, basis_source, created_at)
         VALUES (?, 'swap', '0x0', ?, ?, 5, 'landed', 'buy', 200, 5, 'quote', ?)`,
      )
      .run(A, USDG, TSLA.toUpperCase().replace("0X", "0x"), o.quoteAt);
  }
  const decide = raw.prepare(`INSERT INTO decisions (id, agent_id, source, action, symbol, size_usdg, reason, at) VALUES (?, ?, 'brain', 'sell', 'TSLA', 5, ?, ?)`);
  const sell = raw.prepare(
    `INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, status, decision_id, fill_side, fill_price_usd, fill_cash_usdg, realized_pnl_usdg, basis_source, created_at)
     VALUES (?, 'swap', '0x0', ?, ?, 5, 'landed', ?, 'sell', 200, 5, 1, 'receipt', ?)`,
  );
  for (let i = 0; i < o.sells; i++) {
    const at = NOW - 80_000 + i * 1_800;
    decide.run(`s${i}`, A, `Selling TSLA, reason ${i}.`, at);
    sell.run(A, TSLA, USDG, `s${i}`, o.sellWrittenAt ?? at);
  }
  // Views: a hold on each of `holds` names, which never carries a fill.
  const hold = raw.prepare(`INSERT INTO decisions (id, agent_id, source, action, symbol, reason, at) VALUES (?, ?, 'brain', 'hold', ?, ?, ?)`);
  for (let i = 0; i < (o.holds ?? 0); i++) hold.run(`h${i}`, A, `NAME${i}`, `Holding NAME${i}: nothing has changed.`, NOW - 600 - i);
  raw.exec("COMMIT");
  // Every trade row the engine reads from here on is counted.
  const count = { visits: 0 };
  raw.function("visit", { deterministic: false }, () => {
    count.visits++;
    return 1;
  });
  raw.exec("ALTER TABLE trades RENAME TO trades_ledger; CREATE VIEW trades AS SELECT * FROM trades_ledger WHERE visit();");
  return { raw, db, count };
}

const identities = async () => [{ tenant: "0x1" as const, slug: SLUG, accounts: [A.toLowerCase() as `0x${string}`], createdAt: 1, updatedAt: 1 }];
const privateBook = (async () => ({ strategy: "custom", publicBook: false })) as never;

async function feed(o: Parameters<typeof ledger>[0], opts: { agentSlug?: string } = {}) {
  const { raw, db, count } = await ledger(o);
  try {
    const r = await readTheses(opts, (fn) => fn(db), identities, privateBook);
    return { visits: count.visits, pct: r.theses.map((t) => t.realizedPct ?? null) };
  } finally {
    raw.close();
  }
}

async function peers(o: Parameters<typeof ledger>[0]) {
  const { raw, db, count } = await ledger(o);
  try {
    const r = await readPeerTheses(db as Db, [A.toLowerCase() as `0x${string}`]);
    return { visits: count.visits, pct: r.filter((t) => t.action === "sell").map((t) => t.realizedPct ?? null) };
  } finally {
    raw.close();
  }
}

describe("the basis check costs one pass per read, however many sells it covers", () => {
  it("THE REVIEW'S BENCH ON THE FEED: forty sells cost what one does, and all forty keep their percent", async () => {
    const one = await feed({ history: HISTORY, sells: 1 });
    const forty = await feed({ history: HISTORY, sells: 40 });
    assert.deepEqual(one.pct, [25]);
    assert.deepEqual(forty.pct, Array(40).fill(25), "the figures are the same figures");
    // Per sell, the old EXISTS read the whole history again: 40 × 6,000.
    assert.ok(forty.visits < one.visits + 40 * 20, `forty sells visited ${forty.visits} rows, one visited ${one.visits}`);
  });

  it("the same on one agent's own page (the profile's thirty days), scoped to its accounts", async () => {
    const one = await feed({ history: HISTORY, sells: 1 }, { agentSlug: SLUG });
    const forty = await feed({ history: HISTORY, sells: 40 }, { agentSlug: SLUG });
    assert.deepEqual(forty.pct, Array(40).fill(25));
    assert.ok(forty.visits < one.visits + 40 * 20, `forty sells visited ${forty.visits} rows, one visited ${one.visits}`);
  });

  it("the same for the peer files, which every tenant reads on every mirror pass", async () => {
    const one = await peers({ history: HISTORY, sells: 1 });
    const forty = await peers({ history: HISTORY, sells: 40 });
    assert.ok(forty.pct.length > 0 && forty.pct.every((p) => p === 25), JSON.stringify(forty.pct));
    assert.ok(forty.visits < one.visits + 40 * 20, `forty sells visited ${forty.visits} rows, one visited ${one.visits}`);
  });
});

describe("and it answers what the EXISTS answered", () => {
  it("a quote-booked buy before the sells makes every one an estimate — found through a mixed-case account and token", async () => {
    const r = await feed({ history: 100, sells: 3, quoteAt: NOW - 86400 * 20 });
    assert.deepEqual(r.pct, [null, null, null]);
    const own = await feed({ history: 100, sells: 3, quoteAt: NOW - 86400 * 20 }, { agentSlug: SLUG });
    assert.deepEqual(own.pct, [null, null, null], "the scoped read finds the account whatever case the ledger spells it in");
  });

  it("a quote-booked buy AFTER a sell does not reach back and taint it", async () => {
    // Sells at NOW-80000, -78200, -76400; the quote buy between the second and third.
    const r = await feed({ history: 100, sells: 3, quoteAt: NOW - 77_000 });
    assert.deepEqual([...r.pct].sort(), [25, 25, null].sort());
  });

  it("a trade written a little before its decision's window is still in scope, and keeps its figure", async () => {
    // Decisions ~22h ago; their trade rows stamped 25h ago, past the 24h window.
    const r = await feed({ history: 100, sells: 2, sellWrittenAt: NOW - 90_000 });
    assert.deepEqual(r.pct, [25, 25]);
  });

  it("A SELL THE SCOPE CANNOT SEE IS AN ESTIMATE, NEVER A FIGURE — the bound fails closed", async () => {
    // The trade row written long before the decision that owns it: outside the
    // window the scope reads, so its basis was never checked.
    const r = await feed({ history: 100, sells: 2, sellWrittenAt: NOW - 86400 * 10 });
    assert.deepEqual(r.pct, [null, null]);
  });
});

/**
 * THE VIEW LANE PAYS NOTHING FOR IT (R3F-3). The view statement reads holds
 * and pure theses, and a view publishes no entry or realized figure
 * (publishableThesis gives both only to a filled buy or sell). It used to cost
 * almost nothing, then the basis scope was put in front of it too: a full pass
 * over each selling account's history per read, for figures nothing there can
 * publish. Counted per statement here, with every trade row the engine visits.
 */
describe("the view lane never reads the basis scope", () => {
  async function perStatement(o: Parameters<typeof ledger>[0]) {
    const { raw, db, count } = await ledger(o);
    const per: { sql: string; visits: number }[] = [];
    const counted = new Proxy(db, {
      get(target, prop) {
        if (prop !== "prepare") {
          const v = Reflect.get(target, prop, target);
          return typeof v === "function" ? v.bind(target) : v;
        }
        return (sql: string) => {
          const stmt = target.prepare(sql);
          return {
            ...stmt,
            all: async (...params: unknown[]) => {
              const before = count.visits;
              const out = await stmt.all(...params);
              per.push({ sql, visits: count.visits - before });
              return out;
            },
          };
        };
      },
    });
    try {
      const r = await readTheses({}, (fn) => fn(counted), identities, privateBook);
      const views = per.filter((s) => s.sql.includes("agent_turn"));
      assert.equal(views.length, 1, "one view statement");
      return { view: views[0]!, theses: r.theses };
    } finally {
      raw.close();
    }
  }

  it("A HOLD'S READ COSTS THE SAME ON AN ACCOUNT WITH A LONG HISTORY AS ON A SHORT ONE — and says the same", async () => {
    const short = await perStatement({ history: 100, sells: 1, holds: 3 });
    const long = await perStatement({ history: HISTORY, sells: 1, holds: 3 });
    assert.equal(long.view.visits, short.view.visits, `the view statement visited ${long.view.visits} trade rows over ${HISTORY} of history, ${short.view.visits} over 100`);
    assert.doesNotMatch(long.view.sql, /basis_read|basis_quote/, "and it does not name the scope at all");
    const holds = (t: typeof long.theses) => t.filter((x) => x.action === "hold").map((x) => [x.symbol, x.reason, x.entryPriceUsd, x.realizedPct]);
    assert.equal(holds(long.theses).length, 3, "the holds are read and published");
    assert.deepEqual(holds(long.theses), holds(short.theses));
    assert.deepEqual(long.theses.find((x) => x.action === "sell")?.realizedPct, 25, "the sell keeps its checked figure");
  });
});

