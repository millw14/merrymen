/**
 * THE DESK READS THE WORKER'S ENERGY; IT NEVER WORKS ONE OUT.
 *
 * `agents.energy` is written by the process that throttles, and it is the only
 * process that knows. What this reader must get right is the other half: every
 * way the report can be missing — no row, no column yet, a NULL, a value that
 * is not the v1 shape, a ledger that will not open — has to come back as null,
 * "not said yet", because every surface renders null as "I can't see my
 * energy" and anything else as a fact about somebody's money.
 *
 * Driven against a real in-memory sqlite through the same wrapper the web's
 * read seam uses, so a missing column fails the way it fails in production.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { EnergyStatus } from "@merrymen/core";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { readAgentEnergy, type ReadDb } from "./agent-energy";

const ACCOUNT = "0x1111111111111111111111111111111111111111";

const REPORT: EnergyStatus = {
  v: 1,
  gated: true,
  mode: "enforce",
  level: "low",
  agentTokens: 1_200,
  holderTokens: null,
  needTokens: 100_000,
  day: "2026-09-27",
  resetsAt: 1_790_553_600,
  reviews: { used: 2, allowed: 3 },
  entries: { used: 1, allowed: 2 },
  spent: false,
  buy: "ready",
  estimateUsdg: null,
  at: 1_790_500_000,
};

/** A ledger with an agents table, with or without the energy column. */
function ledger(opts: { energyColumn?: boolean; rows?: { account: string; energy: string | null }[] } = {}): ReadDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec(
    opts.energyColumn === false
      ? "CREATE TABLE agents (smart_account TEXT PRIMARY KEY, mode TEXT)"
      : "CREATE TABLE agents (smart_account TEXT PRIMARY KEY, mode TEXT, energy TEXT)",
  );
  for (const r of opts.rows ?? []) {
    if (opts.energyColumn === false) raw.prepare("INSERT INTO agents (smart_account) VALUES (?)").run(r.account);
    else raw.prepare("INSERT INTO agents (smart_account, energy) VALUES (?, ?)").run(r.account, r.energy);
  }
  const db = wrapSqlite(raw);
  return <T>(fn: (d: Db | null) => Promise<T>) => fn(db);
}

describe("readAgentEnergy", () => {
  it("RETURNS THE WORKER'S REPORT, parsed field by field", async () => {
    const got = await readAgentEnergy(ACCOUNT, ledger({ rows: [{ account: ACCOUNT, energy: JSON.stringify(REPORT) }] }));
    assert.deepEqual(got, REPORT);
  });

  it("AND AN UNREAD COUNT STAYS NULL — never 0", async () => {
    // 0 is the number that sends somebody to buy tokens they may already hold.
    const got = await readAgentEnergy(ACCOUNT, ledger({ rows: [{ account: ACCOUNT, energy: JSON.stringify(REPORT) }] }));
    assert.equal(got?.holderTokens, null);
    assert.equal(got?.estimateUsdg, null);
  });

  it("no row is null — the worker has not said", async () => {
    assert.equal(await readAgentEnergy(ACCOUNT, ledger()), null);
  });

  it("a NULL column is null", async () => {
    assert.equal(await readAgentEnergy(ACCOUNT, ledger({ rows: [{ account: ACCOUNT, energy: null }] })), null);
  });

  it("MALFORMED JSON is null, not a half-read report", async () => {
    assert.equal(await readAgentEnergy(ACCOUNT, ledger({ rows: [{ account: ACCOUNT, energy: "{not json" }] })), null);
  });

  it("a value that is not the v1 shape is null", async () => {
    // String numbers, an unknown level, a future version: a report we cannot
    // trust is no report.
    for (const bad of [
      { ...REPORT, agentTokens: "1200" },
      { ...REPORT, level: "empty" },
      { ...REPORT, v: 2 },
      [REPORT],
    ]) {
      const got = await readAgentEnergy(ACCOUNT, ledger({ rows: [{ account: ACCOUNT, energy: JSON.stringify(bad) }] }));
      assert.equal(got, null, JSON.stringify(bad));
    }
  });

  it("A LEDGER FROM BEFORE THE MIGRATION (no energy column) is null, not an error", async () => {
    assert.equal(
      await readAgentEnergy(ACCOUNT, ledger({ energyColumn: false, rows: [{ account: ACCOUNT, energy: null }] })),
      null,
    );
  });

  it("no ledger at all is null", async () => {
    assert.equal(await readAgentEnergy(ACCOUNT, (fn) => fn(null)), null);
  });

  it("a ledger that throws is null", async () => {
    assert.equal(await readAgentEnergy(ACCOUNT, () => Promise.reject(new Error("pool exhausted"))), null);
  });

  it("NO ACCOUNT, NO QUERY — it cannot answer about an agent it was not given", async () => {
    let asked = false;
    const spy: ReadDb = (fn) => {
      asked = true;
      return fn(null);
    };
    assert.equal(await readAgentEnergy(null, spy), null);
    assert.equal(await readAgentEnergy("", spy), null);
    assert.equal(asked, false);
  });

  it("answers about the account it was asked about and no other", async () => {
    const other = "0x2222222222222222222222222222222222222222";
    const got = await readAgentEnergy(other, ledger({ rows: [{ account: ACCOUNT, energy: JSON.stringify(REPORT) }] }));
    assert.equal(got, null);
  });
});
