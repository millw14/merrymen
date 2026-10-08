import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { wrapSqlite } from "../db";
import { HostedLiveCheckpointStore, HostedStanddownStore, revokeHostedGrant } from "./hosted-standdown-store";
import { sealPerpKey } from "./key-seal";
const owner = `0x${"11".repeat(20)}` as const, spot = `0x${"22".repeat(20)}` as const, perps = `0x${"33".repeat(20)}` as const;
const dek = Buffer.alloc(32, 8), privateKey = `0x${"ab".repeat(40)}`;
const publicKey = `0x${("01" + "00".repeat(7)).repeat(5)}` as const;
function grant(account: typeof spot | typeof perps, purpose: "spot" | "perps") {
 return { purpose, smartAccount: account, expiresAt: 100, chainId: 4663, grantFeatures: ["perp-lighter-v1"], perp: { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: publicKey,
  apiKeySealed: sealPerpKey(privateKey, { tenant: owner, smartAccount: account, apiPublicKey: publicKey, apiKeyIndex: 16 }, dek) } };
}
it("Perps revocation, shutdown lookup and checkpoint fencing never revoke or block the same owner's Spot account", async () => {
 const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw);
 try {
  await db.exec("CREATE TABLE grants (tenant TEXT PRIMARY KEY, grant_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  const store = new HostedStanddownStore(db, dek); await store.init();
  await db.prepare("INSERT INTO grants VALUES (?, ?, 50)").run(owner, JSON.stringify(grant(spot, "spot")));
  await db.prepare("INSERT INTO perps_grants VALUES (?, 4663, ?, 'session', 50)").run(owner, JSON.stringify(grant(perps, "perps")));
  const checkpoints = new HostedLiveCheckpointStore(db, dek);
  const a = await checkpoints.claim(owner, spot, publicKey, "spot-worker");
  const b = await checkpoints.claim(owner, perps, publicKey, "perps-worker");
  assert.equal(await checkpoints.fence(a), true); assert.equal(await checkpoints.fence(b), true);
  assert.equal(await revokeHostedGrant(db, owner, dek, { purpose: "perps", nowMs: 100_000 }), "removed");
  assert.ok(await db.prepare("SELECT * FROM grants WHERE tenant = ?").get(owner));
  assert.equal(await db.prepare("SELECT * FROM perps_grants WHERE tenant = ?").get(owner), undefined);
  assert.equal(await checkpoints.fence(a), true); assert.equal(await checkpoints.fence(b), false);
  assert.equal(await store.latest(owner), null);
  assert.equal((await store.latest(owner, "perps"))?.smartAccount, perps);
  assert.equal((await store.latest(owner, "perps"))?.purpose, "perps");
  assert.equal(await store.blocked(owner, spot), false);
  assert.equal(await store.blocked(owner, perps, "perps"), true);
  assert.equal(await store.blocked(`0x${"44".repeat(20)}`, perps), true);
  assert.equal(await revokeHostedGrant(db, owner, dek, { purpose: "perps" }), "absent");
 } finally { raw.close(); }
});
it("legacy shutdown rows gain Spot purpose without losing their state", async () => {
 const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw);
 try {
  await db.exec(`CREATE TABLE perp_standdown (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, smart_account TEXT NOT NULL, api_public_key TEXT NOT NULL, api_key_index INTEGER NOT NULL, sealed_key TEXT, reason TEXT NOT NULL, created_at_ms BIGINT NOT NULL, expires_at_ms BIGINT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, claimant TEXT, state TEXT NOT NULL DEFAULT 'pending', checkpoint TEXT, result_json TEXT, mirrored INTEGER NOT NULL DEFAULT 0)`);
  await db.prepare("INSERT INTO perp_standdown (id, tenant, smart_account, api_public_key, api_key_index, reason, created_at_ms, expires_at_ms) VALUES ('old', ?, ?, ?, 16, 'kill', 1, 2)").run(owner, spot, publicKey);
  const store = new HostedStanddownStore(db, dek); await store.init(); await store.init();
  assert.equal((await store.latest(owner))?.id, "old");
  assert.equal((await store.latest(owner))?.purpose, "spot");
  assert.equal(await store.latest(owner, "perps"), null);
 } finally { raw.close(); }
});
