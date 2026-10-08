import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { StoredGrant } from "../../packages/core/src/grant";

const home = mkdtempSync(path.join(os.tmpdir(), "merrymen-dual-authority-"));
process.env.MERRYMEN_HOME = home;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 4).toString("base64");
const { FileGrantStore } = await import("./grant-store");
const { FileSettingsStore } = await import("./settings-store");
const { homePaths, purposeHome } = await import("./home");
after(() => rmSync(home, { recursive: true, force: true }));
const owner = "0x0000000000000000000000000000000000000011" as const;
const spotAccount = "0x0000000000000000000000000000000000000022" as const;
const perpAccount = "0x0000000000000000000000000000000000000033" as const;
const spot = { owner, smartAccount: spotAccount, demoSessionPrivateKey: `0x${"ab".repeat(32)}`, serialized: "spot-permission", chainId: 4663, sessionKeyAddress: `0x${"ab".repeat(20)}`, grantedAt: 1, expiresAt: 9999999999, caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 4 } } as StoredGrant;
const perps = { ...spot, purpose: "perps", smartAccount: perpAccount, demoSessionPrivateKey: `0x${"cd".repeat(32)}`, serialized: "perps-permission" } as StoredGrant;

describe("one login, separate account authority", () => {
 it("creating, renewing and revoking Perps leaves the legacy Spot grant byte-for-byte unchanged", async () => {
  const s = new FileGrantStore(), p = new FileGrantStore("perps");
  await s.put(owner, spot);
  const before = readFileSync(path.join(home, "tenants", `${owner}.json`), "utf8");
  await p.put(owner, perps);
  assert.equal((await s.get(owner))?.smartAccount, spotAccount);
  assert.equal((await p.get(owner))?.smartAccount, perpAccount);
  assert.notEqual((await p.get(owner))?.demoSessionPrivateKey, (await s.get(owner))?.demoSessionPrivateKey);
  assert.equal(await s.tenantForAccount(perpAccount), owner);
  assert.equal(await p.tenantForAccount(spotAccount), owner);
  await p.put(owner, { ...perps, serialized: "renewed-perps-permission" });
  await p.remove(owner);
  assert.equal(await p.get(owner), null);
  assert.equal(readFileSync(path.join(home, "tenants", `${owner}.json`), "utf8"), before);
 });
 it("refuses cross-purpose grants and a shared on-chain address before changing either slot", async () => {
  const s = new FileGrantStore(), p = new FileGrantStore("perps");
  await s.put(owner, spot);
  await assert.rejects(p.put(owner, spot), /purpose/);
  await assert.rejects(s.put(owner, perps), /purpose/);
  await assert.rejects(p.put(owner, { ...perps, smartAccount: spotAccount }), /distinct smart accounts/);
  assert.equal(await p.get(owner), null);
  assert.equal((await s.get(owner))?.smartAccount, spotAccount);
 });
 it("never hands a moved record from another account scope to a worker", async () => {
  const p = new FileGrantStore("perps");
  await p.put(owner, perps);
  const file = path.join(home, "tenants-perps", `${owner}.json`);
  const record = JSON.parse(readFileSync(file, "utf8"));
  delete record.grant.purpose;
  writeFileSync(file, JSON.stringify(record));
  assert.equal(await p.get(owner), null);
  assert.equal(await p.hasStoredGrant(owner), true);
  await p.remove(owner);
 });
 it("serializes concurrent first setup so two different owner keys cannot arm the same login", async () => {
  const tenant = "0x0000000000000000000000000000000000000099" as const;
  const s = new FileGrantStore(), p = new FileGrantStore("perps");
  const a = { ...spot, smartAccount: "0x0000000000000000000000000000000000000055" } as StoredGrant;
  const b = { ...perps, owner: "0x0000000000000000000000000000000000000077", smartAccount: "0x0000000000000000000000000000000000000066" } as StoredGrant;
  const result = await Promise.allSettled([s.put(tenant, a), p.put(tenant, b)]);
  assert.equal(result.filter(r => r.status === "fulfilled").length, 1);
  const rejected = result.find(r => r.status === "rejected") as PromiseRejectedResult;
  assert.match(String(rejected.reason), /same owner key/);
  assert.notEqual(!!await s.get(tenant), !!await p.get(tenant));
 });
 it("keeps risk budgets independent but uses one holder identity", async () => {
  const s = new FileSettingsStore(), p = new FileSettingsStore("perps");
  await s.put(owner, { strategy: "trencher", slippageBps: 100 });
  await p.put(owner, { strategy: "perps-only", perpsMaxCollateralUsdg: 20 });
  assert.equal((await s.get(owner))?.strategy, "trencher");
  assert.equal((await p.get(owner))?.perpsMaxCollateralUsdg, 20);
  await p.remove(owner);
  assert.equal((await s.get(owner))?.strategy, "trencher");
  const wallet = "0x0000000000000000000000000000000000000044";
  await s.claimHolder(wallet, owner);
  assert.deepEqual(await p.claimHolder(wallet, owner), { ok: true, fresh: false });
 });
 it("gives a local Perps process its own complete home while the old paths remain stable", () => {
  assert.equal(homePaths.grant(), path.join(home, "grant.json"));
  assert.equal(purposeHome("perps"), path.join(home, "accounts", "perps"));
  assert.equal(homePaths.grant("perps"), path.join(home, "accounts", "perps", "grant.json"));
  assert.equal(homePaths.settings("perps"), path.join(home, "accounts", "perps", "settings.json"));
  assert.throws(() => purposeHome("unknown" as never), /purpose/);
 });
});
