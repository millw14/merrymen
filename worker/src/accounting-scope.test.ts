import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ACCOUNTING_SCOPES, EPOCH_SCOPED, isEvidencedFlow, reconcileEpochCarry } from "./accounting-scope";
import { deriveBootstrapAccounting } from "./bootstrap-source";
import { accountingLicence, classifyAnchor, BOOTSTRAP_SCHEMA_VERSION } from "./bootstrap-state";
import type { Db } from "./db";

/**
 * TWO EPOCHS, AND THE SAME CAPITAL COUNTED ONCE.
 *
 * `openNextEpoch` bridges a boundary by writing the closing equity of the epoch
 * just closed as the new one's opening balance. That is only correct if
 * contributions are read PER EPOCH — and one of the two readers was not.
 * `getNetContributionsUsdg` summed every row for the agent while the web's
 * identical query carried an epoch predicate.
 *
 * It never fired, and the reason it never fired is the interesting part: the
 * only agents ever bumped were those with rows predating the accounting fix, and
 * those rows predate the flows table too — so epoch 1 held no flows and a
 * lifetime sum happened to equal the current epoch's. Accidentally correct is not
 * correct, and the accident stops holding the moment an agent funded on today's
 * code is bumped for any future reason.
 */

const SMART = "0x3E34E58e39DC6614e047dFD3BAD5B7DEA45DCd62";
const NOW = 1_760_000_000;

/**
 * A fake ledger that actually stores flows with epochs, so an epoch predicate is
 * OBSERVABLE rather than asserted. `deriveBootstrapAccounting` builds its own
 * SQL; this reads the epoch out of the parameters it was called with and filters
 * accordingly, which is the only way a test can tell a scoped query from an
 * unscoped one.
 */
function ledger(flows: { epoch: number; amount: number; source: string; tx: string | null }[], opts: {
  epoch: number;
  hwm: number;
  equityByEpoch?: Record<number, number>;
  cash?: number;
}) {
  const asks: { sql: string; params: unknown[] }[] = [];
  const sum = (rows: typeof flows) => rows.reduce((s, f) => s + f.amount, 0);
  const db = {
    prepare(sql: string) {
      return {
        async get(...params: unknown[]) {
          asks.push({ sql, params });
          if (sql.includes("FROM agents")) return { hwm_usdg: opts.hwm, epoch: opts.epoch };
          if (sql.includes("FROM fee_accruals")) return { n: 0 };
          if (sql.includes("SELECT equity_usdg FROM equity")) {
            const e = opts.equityByEpoch?.[Number(params[1])];
            return e === undefined ? undefined : { equity_usdg: e };
          }
          if (sql.includes("FROM equity")) return { cash_usdg: opts.cash ?? 0, at: NOW - 10 };
          if (sql.includes("FROM flows")) {
            // THE EPOCH PREDICATE IS THE THING UNDER TEST. A query that does not
            // pass an epoch gets every row, which is exactly the bug.
            const scoped = sql.includes("epoch = ?");
            const wanted = Number(params[1]);
            let rows = scoped ? flows.filter((f) => f.epoch === wanted) : flows;
            if (sql.includes("AND source = 'epoch-carry'")) {
              rows = rows.filter((f) => f.source === "epoch-carry" && f.amount > 0);
              return { net: sum(rows), n: rows.length, last_at: NOW };
            }
            if (sql.includes("tx_hash IS NOT NULL")) {
              rows = rows.filter((f) => (f.tx !== null && f.tx !== "") || f.source === "epoch-carry");
            }
            return { net: sum(rows), n: rows.length, last_at: NOW };
          }
          return undefined;
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

const anchorOf = (a: unknown) =>
  classifyAnchor(
    JSON.stringify({ schemaVersion: BOOTSTRAP_SCHEMA_VERSION, tenantId: SMART, generatedAt: NOW, accounting: a }),
    { tenantId: SMART, nowSec: NOW },
  );

describe("S1 — AN EPOCH-1 DEPOSIT IS NOT AN EPOCH-2 CONTRIBUTION", () => {
  /**
   * The exact scenario the user asked to be proven impossible: an agent funded
   * with a real, tx-hashed deposit in epoch 1, bumped to epoch 2, and then
   * restarted. Under a lifetime sum its 10 USDG is counted twice — once as the
   * deposit, once as the carry derived from it — so contributions read 20
   * against equity of 10 and P&L reads −10 on an account that has done nothing.
   */
  const EPOCH1_DEPOSIT = { epoch: 1, amount: 10, source: "chain-log", tx: "0xf0fbf03e" };
  const CARRY = { epoch: 2, amount: 10, source: "epoch-carry", tx: null };

  it("counts the capital ONCE across the boundary", async () => {
    const { db } = ledger([EPOCH1_DEPOSIT, CARRY], {
      epoch: 2,
      hwm: 10,
      equityByEpoch: { 1: 10 },
      cash: 10,
    });
    const a = await deriveBootstrapAccounting(db, SMART, NOW);
    assert.equal(a.kind, "established");
    if (a.kind !== "established") return;
    assert.equal(a.netContributionsUsdg, "10000000", "10 USDG contributed, not 20");
    assert.notEqual(a.netContributionsUsdg, "20000000", "the lifetime sum would say 20");
    assert.equal(a.accountingEpoch, 2);
  });

  it("asks the flows table with an epoch predicate at all", async () => {
    const { db, asks } = ledger([EPOCH1_DEPOSIT, CARRY], { epoch: 2, hwm: 10, equityByEpoch: { 1: 10 } });
    await deriveBootstrapAccounting(db, SMART, NOW);
    const flowAsks = asks.filter((a) => a.sql.includes("FROM flows"));
    assert.ok(flowAsks.length >= 2, "the all-rows and evidenced totals are both flow reads");
    for (const a of flowAsks) {
      assert.match(a.sql, /epoch = \?/, `unscoped flow query: ${a.sql.slice(0, 90)}`);
      assert.equal(a.params[1], 2, "and it must ask for the CURRENT epoch");
    }
  });

  it("and a restart does not change the answer", async () => {
    // The child's SQLite is empty every deploy; the anchor is derived fresh each
    // time from the same durable rows, so the figure is a pure function of them.
    const seen = new Set<string>();
    for (let deploy = 0; deploy < 4; deploy++) {
      const { db } = ledger([EPOCH1_DEPOSIT, CARRY], { epoch: 2, hwm: 10, equityByEpoch: { 1: 10 }, cash: 10 });
      const a = await deriveBootstrapAccounting(db, SMART, NOW);
      if (a.kind === "established") seen.add(a.netContributionsUsdg);
    }
    assert.deepEqual([...seen], ["10000000"], "four deploys, one answer");
  });
});

describe("S2 — the carry is EVIDENCE, and it is checked", () => {
  it("a carry that matches the previous epoch's closing equity is evidenced", async () => {
    const { db } = ledger([{ epoch: 2, amount: 10, source: "epoch-carry", tx: null }], {
      epoch: 2,
      hwm: 10,
      equityByEpoch: { 1: 10 },
      cash: 10,
    });
    const a = await deriveBootstrapAccounting(db, SMART, NOW);
    assert.equal(a.kind === "established" && a.unanchoredFlowCount, 0, "a reconciling carry is not unanchored");
    const l = accountingLicence(anchorOf(a), { hosted: true });
    assert.equal(l.contributionsKnown, true, "AN AGENT PAST A BOUNDARY CAN STILL EVIDENCE ITS CAPITAL");
  });

  it("a carry that does NOT match is demoted, not silently believed", async () => {
    // The bridge claims to carry 10 but the epoch closed at 4. It is not a
    // bridge, and the total resting on it is not evidence.
    const { db } = ledger([{ epoch: 2, amount: 10, source: "epoch-carry", tx: null }], {
      epoch: 2,
      hwm: 10,
      equityByEpoch: { 1: 4 },
      cash: 10,
    });
    const a = await deriveBootstrapAccounting(db, SMART, NOW);
    assert.equal(a.kind, "established");
    if (a.kind !== "established") return;
    assert.equal(a.unanchoredFlowCount, 1);
    assert.match(a.carryNote ?? "", /does not match/);
    assert.equal(accountingLicence(anchorOf(a), { hosted: true }).contributionsKnown, false);
  });

  it("a carry with no prior closing mark to check against is unverified, not accepted", async () => {
    const { db } = ledger([{ epoch: 2, amount: 10, source: "epoch-carry", tx: null }], {
      epoch: 2,
      hwm: 10,
      equityByEpoch: {},
      cash: 10,
    });
    const a = await deriveBootstrapAccounting(db, SMART, NOW);
    assert.equal(a.kind === "established" && a.unanchoredFlowCount, 1);
    assert.match((a.kind === "established" && a.carryNote) || "", /nothing to check/);
  });

  it("THE RECOVERY THIS RESTORES: an inferred opening balance would have been permanent", () => {
    // Before `epoch-carry` existed the bridge was written `source: 'inferred'`
    // with no transaction, so a receipts-only rule condemned every agent that had
    // ever crossed a boundary — and no deposit scan could ever fix it, because
    // there is no transfer to find.
    assert.equal(isEvidencedFlow("epoch-carry"), true);
    assert.equal(isEvidencedFlow("chain-log"), true);
    assert.equal(isEvidencedFlow("inferred"), false);
    assert.equal(isEvidencedFlow("transfer-intent"), false, "known by construction, but the settlement is not re-read");

    const src = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
    assert.match(src, /source: "epoch-carry"/, "openNextEpoch must write the distinct source");
    const open = src.slice(src.indexOf("export async function openNextEpoch"));
    assert.doesNotMatch(open.slice(0, 1200), /source: "inferred"/, "and must not fall back to inferred");
  });
});

describe("S3 — reconcileEpochCarry, directly", () => {
  it("accepts an exact match and tolerates only storage noise", () => {
    assert.equal(reconcileEpochCarry({ openingBalanceUsdg: 10, priorEpochClosingEquityUsdg: 10 }).reconciles, true);
    assert.equal(
      reconcileEpochCarry({ openingBalanceUsdg: 10, priorEpochClosingEquityUsdg: 10.00005 }).reconciles,
      true,
      "REAL storage can shift the last place",
    );
    assert.equal(
      reconcileEpochCarry({ openingBalanceUsdg: 10, priorEpochClosingEquityUsdg: 10.01 }).reconciles,
      false,
      "a cent is not noise on a 10 USDG book",
    );
  });

  it("a missing prior mark is unverified rather than false-by-default in a misleading way", () => {
    const r = reconcileEpochCarry({ openingBalanceUsdg: 10, priorEpochClosingEquityUsdg: null });
    assert.equal(r.reconciles, false);
    assert.match(r.why, /unverified rather than wrong/);
  });
});

describe("S4 — the scope register is not decoration", () => {
  it("classifies every money figure the user asked about", () => {
    for (const k of [
      "netContributionsUsdg",
      "realizedPnlUsdg",
      "gasUsdg",
      "hwmUsdg",
      "accruedFeeUsdg",
      "equityUsdg",
      "costBasisUsdg",
    ] as const) {
      assert.ok(ACCOUNTING_SCOPES[k], `${k} must have a declared scope`);
    }
    assert.equal(ACCOUNTING_SCOPES.netContributionsUsdg, "epoch");
    assert.equal(ACCOUNTING_SCOPES.hwmUsdg, "monotonic");
    assert.equal(ACCOUNTING_SCOPES.equityUsdg, "lifetime");
    assert.equal(ACCOUNTING_SCOPES.costBasisUsdg, "carried");
  });

  it("EVERY epoch-scoped figure's query actually carries an epoch predicate", () => {
    // The register is documentation a test can read. A figure declared
    // epoch-scoped whose query forgot the predicate is the bug this file is about.
    assert.ok(EPOCH_SCOPED.includes("netContributionsUsdg"));

    const store = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
    const fn = store.slice(store.indexOf("export async function getNetContributionsUsdg"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.match(body, /FROM flows WHERE agent_id = \? AND epoch = \?/, "the worker's reader must be scoped");

    // The anchor's SQL is assembled by concatenation across lines, so the quotes
    // and joins are stripped before looking — otherwise the match stops at the
    // first `"` and every query reads as unscoped.
    const source = readFileSync(new URL("./bootstrap-source.ts", import.meta.url), "utf8")
      .replace(/"\s*\+\s*\n?\s*"/g, "")
      .replace(/\s+/g, " ");
    const at: number[] = [];
    for (let i = source.indexOf("FROM flows"); i >= 0; i = source.indexOf("FROM flows", i + 1)) at.push(i);
    assert.ok(at.length >= 3, `expected the all-rows, evidenced and carry reads, found ${at.length}`);
    for (const i of at) {
      const clause = source.slice(i, i + 220);
      assert.match(clause, /epoch = \?/, `unscoped flow query in the anchor derivation: ${clause.slice(0, 120)}`);
    }
  });

  it("the HWM is NOT epoch-scoped, deliberately", () => {
    // Resetting a monotonic peak at a boundary would re-charge the owner for
    // profit already paid on. setAgentHwm is MAX() in SQL for the same reason.
    assert.equal(EPOCH_SCOPED.includes("hwmUsdg" as never), false);
    const store = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
    assert.match(store, /UPDATE agents SET hwm_usdg = MAX\(hwm_usdg, \?\)/);
  });
});
