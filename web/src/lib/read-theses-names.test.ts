/**
 * A SELL NAMES THE COIN ITS BUY NAMED.
 *
 * Seen on the live feed 2026-09-23: "sell TA151B4A9E1B 5.01 USDG". A held coin
 * drops off the tape's qualified list, discovery then labels it with its own
 * id, and every exit and review of it written after that carried no name. The
 * writer now carries the buy's name forward; the reader gives the rows already
 * written theirs, from the same author's newest named row for that coin.
 *
 * These run the real query against a real SQLite ledger, because the rule is in
 * which rows the lookup is allowed to borrow from: the same author only, an
 * address-derived id only, and never a placeholder.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../../../worker/src/db";
import { newestNames, readTheses } from "./read-theses";

const SLUG = "ems76d3cncwbt3dz";
const OTHER = "hr5k2m9q4w7x3z8n";
const NOW = Math.floor(Date.now() / 1000);
const COIN = "T3139F043B88";

type Decision = {
  id: string;
  agent?: string;
  action: string | null;
  symbol: string | null;
  size?: number | null;
  source?: string;
  reason: string;
  at: number;
  display?: string | null;
  mark?: number | null;
  mcap?: number | null;
};
type Fill = {
  decision: string;
  status: string;
  rule?: string | null;
  side?: string | null;
  price?: number | null;
  cash?: number | null;
  pnl?: number | null;
  basis?: string | null;
};

/**
 * A ledger shaped like the worker's. `premark` is one the writer has not yet
 * migrated to carry `mark_usd`/`mcap_usd` — the minute between two deploys.
 */
async function ledger(decisions: Decision[], fills: Fill[] = [], opts: { premark?: boolean } = {}) {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  raw.exec(`CREATE TABLE agents(smart_account TEXT, name TEXT, x_handle TEXT, mode TEXT, x_verified INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE decisions(id TEXT, agent_id TEXT, action TEXT, symbol TEXT, display_name TEXT, size_usdg REAL, source TEXT,
      reason TEXT, dropped_rule TEXT, hold_kind TEXT, ${opts.premark ? "" : "mark_usd REAL, mcap_usd REAL,"} at INTEGER);
    CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id TEXT, status TEXT, reject_rule TEXT,
      fill_side TEXT, fill_price_usd REAL, fill_cash_usdg REAL, realized_pnl_usdg REAL, basis_source TEXT);
    CREATE TABLE posts(decision_id TEXT, body TEXT);
    INSERT INTO agents VALUES ('0xabc', 'Shogun', NULL, 'live', 0);
    INSERT INTO agents VALUES ('0xdef', 'SirSendIt', NULL, 'live', 0);`);
  const insert = opts.premark
    ? raw.prepare("INSERT INTO decisions (id, agent_id, action, symbol, display_name, size_usdg, source, reason, at) VALUES (?,?,?,?,?,?,?,?,?)")
    : raw.prepare("INSERT INTO decisions (id, agent_id, action, symbol, display_name, size_usdg, source, reason, at, mark_usd, mcap_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  for (const d of decisions) {
    const base = [d.id, d.agent ?? "0xabc", d.action, d.symbol, d.display ?? null, d.size ?? null, d.source ?? "brain", d.reason, d.at];
    if (opts.premark) insert.run(...(base as never[]));
    else insert.run(...(base as never[]), (d.mark ?? null) as never, (d.mcap ?? null) as never);
  }
  const trade = raw.prepare(
    "INSERT INTO trades (decision_id, status, reject_rule, fill_side, fill_price_usd, fill_cash_usdg, realized_pnl_usdg, basis_source) VALUES (?,?,?,?,?,?,?,?)",
  );
  for (const f of fills) {
    trade.run(f.decision, f.status, f.rule ?? null, f.side ?? null, f.price ?? null, f.cash ?? null, f.pnl ?? null, f.basis ?? null);
  }
  return { raw, db };
}

const identities = async () => [
  { tenant: "0x1" as const, slug: SLUG, accounts: ["0xabc" as const], createdAt: 1, updatedAt: 1 },
  { tenant: "0x2" as const, slug: OTHER, accounts: ["0xdef" as const], createdAt: 1, updatedAt: 1 },
];

async function read(decisions: Decision[], fills: Fill[] = [], opts: { premark?: boolean; publicBook?: `0x${string}`[] } = {}) {
  const { raw, db } = await ledger(decisions, fills, opts);
  // Shogun's owner (0x1) is the one who may have opted in; SirSendIt's never did.
  const settings = async (tenant: `0x${string}`) => ({ strategy: "trencher" as const, publicBook: (opts.publicBook ?? []).includes(tenant) });
  try {
    return await readTheses({}, (fn) => fn(db), identities, settings as never);
  } finally {
    raw.close();
  }
}

const buy = (id: string, over: Partial<Decision> = {}): Decision => ({
  id, action: "buy", symbol: COIN, size: 5, display: "JUGGERNAUT", reason: `Entry ${id}: flow flipped to net buying.`, at: NOW - 3600, ...over,
});

describe("a sell names the coin its buy named", () => {
  it("AN UNNAMED EXIT BORROWS THE NAME OF THE SAME AGENT'S NEWEST NAMED ROW for that coin", async () => {
    // The live case: "sell TA151B4A9E1B 5.01 USDG". The coin aged out of the
    // tape before the exit, so the exit's row was written with no name.
    const r = await read(
      [
        buy("b1", { at: NOW - 7200 }),
        { id: "s1", action: "sell", symbol: COIN, size: 5.01, display: null, reason: "Exit: the stop fired.", source: "strategy:trencher", at: NOW - 60 },
      ],
      [
        { decision: "b1", status: "landed", side: "buy", price: 0.0004, cash: 5, basis: "receipt" },
        { decision: "s1", status: "landed", side: "sell", price: 0.0004, cash: 5.01, pnl: 0.01, basis: "receipt" },
      ],
    );
    const exit = r.theses.find((t) => t.action === "sell")!;
    assert.equal(exit.displayName, "JUGGERNAUT");
    assert.equal(exit.head, `sell JUGGERNAUT (${COIN})`, "the id stays beside it for /why");
  });

  it("an unnamed hold does too", async () => {
    const r = await read([
      buy("b1", { at: NOW - 7200 }),
      { id: "h1", action: "hold", symbol: COIN, display: null, reason: "Still two-sided; holding.", at: NOW - 60 },
    ], [{ decision: "b1", status: "landed", side: "buy", price: 0.0004, cash: 5, basis: "receipt" }]);
    assert.equal(r.theses.find((t) => t.action === "hold")!.displayName, "JUGGERNAUT");
  });

  it("NEVER ANOTHER AGENT'S NAME for the same id", async () => {
    const r = await read([
      buy("b1", { agent: "0xdef", display: "IMPOSTOR", at: NOW - 7200 }),
      { id: "s1", action: "sell", symbol: COIN, size: 5, display: null, reason: "Exit: the stop fired.", source: "strategy:trencher", at: NOW - 60 },
    ], [{ decision: "s1", status: "landed", side: "sell", basis: "receipt" }]);
    const exit = r.theses.find((t) => t.name === "Shogun")!;
    assert.equal(exit.displayName, null);
    assert.equal(exit.head, `sell ${COIN}`);
  });

  it("A STOCK IS NEVER RENAMED — its name is its ticker, whatever a stray row says", async () => {
    const r = await read([
      { id: "h1", action: "hold", symbol: "TSLA", display: "Tesla", reason: "Holding through the print.", at: NOW - 7200 },
      { id: "s1", action: "sell", symbol: "TSLA", size: 5, display: null, reason: "Trimming into strength.", source: "strategy:even-keel", at: NOW - 60 },
    ], [{ decision: "s1", status: "landed", side: "sell", basis: "receipt" }]);
    const exit = r.theses.find((t) => t.action === "sell")!;
    assert.equal(exit.displayName, null);
    assert.equal(exit.head, "sell TSLA");
  });

  it("TWO NAMES IN ONE SECOND: the pick is the first by name, whatever order the rows come back in", async () => {
    const rows = [
      { agent_id: "0xabc", symbol: COIN, display_name: "ZEBRA", at: NOW - 7200 },
      { agent_id: "0xabc", symbol: COIN, display_name: "JUGGERNAUT", at: NOW - 7200 },
      { agent_id: "0xabc", symbol: COIN, display_name: "OLDER", at: NOW - 9000 },
    ];
    for (const order of [rows, [...rows].reverse(), [rows[1]!, rows[2]!, rows[0]!]]) {
      assert.equal(newestNames(order).get(`0xabc|${COIN}`), "JUGGERNAUT");
    }
    // A newer name still wins over the tie, whatever its spelling.
    assert.equal(newestNames([...rows, { agent_id: "0xabc", symbol: COIN, display_name: "ZZZ", at: NOW - 60 }]).get(`0xabc|${COIN}`), "ZZZ");
    // And through the real read, both ways round in the ledger.
    for (const [first, second] of [["ZEBRA", "JUGGERNAUT"], ["JUGGERNAUT", "ZEBRA"]]) {
      const r = await read([
        buy("b1", { display: first, at: NOW - 7200 }),
        buy("b2", { display: second, at: NOW - 7200, reason: "Entry b2: a second look." }),
        { id: "s1", action: "sell", symbol: COIN, size: 5, display: null, reason: "Exit: the stop fired.", source: "strategy:trencher", at: NOW - 60 },
      ], [{ decision: "s1", status: "landed", side: "sell", basis: "receipt" }]);
      assert.equal(r.theses.find((t) => t.action === "sell")!.displayName, "JUGGERNAUT", `${first} first`);
    }
  });

  it("and a coin nobody ever named stays unnamed — absent, never a placeholder", async () => {
    const r = await read([{ id: "s1", action: "sell", symbol: COIN, size: 5, display: null, reason: "Exit: the stop fired.", source: "strategy:trencher", at: NOW - 60 }],
      [{ decision: "s1", status: "landed", side: "sell", basis: "receipt" }]);
    assert.equal(r.theses[0]!.displayName, null);
  });
});
