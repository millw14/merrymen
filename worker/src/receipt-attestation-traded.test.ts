import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { attestOriginalReceipt } from "./receipt-attestation";
import { attestReceipt, attestTradedReceipt, MAX_WINDOW_BLOCKS, SCAN_LOOKBACK_BLOCKS, WINDOW_MARGIN_BLOCKS } from "./receipt-attestation-traded";
import { assertNoPendingReceiptAttestation, readReceiptAttestation } from "./receipt-attestation-state";
import { receiptAttestationRequest, scopedReceiptAttestationAllowed } from "./receipt-attestation-controls";
import { BLOCK, BOOKED_AT, DEPOSITOR, LOCAL_FLOW, SHARED_FLOW, TEST_ACCOUNT, TEST_TENANT, TOP_UP, TOP_UP_RAW, TX,
  blockTime, tradedFixture, transferLog } from "./receipt-attestation-traded-fixture";
import { receiptFixture } from "./receipt-attestation-fixture";
import { canonicalJson, JOURNAL_GENESIS, journalHash } from "./store";
import { deriveBootstrapAccounting } from "./bootstrap-source";
import { accountingLicence, BOOTSTRAP_SCHEMA_VERSION, classifyAnchor } from "./bootstrap-state";
import { resumeFrom } from "./deposit-log";

type Fixture = Awaited<ReturnType<typeof tradedFixture>>;
type Row = Record<string, unknown>;
const holds = process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
afterEach(() => { if (holds === undefined) delete process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS; else process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = holds; });
async function fixture(opts?: Parameters<typeof tradedFixture>[2]) { process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = TEST_TENANT; return tradedFixture(undefined, undefined, opts); }
const marker = (f: Fixture) => path.join(f.options.home, "ledger-source-blocked.json");
const commit = (f: Fixture, approvedDigest: string, more: Partial<Fixture["options"]> = {}) => attestTradedReceipt({ ...f.options, mode: "commit", approvedDigest, ...more });
/** Recompute every link after a test edits the original journal: an intact chain that says something else. */
async function rechain(f: Fixture): Promise<void> {
  const heads = new Map<number, string>();
  for (const r of await f.local.prepare("SELECT seq, epoch, payload_json FROM journal ORDER BY seq").all() as Row[]) {
    const prev = heads.get(Number(r.epoch)) ?? JOURNAL_GENESIS, next = journalHash(prev, String(r.payload_json));
    await f.local.prepare("UPDATE journal SET prev_hash=?, hash=? WHERE seq=?").run(prev, next, r.seq);
    heads.set(Number(r.epoch), next);
  }
}
/** Everything a traded book holds besides the selected flow's provenance. */
async function money(f: Fixture) {
  const read = async (sql: string, db = f.local) => db.prepare(sql).all();
  return {
    agents: [await read("SELECT * FROM agents"), await read("SELECT * FROM agents", f.shared)],
    trades: [await read("SELECT * FROM trades ORDER BY id"), await read("SELECT * FROM trades ORDER BY id", f.shared)],
    equity: [await read("SELECT * FROM equity ORDER BY id"), await read("SELECT * FROM equity ORDER BY id", f.shared)],
    fees: [await read("SELECT * FROM fee_accruals ORDER BY id"), await read("SELECT * FROM fee_accruals ORDER BY id", f.shared)],
    positions: [await read("SELECT * FROM positions"), await read("SELECT * FROM positions", f.shared)],
    otherFlows: [await read(`SELECT * FROM flows WHERE id <> ${LOCAL_FLOW} ORDER BY id`), await read(`SELECT * FROM flows WHERE id <> ${SHARED_FLOW} ORDER BY id`, f.shared)],
    marks: await read("SELECT * FROM mirror_state ORDER BY table_name", f.shared),
    source: await read("SELECT * FROM tenant_ledger_import", f.shared),
    grants: await read("SELECT * FROM grants", f.shared),
  };
}
async function refusesWithoutWriting(f: Fixture, pattern: RegExp, options = f.options): Promise<void> {
  const before = readFileSync(f.file), flows = await f.shared.prepare("SELECT * FROM flows ORDER BY id").all();
  await assert.rejects(attestTradedReceipt(options), pattern);
  assert.deepEqual(readFileSync(f.file), before, "the original book is unchanged");
  assert.deepEqual(await f.shared.prepare("SELECT * FROM flows ORDER BY id").all(), flows, "the shared book is unchanged");
  assert.equal(await readReceiptAttestation(f.shared, TEST_TENANT), undefined, "no audit was recorded");
  assert.equal(existsSync(marker(f)), false, "no source barrier was written");
}

test("dry run of a traded book writes no schema, file, journal, source metadata or shared row", async () => {
  const f = await fixture();
  try {
    const before = readFileSync(f.file), flows = await f.shared.prepare("SELECT * FROM flows").all();
    const report = await attestTradedReceipt(f.options);
    assert.equal(report.state, "preview"); assert.equal(report.protocol, "traded-book");
    assert.equal(report.amountUsdg, TOP_UP); assert.equal(report.localFlowId, LOCAL_FLOW); assert.equal(report.sharedFlowId, SHARED_FLOW);
    assert.deepEqual(readFileSync(f.file), before);
    assert.deepEqual(await f.shared.prepare("SELECT * FROM flows").all(), flows);
    assert.equal(existsSync(marker(f)), false);
    assert.equal(await f.shared.prepare("SELECT name FROM sqlite_master WHERE name='ledger_receipt_attestations'").get(), undefined);
  } finally { f.close(); }
});

test("preview names the one receipt, the readings' window and the anchor the next spawn will read", async () => {
  const f = await fixture();
  try {
    const report = await attestTradedReceipt(f.options);
    assert.deepEqual({ ...report.receipt, blockHash: "" }, { txHash: TX.deposit, blockNumber: BLOCK.deposit, blockHash: "", logIndex: 2, at: blockTime(BLOCK.deposit),
      amountUsdg6: String(TOP_UP_RAW), from: DEPOSITOR, to: TEST_ACCOUNT.toLowerCase(), token: report.receipt.token });
    assert.deepEqual(report.window, { fromBlock: BLOCK.baseline + 1 - Number(WINDOW_MARGIN_BLOCKS), toBlock: BLOCK.booking + Number(WINDOW_MARGIN_BLOCKS),
      baselineBlock: BLOCK.baseline, bookingBlock: BLOCK.booking });
    assert.ok(report.window.fromBlock <= BLOCK.trade && BLOCK.trade <= report.window.toBlock, "the window holds a trade as well as the deposit");
    assert.deepEqual(report.anchor, { contributions: "159954460", evidenced: "159954460", unevidencedRows: 0 });
  } finally { f.close(); }
});

test("a reading held by an op in flight is no baseline: the window opens at the last unheld one", async () => {
  const f = await fixture({ heldBeforeEntry: true });
  try {
    assert.equal((await attestTradedReceipt(f.options)).window.baselineBlock, BLOCK.baseline);
  } finally { f.close(); }
});

test("the untouched-book protocol still refuses this book; the traded one is what attests it", async () => {
  const f = await fixture();
  try {
    await assert.rejects(attestOriginalReceipt(f.options), /untouched epoch-one live book|trade or settlement evidence exists/);
    assert.equal((await attestReceipt(f.options)).state, "preview");
  } finally { f.close(); }
});

test("the amended books give the next spawn a known licence without moving contributions, peaks or cash", async () => {
  const f = await fixture();
  try {
    const licence = async () => {
      const now = 1_800_000_000, accounting = await deriveBootstrapAccounting(f.shared, TEST_ACCOUNT, now);
      return accountingLicence(classifyAnchor(JSON.stringify({ schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
        tenantId: TEST_TENANT, generatedAt: now, accounting }), { tenantId: TEST_TENANT, nowSec: now }), { hosted: true });
    };
    const before = await licence();
    assert.equal(before.contributionsKnown, false);
    const preview = await attestTradedReceipt(f.options);
    await commit(f, preview.approvalDigest);
    const after = await licence();
    assert.equal(after.licence, "resume"); assert.equal(after.contributionsKnown, true);
    for (const key of ["netContributionsUsdg", "highWaterMarkUsdg", "highWaterWithdrawnUsdg", "lastObservedCashUsdg", "accountingEpoch"] as const) {
      assert.equal(after[key], before[key], `${key} is unchanged`);
    }
    assert.equal(after.netContributionsUsdg, 159_954_460n);
  } finally { f.close(); }
});

for (const boundary of ["audit", "marker", "local", "shared", "cleared"] as const) {
  test(`crash after ${boundary}: the repair resumes once, changing only provenance, never money, cursors or other rows`, async () => {
    const f = await fixture();
    try {
      const was = await money(f), journal = await f.local.prepare("SELECT * FROM journal ORDER BY seq").all() as Row[];
      const row = async (db: typeof f.local, id: number) => ({ ...await db.prepare("SELECT * FROM flows WHERE id=?").get(id) as Row });
      const flows = { local: await row(f.local, LOCAL_FLOW), shared: await row(f.shared, SHARED_FLOW) };
      const preview = await attestTradedReceipt(f.options);
      await assert.rejects(commit(f, preview.approvalDigest, { checkpoint(at) { if (at === boundary) throw new Error("simulated crash"); } }), /simulated crash/);
      assert.ok(await readReceiptAttestation(f.shared, TEST_TENANT), "the audit is durable before any amendment");
      if (["audit", "marker", "local"].includes(boundary)) await assert.rejects(assertNoPendingReceiptAttestation(f.shared, TEST_TENANT), /unfinished/);
      assert.equal((await commit(f, preview.approvalDigest)).state, "applied");
      assert.equal((await commit(f, preview.approvalDigest)).state, "applied", "exact replay is idempotent");
      assert.equal((await attestTradedReceipt(f.options)).state, "applied", "a later dry run reports the applied repair");
      await assertNoPendingReceiptAttestation(f.shared, TEST_TENANT);
      assert.deepEqual(await money(f), was);
      for (const [db, id, original] of [[f.local, LOCAL_FLOW, flows.local], [f.shared, SHARED_FLOW, flows.shared]] as const) {
        assert.deepEqual(await row(db, id), { ...original, source: "chain-log", tx_hash: TX.deposit,
          block_number: BLOCK.deposit, log_index: 2, chain_id: 4663 });
      }
      const now = await f.local.prepare("SELECT * FROM journal ORDER BY seq").all() as Row[];
      assert.deepEqual(now.slice(0, -1), journal, "every original journal entry is retained");
      const correction = now.at(-1)!;
      assert.equal(correction.kind, "mark"); assert.equal(correction.epoch, 1); assert.equal(correction.agent_id, TEST_ACCOUNT);
      assert.equal(correction.prev_hash, journal.at(-1)!.hash); assert.equal(correction.hash, journalHash(String(correction.prev_hash), String(correction.payload_json)));
      const mark = JSON.parse(String(correction.payload_json)).receiptAttestation;
      assert.equal(mark.version, 2); assert.equal(mark.originalFlow.source, "inferred"); assert.equal(mark.originalFlow.tx_hash, null);
      assert.equal(mark.correctedFlow.at, BOOKED_AT); assert.equal(mark.receipt.txHash, TX.deposit); assert.equal(mark.approvalDigest, preview.approvalDigest);
      assert.equal(existsSync(marker(f)), false);
      assert.equal((await readReceiptAttestation(f.shared, TEST_TENANT))!.state, "applied");
    } finally { f.close(); }
  });
}

test("the worker's next journal entry chains from the correcting mark, in its own spelling and epoch", async () => {
  const f = await fixture();
  try {
    const preview = await attestTradedReceipt(f.options);
    await commit(f, preview.approvalDigest);
    // store.ts appendJournalRow's own lookup of the link it extends.
    const prev = await f.local.prepare("SELECT hash FROM journal WHERE agent_id = ? AND epoch = ? ORDER BY seq DESC LIMIT 1").get(TEST_ACCOUNT, 1) as { hash: string };
    const last = await f.local.prepare("SELECT hash, kind FROM journal ORDER BY seq DESC LIMIT 1").get() as { hash: string; kind: string };
    assert.equal(prev.hash, last.hash); assert.equal(last.kind, "mark");
  } finally { f.close(); }
});

test("the amended receipt is too deep to become the deposit scan's resume point", () => {
  // store.ts lastChainLogBlock is the highest chain-log block; resumeFrom past the lookback opens at the head.
  const head = BigInt(BLOCK.deposit) + SCAN_LOOKBACK_BLOCKS + 1n;
  assert.ok(resumeFrom(BLOCK.deposit, head, SCAN_LOOKBACK_BLOCKS) > BigInt(BLOCK.deposit));
  const index = readFileSync(path.join(import.meta.dirname, "index.ts"), "utf8");
  assert.match(index, new RegExp(`const DEPOSIT_LOOKBACK_BLOCKS = ${SCAN_LOOKBACK_BLOCKS.toLocaleString("en").replace(/,/g, "_")}n;`), "the scan's lookback is the one this protocol defers to");
});

test("a receipt shallower than the scan's lookback, or a window inside the confirmation tail, cannot be attested", async () => {
  const f = await fixture();
  try {
    f.setHead(BigInt(BLOCK.deposit) + SCAN_LOOKBACK_BLOCKS - 1n);
    await refusesWithoutWriting(f, /too recent/);
    f.setHead(BigInt(BLOCK.booking) + WINDOW_MARGIN_BLOCKS + 63n);
    await refusesWithoutWriting(f, /not yet confirmed/);
    f.setHead(BigInt(BLOCK.deposit) + SCAN_LOOKBACK_BLOCKS);
    assert.equal((await attestTradedReceipt(f.options)).state, "preview");
  } finally { f.close(); }
});

test("a second unbooked capital transfer in the window refuses, whichever is larger", async () => {
  const f = await fixture();
  try {
    f.state.logs.push(transferLog({ from: DEPOSITOR, to: TEST_ACCOUNT, raw: 1_000_000n, block: BLOCK.booking + 100, tx: `0x${"c4".repeat(32)}`, index: 0 }));
    await refusesWithoutWriting(f, /2 capital transfers are in the window/);
  } finally { f.close(); }
});

test("an unbooked withdrawal in the window refuses too: the change cannot be told from it", async () => {
  const f = await fixture();
  try {
    f.state.logs.push(transferLog({ from: TEST_ACCOUNT, to: DEPOSITOR, raw: 5_000_000n, block: BLOCK.booking + 100, tx: `0x${"c5".repeat(32)}`, index: 0 }));
    await refusesWithoutWriting(f, /2 capital transfers are in the window/);
  } finally { f.close(); }
});

test("a withdrawal both books already hold by its transaction is left out, as the scanner leaves it", async () => {
  const f = await fixture();
  try {
    const withdrawal = `0x${"c6".repeat(32)}`;
    f.state.logs.push(transferLog({ from: TEST_ACCOUNT, to: DEPOSITOR, raw: 5_000_000n, block: BLOCK.booking + 100, tx: withdrawal, index: 0 }));
    for (const db of [f.local, f.shared]) {
      // The executor books a transfer home with its transaction and no log index (the identity index cannot see it).
      await db.prepare("INSERT INTO flows(agent_id,direction,amount_usdg,tx_hash,source,at,epoch,chain_id) VALUES(?,'out',5,?,'transfer-intent',?,1,4663)").run(TEST_ACCOUNT, withdrawal, BOOKED_AT + 30);
    }
    assert.equal((await attestTradedReceipt(f.options)).receipt.txHash, TX.deposit);
  } finally { f.close(); }
});

for (const [description, shared] of [["the original book", false], ["the shared book alone", true]] as const) {
  test(`a receipt ${description} already names by transaction is not unbooked: nothing is left to attest`, async () => {
    const f = await fixture();
    try {
      await (shared ? f.shared : f.local).prepare("INSERT INTO flows(agent_id,direction,amount_usdg,tx_hash,source,at,epoch,chain_id) VALUES(?,'in',1,?,'transfer-intent',?,1,4663)")
        .run(TEST_ACCOUNT, TX.deposit, BOOKED_AT + 30);
      await refusesWithoutWriting(f, shared ? /no capital transfer is in the window/ : /./);
    } finally { f.close(); }
  });
}

test("a transfer of a different amount is a different movement", async () => {
  const f = await fixture();
  try {
    f.deposit.data = `0x${(TOP_UP_RAW + 1n).toString(16).padStart(64, "0")}`;
    await refusesWithoutWriting(f, /not this change's/);
  } finally { f.close(); }
});

test("a deposit outside the readings' window is not this flow's receipt", async () => {
  const f = await fixture();
  try {
    const moved = BLOCK.baseline - Number(WINDOW_MARGIN_BLOCKS) - 10;
    Object.assign(f.deposit, { blockNumber: `0x${moved.toString(16)}`, blockHash: `0x${"b".repeat(58)}${moved.toString(16)}` });
    await refusesWithoutWriting(f, /no capital transfer is in the window/);
  } finally { f.close(); }
});

test("a receipt whose block time falls outside the readings refuses", async () => {
  const f = await fixture();
  try {
    const rpc: typeof f.rpc = async (method, params) => {
      const result = await f.rpc(method, params) as Row | null;
      return method === "eth_getBlockByNumber" && BigInt(String(params[0])) === BigInt(BLOCK.deposit) ? { ...result, timestamp: `0x${(BOOKED_AT + 601).toString(16)}` } : result;
    };
    await refusesWithoutWriting(f, /block time is outside/, { ...f.options, rpc });
  } finally { f.close(); }
});

test("unreadable, removed or reorganized chain evidence refuses", async () => {
  const f = await fixture();
  try {
    const unread: typeof f.rpc = async (method, params) => { if (method === "eth_getLogs") throw new Error("upstream refused"); return f.rpc(method, params); };
    await refusesWithoutWriting(f, /could not be read or classified \(deposit scan covered only/, { ...f.options, rpc: unread });
    f.state.receipts.set(TX.deposit, null);
    await refusesWithoutWriting(f, /no successful receipt/);
    f.state.receipts.set(TX.deposit, { status: "0x0", transactionHash: TX.deposit, logs: [] });
    await refusesWithoutWriting(f, /no successful receipt/);
    f.state.receipts.clear();
    f.deposit.removed = true;
    await refusesWithoutWriting(f, /logs are malformed/);
    f.deposit.removed = false;
    let calls = 0;
    const rpc: typeof f.rpc = async (method, params) => {
      const result = await f.rpc(method, params) as Row | null;
      const end = method === "eth_getBlockByNumber" && BigInt(String(params[0])) === BigInt(BLOCK.booking) + WINDOW_MARGIN_BLOCKS;
      return end && ++calls > 1 ? { ...result, hash: `0x${"9".repeat(64)}` } : result;
    };
    await refusesWithoutWriting(f, /reorganized/, { ...f.options, rpc });
  } finally { f.close(); }
});

test("readings too far apart for one window refuse rather than read a day of trades", async () => {
  const f = await fixture();
  try {
    const far = BLOCK.baseline + Number(MAX_WINDOW_BLOCKS);
    const row = await f.local.prepare("SELECT seq, payload_json FROM journal WHERE kind='mark' AND seq > (SELECT seq FROM journal WHERE kind='flow' AND payload_json LIKE '%inferred%') ORDER BY seq LIMIT 1").get() as Row;
    await f.local.prepare("UPDATE journal SET payload_json=? WHERE seq=?").run(canonicalJson({ ...JSON.parse(String(row.payload_json)), blockNumber: String(far) }), row.seq);
    await rechain(f);
    f.setHead(BigInt(far) + SCAN_LOOKBACK_BLOCKS);
    await refusesWithoutWriting(f, /too far apart/);
  } finally { f.close(); }
});

for (const [description, mutate, pattern] of [
  ["another account's flow id", async (f: Fixture) => {
    await f.shared.prepare("INSERT INTO flows(id,agent_id,direction,amount_usdg,source,at,epoch) VALUES(77,?,'in',59.95446,'inferred',?,1)").run(`0x${"9f".repeat(20)}`, BOOKED_AT);
    f.options.sharedFlowId = 77;
  }, /not exactly one row of this account/],
  ["an evidenced flow's id", async (f: Fixture) => { f.options.sharedFlowId = 501; }, /not an unattested inferred deposit/],
  ["an absent flow id", async (f: Fixture) => { f.options.sharedFlowId = 9999; }, /not exactly one row/],
  ["an original row that differs from its shared copy", async (f: Fixture) => { await f.local.prepare("UPDATE flows SET amount_usdg=59.95445 WHERE id=?").run(LOCAL_FLOW); }, /not exactly one row/],
  ["a shared copy duplicated by a cursor rewind", async (f: Fixture) => {
    await f.shared.prepare("INSERT INTO flows(agent_id,direction,amount_usdg,source,at,epoch,chain_id) VALUES(?,'in',?,'inferred',?,1,4663)").run(TEST_ACCOUNT, TOP_UP, BOOKED_AT);
  }, /booked more than once/],
  ["an original row the mirror has not copied", async (f: Fixture) => {
    await f.shared.prepare("UPDATE mirror_state SET last_id=1,last_stamp=? WHERE table_name='flows'").run(blockTime(BLOCK.open) + 5);
  }, /no shared copy behind the mirror's witness/],
  ["an intact journal whose inferred fact is another amount", async (f: Fixture) => {
    await f.local.prepare("UPDATE journal SET payload_json=? WHERE kind='flow' AND payload_json LIKE '%inferred%'")
      .run(canonicalJson({ amountUsdg: 59.95445, blockNumber: null, direction: "in", logIndex: null, source: "inferred", txHash: null }));
    await rechain(f);
  }, /original flow journal does not hold exactly one entry/],
  ["an edited journal entry", async (f: Fixture) => { await f.local.prepare("UPDATE journal SET payload_json='{}' WHERE seq=3").run(); }, /journal hash chain is invalid/],
  ["a hash-valid journal with a deleted entry", async (f: Fixture) => { await f.local.prepare("DELETE FROM journal WHERE seq=3").run(); await rechain(f); }, /journal hash chain is invalid/],
  ["a journal with no reading after the fact", async (f: Fixture) => {
    await f.local.prepare("DELETE FROM journal WHERE seq > (SELECT seq FROM journal WHERE kind='flow' AND payload_json LIKE '%inferred%')").run();
  }, /no live cash reading with a block brackets the flow/],
  ["a second account in the original book", async (f: Fixture) => {
    await f.local.prepare("INSERT INTO trades(agent_id,kind,target,amount_usdg,status) VALUES(?,'swap','pool',1,'rejected')").run(`0x${"9f".repeat(20)}`);
  }, /different account/],
  ["a quarantined copy of the receipt", async (f: Fixture) => {
    await f.shared.prepare("INSERT INTO flows_quarantine(original_id,agent_id,epoch,direction,amount_usdg,tx_hash,source,run_id,quarantined_at,reason) VALUES(1,?,1,'in',59.95446,?,'chain-log','run',1,'test')").run(TEST_ACCOUNT, TX.deposit);
  }, /earlier repair or owner record/],
  ["a changed source generation", async (f: Fixture) => { await f.shared.prepare("UPDATE tenant_ledger_import SET source_identity='another-book'").run(); }, /consumed source receipt differs/],
  ["a cursor witness that names another row", async (f: Fixture) => { await f.shared.prepare("UPDATE mirror_state SET last_stamp=1000 WHERE table_name='equity'").run(); }, /./],
] as const) test(`refuses ${description} and preserves both books`, async () => {
  const f = await fixture();
  try { await mutate(f); await refusesWithoutWriting(f, pattern); }
  finally { f.close(); }
});

test("hold, live process, lease and approval refusals cannot write", async () => {
  const f = await fixture();
  try {
    const preview = await attestTradedReceipt(f.options);
    delete process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
    await refusesWithoutWriting(f, /explicitly held/);
    process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = TEST_TENANT;
    f.setQuiet(false); await refusesWithoutWriting(f, /process/); f.setQuiet(true);
    f.setHealthy(false); await refusesWithoutWriting(f, /lease/); f.setHealthy(true);
    await refusesWithoutWriting(f, /approval/, { ...f.options, mode: "commit", approvedDigest: "0".repeat(64) });
    assert.equal((await attestTradedReceipt(f.options)).approvalDigest, preview.approvalDigest, "the same evidence previews to the same digest");
  } finally { f.close(); }
});

test("a book that changes after its preview no longer matches the approval; after the audit it no longer matches the plan", async () => {
  const f = await fixture();
  try {
    const preview = await attestTradedReceipt(f.options);
    await f.local.prepare("INSERT INTO trades(agent_id,kind,target,amount_usdg,status,created_at,epoch) VALUES(?,'swap','pool',1,'rejected',?,1)").run(TEST_ACCOUNT, BOOKED_AT + 900);
    await refusesWithoutWriting(f, /approval does not match/, { ...f.options, mode: "commit", approvedDigest: preview.approvalDigest });
    await f.local.prepare("DELETE FROM trades WHERE created_at=?").run(BOOKED_AT + 900);
    await assert.rejects(commit(f, preview.approvalDigest, { checkpoint(at) { if (at === "marker") throw new Error("stop before amendment"); } }), /stop before amendment/);
    await f.shared.prepare("UPDATE fee_accruals SET fee_usdg=0.13").run();
    await assert.rejects(commit(f, preview.approvalDigest), /accounting preimages changed/);
    assert.equal((await readReceiptAttestation(f.shared, TEST_TENANT))!.state, "pending", "the barriers stay");
    assert.equal(existsSync(marker(f)), true);
    await f.shared.prepare("UPDATE fee_accruals SET fee_usdg=0.12").run();
    assert.equal((await commit(f, preview.approvalDigest)).state, "applied");
  } finally { f.close(); }
});

test("lease loss after the durable audit leaves the pending barrier; resumed ownership finishes the exact evidence", async () => {
  const f = await fixture();
  try {
    const preview = await attestTradedReceipt(f.options);
    await assert.rejects(commit(f, preview.approvalDigest, { checkpoint(at) { if (at === "audit") f.setHealthy(false); } }), /lease/);
    assert.equal((await readReceiptAttestation(f.shared, TEST_TENANT))!.state, "pending");
    assert.equal((await f.local.prepare("SELECT source FROM flows WHERE id=?").get(LOCAL_FLOW) as { source: string }).source, "inferred");
    f.setHealthy(true);
    assert.equal((await commit(f, preview.approvalDigest)).state, "applied");
  } finally { f.close(); }
});

test("a pending repair keeps both barriers when its receipt reads differently, and resumes on the same evidence", async () => {
  const f = await fixture();
  try {
    const preview = await attestTradedReceipt(f.options);
    await assert.rejects(commit(f, preview.approvalDigest, { checkpoint(at) { if (at === "local") throw new Error("stop after the original book"); } }), /stop after/);
    f.state.logs.push(transferLog({ from: DEPOSITOR, to: TEST_ACCOUNT, raw: 1_000_000n, block: BLOCK.booking + 100, tx: `0x${"c7".repeat(32)}`, index: 0 }));
    await assert.rejects(commit(f, preview.approvalDigest), /2 capital transfers are in the window/);
    assert.equal((await readReceiptAttestation(f.shared, TEST_TENANT))!.state, "pending");
    assert.equal(existsSync(marker(f)), true);
    f.state.logs.pop();
    assert.equal((await commit(f, preview.approvalDigest)).state, "applied");
  } finally { f.close(); }
});

test("a pending audit or marker tampered with refuses retry without clearing the evidence", async () => {
  const f = await fixture();
  try {
    const preview = await attestTradedReceipt(f.options);
    await assert.rejects(commit(f, preview.approvalDigest, { checkpoint(at) { if (at === "marker") throw new Error("stop"); } }), /stop/);
    const original = readFileSync(marker(f), "utf8");
    writeFileSync(marker(f), canonicalJson({ state: "unrelated-barrier" }));
    await assert.rejects(commit(f, preview.approvalDigest), /barrier/);
    writeFileSync(marker(f), original);
    await f.shared.prepare("UPDATE ledger_receipt_attestations SET plan_json='{}'").run();
    await assert.rejects(commit(f, preview.approvalDigest), /audit/);
    assert.equal(existsSync(marker(f)), true);
  } finally { f.close(); }
});

test("one attestation per tenant: another flow, or the other protocol, refuses by name", async () => {
  const f = await fixture();
  try {
    const preview = await attestTradedReceipt(f.options);
    await commit(f, preview.approvalDigest);
    await assert.rejects(attestTradedReceipt({ ...f.options, sharedFlowId: 501 }), /names another flow/);
    const { sharedFlowId: _flow, ...untouched } = f.options;
    await assert.rejects(attestReceipt(untouched), /set MERRYMEN_RECEIPT_ATTEST_FLOW/);
  } finally { f.close(); }
  const g = await receiptFixture();
  process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = TEST_TENANT;
  try {
    const preview = await attestOriginalReceipt(g.options);
    await attestOriginalReceipt({ ...g.options, mode: "commit", approvedDigest: preview.approvalDigest });
    await assert.rejects(attestReceipt({ ...g.options, sharedFlowId: 428 }), /untouched-book protocol; remove MERRYMEN_RECEIPT_ATTEST_FLOW/);
    assert.equal((await attestReceipt(g.options)).state, "applied");
  } finally { g.close(); }
});

test("operator flow selection is one decimal shared id, admitted by the staged-rollout exemption only with the rest of the scope", () => {
  const base = { MERRYMEN_RECEIPT_ATTEST_ACCOUNT: TEST_ACCOUNT, MERRYMEN_RECEIPT_ATTEST_TENANT: TEST_TENANT, MERRYMEN_RECEIPT_ATTEST_MODE: "dry-run" };
  assert.equal(receiptAttestationRequest({ ...base, MERRYMEN_RECEIPT_ATTEST_FLOW: "428" })!.flowId, 428);
  assert.equal(receiptAttestationRequest(base)!.flowId, undefined);
  for (const flow of ["", "0", "-1", "0428", "4e2", "abc", "428,429", String(Number.MAX_SAFE_INTEGER + 2)]) {
    assert.throws(() => receiptAttestationRequest({ ...base, MERRYMEN_RECEIPT_ATTEST_FLOW: flow }), /shared flow id/, flow);
  }
  assert.throws(() => receiptAttestationRequest({ MERRYMEN_RECEIPT_ATTEST_FLOW: "428" }));
  const env = { ...base, MERRYMEN_RECEIPT_ATTEST_FLOW: "428", MERRYMEN_ACCOUNTING_HOLD_TENANTS: TEST_TENANT };
  assert.equal(scopedReceiptAttestationAllowed(env, Object.keys(env).filter(k => k.startsWith("MERRYMEN_RECEIPT"))), true);
  assert.equal(scopedReceiptAttestationAllowed({ ...env, MERRYMEN_RECEIPT_ATTEST_FLOW: "x" }, Object.keys(env).filter(k => k.startsWith("MERRYMEN_RECEIPT"))), false);
});

test("rows far apart in the key space are all bound: a change several key windows up still refuses the approval", async () => {
  const f = await fixture();
  try {
    const other = `0x${"9f".repeat(20)}`;
    // Another tenant's rows between, as in the fleet's shared tables, and this account's rows windows apart.
    await f.shared.prepare("INSERT INTO equity(id,agent_id,eth_wei,cash_usdg,vault_usdg,positions_usdg,equity_usdg,at,epoch,mode) VALUES(60000,?,'1',1,0,0,1,1,1,'live')").run(other);
    await f.shared.prepare("INSERT INTO equity(id,agent_id,eth_wei,cash_usdg,vault_usdg,positions_usdg,equity_usdg,at,epoch,mode) VALUES(170001,?,'100',154.95446,0,2.4,157.35446,?,1,'live')").run(TEST_ACCOUNT, BOOKED_AT + 900);
    await f.local.prepare("INSERT INTO fee_accruals(id,agent_id,profit_usdg,fee_usdg,hwm_before_usdg,hwm_after_usdg,at,epoch) VALUES(120000,?,0.1,0.02,100.6,100.7,?,1)").run(TEST_ACCOUNT, BOOKED_AT + 900);
    const preview = await attestTradedReceipt(f.options);
    await f.shared.prepare("UPDATE equity SET cash_usdg=154 WHERE id=170001").run();
    await refusesWithoutWriting(f, /approval does not match/, { ...f.options, mode: "commit", approvedDigest: preview.approvalDigest });
    await f.shared.prepare("UPDATE equity SET cash_usdg=154.95446 WHERE id=170001").run();
    await f.local.prepare("UPDATE fee_accruals SET fee_usdg=0.03 WHERE id=120000").run();
    await refusesWithoutWriting(f, /approval does not match/, { ...f.options, mode: "commit", approvedDigest: preview.approvalDigest });
    await f.local.prepare("UPDATE fee_accruals SET fee_usdg=0.02 WHERE id=120000").run();
    await f.shared.prepare("UPDATE equity SET cash_usdg=2 WHERE id=60000").run();
    assert.equal((await commit(f, preview.approvalDigest)).state, "applied", "another tenant's rows are not this book's evidence");
  } finally { f.close(); }
});

test("a lease lost while the window is read refuses by its own name, not as an unread window", async () => {
  const f = await fixture();
  try {
    let reads = 0;
    const rpc: typeof f.rpc = async (method, params) => { if (method === "eth_getLogs" && ++reads === 1) f.setHealthy(false); return f.rpc(method, params); };
    await refusesWithoutWriting(f, /tenant lease is not held/, { ...f.options, rpc });
  } finally { f.close(); }
});
