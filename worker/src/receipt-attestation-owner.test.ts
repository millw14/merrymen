import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { decodeFunctionData, encodeFunctionData, parseAbi, type Hex } from "viem";
import { CASH, GRANT_TRENCHER } from "../../packages/core/src/index";
import { USER_OPERATION_EVENT_TOPIC } from "./asset-movements";
import { TRANSFER_TOPIC } from "./chain-capital";
import { attestOriginalReceipt } from "./receipt-attestation";
import { receiptFixture, TEST_ACCOUNT, TEST_TENANT } from "./receipt-attestation-fixture";
import { OWNER_HANDLE_OPS_ABI, seedOwnerRevocations } from "./receipt-attestation-owner-fixture";
import { readReceiptAttestation } from "./receipt-attestation-state";
import { canonicalJson } from "./store";

const holds = process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
afterEach(() => { if (holds === undefined) delete process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS; else process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = holds; });
async function fixture(count = 2) {
  process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = TEST_TENANT;
  const f = await receiptFixture();
  return { ...f, owner: await seedOwnerRevocations(f, count) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const firstReceipt = (f: Fixture) => [...f.owner.receipts.values()][0]!;
const firstTx = (f: Fixture) => [...f.owner.transactions.values()][0]!;
const before = async (f: Fixture) => ({ file: readFileSync(f.file), rows: await f.shared.prepare("SELECT * FROM owner_operations ORDER BY id").all(),
  flow: await f.shared.prepare("SELECT * FROM flows").all(), cursors: await f.shared.prepare("SELECT * FROM mirror_state ORDER BY table_name").all() });
async function refuses(f: Fixture) {
  const original = await before(f);
  await assert.rejects(attestOriginalReceipt(f.options), /owner operations|owner proof|mirrored owner/);
  assert.deepEqual(await before(f), original);
  assert.equal(await readReceiptAttestation(f.shared, TEST_TENANT), undefined);
  assert.equal(existsSync(path.join(f.options.home, "ledger-source-blocked.json")), false);
}
function calldata(f: Fixture, data: Hex) {
  const t = firstTx(f), decoded = decodeFunctionData({ abi: OWNER_HANDLE_OPS_ABI, data: t.input as Hex });
  const args = decoded.args;
  t.input = encodeFunctionData({ abi: OWNER_HANDLE_OPS_ABI, functionName: "handleOps", args: [[{ ...args[0][0]!, callData: data }], args[1]] });
}

test("23 confirmed nonce revocations are freshly proved and preserved, including gas, ids, timestamps and mirror cursors", async () => {
  const f = await fixture(23);
  try {
    const original = await before(f), local = await f.local.prepare("SELECT * FROM owner_operations ORDER BY id").all();
    const preview = await attestOriginalReceipt(f.options);
    assert.equal(preview.state, "preview"); assert.deepEqual(await before(f), original);
    assert.ok(preview.ownerProofSummary);
    assert.equal(preview.ownerProofSummary.operationCount, 23); assert.deepEqual(preview.ownerProofSummary.custody, []);
    f.setHead(161n);
    const laterPreview = await attestOriginalReceipt(f.options);
    assert.equal(laterPreview.approvalDigest, preview.approvalDigest, "volatile head is not part of approval");
    assert.deepEqual(laterPreview.ownerProofSummary, preview.ownerProofSummary);
    await attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest });
    const audit = (await readReceiptAttestation(f.shared, TEST_TENANT))!, plan = JSON.parse(String(audit.plan_json));
    assert.equal(plan.ownerProof.operations.length, 23);
    assert.equal(preview.ownerProofSummary.proofDigest, createHash("sha256").update(canonicalJson(plan.ownerProof)).digest("hex"));
    assert.deepEqual(plan.ownerProof.custody, []);
    assert.ok(plan.ownerProof.operations.every((p: { record: { gas_wei: string }; callKind: string }) => p.callKind === "invalidate-nonce" && p.record.gas_wei === "777"));
    assert.equal(canonicalJson(plan.local.ownerOperations), canonicalJson(local));
    assert.equal(canonicalJson(plan.shared.ownerOperations), canonicalJson(original.rows));
    assert.deepEqual(await f.local.prepare("SELECT * FROM owner_operations ORDER BY id").all(), local);
    const committed = await before(f);
    assert.deepEqual(committed.rows, original.rows); assert.deepEqual(committed.cursors, original.cursors);
    const replay = await attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest });
    assert.deepEqual(replay.ownerProofSummary, preview.ownerProofSummary);
    assert.deepEqual(await before(f), committed);
  } finally { f.close(); }
});

for (const boundary of ["audit", "marker", "local", "shared", "cleared"] as const) test(`nonempty owner proof survives crash after ${boundary} without replaying or changing operations`, async () => {
  const f = await fixture();
  try {
    const original = await before(f), local = await f.local.prepare("SELECT * FROM owner_operations ORDER BY id").all();
    const preview = await attestOriginalReceipt(f.options);
    await assert.rejects(attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest,
      checkpoint(at) { if (at === boundary) throw new Error("interrupted"); } }), /interrupted/);
    await attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest });
    assert.deepEqual(await f.local.prepare("SELECT * FROM owner_operations ORDER BY id").all(), local);
    const after = await before(f); assert.deepEqual(after.rows, original.rows); assert.deepEqual(after.cursors, original.cursors);
    assert.equal((await f.local.prepare("SELECT COUNT(*) AS n FROM journal").get() as { n: number }).n, 2);
    assert.equal((await f.shared.prepare("SELECT COUNT(*) AS n FROM flows").get() as { n: number }).n, 1);
  } finally { f.close(); }
});

for (const [name, mutate] of [
  ["acknowledged row with stored movement", (f: Fixture) => f.local.prepare("UPDATE owner_operations SET usdg_legs_json='[{}]'").run()],
  ["review disposition", (f: Fixture) => f.local.prepare("UPDATE owner_operations SET disposition='review',review_reason='token-departed'").run()],
  ["different local/shared gas", (f: Fixture) => f.shared.prepare("UPDATE owner_operations SET gas_wei='778'").run()],
  ["wrong shared tenant", (f: Fixture) => f.shared.prepare("UPDATE owner_operations SET tenant='another-tenant'").run()],
  ["wrong recording epoch", (f: Fixture) => f.local.prepare("UPDATE owner_operations SET recorded_epoch=2").run()],
  ["missing mirrored record", (f: Fixture) => f.shared.prepare("DELETE FROM owner_operations WHERE id=101").run()],
  ["missing owner mirror witness", (f: Fixture) => f.shared.prepare("DELETE FROM mirror_state WHERE table_name='owner_operations'").run()],
  ["stale owner mirror witness", (f: Fixture) => f.shared.prepare("UPDATE mirror_state SET last_stamp=1 WHERE table_name='owner_operations'").run()],
  ["noncanonical gas", (f: Fixture) => f.local.prepare("UPDATE owner_operations SET gas_wei='0777'").run()],
  ["reverted receipt", (f: Fixture) => { firstReceipt(f).status = "0x0"; }],
  ["receipt from a different block", (f: Fixture) => { firstReceipt(f).blockHash = `0x${"ff".repeat(32)}`; }],
  ["failed root event", (f: Fixture) => { f.owner.opLogs[0]!.data = `0x${"1".padStart(64, "0")}${"0".repeat(64)}${"309".padStart(64, "0")}${"37".padStart(64, "0")}`; }],
  ["session-key event", (f: Fixture) => { const event = f.owner.opLogs[0]!; event.data = `0x${((2n << 240n) | 1n).toString(16).padStart(64, "0")}${event.data.slice(66)}`; }],
  ["missing execution boundary", (f: Fixture) => { firstReceipt(f).logs.shift(); }],
  ["duplicate receipt log position", (f: Fixture) => { firstReceipt(f).logs.push({ ...firstReceipt(f).logs[0]! }); }],
  ["unconfirmed operation", (f: Fixture) => { f.owner.opLogs[0]!.blockNumber = "0x90"; }],
  ["unknown operation", (f: Fixture) => { f.owner.opLogs.push({ ...f.owner.opLogs[0]!, topics: [...f.owner.opLogs[0]!.topics.slice(0, 1), `0x${"fa".repeat(32)}`, ...f.owner.opLogs[0]!.topics.slice(2)] }); }],
  ["transaction from another block", (f: Fixture) => { firstTx(f).blockHash = `0x${"fe".repeat(32)}`; }],
  ["transaction sent to another target", (f: Fixture) => { firstTx(f).to = TEST_ACCOUNT; }],
  ["transaction sends native value", (f: Fixture) => { firstTx(f).value = "0x1"; }],
] as const) test(`refuses ${name} before any audit or financial mutation`, async () => {
  const f = await fixture(); try { await mutate(f); await refuses(f); } finally { f.close(); }
});

test("current grant custody is included in the stable proof; any receipt Transfer at that custody refuses", async () => {
  const f = await fixture(), vault = "0x00000000000000000000000000000000000000c1";
  try {
    await f.shared.prepare("UPDATE grants SET grant_json=?,row_version=2").run(JSON.stringify({ smartAccount: TEST_ACCOUNT, owner: TEST_TENANT,
      chainId: 4663, grantFeatures: [GRANT_TRENCHER], trencherVaultAddress: vault, trencherFactoryAddress: "0x00000000000000000000000000000000000000c2" }));
    const preview = await attestOriginalReceipt(f.options);
    await assert.rejects(attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest,
      checkpoint(at) { if (at === "audit") throw new Error("inspect proof"); } }), /inspect proof/);
    const audit = (await readReceiptAttestation(f.shared, TEST_TENANT))!, plan = JSON.parse(String(audit.plan_json));
    assert.deepEqual(plan.ownerProof.custody, [vault]);
    const original = await before(f);
    firstReceipt(f).logs.push({ ...firstReceipt(f).logs[0]!, address: "0x00000000000000000000000000000000000000b1",
      topics: [TRANSFER_TOPIC, `0x${vault.slice(2).padStart(64, "0")}`, `0x${"b2".padStart(64, "0")}`], data: `0x${"1".padStart(64, "0")}`, logIndex: "0x2" });
    await assert.rejects(attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest }), /owner operations/);
    assert.deepEqual(await before(f), original); assert.equal((await readReceiptAttestation(f.shared, TEST_TENANT))!.state, "pending");
  } finally { f.close(); }
});

test("a custody capability with missing or malformed addresses cannot hide its book scope", async () => {
  const f = await fixture();
  try {
    for (const extra of [{}, { trencherVaultAddress: "not-an-address", trencherFactoryAddress: "0x00000000000000000000000000000000000000c2" }]) {
      await f.shared.prepare("UPDATE grants SET grant_json=?").run(JSON.stringify({ smartAccount: TEST_ACCOUNT, owner: TEST_TENANT, chainId: 4663, grantFeatures: [GRANT_TRENCHER], ...extra }));
      await refuses(f);
    }
  } finally { f.close(); }
});

for (const failWindow of [false, true]) test(`owner scan splits a large history into complete contiguous windows${failWindow ? " and refuses an unread window" : ""}`, async () => {
  const f = await fixture(), ranges: Array<[bigint, bigint]> = [];
  try {
    f.setHead(85_000_000n);
    f.options.rpc = async (method, params) => {
      if (method === "eth_getLogs") {
        const filter = params[0] as { topics: unknown[]; fromBlock: string; toBlock: string };
        if (filter.topics[0] === USER_OPERATION_EVENT_TOPIC) {
          const from = BigInt(filter.fromBlock), to = BigInt(filter.toBlock);
          if (to - from >= 10_000_000n) throw new Error("query spans too many blocks; only 10000000 allowed for this request");
          if (failWindow && from > 0n) throw new Error("RPC window unavailable");
          ranges.push([from, to]);
        }
      }
      return f.owner.rpc(method, params);
    };
    if (failWindow) await refuses(f);
    else {
      assert.equal((await attestOriginalReceipt(f.options)).state, "preview");
      assert.ok(ranges.length > 1); assert.equal(ranges[0]![0], 0n); assert.equal(ranges.at(-1)![1], 85_000_000n);
      for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i]![0], ranges[i - 1]![1] + 1n);
    }
  } finally { f.close(); }
});

test("both pinned headers remain fenced until all owner receipts are read", async () => {
  const f = await fixture();
  try {
    let ownerRead = false;
    f.options.rpc = async (method, params) => {
      const result = await f.owner.rpc(method, params);
      if (method === "eth_getTransactionByHash") ownerRead = true;
      if (ownerRead && method === "eth_getBlockByNumber" && params[0] === "0x60") return { ...result as object, hash: `0x${"ef".repeat(32)}` };
      return result;
    };
    await refuses(f);
  } finally { f.close(); }
});

test("grant version changes during the slow owner proof refuse before audit creation", async () => {
  const f = await fixture();
  try {
    let changed = false;
    f.options.rpc = async (method, params) => {
      if (!changed && method === "eth_getTransactionByHash") {
        changed = true; await f.shared.prepare("UPDATE grants SET row_version=row_version+1").run();
      }
      return f.owner.rpc(method, params);
    };
    const original = await before(f);
    await assert.rejects(attestOriginalReceipt(f.options), /grant or cursor evidence changed/);
    assert.deepEqual(await before(f), original); assert.equal(await readReceiptAttestation(f.shared, TEST_TENANT), undefined);
  } finally { f.close(); }
});

for (const [name, data] of [
  ["unknown direct selector", `0x11223344${"0".repeat(64)}`],
  ["trailing calldata", `0x1f1b92e3${"2".padStart(64, "0")}00`],
  ["noncanonical uint32", `0x1f1b92e3${"1".padEnd(64, "0")}`],
  ["generic zero-value execute", encodeFunctionData({ abi: parseAbi(["function execute(bytes32,bytes)"]), functionName: "execute", args: [`0x${"0".repeat(64)}`, `${TEST_ACCOUNT.toLowerCase()}${"0".repeat(64)}` as Hex] })],
] as const) test(`refuses ${name}; only exact nonce revocation is allowed`, async () => {
  const f = await fixture(); try { calldata(f, data as Hex); await refuses(f); } finally { f.close(); }
});

for (const token of [CASH.USDG, "0x00000000000000000000000000000000000000b1"]) test(`refuses book Transfer outside the owner segment (${token === CASH.USDG ? "USDG" : "another token"})`, async () => {
  const f = await fixture();
  try {
    firstReceipt(f).logs.push({ ...firstReceipt(f).logs[0]!, address: token, topics: [TRANSFER_TOPIC,
      `0x${TEST_ACCOUNT.toLowerCase().slice(2).padStart(64, "0")}`, `0x${"b2".padStart(64, "0")}`], data: `0x${"0".repeat(64)}`, logIndex: "0x2" });
    await refuses(f);
  } finally { f.close(); }
});

test("unknown chain operation refuses even when both owner tables are empty", async () => {
  const f = await fixture();
  try { await f.local.exec("DELETE FROM owner_operations"); await f.shared.exec("DELETE FROM owner_operations"); await refuses(f); } finally { f.close(); }
});

test("pending plan refuses changed public owner receipt and retains barriers until the original proof returns", async () => {
  const f = await fixture();
  try {
    const preview = await attestOriginalReceipt(f.options);
    await assert.rejects(attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest,
      checkpoint(at) { if (at === "local") throw new Error("interrupted"); } }), /interrupted/);
    const original = await before(f), t = firstTx(f), input = t.input;
    calldata(f, `0x1f1b92e3${"99".padStart(64, "0")}`);
    await assert.rejects(attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest }), /owner proof changed/);
    assert.deepEqual(await before(f), original);
    assert.equal((await readReceiptAttestation(f.shared, TEST_TENANT))!.state, "pending");
    assert.equal(existsSync(path.join(f.options.home, "ledger-source-blocked.json")), true);
    t.input = input;
    assert.equal((await attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest })).state, "applied");
  } finally { f.close(); }
});

test("legacy v1 empty-owner pending plan resumes with its original digest and a fresh empty operation scan", async () => {
  process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = TEST_TENANT;
  const f = await receiptFixture();
  try {
    const preview = await attestOriginalReceipt(f.options);
    assert.equal(preview.ownerProofSummary, undefined);
    await assert.rejects(attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest,
      checkpoint(at) { if (at === "audit") throw new Error("interrupted"); } }), /interrupted/);
    const old = (await readReceiptAttestation(f.shared, TEST_TENANT))!, plan = JSON.parse(String(old.plan_json));
    assert.equal(plan.ownerProof, undefined); assert.equal(plan.local.ownerOperations, undefined);
    const ownerScan = plan.evidence.findIndex((r: { method: string; params: [{ address?: string }] }) => r.method === "eth_getLogs" && r.params[0]?.address?.toLowerCase() !== CASH.USDG.toLowerCase());
    assert.ok(ownerScan >= 0); plan.evidence = plan.evidence.slice(0, ownerScan);
    const legacy = canonicalJson(plan), hash = createHash("sha256").update(legacy).digest("hex");
    await f.shared.prepare("UPDATE ledger_receipt_attestations SET plan_json=?,plan_hash=?").run(legacy, hash);
    assert.equal((await attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest })).state, "applied");
    assert.equal((await readReceiptAttestation(f.shared, TEST_TENANT))!.approval_digest, old.approval_digest);
  } finally { f.close(); }
});

test("an empty-owner approval cannot authorize owner history added after its pending audit", async () => {
  process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = TEST_TENANT;
  const f = await receiptFixture();
  try {
    const preview = await attestOriginalReceipt(f.options);
    await assert.rejects(attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest,
      checkpoint(at) { if (at === "audit") throw new Error("interrupted"); } }), /interrupted/);
    await seedOwnerRevocations(f);
    const file = readFileSync(f.file);
    await assert.rejects(attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest }), /evidence changed|preimages changed/);
    assert.deepEqual(readFileSync(f.file), file);
    assert.equal((await readReceiptAttestation(f.shared, TEST_TENANT))!.state, "pending");
    assert.equal((await f.shared.prepare("SELECT source FROM flows").get() as { source: string }).source, "inferred");
  } finally { f.close(); }
});
