import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diagnoseAccounting, diagnosisLines } from "./accounting-diagnosis";
import type { Db } from "./db";

/**
 * THE PREVIEW A REPAIR DECISION IS MADE AGAINST.
 *
 * Nobody can consent to "quarantine 3 rows" without seeing which three, so this
 * checks that the per-row detail is real and that the two totals it prints —
 * before and after — actually correspond to what a quarantine would remove.
 *
 * The fixtures are the shapes really in the hosted database: the canary's one
 * genuine deposit under a pile of phantom openings, and the paper agents whose
 * inferred flows have booked tens of thousands in withdrawals that never
 * happened.
 */

const CANARY = "0x3E34E58e39DC6614e047dFD3BAD5B7DEA45DCd62";
const PAPER = "0xC394b04528F81c72dA2bf4cac783E091760aDeB5";

interface Row {
  [k: string]: unknown;
}

/** A Db that answers the three reads `diagnoseAccounting` makes. */
function ledger(args: { flows: Row[]; agents: Row[]; equity?: Row[] }): Db {
  return {
    prepare(sql: string) {
      return {
        async all() {
          if (sql.includes("FROM flows")) return args.flows;
          if (sql.includes("FROM agents")) return args.agents;
          if (sql.includes("FROM equity")) return args.equity ?? [];
          return [];
        },
        async get() {
          return undefined;
        },
        async run() {
          return { changes: 0 };
        },
      };
    },
    async exec() {},
    async tx<T>(fn: (db: Db) => Promise<T>) {
      return fn(this as unknown as Db);
    },
  } as unknown as Db;
}

const flow = (id: number, agent: string, dir: string, amt: number, source: string, tx: string | null, epoch = 1) => ({
  id,
  agent_id: agent,
  epoch,
  direction: dir,
  amount_usdg: amt,
  source,
  tx_hash: tx,
  at: 1_700_000_000 + id,
});

describe("D1 — the canary: one receipt under a pile of phantoms", () => {
  const db = ledger({
    agents: [{ smart_account: CANARY, owner_address: "0xa233a3085a6f9b43274410e45836d43d091b5908", epoch: 1, hwm_usdg: 9.912617 }],
    equity: [{ agent_id: CANARY, epoch: 1, equity_usdg: 9.873005, at: 1_700_000_100 }],
    flows: [
      flow(1, CANARY, "in", 10, "chain-log", "0xf0fbf03e7e626e6346e9e83a2924e127cb077d41e2020b048a07d03dd1d34931"),
      flow(2, CANARY, "in", 10, "inferred", null),
      flow(3, CANARY, "in", 10, "inferred", null),
    ],
  });

  it("separates what is claimed from what is evidenced", async () => {
    const [a] = await diagnoseAccounting(db);
    assert.equal(a!.contributionsBeforeUsdg, 30);
    assert.equal(a!.contributionsAfterUsdg, 10, "only the tx-hashed deposit survives");
    assert.equal(a!.unevidencedUsdg, 20);
    assert.equal(a!.unevidencedRows, 2);
    assert.equal(a!.suspectedPhantomDeposits, 2);
    assert.equal(a!.suspectedPhantomWithdrawals, 0);
  });

  it("keeps the owner address SEPARATE from the ledger key", async () => {
    // They are different addresses, and confusing them is what made the anchor
    // read every funded account as brand new.
    const [a] = await diagnoseAccounting(db);
    assert.equal(a!.smartAccount, CANARY);
    assert.equal(a!.ownerAddress, "0xa233a3085a6f9b43274410e45836d43d091b5908");
    assert.notEqual(a!.smartAccount.toLowerCase(), a!.ownerAddress!.toLowerCase());
  });

  it("names every row and what would happen to it", async () => {
    const lines = diagnosisLines(await diagnoseAccounting(db));
    const body = lines.join("\n");
    assert.match(body, /id\s+1 e1 in\s+10\.000000 src chain-log\s+tx 0xf0fbf03e7e…?\s*KEEP/);
    assert.equal((body.match(/QUARANTINE/g) ?? []).length, 2, "both phantoms named individually");
    assert.match(body, /contributions 30\.000000 -> 10\.000000 USDG/);
  });

  it("a correction IS safe here — an evidenced receipt survives it", async () => {
    const [a] = await diagnoseAccounting(db);
    assert.equal(a!.unsafe, null);
  });
});

describe("D2 — the paper agents with large negative totals", () => {
  /**
   * `contributions -59000000000` in the live log is -59,000 USDG on a 1,000 USDG
   * paper book. That cannot be a withdrawal history; it is the inference path
   * booking every downward balance move as capital leaving.
   */
  const db = ledger({
    agents: [{ smart_account: PAPER, owner_address: "0xcabfe6863070b0ded671e3149d7632db60712a8a", epoch: 1, hwm_usdg: 0 }],
    equity: [{ agent_id: PAPER, epoch: 1, equity_usdg: 1000, at: 1_700_000_100 }],
    flows: [
      flow(10, PAPER, "out", 30_000, "inferred", null),
      flow(11, PAPER, "out", 29_000, "inferred", null),
    ],
  });

  it("reports the shape without pretending it can be corrected", async () => {
    const [a] = await diagnoseAccounting(db);
    assert.equal(a!.contributionsBeforeUsdg, -59_000);
    assert.equal(a!.contributionsAfterUsdg, 0, "nothing evidenced survives");
    assert.equal(a!.suspectedPhantomWithdrawals, 2);
    assert.equal(a!.suspectedPhantomDeposits, 0);
  });

  it("REFUSES to call the correction safe — zero contributions against a live book", async () => {
    // Quarantining leaves contributions at 0, and equity minus zero is the whole
    // book published as profit. That is the bug the epoch mechanism exists to
    // prevent, arriving through the cleanup.
    const [a] = await diagnoseAccounting(db);
    assert.notEqual(a!.unsafe, null);
    assert.match(a!.unsafe!, /principal published as profit/);
    const body = diagnosisLines([a!]).join("\n");
    assert.match(body, /CANNOT PROPOSE A SAFE CORRECTION/);
  });
});

describe("D3 — the reads are epoch-scoped and duplicate-aware", () => {
  it("ignores rows from a closed epoch", async () => {
    const db = ledger({
      agents: [{ smart_account: CANARY, owner_address: null, epoch: 2, hwm_usdg: 0 }],
      flows: [
        flow(1, CANARY, "in", 999, "inferred", null, 1),
        flow(2, CANARY, "in", 10, "chain-log", "0xabc", 2),
      ],
    });
    const [a] = await diagnoseAccounting(db);
    assert.equal(a!.totalRows, 1, "only the current epoch's row is in scope");
    assert.equal(a!.contributionsBeforeUsdg, 10);
    assert.equal(a!.unevidencedRows, 0);
  });

  it("counts a re-copied tx-hashed row as a duplicate, not a second deposit", async () => {
    // The mirror's cursor rewind re-reads a rebuilt child ledger into a table
    // with no unique key. One transaction cannot have deposited twice.
    const db = ledger({
      agents: [{ smart_account: CANARY, owner_address: null, epoch: 1, hwm_usdg: 0 }],
      flows: [
        flow(1, CANARY, "in", 10, "chain-log", "0xsame"),
        flow(2, CANARY, "in", 10, "chain-log", "0xsame"),
      ],
    });
    const [a] = await diagnoseAccounting(db);
    assert.equal(a!.duplicateRows, 1);
    // Both are evidenced, so the naive "after" still double-counts — which is
    // exactly why the duplicate count is reported separately rather than folded
    // into the evidenced total.
    assert.equal(a!.contributionsAfterUsdg, 20);
  });

  it("an epoch bridge is evidence, and is not quarantined", async () => {
    const db = ledger({
      agents: [{ smart_account: CANARY, owner_address: null, epoch: 2, hwm_usdg: 0 }],
      flows: [flow(1, CANARY, "in", 42, "epoch-carry", null, 2)],
    });
    const [a] = await diagnoseAccounting(db);
    assert.equal(a!.unevidencedRows, 0);
    assert.equal(a!.contributionsAfterUsdg, 42);
    assert.match(diagnosisLines([a!]).join("\n"), /src epoch-carry\s+tx NONE\s+KEEP/);
  });
});

describe("D4 — it never throws, and the worst offenders come first", () => {
  it("orders by how much rests on inference", async () => {
    const db = ledger({
      agents: [
        { smart_account: CANARY, owner_address: null, epoch: 1, hwm_usdg: 0 },
        { smart_account: PAPER, owner_address: null, epoch: 1, hwm_usdg: 0 },
      ],
      flows: [
        flow(1, CANARY, "in", 20, "inferred", null),
        flow(2, PAPER, "out", 59_000, "inferred", null),
      ],
    });
    const all = await diagnoseAccounting(db);
    assert.equal(all[0]!.smartAccount, PAPER, "the -59,000 case is not buried below a 20 USDG one");
  });

  it("an agent with no flows at all is simply absent", async () => {
    const db = ledger({ agents: [{ smart_account: CANARY, owner_address: null, epoch: 1, hwm_usdg: 0 }], flows: [] });
    assert.deepEqual(await diagnoseAccounting(db), []);
  });
});
