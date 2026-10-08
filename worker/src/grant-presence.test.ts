import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { it } from "node:test";
import { FileGrantStore, PgGrantStore } from "./grant-store";
const tenant = `0x${"AB".repeat(20)}` as const;
it("file grant presence distinguishes absent from malformed and unavailable storage", async () => {
  const original = process.env.MERRYMEN_HOME, home = await mkdtemp(path.join(os.tmpdir(), "mm-grant-presence-"));
  process.env.MERRYMEN_HOME = home;
  try {
    const store = new FileGrantStore();
    assert.equal(await store.hasStoredGrant(tenant), false);
    await mkdir(path.join(home, "tenants"));
    await writeFile(path.join(home, "tenants", `${tenant.toLowerCase()}.json`), "malformed");
    assert.equal(await store.hasStoredGrant(tenant), true);
    assert.equal(await store.get(tenant), null, "ordinary read cannot prove absence");
    await rm(path.join(home, "tenants"), { recursive: true });
    await writeFile(path.join(home, "tenants"), "not a directory");
    await assert.rejects(store.hasStoredGrant(tenant), { code: "ENOTDIR" });
  } finally {
    if (original === undefined) delete process.env.MERRYMEN_HOME; else process.env.MERRYMEN_HOME = original;
    await rm(home, { recursive: true, force: true });
  }
});
it("Postgres presence binds the tenant and propagates database failures", async () => {
  let rows: unknown[] = [], fail = false;
  const fake = { async client() { return { async query(sql: string, args: unknown[]) {
    assert.equal(sql, "SELECT 1 FROM grants WHERE tenant = $1 LIMIT 1");
    assert.deepEqual(args, [tenant.toLowerCase()]);
    if (fail) throw new Error("database unavailable");
    return { rows };
  } }; } } as unknown as PgGrantStore;
  assert.equal(await PgGrantStore.prototype.hasStoredGrant.call(fake, tenant), false);
  rows = [{ "?column?": 1 }];
  assert.equal(await PgGrantStore.prototype.hasStoredGrant.call(fake, tenant), true);
  fail = true;
  await assert.rejects(PgGrantStore.prototype.hasStoredGrant.call(fake, tenant), /unavailable/);
});
