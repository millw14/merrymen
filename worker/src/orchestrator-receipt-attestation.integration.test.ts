import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { after, test } from "node:test";
import type { StoredGrant } from "../../packages/core/src/index";
import { receiptFixture, TEST_ACCOUNT, TEST_TENANT } from "./receipt-attestation-fixture";
import { readReceiptAttestation } from "./receipt-attestation-state";

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mm-supervisor-attestation-")));
process.env.MERRYMEN_HOME = root;
process.env.MERRYMEN_HOSTED = "1";
process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = TEST_TENANT;
delete process.env.DATABASE_URL;
const { attestReceiptUnderSupervisor, setPersistentHomeVerifierForTest, setTenantLeaseForTest, setSpawningForTest,
  adoptChildForTest, mirrorRunningLedgerForTest } = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const grant = { smartAccount: TEST_ACCOUNT, owner: TEST_TENANT, chainId: 4663,
  sessionKeyAddress: "0x00000000000000000000000000000000000000d8", serialized: "fixture-permission",
  grantedAt: 1, expiresAt: 9999999999, caps: { perTradeUsdg: 40, dailyUsdg: 100, maxDrawdownPct: 5, expiryDays: 24 },
  demoSessionPrivateKey: `0x${"cd".repeat(32)}`, grantFeatures: ["tradeable-v2"], grantTokens: [] } as unknown as StoredGrant;
class Process extends EventEmitter {
  readonly pid = 900001;
  kill() { this.emit("exit", 0, "SIGTERM"); return true; }
}
after(() => { rmSync(root, { recursive: true, force: true }); });

test("real supervisor derives no-child/spawn/lease/volume authority; pending shared audit blocks mirror before any local marker", async () => {
  const f = await receiptFixture();
  process.env.MERRYMEN_HOME = f.options.volume.homeRoot;
  const store = getGrantStore(); await store.put(TEST_TENANT, grant);
  setPersistentHomeVerifierForTest(() => f.options.volume);
  const options = { tenant: TEST_TENANT, smartAccount: TEST_ACCOUNT, shared: f.shared, rpc: f.rpc, dialect: "sqlite" as const };
  try {
    await assert.rejects(attestReceiptUnderSupervisor(options), /supervisor.*lease/);
    setTenantLeaseForTest(TEST_TENANT, f.options.lease);
    await assert.rejects(attestReceiptUnderSupervisor({ ...options, smartAccount: TEST_TENANT }), /same current stored account/);
    setSpawningForTest(TEST_TENANT, 1000);
    await assert.rejects(attestReceiptUnderSupervisor(options), /quiet supervisor/);
    setSpawningForTest(TEST_TENANT, null);
    const before = readFileSync(f.file), preview = await attestReceiptUnderSupervisor(options);
    assert.equal(preview.state, "preview"); assert.deepEqual(readFileSync(f.file), before);
    const proc = new Process(); adoptChildForTest(TEST_TENANT, TEST_ACCOUNT, proc as unknown as ChildProcess, f.options.lease);
    await assert.rejects(attestReceiptUnderSupervisor(options), /quiet supervisor/);
    // The real mirror failure/stand-down boundary removes this running child.
    // An injected pending audit is unnecessary: a source continuity refusal
    // exercises the same authoritative process-removal path first.
    await f.shared.prepare("UPDATE mirror_state SET last_stamp=1").run();
    await assert.rejects(mirrorRunningLedgerForTest(TEST_TENANT, f.shared));
    await f.shared.prepare("UPDATE mirror_state SET last_stamp=1791595716").run();
    const ready = await attestReceiptUnderSupervisor(options);
    await assert.rejects(attestReceiptUnderSupervisor({ ...options, mode: "commit", approvedDigest: ready.approvalDigest,
      checkpoint(at) { if (at === "audit") throw new Error("interrupted before local marker"); } }), /interrupted/);
    assert.equal(existsSync(path.join(f.options.home, "ledger-source-blocked.json")), false);
    assert.equal((await readReceiptAttestation(f.shared, TEST_TENANT))!.state, "pending");
    const unsafe = new Process(); adoptChildForTest(TEST_TENANT, TEST_ACCOUNT, unsafe as unknown as ChildProcess, f.options.lease);
    const marks = await f.shared.prepare("SELECT * FROM mirror_state").all();
    await assert.rejects(mirrorRunningLedgerForTest(TEST_TENANT, f.shared), /unfinished/);
    assert.deepEqual(await f.shared.prepare("SELECT * FROM mirror_state").all(), marks);
    assert.deepEqual(readFileSync(f.file), before);
    const final = await attestReceiptUnderSupervisor({ ...options, mode: "commit", approvedDigest: ready.approvalDigest });
    assert.equal(final.state, "applied");
    assert.deepEqual(await store.get(TEST_TENANT), grant, "the existing signed permission and caps are unchanged");
  } finally {
    setSpawningForTest(TEST_TENANT, null); setPersistentHomeVerifierForTest(null);
    setTenantLeaseForTest(TEST_TENANT, null); await store.remove(TEST_TENANT); f.close();
  }
});
