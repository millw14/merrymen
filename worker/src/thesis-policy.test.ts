/**
 * THE GATE'S SQL HALF, AND A COIN NAME THAT IS NOT A PATTERN.
 *
 * Two things a bounded reader leans on and nothing executed until now.
 *
 * `publicationNarrowing` lets the feed and the peer files skip, in SQL, the rows
 * the gate was always going to drop — the class route's refused re-proposals and
 * a blocked basket's account-wide refusals, written every tick. It is only safe
 * while it is never NARROWER than `publishableThesis`, so that is tested against
 * a real SQLite on every combination of the columns it reads, NULLs included,
 * rather than read.
 *
 * `readerHead` put a deployer-chosen name into `String.prototype.replace` as the
 * replacement string, where `$$`, `$&`, `` $` `` and `$'` are patterns.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { wrapSqlite } from "./db";
import { readPeerTheses } from "./peer-theses";
import {
  LANDED_STATUSES,
  outcomeOf,
  publicationNarrowing,
  publishableThesis,
  readerHead,
  type ThesisRow,
} from "./thesis-policy";

describe("a coin's name is printed as it was typed", () => {
  const head = (display_name: string) => {
    const post = publishableThesis({
      agent_id: "0xabc",
      name: "Shogun",
      source: "brain",
      action: "hold",
      symbol: "T3139F043B88",
      display_name,
      reason: "Flow is two-sided and the book is deep enough.",
      said: 1,
      last_at: 1,
      first_at: 1,
      mode: "live",
    });
    assert.ok(post, "the fixture must publish");
    return readerHead(post);
  };

  it("DOLLAR PATTERNS IN A NAME ARE TEXT, NOT REPLACEMENT SYNTAX", () => {
    assert.equal(head("$$CASH"), "hold $$CASH");
    assert.equal(head("MOON$'"), "hold MOON$'");
    assert.equal(head("A$`B"), "hold A$`B");
    assert.equal(head("$&"), "hold $&");
  });

  it("and an ordinary name still loses only the id it added", () => {
    assert.equal(head("JUGGERNAUT"), "hold JUGGERNAUT");
  });
});

describe("what the SQL calls landed is what outcomeOf calls landed", () => {
  it("every landed status lands, and nothing else does", () => {
    for (const s of LANDED_STATUSES) assert.equal(outcomeOf(s, null).outcome, "landed", s);
    for (const s of ["rejected", "reverted", "submitted", "weird", null]) {
      assert.notEqual(outcomeOf(s, null).outcome, "landed", String(s));
    }
  });
});

/** Every value the three narrowed rules read, NULL included for each. */
const SOURCES = ["class-route", "strategy:steady-basket", "strategy:even-keel", "strategist", "brain", "brain-shadow", "market-review"];
const ACTIONS = [null, "buy", "sell", "hold", "vault-deposit", "vault-withdraw", "transfer"];
const STATUSES = [null, "landed", "paper", "rejected", "reverted", "submitted"];
const RULES = [null, "ops-cap", "live-not-enabled", "no-cash", "drawdown-breaker", "per-trade-cap", "asset-allowlist", "free text"];

async function matrix() {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await db.exec(`CREATE TABLE decisions(id TEXT, source TEXT, action TEXT, symbol TEXT, reason TEXT);
    CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id TEXT, status TEXT, reject_rule TEXT);`);
  const rows = new Map<string, ThesisRow>();
  let n = 0;
  for (const source of SOURCES)
    for (const action of ACTIONS)
      for (const status of STATUSES)
        for (const rule of status === "rejected" ? RULES : [null]) {
          const id = `d${n++}`;
          const symbol = action === null ? null : "TSLA";
          const reason = "Depth is thin and the spread is wide; nothing worth taking.";
          await db.prepare("INSERT INTO decisions VALUES (?,?,?,?,?)").run(id, source, action, symbol, reason);
          // A decision with no trade has no status at all, which is a
          // different row from a trade whose status is NULL — both are read.
          if (status !== null) await db.prepare("INSERT INTO trades (decision_id, status, reject_rule) VALUES (?,?,?)").run(id, status, rule);
          rows.set(id, { agent_id: "0xabc", name: "Robin", source, action, symbol, reason, status, reject_rule: rule, mode: "live", said: 1, last_at: 1, first_at: 1 });
        }
  return { raw, db, rows };
}

describe("the SQL half of the gate", () => {
  it("NEVER KEEPS OUT A ROW THE GATE WOULD PUBLISH — on every combination, NULLs included", async () => {
    const { raw, db, rows } = await matrix();
    try {
      const narrow = publicationNarrowing("d", "t");
      const kept = new Set(
        ((await db
          .prepare(`SELECT d.id AS id FROM decisions d LEFT JOIN trades t ON t.decision_id = d.id WHERE ${narrow.sql}`)
          .all(...narrow.args)) as { id: string }[]).map((r) => r.id),
      );
      let published = 0;
      for (const [id, row] of rows) {
        if (!publishableThesis(row)) continue;
        published++;
        assert.ok(kept.has(id), `the SQL dropped a publishable row: ${JSON.stringify(row)}`);
      }
      assert.ok(published > 50, "the matrix must actually contain publishable rows");
    } finally {
      raw.close();
    }
  });

  it("and it does keep out the three kinds a bounded scan was drowning in", async () => {
    const { raw, db, rows } = await matrix();
    try {
      const narrow = publicationNarrowing("d", "t");
      const kept = new Set(
        ((await db
          .prepare(`SELECT d.id AS id FROM decisions d LEFT JOIN trades t ON t.decision_id = d.id WHERE ${narrow.sql}`)
          .all(...narrow.args)) as { id: string }[]).map((r) => r.id),
      );
      const find = (want: Partial<ThesisRow>) =>
        [...rows].find(([, r]) => Object.entries(want).every(([k, v]) => r[k as keyof ThesisRow] === v))![0];
      assert.ok(!kept.has(find({ source: "class-route", action: "buy", status: "rejected", reject_rule: "per-trade-cap" })), "a refused class entry");
      assert.ok(!kept.has(find({ source: "class-route", action: "buy", status: null })), "a class entry that never traded");
      assert.ok(!kept.has(find({ source: "strategy:steady-basket", action: "vault-deposit", status: "rejected", reject_rule: null })), "a refused vault park");
      assert.ok(!kept.has(find({ source: "strategy:steady-basket", action: "buy", status: "rejected", reject_rule: "live-not-enabled" })), "an account-wide refusal");
      // And the boundary: a model's refused thesis, and a refusal about the
      // trade itself, still reach the gate.
      assert.ok(kept.has(find({ source: "strategist", action: "buy", status: "rejected", reject_rule: "ops-cap" })));
      assert.ok(kept.has(find({ source: "strategy:steady-basket", action: "buy", status: "rejected", reject_rule: "asset-allowlist" })));
      assert.ok(kept.has(find({ source: "class-route", action: "buy", status: "paper" })), "a paper fill landed");
    } finally {
      raw.close();
    }
  });
});

describe("a peer's landed trade is not buried under refusals the gate drops", () => {
  it("A THOUSAND REFUSED CLASS ENTRIES, THEN ONE LANDED EXIT — the exit reaches the peer file", async () => {
    // The peer scan pages to 960 groups and stops. The class route writes a
    // fresh refused entry every tick with drifting evidence, so each is its own
    // group; before the SQL said the rule too, a day of them was the whole scan.
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    try {
      await db.exec(`CREATE TABLE agents(smart_account TEXT, name TEXT, x_handle TEXT, mode TEXT);
        CREATE TABLE decisions(id TEXT, agent_id TEXT, action TEXT, symbol TEXT, size_usdg REAL, source TEXT, reason TEXT, dropped_rule TEXT, hold_kind TEXT, at INTEGER);
        CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id TEXT, status TEXT, reject_rule TEXT);
        CREATE TABLE posts(decision_id TEXT, body TEXT);
        INSERT INTO agents VALUES ('0xabc', 'Shogun', NULL, 'live');`);
      const now = Math.floor(Date.now() / 1000);
      const insert = db.prepare("INSERT INTO decisions VALUES (?, '0xabc', ?, ?, 5, 'class-route', ?, NULL, NULL, ?)");
      const trade = db.prepare("INSERT INTO trades (decision_id, status, reject_rule) VALUES (?, ?, ?)");
      await insert.run("exit", "sell", "TKNA", "Taking the exit; the curve stalled.", now - 3 * 3600);
      await trade.run("exit", "landed", null);
      for (let i = 0; i < 1000; i++) {
        await insert.run(`r${i}`, "buy", "TKNB", `Taking 5.00 USDG of TKNB; depth ${1000 + i} and rising.`, now - i * 10);
        await trade.run(`r${i}`, "rejected", "per-trade-cap");
      }
      const peer = await readPeerTheses(db, ["0xabc"]);
      assert.ok(peer.some((t) => t.action === "sell" && t.outcome === "landed"), "the landed exit is in the peer file");
    } finally {
      raw.close();
    }
  });
});
