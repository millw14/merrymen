/**
 * The status fallback must distinguish a deliberately stopped permission from
 * a record whose active secret cannot be read. Exercise both real decoders;
 * PostgreSQL's connection is stood in, so this suite needs no live database.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { StoredGrant } from "../../packages/core/src/index";
import type { StoredRecord } from "./grant-store";
import { sealSecret } from "./store-crypto";

const home = mkdtempSync(path.join(tmpdir(), "mm-grant-status-read-"));
const savedHome = process.env.MERRYMEN_HOME, savedDek = process.env.MERRYMEN_STORE_DEK;
process.env.MERRYMEN_HOME = home;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
after(() => {
  if (savedHome === undefined) delete process.env.MERRYMEN_HOME; else process.env.MERRYMEN_HOME = savedHome;
  if (savedDek === undefined) delete process.env.MERRYMEN_STORE_DEK; else process.env.MERRYMEN_STORE_DEK = savedDek;
  rmSync(home, { recursive: true, force: true });
});
const { FileGrantStore, PgGrantStore } = await import("./grant-store");
const tenant = "0x00000000000000000000000000000000000000a1";
const sessionKey = `0x${"cd".repeat(32)}` as const;
const grant: StoredGrant = {
  purpose: "perps", owner: tenant, smartAccount: "0x00000000000000000000000000000000000000b1", chainId: 4663,
  demoSessionPrivateKey: sessionKey, sessionKeyAddress: privateKeyToAccount(sessionKey).address,
  serialized: "signed-permission", grantedAt: 1, expiresAt: 9_999_999_999,
  caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 4 },
};
const fileStore = new FileGrantStore("perps");
const file = path.join(home, "tenants-perps", `${tenant}.json`);
await fileStore.put(tenant, grant);
const active = JSON.parse(readFileSync(file, "utf8")) as StoredRecord;
assert.equal(await fileStore.stopForReplacement(tenant), "stopped");
const stopped = JSON.parse(readFileSync(file, "utf8")) as StoredRecord;

for (const backend of ["file", "postgres"] as const) {
  test(`${backend}: unreadable active secret is refused; a genuine replacement stop keeps its owner`, async () => {
    let record: StoredRecord | null = active;
    const replace = (next: StoredRecord | null) => {
      record = next;
      if (backend === "file") {
        if (next) writeFileSync(file, JSON.stringify(next));
        else rmSync(file);
      }
    };
    const store = backend === "file" ? fileStore : new PgGrantStore("test-only-no-network", "perps", async () => ({
      async query(sql: string, params?: unknown[]) {
        if (sql === "SELECT to_regclass($1) IS NOT NULL AS found") {
          assert.deepEqual(params, ["perps_grants"]);
          return { rows: [{ found: true }] };
        }
        assert.match(sql, /^SELECT (?:grant_json|tenant, chain_id, grant_json, sealed_session_key, updated_at) FROM perps_grants WHERE tenant = \$1$/,
          "status only reads the requested tenant; it must not write schema or grant state");
        assert.deepEqual(params, [tenant]);
        return { rows: record ? [{ tenant: record.tenant, chain_id: record.chainId, grant_json: record.grant,
          sealed_session_key: record.sealedSessionKey, updated_at: record.updatedAt }] : [] };
      },
    }));
    replace(active);
    assert.equal((await store.get(tenant))?.demoSessionPrivateKey, sessionKey);
    assert.equal(await store.storedGrantOwner(tenant), tenant);
    for (const sealedSessionKey of ["malformed-secret", sealSecret(sessionKey, Buffer.alloc(32, 8))]) {
      replace({ ...active, sealedSessionKey });
      if (backend === "file") assert.equal(await store.get(tenant), null);
      else await assert.rejects(store.get(tenant));
      await assert.rejects(store.storedGrantOwner(tenant), Error, "unsealing failure is not a replacement stop");
      assert.equal(record?.sealedSessionKey, sealedSessionKey);
      if (backend === "file") assert.equal(readFileSync(file, "utf8"), JSON.stringify(record));
    }
    replace(stopped);
    assert.equal(stopped.sealedSessionKey, "", "the real replacement operation erased the session key");
    assert.equal(await store.get(tenant), null);
    assert.equal(await store.storedGrantOwner(tenant), tenant, "a stopped record needs no decryption");
    for (const replacementStop of [null, {}, { ...stopped.grant.replacementStop, sessionKeyHash: "not-a-hash" },
      { ...stopped.grant.replacementStop, sessionKeyAddress: "not-an-address" },
      { ...stopped.grant.replacementStop, stoppedAt: -1 }]) {
      replace({ ...stopped, grant: { ...stopped.grant, replacementStop } } as StoredRecord);
      await assert.rejects(store.storedGrantOwner(tenant), Error, "a malformed marker cannot establish a deliberate stop");
    }
    replace({ ...stopped, grant: { ...stopped.grant, retiredSessionKeyHashes: ["not-a-hash"] } });
    await assert.rejects(store.storedGrantOwner(tenant), Error, "a malformed historical fence is not a verified stop");
    replace({ ...stopped, sealedSessionKey: active.sealedSessionKey });
    await assert.rejects(store.storedGrantOwner(tenant), Error, "a stop must have erased the secret");
    replace({ ...stopped, grant: { ...stopped.grant, serialized: active.grant.serialized } });
    await assert.rejects(store.storedGrantOwner(tenant), Error, "a stop must have erased the permission's key copy too");
    replace(null);
    assert.equal(await store.get(tenant), null);
    assert.equal(await store.storedGrantOwner(tenant), null, "absence remains distinct from unreadable");
  });
}
