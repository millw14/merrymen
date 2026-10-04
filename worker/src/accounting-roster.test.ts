import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { reconstructionRoster, type ReconstructionGrant } from "./accounting-roster";
import { accountingCommitRefusal, ACCOUNTING_HOLD_ENV } from "./accounting-maintenance";
import { planReconstruction, FLOW_SNAPSHOT_COLUMNS } from "./accounting-reconstruction";
import { runRepair } from "./accounting-repair";
import { totalCapital } from "../../packages/core/src/index";
import { wrapSqlite } from "./db";
import { applyLedgerSchema } from "./store";

const ACCOUNT = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD";
const OTHER_ACCOUNT = "0x00000000000000000000000000000000000000aa";
const TENANT = "0x00000000000000000000000000000000000000bb";
const OTHER_TENANT = "0x00000000000000000000000000000000000000cc";
const OWNER = "0x00000000000000000000000000000000000000dd";
const VAULT = "0x00000000000000000000000000000000000000ee";
const TX = "0x" + "ab".repeat(32);
const ledger = (over: Record<string, unknown> = {}) => ({ smart_account: ACCOUNT, owner_address: OWNER,
  chain_id: 4663, epoch: 1, mode: "live", hwm_usdg: 60, contributions_known: 0,
  beat_at: 100, created_at: 10, ...over });
const grant = (over: Partial<ReconstructionGrant> = {}): ReconstructionGrant => ({
  tenant: TENANT, smartAccount: ACCOUNT, owner: OWNER, chainId: 4663, custodyAddresses: [], ...over,
});
const claim = (tenant = TENANT, account = ACCOUNT) => ({ smart_account: account, tenant });
const key = ACCOUNT.toLowerCase();

test("a stopped account resolves from its durable claim without recreating a grant or financial row", () => {
  const row = ledger();
  const roster = reconstructionRoster({ ledgerAgents: [row], grants: [], claims: [claim()] });
  assert.deepEqual(roster.agents, [row]);
  assert.equal(roster.agents[0], row, "raw mixed-case ledger identity remains the mutation key");
  assert.equal(roster.tenantByAccount.get(key), TENANT);
  assert.equal(roster.custodyVaults.size, 0, "a claim cannot supply custody permission");
  assert.equal(roster.refusals.size, 0);
  assert.equal(roster.rosterOnly, 0);
  assert.equal(accountingCommitRefusal({ mode: "commit", accounts: [ACCOUNT],
    plans: [{ smartAccount: String(row.smart_account), tenant: roster.tenantByAccount.get(key)! }],
    env: { [ACCOUNTING_HOLD_ENV]: TENANT }, localState: () => ({ processPresent: false, localHomePresent: false }) }), null);
});

test("agreement between a signed grant and normalized durable aliases retains only signed custody", () => {
  const roster = reconstructionRoster({ ledgerAgents: [ledger()], grants: [grant({ custodyAddresses: [VAULT] })],
    claims: [claim(), claim(TENANT.toUpperCase().replace("0X", "0x"), key)] });
  assert.equal(roster.tenantByAccount.get(key), TENANT);
  assert.deepEqual(roster.custodyVaults.get(key), [VAULT]);
  assert.equal(roster.refusals.size, 0);
});

test("a current grant without an existing claim retains the previous grant roster behavior", () => {
  const roster = reconstructionRoster({ ledgerAgents: [ledger()], grants: [grant()], claims: [] });
  assert.equal(roster.tenantByAccount.get(key), TENANT);
  assert.equal(roster.refusals.size, 0);
});

test("an absent claim and grant leave a recorded account unresolved rather than using its owner as tenant", () => {
  const roster = reconstructionRoster({ ledgerAgents: [ledger()], grants: [], claims: [] });
  assert.equal(roster.agents.length, 1);
  assert.equal(roster.tenantByAccount.has(key), false);
  assert.match(accountingCommitRefusal({ mode: "commit", accounts: [ACCOUNT],
    plans: [{ smartAccount: ACCOUNT, tenant: null }], env: { [ACCOUNTING_HOLD_ENV]: OWNER },
    localState: () => ({ processPresent: false, localHomePresent: false }) })!, /exactly one tenant/);
});

test("durable claims do not synthesize an account absent from both the ledger and grants", () => {
  const roster = reconstructionRoster({ ledgerAgents: [], grants: [], claims: [claim()] });
  assert.deepEqual(roster.agents, []);
  assert.equal(roster.tenantByAccount.size, 0);
});

test("a grant not yet mirrored stays in the roster with the actual signed chain and owner", () => {
  const roster = reconstructionRoster({ ledgerAgents: [], grants: [grant()], claims: [claim()] });
  assert.equal(roster.rosterOnly, 1);
  assert.equal(roster.agents[0]!.smart_account, ACCOUNT);
  assert.equal(roster.agents[0]!.owner_address, OWNER);
  assert.equal(roster.agents[0]!.chain_id, 4663);
  assert.equal(roster.agents[0]!.contributions_known, null);
  assert.equal(roster.tenantByAccount.get(key), TENANT);
});

test("canonical ledger selection follows epoch, heartbeat, creation time and raw spelling independent of input order", () => {
  const rows = [
    ledger({ epoch: 1, beat_at: 9999 }),
    ledger({ smart_account: key, epoch: 2, beat_at: 101, created_at: 11 }),
    ledger({ epoch: 2, beat_at: 101, created_at: 12 }),
    ledger({ epoch: 2, beat_at: 100, created_at: 9999 }),
    ledger({ smart_account: key, epoch: 2, beat_at: 101, created_at: 12 }),
  ];
  for (const ordered of [rows, [...rows].reverse(), [...rows.slice(2), ...rows.slice(0, 2)]]) {
    const roster = reconstructionRoster({ ledgerAgents: ordered, grants: [], claims: [claim()] });
    assert.equal(roster.agents.length, 1);
    assert.equal(roster.agents[0], rows[2]);
    assert.equal(roster.refusals.size, 0);
  }
});

const conflicts: { name: string; ledgerAgents?: Record<string, unknown>[]; grants?: ReconstructionGrant[];
  claims?: Record<string, unknown>[]; reason: RegExp }[] = [
  { name: "different durable tenant aliases", claims: [claim(), claim(OTHER_TENANT, key)], reason: /durable account aliases/ },
  { name: "an invalid durable tenant alongside a valid claim", claims: [claim(), claim("0x123", key)], reason: /invalid tenant/ },
  { name: "grant and claim disagreement", grants: [grant({ tenant: OTHER_TENANT })], reason: /different tenants/ },
  { name: "different grant tenant aliases", grants: [grant(), grant({ tenant: OTHER_TENANT, smartAccount: key })], reason: /grant account aliases resolve/ },
  { name: "different ledger owner aliases", ledgerAgents: [ledger(), ledger({ smart_account: key, owner_address: OTHER_TENANT })], reason: /disagree about the owner/ },
  { name: "different ledger chain aliases", ledgerAgents: [ledger(), ledger({ smart_account: key, chain_id: 46633 })], reason: /disagree about the chain/ },
  { name: "signed owner disagreement", grants: [grant({ owner: OTHER_TENANT })], reason: /disagree about the owner/ },
  { name: "signed chain disagreement", grants: [grant({ chainId: 46633 })], reason: /disagree about the chain/ },
  { name: "signed custody disagreement", grants: [grant(), grant({ custodyAddresses: [VAULT] })], reason: /disagree about custody/ },
  { name: "invalid current-row ordering", ledgerAgents: [ledger({ epoch: "bad" })], reason: /invalid current-row ordering/ },
];
for (const scenario of conflicts) {
  test(`repair ownership refuses ${scenario.name}`, () => {
    const roster = reconstructionRoster({ ledgerAgents: scenario.ledgerAgents ?? [ledger()],
      grants: scenario.grants ?? [], claims: scenario.claims ?? [claim()] });
    assert.match(roster.refusals.get(key)!, scenario.reason);
    assert.equal(roster.tenantByAccount.has(key), false);
    assert.equal(roster.custodyVaults.has(key), false);
    assert.equal(roster.agents.length, 1, "keep the refused financial account visible in the report");
  });
}

test("an unrelated ambiguous account does not prevent resolving an explicitly scoped stopped account", () => {
  const roster = reconstructionRoster({ ledgerAgents: [ledger(), ledger({ smart_account: OTHER_ACCOUNT })], grants: [],
    claims: [claim(), claim(TENANT, OTHER_ACCOUNT), claim(OTHER_TENANT, OTHER_ACCOUNT)] });
  assert.equal(roster.tenantByAccount.get(key), TENANT);
  assert.equal(roster.refusals.has(key), false);
  assert.equal(roster.refusals.has(OTHER_ACCOUNT), true);
});

test("claim-based resolution can feed the existing guarded receipt repair without changing wallet authority or caps", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await applyLedgerSchema(db);
    await db.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps,
      granted_at, expires_at, mode, hwm_usdg, contributions_known) VALUES (?, ?, ?, 4663, ?, 0, 0, 'live', 60, 0)`)
      .run(ACCOUNT, OWNER, OTHER_ACCOUNT, '{"dailyUsdg":50}');
    await db.prepare("INSERT INTO flows (agent_id, direction, amount_usdg, source, epoch, at) VALUES (?, 'in', 60, 'inferred', 1, 100)")
      .run(ACCOUNT);
    const before = await db.prepare("SELECT * FROM agents WHERE smart_account = ?").get(ACCOUNT) as Record<string, unknown>;
    const roster = reconstructionRoster({ ledgerAgents: [before], grants: [], claims: [claim()] });
    const classification = { kind: "capital-in" as const, why: "external deposit", evidence: {
      counterparty: OWNER, direction: "in" as const, txLegCount: 1, rule: "no-pair-external" as const } };
    const plans = planReconstruction({ agents: roster.agents,
      flows: await db.prepare(`SELECT ${FLOW_SNAPSHOT_COLUMNS} FROM flows`).all() as Record<string, unknown>[],
      chain: new Map([[key, { account: ACCOUNT, complete: true, notes: [],
        movements: [{ txHash: TX, blockNumber: 10, logIndex: 0, at: 90, direction: "in" as const,
          amountRaw: "60000000", counterparty: OWNER, classification }],
        totals: totalCapital([{ amountRaw: "60000000", classification }]) }]]),
      onchainCash: new Map([[key, 60]]), equityByAccountEpoch: new Map([[`${key}#1`, 60]]),
      tenantByAccount: roster.tenantByAccount });
    assert.equal(accountingCommitRefusal({ mode: "commit", accounts: [ACCOUNT], plans,
      env: { [ACCOUNTING_HOLD_ENV]: TENANT }, localState: () => ({ processPresent: false, localHomePresent: false }) }), null);
    const repaired = await runRepair(db, plans, { mode: "commit", accounts: [key], runId: "stopped-claim", resume: false }, 4663);
    assert.equal(repaired[0]!.stage, "recomputed");
    assert.equal(repaired[0]!.inserted, 1);
    assert.equal(repaired[0]!.quarantined, 1);
    assert.equal(repaired[0]!.contributionsKnownAfter, true);
    const after = await db.prepare("SELECT * FROM agents WHERE smart_account = ?").get(ACCOUNT) as Record<string, unknown>;
    for (const column of Object.keys(before).filter((column) => !["contributions_known", "contributions_why", "quality_at"].includes(column))) {
      assert.deepEqual(after[column], before[column], `${column} must not change`);
    }
    const flow = await db.prepare("SELECT agent_id, source, tx_hash, at FROM flows").get() as Record<string, unknown>;
    assert.deepEqual({ ...flow }, { agent_id: ACCOUNT, source: "chain-log", tx_hash: TX, at: 90 });
    assert.equal((await db.prepare("SELECT run_id FROM flows_quarantine").get() as { run_id: string }).run_id, "stopped-claim");
  } finally { raw.close(); }
});
