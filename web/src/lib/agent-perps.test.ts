/**
 * THE WEB READS THE WORKER'S PERPS REPORT; IT NEVER WORKS ONE OUT.
 *
 * `agents.perps` is written by the one process holding the Lighter key. What
 * this reader must get right is every way the report can be missing or wrong
 * — no row, no column yet, NULL, garbage, a malformed position, a ledger that
 * will not open — and it must keep "not said" apart from "unreadable": the
 * desk draws nothing for the first and "Lighter could not be read" for the
 * second, and neither is ever an empty book (docs/perps.md rule 11).
 *
 * Driven against a real in-memory sqlite through the same wrapper the web's
 * read seam uses, so a missing column fails the way it fails in production.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { PerpsReport } from "@merrymen/core";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { readAgentPerps, readAgentPerpsFrom, readAgentPerpsRead, type ReadDb } from "./agent-perps";

const ACCOUNT = "0x1111111111111111111111111111111111111111";

const REPORT: PerpsReport = {
  v: 1,
  mode: "live",
  blocker: null,
  venueReadAt: 1_790_697_000_000,
  protectAt: 1_790_697_010_000,
  accountIndex: 22149,
  positions: [
    {
      market: "BTC-PERP",
      side: "long",
      baseAmount: "0.00030",
      entryPrice: "83218.6",
      markPrice: "83220.1",
      leverage: 2,
      marginMicro: "12482790",
      liqPrice: "41931.3",
      unrealizedMicro: "-450",
      stopTrigger: "79057.7",
      fundingMicro: "-12",
    },
  ],
  openNotionalMicro: "24965580",
  collateralMicro: "17517210",
  inTransitMicro: "0",
  minLiqDistanceBps: 4961,
  stopsMissing: 0,
  incident: false,
};

/** A ledger with an agents table, with or without the perps column. */
function ledger(opts: { perpsColumn?: boolean; rows?: { account: string; perps: string | null }[] } = {}): ReadDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec(
    opts.perpsColumn === false
      ? "CREATE TABLE agents (smart_account TEXT PRIMARY KEY, mode TEXT)"
      : "CREATE TABLE agents (smart_account TEXT PRIMARY KEY, mode TEXT, perps TEXT)",
  );
  for (const r of opts.rows ?? []) {
    if (opts.perpsColumn === false) raw.prepare("INSERT INTO agents (smart_account) VALUES (?)").run(r.account);
    else raw.prepare("INSERT INTO agents (smart_account, perps) VALUES (?, ?)").run(r.account, r.perps);
  }
  const db = wrapSqlite(raw);
  return <T>(fn: (d: Db | null) => Promise<T>) => fn(db);
}

const one = (perps: string | null) => ledger({ rows: [{ account: ACCOUNT, perps }] });

describe("readAgentPerps — the /api/grants shape: the report or null", () => {
  it("RETURNS THE WORKER'S REPORT, parsed field by field", async () => {
    assert.deepEqual(await readAgentPerps(ACCOUNT, one(JSON.stringify(REPORT))), REPORT);
  });

  it("an unread venue figure STAYS NULL — never 0", async () => {
    const unread = { ...REPORT, collateralMicro: null, inTransitMicro: null, positions: [{ ...REPORT.positions[0], markPrice: null, unrealizedMicro: null }] };
    const got = await readAgentPerps(ACCOUNT, one(JSON.stringify(unread)));
    assert.equal(got?.collateralMicro, null);
    assert.equal(got?.positions[0]?.unrealizedMicro, null);
    assert.equal(got?.positions[0]?.markPrice, null);
  });

  it("NO KEY OF ANY KIND SURVIVES THE READ: fields the v1 shape does not name are dropped", async () => {
    const stray = `0x${"9f".repeat(40)}`;
    const raw = { ...REPORT, apiPrivateKey: stray, positions: [{ ...REPORT.positions[0], apiKey: stray }] };
    const got = await readAgentPerps(ACCOUNT, one(JSON.stringify(raw)));
    assert.deepEqual(got, REPORT);
    assert.ok(!JSON.stringify(got).includes("9f9f"), "the stray key-shaped value is not carried");
  });

  it("no row, a NULL column, garbage and the wrong shape are all null", async () => {
    assert.equal(await readAgentPerps(ACCOUNT, ledger()), null);
    assert.equal(await readAgentPerps(ACCOUNT, one(null)), null);
    assert.equal(await readAgentPerps(ACCOUNT, one("{not json")), null);
    for (const bad of [
      { ...REPORT, v: 2 },
      { ...REPORT, mode: "leveraged" },
      { ...REPORT, collateralMicro: 17.5 },
      // ONE malformed position rejects the whole report: a book with a
      // leveraged position quietly missing is the lie the banner prevents.
      { ...REPORT, positions: [...REPORT.positions, { ...REPORT.positions[0], side: "sell" }] },
      [REPORT],
    ]) {
      assert.equal(await readAgentPerps(ACCOUNT, one(JSON.stringify(bad))), null, JSON.stringify(bad).slice(0, 80));
    }
  });

  it("no ledger, a ledger that throws, and no account are null — and no account asks nothing", async () => {
    assert.equal(await readAgentPerps(ACCOUNT, (fn) => fn(null)), null);
    assert.equal(await readAgentPerps(ACCOUNT, () => Promise.reject(new Error("pool exhausted"))), null);
    let asked = false;
    const spy: ReadDb = (fn) => {
      asked = true;
      return fn(null);
    };
    assert.equal(await readAgentPerps(null, spy), null);
    assert.equal(await readAgentPerps("", spy), null);
    assert.equal(asked, false);
  });

  it("answers about the account it was asked about and no other", async () => {
    const other = "0x2222222222222222222222222222222222222222";
    assert.equal(await readAgentPerps(other, one(JSON.stringify(REPORT))), null);
  });
});

describe("readAgentPerpsRead — NOT SAID and UNREADABLE are different answers", () => {
  it("no row, a NULL column, no ledger and a ledger from before the column: not said", async () => {
    assert.deepEqual(await readAgentPerpsRead(ACCOUNT, ledger()), { state: "not-said" });
    assert.deepEqual(await readAgentPerpsRead(ACCOUNT, one(null)), { state: "not-said" });
    assert.deepEqual(await readAgentPerpsRead(ACCOUNT, (fn) => fn(null)), { state: "not-said" });
    assert.deepEqual(
      await readAgentPerpsRead(ACCOUNT, ledger({ perpsColumn: false, rows: [{ account: ACCOUNT, perps: null }] })),
      { state: "not-said" },
      "a worker that predates the column has said nothing, which is not something we cannot read",
    );
  });

  it("garbage, the wrong shape and a ledger that throws: unreadable — never flat", async () => {
    assert.deepEqual(await readAgentPerpsRead(ACCOUNT, one("{not json")), { state: "unreadable" });
    assert.deepEqual(await readAgentPerpsRead(ACCOUNT, one(JSON.stringify({ ...REPORT, v: 2 }))), { state: "unreadable" });
    assert.deepEqual(await readAgentPerpsRead(ACCOUNT, () => Promise.reject(new Error("locked"))), { state: "unreadable" });
    const throwing = {
      prepare: () => ({
        get: async () => {
          throw new Error("disk I/O error");
        },
      }),
    } as unknown as Db;
    assert.deepEqual(await readAgentPerpsFrom(throwing, ACCOUNT), { state: "unreadable" });
  });

  it("a readable report is ok, and it asks for the perps column of this agent's row only", async () => {
    const asked: { sql: string; params: unknown[] }[] = [];
    const stub = {
      prepare: (sql: string) => ({
        get: async (...params: unknown[]) => {
          asked.push({ sql, params });
          return params[0] === ACCOUNT ? { perps: JSON.stringify(REPORT) } : undefined;
        },
      }),
    } as unknown as Db;
    assert.deepEqual(await readAgentPerpsFrom(stub, ACCOUNT), { state: "ok", report: REPORT, accountMode: null });
    assert.equal(asked.length, 2);
    assert.match(asked[0]!.sql, /^\s*SELECT\s+perps\s+FROM\s+agents\s+WHERE\s+smart_account\s*=\s*\?\s*$/i);
    assert.deepEqual(asked[0]!.params, [ACCOUNT]);
    // …and the account's own book from the same row, on its own (perps-view.ts perpsBookOf).
    assert.match(asked[1]!.sql, /^\s*SELECT\s+mode\s+FROM\s+agents\s+WHERE\s+smart_account\s*=\s*\?\s*$/i);
    assert.deepEqual(asked[1]!.params, [ACCOUNT]);
  });

  it("THE ACCOUNT'S BOOK RIDES WITH THE REPORT: agents.mode, and a failed read of it is null, never the report's loss", async () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec("CREATE TABLE agents (smart_account TEXT PRIMARY KEY, mode TEXT, perps TEXT)");
    raw.prepare("INSERT INTO agents (smart_account, mode, perps) VALUES (?, ?, ?)").run(ACCOUNT, "paper", JSON.stringify(REPORT));
    const got = await readAgentPerpsFrom(wrapSqlite(raw), ACCOUNT);
    assert.deepEqual(got, { state: "ok", report: REPORT, accountMode: "paper" });
    // A driver that answers the report and refuses the mode: the report stands, the book is not said.
    const modeFails = {
      prepare: (sql: string) => ({
        get: async () => {
          if (/SELECT\s+mode/i.test(sql)) throw new Error("no such column: mode");
          return { perps: JSON.stringify(REPORT) };
        },
      }),
    } as unknown as Db;
    assert.deepEqual(await readAgentPerpsFrom(modeFails, ACCOUNT), { state: "ok", report: REPORT, accountMode: null });
  });
});
