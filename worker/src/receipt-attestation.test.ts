import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { attestOriginalReceipt } from "./receipt-attestation";
import { assertNoPendingReceiptAttestation, readReceiptAttestation } from "./receipt-attestation-state";
import { receiptAttestationRequest, receiptAttestationTenant } from "./receipt-attestation-controls";
import { receiptFixture, TEST_TENANT, TEST_ACCOUNT } from "./receipt-attestation-fixture";
import { canonicalJson, journalHash, JOURNAL_GENESIS } from "./store";
import { deriveBootstrapAccounting } from "./bootstrap-source";
import { accountingLicence, BOOTSTRAP_SCHEMA_VERSION, classifyAnchor } from "./bootstrap-state";

const holds = process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
afterEach(() => { if (holds === undefined) delete process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS; else process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = holds; });
async function fixture() { process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = TEST_TENANT; return receiptFixture(); }

test("dry run writes no schema, file, journal, source metadata or shared row", async () => {
  const f = await fixture();
  try {
    const before = readFileSync(f.file), flows = await f.shared.prepare("SELECT * FROM flows").all();
    const report = await attestOriginalReceipt(f.options);
    assert.equal(report.state, "preview"); assert.equal(report.amountUsdg, 200); assert.equal(report.localFlowId, 7); assert.equal(report.sharedFlowId, 428);
    assert.deepEqual(readFileSync(f.file), before);
    assert.deepEqual(await f.shared.prepare("SELECT * FROM flows").all(), flows);
    assert.equal(await readReceiptAttestation(f.shared, TEST_TENANT), undefined);
    assert.equal(existsSync(path.join(f.options.home, "ledger-source-blocked.json")), false);
    assert.equal(await f.shared.prepare("SELECT name FROM sqlite_master WHERE name='ledger_receipt_attestations'").get(), undefined);
  } finally { f.close(); }
});

test("the corrected original/shared flow gives the actual next worker a known resume licence without reopening capital", async () => {
  const f = await fixture();
  try {
    const licence = async () => {
      const now = 1_800_000_000, accounting = await deriveBootstrapAccounting(f.shared, TEST_ACCOUNT, now);
      return accountingLicence(classifyAnchor(JSON.stringify({ schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
        tenantId: TEST_TENANT, generatedAt: now, accounting }), { tenantId: TEST_TENANT, nowSec: now }), { hosted: true });
    };
    assert.equal((await licence()).contributionsKnown, false);
    const preview = await attestOriginalReceipt(f.options);
    await attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest });
    const resumed = await licence();
    assert.equal(resumed.licence, "resume"); assert.equal(resumed.contributionsKnown, true);
    assert.equal(resumed.netContributionsUsdg, 200_000_000n); assert.equal(resumed.highWaterMarkUsdg, 200_000_000n);
    assert.equal(resumed.lastObservedCashUsdg, 200_000_000n); assert.equal(resumed.accountingEpoch, 1);
    assert.equal(resumed.highWaterWithdrawnUsdg, 0n);
  } finally { f.close(); }
});

for (const boundary of ["audit", "marker", "local", "shared", "cleared"] as const) {
  test(`crash after ${boundary}: exact repair resumes without changing source/HWM/caps/epoch/cursors or duplicating cash`, async () => {
    const f = await fixture();
    try {
      const beforeSource = await f.shared.prepare("SELECT * FROM tenant_ledger_import").all();
      const beforeMarks = await f.shared.prepare("SELECT * FROM mirror_state").all();
      const beforeAgents = await f.local.prepare("SELECT * FROM agents").all();
      const beforeJournal = await f.local.prepare("SELECT * FROM journal").all();
      const report = await attestOriginalReceipt(f.options);
      await assert.rejects(attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: report.approvalDigest,
        checkpoint(at) { if (at === boundary) throw new Error("simulated crash"); } }), /simulated crash/);
      const pending = await readReceiptAttestation(f.shared, TEST_TENANT);
      assert.ok(pending, "audit is durable before any amendment");
      if (["audit", "marker", "local"].includes(boundary)) await assert.rejects(assertNoPendingReceiptAttestation(f.shared, TEST_TENANT), /unfinished/);
      const completed = await attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: report.approvalDigest });
      assert.equal(completed.state, "applied");
      await attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: report.approvalDigest });
      await assertNoPendingReceiptAttestation(f.shared, TEST_TENANT);
      for (const db of [f.local, f.shared]) {
        const flows = await db.prepare("SELECT * FROM flows").all() as Record<string, unknown>[];
        assert.equal(flows.length, 1); assert.equal(flows[0]!.amount_usdg, 200); assert.equal(flows[0]!.at, 1791595716);
        assert.equal(flows[0]!.source, "chain-log"); assert.equal(flows[0]!.log_index, 17);
      }
      assert.deepEqual(await f.shared.prepare("SELECT * FROM tenant_ledger_import").all(), beforeSource);
      assert.deepEqual(await f.shared.prepare("SELECT * FROM mirror_state").all(), beforeMarks);
      assert.deepEqual(await f.local.prepare("SELECT * FROM agents").all(), beforeAgents);
      const journal = await f.local.prepare("SELECT * FROM journal ORDER BY seq").all() as Record<string, unknown>[];
      assert.deepEqual(journal.slice(0, -1), beforeJournal); assert.equal(journal.length, 2);
      let previous = JOURNAL_GENESIS;
      for (const row of journal) { assert.equal(row.prev_hash, previous); assert.equal(row.hash, journalHash(previous, String(row.payload_json))); previous = String(row.hash); }
      const mark = JSON.parse(String(journal[1]!.payload_json)).receiptAttestation;
      assert.equal(mark.originalFlow.source, "inferred"); assert.equal(mark.originalFlow.tx_hash, null);
      assert.equal(mark.receipt.at, 1791581459); assert.equal(mark.correctedFlow.at, 1791595716);
      assert.equal(existsSync(path.join(f.options.home, "ledger-source-blocked.json")), false);
    } finally { f.close(); }
  });
}

test("hold, live-process, missing/changed lease and approval refusals cannot write", async () => {
  const f = await fixture();
  try {
    const preview = await attestOriginalReceipt(f.options), before = readFileSync(f.file);
    delete process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
    await assert.rejects(attestOriginalReceipt(f.options), /explicitly held/);
    process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = TEST_TENANT;
    f.setQuiet(false); await assert.rejects(attestOriginalReceipt(f.options), /process/); f.setQuiet(true);
    f.setHealthy(false); await assert.rejects(attestOriginalReceipt(f.options), /lease/); f.setHealthy(true);
    await assert.rejects(attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: "0".repeat(64) }), /approval/);
    assert.equal(await readReceiptAttestation(f.shared, TEST_TENANT), undefined);
    assert.deepEqual(readFileSync(f.file), before); assert.equal(preview.state, "preview");
  } finally { f.close(); }
});

for (const [description, mutate] of [
  ["filled trade", async (f: Awaited<ReturnType<typeof fixture>>) => f.local.prepare("UPDATE trades SET status='landed',tx_hash='0xabc'").run()],
  ["position", async (f: Awaited<ReturnType<typeof fixture>>) => f.local.prepare("INSERT INTO positions(agent_id,symbol,token,raw_balance,ui_multiplier,price_usd,value_usdg) VALUES(?,'COIN','coin','1','1',1,1)").run(TEST_ACCOUNT)],
  ["second flow", async (f: Awaited<ReturnType<typeof fixture>>) => f.shared.prepare("INSERT INTO flows(agent_id,direction,amount_usdg,source) VALUES(?,'in',1,'inferred')").run(TEST_ACCOUNT)],
  ["HWM change", async (f: Awaited<ReturnType<typeof fixture>>) => f.local.prepare("UPDATE agents SET hwm_usdg=201").run()],
  ["nonzero fee counter", async (f: Awaited<ReturnType<typeof fixture>>) => f.local.prepare("UPDATE agents SET accrued_fee_usdg=1").run()],
  ["missing flow journal", async (f: Awaited<ReturnType<typeof fixture>>) => f.local.prepare("DELETE FROM journal").run()],
  ["journal tamper", async (f: Awaited<ReturnType<typeof fixture>>) => f.local.prepare("UPDATE journal SET payload_json='{}'").run()],
  ["hash-valid journal sequence gap", async (f: Awaited<ReturnType<typeof fixture>>) => f.local.prepare("UPDATE journal SET seq=2").run()],
  ["cursor tamper", async (f: Awaited<ReturnType<typeof fixture>>) => f.shared.prepare("UPDATE mirror_state SET last_stamp=1000").run()],
  ["source generation tamper", async (f: Awaited<ReturnType<typeof fixture>>) => f.shared.prepare("UPDATE tenant_ledger_import SET source_identity='another-book'").run()],
] as const) test(`refuses ${description} and preserves original files`, async () => {
  const f = await fixture();
  try { await mutate(f); const before = readFileSync(f.file); await assert.rejects(attestOriginalReceipt(f.options)); assert.deepEqual(readFileSync(f.file), before); assert.equal(await readReceiptAttestation(f.shared, TEST_TENANT), undefined); }
  finally { f.close(); }
});

test("operator request defaults to dry run and never infers a commit approval", () => {
  assert.equal(receiptAttestationRequest({}), null);
  assert.deepEqual(receiptAttestationRequest({ MERRYMEN_RECEIPT_ATTEST_ACCOUNT: TEST_ACCOUNT, MERRYMEN_RECEIPT_ATTEST_TENANT: TEST_TENANT }), { account: TEST_ACCOUNT.toLowerCase(), tenant: TEST_TENANT, mode: "dry-run" });
  for (const env of [
    { MERRYMEN_RECEIPT_ATTEST_MODE: "commit" },
    { MERRYMEN_RECEIPT_ATTEST_ACCOUNT: TEST_ACCOUNT, MERRYMEN_RECEIPT_ATTEST_MODE: "commit" },
    { MERRYMEN_RECEIPT_ATTEST_ACCOUNT: TEST_ACCOUNT, MERRYMEN_RECEIPT_ATTEST_MODE: "yes" },
    { MERRYMEN_RECEIPT_ATTEST_ACCOUNT: `${TEST_ACCOUNT},${TEST_ACCOUNT}` },
    { MERRYMEN_RECEIPT_ATTEST_ACCOUNT: TEST_ACCOUNT, MERRYMEN_RECEIPT_ATTEST_APPROVAL: "a".repeat(64) },
  ]) assert.throws(() => receiptAttestationRequest(env));
  assert.equal(receiptAttestationRequest({ MERRYMEN_RECEIPT_ATTEST_ACCOUNT: TEST_ACCOUNT, MERRYMEN_RECEIPT_ATTEST_TENANT: TEST_TENANT, MERRYMEN_RECEIPT_ATTEST_MODE: "commit", MERRYMEN_RECEIPT_ATTEST_APPROVAL: "a".repeat(64) })!.mode, "commit");
  const request = receiptAttestationRequest({ MERRYMEN_RECEIPT_ATTEST_ACCOUNT: TEST_ACCOUNT, MERRYMEN_RECEIPT_ATTEST_TENANT: TEST_TENANT })!;
  assert.equal(receiptAttestationTenant(request, [{ account: TEST_ACCOUNT, tenant: TEST_TENANT }]), TEST_TENANT);
  for (const roster of [[], [{ account: TEST_ACCOUNT, tenant: "0x00000000000000000000000000000000000000a9" }],
    [{ account: TEST_ACCOUNT, tenant: TEST_TENANT }, { account: TEST_ACCOUNT, tenant: TEST_TENANT }]]) assert.throws(() => receiptAttestationTenant(request, roster), /declared tenant/);
});

test("a verified remount changes transient device number without changing approval or crash recovery", async context => {
  const f = await fixture();
  try {
    const preview = await attestOriginalReceipt(f.options);
    await assert.rejects(attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest,
      checkpoint(at) { if (at === "audit") throw new Error("stop before remount"); } }), /stop before remount/);
    const originalStat = fs.lstatSync;
    const mock = context.mock.method(fs, "lstatSync", ((file: fs.PathLike, options?: fs.StatOptions) => {
      const value = originalStat(file, options as never);
      if (options?.bigint) (value as unknown as { dev: bigint }).dev += 100n;
      return value;
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    f.options.volume.device = String(BigInt(f.options.volume.device) + 100n);
    try {
      const resumed = await attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest });
      assert.equal(resumed.state, "applied"); assert.equal(resumed.approvalDigest, preview.approvalDigest);
      const plan = JSON.parse(String((await readReceiptAttestation(f.shared, TEST_TENANT))!.plan_json));
      assert.equal("device" in plan.file, false);
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  } finally { f.close(); }
});

test("an intact hash chain with a different original capital fact is refused", async () => {
  const f = await fixture();
  try {
    const payload = canonicalJson({ direction: "in", amountUsdg: 199, source: "inferred", txHash: null });
    await f.local.prepare("UPDATE journal SET payload_json=?,hash=?").run(payload, journalHash(JOURNAL_GENESIS, payload));
    await assert.rejects(attestOriginalReceipt(f.options), /original flow journal/);
    assert.equal(await readReceiptAttestation(f.shared, TEST_TENANT), undefined);
  } finally { f.close(); }
});

test("benign rejected-fill journal entries remain unchanged; real fills and fees refuse", async () => {
  const f = await fixture();
  try {
    const head = (await f.local.prepare("SELECT hash FROM journal ORDER BY seq DESC LIMIT 1").get() as { hash: string }).hash;
    const payload = canonicalJson({ status: "rejected", amountUsdg: 2.5, txHash: null, userOpHash: null, fillQtyRaw: null, fillCashUsdg: null });
    await f.local.prepare("INSERT INTO journal(agent_id,epoch,kind,payload_json,prev_hash,hash) VALUES(?,1,'fill',?,?,?)")
      .run(TEST_ACCOUNT, payload, head, journalHash(head, payload));
    const before = await f.local.prepare("SELECT * FROM journal").all();
    const preview = await attestOriginalReceipt(f.options);
    assert.equal(preview.state, "preview");
    assert.deepEqual(await f.local.prepare("SELECT * FROM journal").all(), before);
    const landed = canonicalJson({ status: "landed", amountUsdg: 2.5 });
    await f.local.prepare("UPDATE journal SET payload_json=?,hash=? WHERE kind='fill'").run(landed, journalHash(head, landed));
    await assert.rejects(attestOriginalReceipt(f.options), /original flow journal/);
    await f.local.prepare("UPDATE journal SET kind='fee' WHERE kind='fill'").run();
    await assert.rejects(attestOriginalReceipt(f.options), /original flow journal/);
  } finally { f.close(); }
});

test("lease loss after durable audit leaves pending barrier; resumed ownership finishes exact evidence", async () => {
  const f = await fixture();
  try {
    const preview = await attestOriginalReceipt(f.options);
    await assert.rejects(attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest,
      checkpoint(at) { if (at === "audit") f.setHealthy(false); } }), /lease/);
    assert.equal((await readReceiptAttestation(f.shared, TEST_TENANT))!.state, "pending");
    assert.equal((await f.local.prepare("SELECT source FROM flows").get() as { source: string }).source, "inferred");
    f.setHealthy(true);
    assert.equal((await attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest })).state, "applied");
  } finally { f.close(); }
});

test("pending audit or marker tamper refuses retry without clearing the evidence", async () => {
  const f = await fixture();
  try {
    const preview = await attestOriginalReceipt(f.options);
    await assert.rejects(attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest,
      checkpoint(at) { if (at === "marker") throw new Error("stop"); } }), /stop/);
    const marker = path.join(f.options.home, "ledger-source-blocked.json"), original = readFileSync(marker, "utf8");
    writeFileSync(marker, canonicalJson({ state: "unrelated-barrier" }));
    await assert.rejects(attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest }), /barrier/);
    writeFileSync(marker, original);
    await f.shared.prepare("UPDATE ledger_receipt_attestations SET plan_json='{}'").run();
    await assert.rejects(attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest }), /audit/);
    assert.equal(existsSync(marker), true);
  } finally { f.close(); }
});
