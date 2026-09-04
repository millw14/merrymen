import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Db } from "./db";
import { deriveBootstrapAccounting, usdgRealToMicro } from "./bootstrap-source";
import {
  accountingLicence,
  BOOTSTRAP_SCHEMA_VERSION,
  classifyAnchor,
  planFirstObservation,
} from "./bootstrap-state";

/**
 * THE SOLE LICENSOR OF AN OPENING BALANCE, TESTED.
 *
 * `deriveBootstrapAccounting` is the only thing in the system that can say
 * `no-prior-accounting`, and that arm is the only thing that permits booking a
 * whole balance as a new contribution. It shipped with no test at all, and the
 * defect that got through was as bad as defects get: it queried the ledger by
 * the OWNER address while every table keys on the SMART ACCOUNT, so every funded
 * tenant would have read as brand new and been re-booked on every deploy — with
 * the parent's explicit blessing, which is strictly worse than the inference it
 * replaced.
 *
 * So the tests below assert on the PARAMETERS, not only the verdict. A fake `Db`
 * records what it was asked; getting the right answer from the wrong key is the
 * failure mode, and only the parameter can see it.
 */

const OWNER = "0xa233a3085a6f9b43274410e45836d43d091b5908";
const SMART = "0x3E34E58e39DC6614e047dFD3BAD5B7DEA45DCd62";
const NOW = 1_760_000_000;

interface Ask {
  sql: string;
  params: unknown[];
}

/**
 * A Db that answers from a table of canned rows, keyed by a substring of the
 * SQL, and records every question.
 */
function fakeDb(rows: { match: string; row: unknown }[], onQuery?: (a: Ask) => void): { db: Db; asks: Ask[] } {
  const asks: Ask[] = [];
  const db = {
    prepare(sql: string) {
      return {
        async get(...params: unknown[]) {
          const ask = { sql, params };
          asks.push(ask);
          onQuery?.(ask);
          return rows.find((r) => sql.includes(r.match))?.row;
        },
        async all() {
          return [];
        },
        async run() {
          return { changes: 0 };
        },
      };
    },
    async exec() {},
    async tx<T>(fn: (db: Db) => Promise<T>) {
      return fn(db as Db);
    },
  } as unknown as Db;
  return { db, asks };
}

/**
 * MATCH ORDER IS SIGNIFICANT — the first entry whose substring appears in the
 * SQL wins, so the narrow queries must come before the broad ones. Four of the
 * six reads hit the flows table, and they mean different things.
 */
const EMPTY = [
  { match: "FROM agents", row: undefined },
  { match: "AND source = 'epoch-carry'", row: { net: 0, n: 0, last_at: 0 } },
  { match: "tx_hash IS NOT NULL", row: { net: 0, n: 0, last_at: 0 } },
  { match: "FROM flows", row: { net: 0, n: 0, last_at: 0 } },
  { match: "SELECT equity_usdg FROM equity", row: undefined },
  { match: "FROM equity", row: undefined },
  { match: "FROM fee_accruals", row: { n: 0 } },
];

/** One evidenced deposit in epoch 2, no carry. */
const FUNDED = [
  { match: "FROM agents", row: { hwm_usdg: 10, epoch: 2 } },
  { match: "AND source = 'epoch-carry'", row: { net: 0, n: 0, last_at: 0 } },
  { match: "tx_hash IS NOT NULL", row: { net: 10, n: 1, last_at: NOW - 100 } },
  { match: "FROM flows", row: { net: 10, n: 1, last_at: NOW - 100 } },
  { match: "SELECT equity_usdg FROM equity", row: { equity_usdg: 0 } },
  { match: "FROM equity", row: { cash_usdg: 3.334, at: NOW - 50 } },
  { match: "FROM fee_accruals", row: { n: 0 } },
];

describe("B1 — IT MUST ASK ABOUT THE SMART ACCOUNT", () => {
  it("passes the smart account, never the owner address, to every query", async () => {
    const { db, asks } = fakeDb(FUNDED);
    await deriveBootstrapAccounting(db, SMART, NOW);
    assert.ok(asks.length >= 4, `expected the four accounting reads, got ${asks.length}`);
    for (const a of asks) {
      // The account is always the FIRST parameter; an epoch may follow it.
      assert.equal(a.params[0], SMART.toLowerCase(), `queried with ${JSON.stringify(a.params)}: ${a.sql.slice(0, 60)}`);
      assert.notEqual(a.params[0], OWNER.toLowerCase(), "the owner address is not a ledger key");
    }
  });

  it("lowercases, because the ledger stores mixed case and the queries compare LOWER()", async () => {
    const { db, asks } = fakeDb(FUNDED);
    await deriveBootstrapAccounting(db, SMART.toUpperCase(), NOW);
    for (const a of asks) assert.equal(a.params[0], SMART.toLowerCase());
  });

  it("every query is a LOWER() comparison, so a mixed-case stored key still matches", async () => {
    const { db, asks } = fakeDb(FUNDED);
    await deriveBootstrapAccounting(db, SMART, NOW);
    for (const a of asks) assert.match(a.sql, /LOWER\((?:agent_id|smart_account)\)\s*=\s*\?/);
  });
});

describe("B2 — 'no prior accounting' is a positive finding, not a default", () => {
  it("claims it ONLY when every durable trace is absent", async () => {
    const { db } = fakeDb(EMPTY);
    const a = await deriveBootstrapAccounting(db, SMART, NOW);
    assert.equal(a.kind, "no-prior-accounting");
  });

  it("ANY ONE surviving trace is enough to refuse the claim", async () => {
    // Each of these alone means the account has history, and booking an opening
    // balance on top of it would double the owner's recorded capital.
    const cases: [string, { match: string; row: unknown }[]][] = [
      ["a high-water mark", [{ match: "FROM agents", row: { hwm_usdg: 10, epoch: 2 } }]],
      ["a flow row", [{ match: "FROM flows", row: { net: 10, n: 1, last_at: NOW } }]],
      ["an equity mark", [{ match: "FROM equity", row: { cash_usdg: 0, at: NOW } }]],
      ["a fee accrual", [{ match: "FROM fee_accruals", row: { n: 1 } }]],
    ];
    for (const [what, override] of cases) {
      const rows = EMPTY.map((e) => override.find((o) => o.match === e.match) ?? e);
      const a = await deriveBootstrapAccounting(fakeDb(rows).db, SMART, NOW);
      assert.equal(a.kind, "established", `${what} must refuse the new-account claim`);
    }
  });

  it("a funded agent that is UNDERWATER is not new — a zero peak is not emptiness", async () => {
    // hwm 0 with real flows: an agent can be below every peak it ever had.
    const rows = EMPTY.map((e) =>
      e.match === "FROM flows" ? { match: "FROM flows", row: { net: 50, n: 3, last_at: NOW } } : e,
    );
    const a = await deriveBootstrapAccounting(fakeDb(rows).db, SMART, NOW);
    assert.equal(a.kind, "established");
  });
});

describe("B3 — a database that throws is not a database that answered", () => {
  it("returns the `unknown` arm, never `no-prior-accounting`", async () => {
    const db = {
      prepare() {
        return {
          async get() {
            throw new Error("connection refused");
          },
        };
      },
    } as unknown as Db;
    const a = await deriveBootstrapAccounting(db, SMART, NOW);
    assert.equal(a.kind, "unknown");
    assert.match(a.kind === "unknown" ? a.why : "", /connection refused/);
  });

  it("a failure PART WAY THROUGH still refuses, rather than reporting what it got", async () => {
    // The agents read succeeds and the flows read throws. Half an answer about
    // money is not an answer.
    let n = 0;
    const db = {
      prepare(sql: string) {
        return {
          async get() {
            n += 1;
            if (sql.includes("FROM flows")) throw new Error("statement timeout");
            return { hwm_usdg: 10, epoch: 2 };
          },
        };
      },
    } as unknown as Db;
    const a = await deriveBootstrapAccounting(db, SMART, NOW);
    assert.equal(a.kind, "unknown");
    assert.ok(n > 0);
  });

  it("NEVER THROWS, so no caller has to decide for itself what a dead database means", async () => {
    const db = {
      prepare() {
        throw new Error("pool exhausted");
      },
    } as unknown as Db;
    await assert.doesNotReject(() => deriveBootstrapAccounting(db, SMART, NOW));
  });
});

describe("B4 — the receipts-only total is computed separately and reported honestly", () => {
  it("agrees with the all-rows total when every flow names a transaction", async () => {
    const a = await deriveBootstrapAccounting(fakeDb(FUNDED).db, SMART, NOW);
    assert.equal(a.kind, "established");
    if (a.kind !== "established") return;
    assert.equal(a.netContributionsUsdg, "10000000");
    assert.equal(a.anchoredContributionsUsdg, "10000000");
    assert.equal(a.unanchoredFlowCount, 0);
    assert.equal(a.highWaterMarkUsdg, "10000000");
    assert.equal(a.lastObservedCashUsdg, "3334000");
    assert.equal(a.accountingEpoch, 2);
  });

  it("reports the SHORTFALL when some flows carry no transaction", async () => {
    // Three phantom openings, none of them a receipt — the canary's shape.
    const rows = [
      { match: "FROM agents", row: { hwm_usdg: 30, epoch: 2 } },
      { match: "AND source = 'epoch-carry'", row: { net: 0, n: 0, last_at: 0 } },
      { match: "tx_hash IS NOT NULL", row: { net: 0, n: 0, last_at: 0 } },
      { match: "FROM flows", row: { net: 30, n: 3, last_at: NOW } },
      { match: "SELECT equity_usdg FROM equity", row: { equity_usdg: 0 } },
      { match: "FROM equity", row: { cash_usdg: 3.334, at: NOW } },
      { match: "FROM fee_accruals", row: { n: 0 } },
    ];
    const a = await deriveBootstrapAccounting(fakeDb(rows).db, SMART, NOW);
    assert.equal(a.kind, "established");
    if (a.kind !== "established") return;
    assert.equal(a.netContributionsUsdg, "30000000");
    assert.equal(a.anchoredContributionsUsdg, "0", "not one of them is a receipt");
    assert.equal(a.unanchoredFlowCount, 3);
  });

  it("distinguishes 'no cash reading' from 'held nothing'", async () => {
    const rows = FUNDED.map((e) => (e.match === "FROM equity" ? { match: "FROM equity", row: undefined } : e));
    const a = await deriveBootstrapAccounting(fakeDb(rows).db, SMART, NOW);
    assert.equal(a.kind === "established" && a.lastObservedCashUsdg, null);

    const zero = FUNDED.map((e) =>
      e.match === "FROM equity" ? { match: "FROM equity", row: { cash_usdg: 0, at: NOW } } : e,
    );
    const b = await deriveBootstrapAccounting(fakeDb(zero).db, SMART, NOW);
    assert.equal(b.kind === "established" && b.lastObservedCashUsdg, "0");
  });

  it("money crosses as exact integer strings, never as floats", async () => {
    const rows = FUNDED.map((e) =>
      e.match === "tx_hash IS NOT NULL"
        ? { match: "tx_hash IS NOT NULL", row: { net: 154.87, n: 2, last_at: NOW } }
        : e.match === "FROM flows"
          ? { match: "FROM flows", row: { net: 154.87, n: 2, last_at: NOW } }
          : e,
    );
    const a = await deriveBootstrapAccounting(fakeDb(rows).db, SMART, NOW);
    assert.equal(a.kind === "established" && a.netContributionsUsdg, "154870000");
  });

  it("Postgres numerics arriving as strings are still counted", async () => {
    // node-postgres hands NUMERIC/int8 back as strings unless told otherwise.
    const rows = [
      { match: "FROM agents", row: { hwm_usdg: "10", epoch: "2" } },
      { match: "tx_hash IS NOT NULL", row: { net: "10", n: "1", last_at: "0" } },
      { match: "FROM flows", row: { net: "10", n: "1", last_at: String(NOW) } },
      { match: "FROM equity", row: { cash_usdg: "3.334", at: String(NOW) } },
      { match: "FROM fee_accruals", row: { n: "0" } },
    ];
    const a = await deriveBootstrapAccounting(fakeDb(rows).db, SMART, NOW);
    assert.equal(a.kind, "established");
    if (a.kind !== "established") return;
    assert.equal(a.netContributionsUsdg, "10000000");
    assert.equal(a.accountingEpoch, 2);
  });
});

describe("B6 — THE PRE-DEPLOY GATE: the polluted Postgres, as it actually is", () => {
  /**
   * PR A must be safe to deploy against the database as it stands TODAY, which
   * is not clean. Two mechanisms put contributions there that never happened:
   * the worker booked the whole balance as a fresh opening balance on every
   * redeploy, and the mirror — finding its watermark row gone after a rebuild —
   * rewound to zero and re-copied rows 1..N into a table with no unique key and
   * an INSERT with no ON CONFLICT.
   *
   * So this is the shape that is really in there: one genuine 10 USDG deposit
   * with a transaction, and three phantom inferred openings of the same amount.
   * The requirement is not that the derivation cleans it up — it cannot, that is
   * a data repair — but that it does not treat those rows as EVIDENCE.
   */
  const POLLUTED = [
    { match: "FROM agents", row: { hwm_usdg: 40, epoch: 1 } },
    { match: "AND source = 'epoch-carry'", row: { net: 0, n: 0, last_at: 0 } },
    // Only the real deposit is evidenced.
    { match: "tx_hash IS NOT NULL", row: { net: 10, n: 1, last_at: NOW - 5000 } },
    // All four rows: the deposit plus three phantoms.
    { match: "FROM flows", row: { net: 40, n: 4, last_at: NOW - 100 } },
    { match: "SELECT equity_usdg FROM equity", row: undefined },
    { match: "FROM equity", row: { cash_usdg: 3.334, at: NOW - 50 } },
    { match: "FROM fee_accruals", row: { n: 0 } },
  ];

  it("does not treat the phantom rows as evidence", async () => {
    const a = await deriveBootstrapAccounting(fakeDb(POLLUTED).db, SMART, NOW);
    assert.equal(a.kind, "established");
    if (a.kind !== "established") return;
    assert.equal(a.netContributionsUsdg, "40000000", "it reports what is there, honestly");
    assert.equal(a.anchoredContributionsUsdg, "10000000", "and what is EVIDENCED, separately");
    assert.equal(a.unanchoredFlowCount, 3, "three rows nothing can point at");
  });

  it("and the licence therefore refuses to call contributions known", async () => {
    const a = await deriveBootstrapAccounting(fakeDb(POLLUTED).db, SMART, NOW);
    const l = accountingLicence(
      classifyAnchor(
        JSON.stringify({
          schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
          tenantId: SMART,
          generatedAt: NOW,
          accounting: a,
        }),
        { tenantId: SMART, nowSec: NOW },
      ),
      { hosted: true },
    );
    // RESUME, so the peak still comes back — an unrestored peak is how a fee
    // lands on principal, and that danger does not care how dirty the flows are.
    assert.equal(l.licence, "resume");
    assert.equal(l.highWaterMarkUsdg, 40_000_000n);
    // But the total is not evidence, so nothing downstream may publish a return.
    assert.equal(l.contributionsKnown, false);
    assert.match(l.why, /rests on inference/);
  });

  it("BOOKS NOTHING NEW on top of it, however many times it restarts", async () => {
    // The failure that would make PR A unsafe to deploy: arriving at a polluted
    // ledger and adding a fifth phantom to it.
    for (let deploy = 0; deploy < 5; deploy++) {
      const a = await deriveBootstrapAccounting(fakeDb(POLLUTED).db, SMART, NOW);
      const l = accountingLicence(
        classifyAnchor(
          JSON.stringify({
            schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
            tenantId: SMART,
            generatedAt: NOW,
            accounting: a,
          }),
          { tenantId: SMART, nowSec: NOW },
        ),
        { hosted: true },
      );
      const plan = planFirstObservation({
        licence: l.licence,
        equityUsdg: 9_873_005n,
        cashUsdg: 3_334_000n,
        anchorCashUsdg: l.lastObservedCashUsdg,
        materialDriftUsdg: 10_000n,
      });
      assert.notEqual(plan.action, "book-opening-balance", `deploy ${deploy} tried to book another one`);
    }
  });

  it("a polluted ledger is never mistaken for a NEW account", async () => {
    // The catastrophic direction. `no-prior-accounting` is the only arm that
    // licenses booking a balance, and forty USDG of junk flows is still history.
    const a = await deriveBootstrapAccounting(fakeDb(POLLUTED).db, SMART, NOW);
    assert.notEqual(a.kind, "no-prior-accounting");
  });
});

describe("B5 — the REAL to micro conversion", () => {
  it("is exact at six places and defensive beyond them", () => {
    assert.equal(usdgRealToMicro(154.87), 154_870_000n);
    assert.equal(usdgRealToMicro(3.334), 3_334_000n);
    assert.equal(usdgRealToMicro(-6.666), -6_666_000n);
    assert.equal(usdgRealToMicro(0), 0n);
    // A non-finite figure is a broken read, and 0n is the only value that
    // cannot make a downstream total larger than the truth.
    assert.equal(usdgRealToMicro(Number.NaN), 0n);
    assert.equal(usdgRealToMicro(Number.POSITIVE_INFINITY), 0n);
  });
});
