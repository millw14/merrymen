/**
 * A REHEARSAL, not the preview.
 *
 * Runs the real planner and the real mutation against a local sqlite seeded with
 * the canary's known chain truth and the shape of its hosted ledger rows, so the
 * exact sequence that will run in production is exercised end to end before it
 * is pointed at production. Prints the lines the hosted run will print.
 */
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../../worker/src/db.ts";
import { applyLedgerSchema } from "../../worker/src/store.ts";
import {
  planReconstruction,
  reconstructionLines,
} from "../../worker/src/accounting-reconstruction.ts";
import {
  parseRepairOptions,
  repairLines,
  runRepair,
  hasChainIdentityIndex,
} from "../../worker/src/accounting-repair.ts";
import { totalCapital } from "../../packages/core/src/index.ts";
import type { AccountCapital } from "../../worker/src/chain-capital.ts";

const CANARY = "0x3E34E58e1E1b52A6cbE2Bd7C6e0C1B1e1e1e1e1e";
const OWNER = "0x00000000000000000000000000000000000000ff";
const CHAIN = 4663;

const ev = (d: "in" | "out") => ({
  counterparty: OWNER,
  direction: d,
  txLegCount: 1,
  rule: "no-pair-external" as const,
});

// Chain truth: ONE deposit of exactly 10.000000 USDG. The four 1.6665 outflows
// are trade legs and the classifier already dropped them, which is why they are
// not here — totalCapital counts them only as tradeLegs.
const movements = [
  {
    txHash: "0xfund0000000000000000000000000000000000000000000000000000000000",
    blockNumber: 4_100_000,
    logIndex: 0,
    direction: "in" as const,
    amountRaw: "10000000",
    counterparty: OWNER,
    classification: { kind: "capital-in" as const, why: "external capital", evidence: ev("in") },
  },
];
const tradeLegs = Array.from({ length: 4 }, (_, i) => ({
  amountRaw: "1666500",
  classification: {
    kind: "trade-out" as const,
    why: "paired token movement",
    evidence: { ...ev("out"), rule: "paired-token-movement" as const },
  },
}));

const cap: AccountCapital = {
  account: CANARY,
  movements,
  totals: totalCapital([...movements.map((m) => ({ amountRaw: m.amountRaw, classification: m.classification })), ...tradeLegs]),
  complete: true,
  notes: [],
};

const db = wrapSqlite(new DatabaseSync(":memory:"));
await applyLedgerSchema(db);
await db
  .prepare(
    `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, epoch, mode)
     VALUES (?, ?, ?, ?, '{}', 0, 0, 1, 'live')`,
  )
  .run(CANARY, OWNER, OWNER, CHAIN);

// The hosted ledger's shape for this account: the 10 USDG opening balance booked
// three times, once per redeploy, all `inferred` with no transaction.
for (let i = 0; i < 3; i++) {
  await db
    .prepare("INSERT INTO flows (agent_id, direction, amount_usdg, source, epoch, at) VALUES (?, 'in', 10, 'inferred', 1, ?)")
    .run(CANARY, 1_756_000_000 + i);
}
await db
  .prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, at) VALUES (?, '0', 3.334, 0, 6.55, 9.884, 1, 1)")
  .run(CANARY);

const agents = (await db.prepare("SELECT smart_account, owner_address, epoch, mode, hwm_usdg FROM agents").all()) as Record<string, unknown>[];
const flows = (await db.prepare("SELECT id, agent_id, epoch, direction, amount_usdg, source, tx_hash, at FROM flows").all()) as Record<string, unknown>[];

const plans = planReconstruction({
  agents,
  flows,
  equityByAccountEpoch: new Map([[`${CANARY.toLowerCase()}#1`, 9.884]]),
  chain: new Map([[CANARY.toLowerCase(), cap]]),
  onchainCash: new Map([[CANARY.toLowerCase(), 3.334]]),
  tenantByAccount: new Map([[CANARY.toLowerCase(), "0xa233a3"]]),
});

console.log("── PLAN ".padEnd(78, "─"));
for (const l of reconstructionLines(plans)) console.log(`recon| ${l}`);

console.log("\n── index present:", await hasChainIdentityIndex(db));

const dry = parseRepairOptions({
  MERRYMEN_REPAIR: "dry-run",
  MERRYMEN_REPAIR_ACCOUNT: CANARY,
  MERRYMEN_REPAIR_RUN_ID: "canary-rehearsal",
})!;
console.log(`\n── DRY RUN (mode ${dry.mode}) `.padEnd(78, "─"));
for (const l of repairLines(dry.runId, dry.mode, await runRepair(db, plans, dry, CHAIN))) console.log(`repair| ${l}`);

const before = await db.prepare("SELECT COUNT(*) AS n FROM flows").get();
console.log(`\nrows after the dry run: ${(before as { n: number }).n} (unchanged)`);

const commit = { ...dry, mode: "commit" as const };
console.log(`\n── COMMIT (rehearsal only, local sqlite) `.padEnd(78, "─"));
for (const l of repairLines(commit.runId, commit.mode, await runRepair(db, plans, commit, CHAIN))) console.log(`repair| ${l}`);

const after = (await db.prepare("SELECT id, direction, amount_usdg, source, tx_hash, chain_id FROM flows").all()) as Record<string, unknown>[];
console.log("\nflows now:");
for (const r of after) console.log(`  ${r.direction} ${r.amount_usdg} ${r.source} tx ${r.tx_hash} chain ${r.chain_id}`);
const q = (await db.prepare("SELECT COUNT(*) AS n FROM flows_quarantine").get()) as { n: number };
const a = (await db.prepare("SELECT contributions_known, contributions_why FROM agents WHERE smart_account = ?").get(CANARY)) as Record<string, unknown>;
console.log(`quarantined: ${q.n} · contributions_known: ${a.contributions_known} · ${a.contributions_why}`);

console.log(`\n── RE-RUN (idempotency) `.padEnd(78, "─"));
for (const l of repairLines("canary-rehearsal-2", "commit", await runRepair(db, plans, { ...commit, runId: "canary-rehearsal-2" }, CHAIN))) console.log(`repair| ${l}`);
const n2 = (await db.prepare("SELECT COUNT(*) AS n FROM flows").get()) as { n: number };
const q2 = (await db.prepare("SELECT COUNT(*) AS n FROM flows_quarantine").get()) as { n: number };
console.log(`flows: ${n2.n} · quarantine rows: ${q2.n}`);
