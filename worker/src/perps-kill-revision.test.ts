/** Completed kills invalidate stale entry-enable pages, even after an incomplete first attempt. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileSettingsStore, useSettingsStoreForTest, resetSettingsStoreForTest } from "./settings-store";
import { stopLocalPerpsWallet, stopPerpsForKill } from "./perps-kill";
const OWNER = "0x1111111111111111111111111111111111111111" as const;
function fixture(t: import("node:test").TestContext) {
    const keys = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "DATABASE_URL", "MERRYMEN_STORE_DEK"] as const;
    const before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    const home = mkdtempSync(join(tmpdir(), "perps-kill-revision-"));
    process.env.MERRYMEN_HOME = home;
    delete process.env.MERRYMEN_HOSTED;
    delete process.env.DATABASE_URL;
    process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 13).toString("base64");
    t.after(() => { resetSettingsStoreForTest(); for (const k of keys) {
        if (before[k] === undefined)
            delete process.env[k];
        else
            process.env[k] = before[k];
    } rmSync(home, { recursive: true, force: true }); });
    return home;
}
const nonce = (value: unknown) => { assert.ok(value && typeof value === "object"); const v = value as {
    perpsEnabled?: boolean;
    perpsControlNonce?: string;
}; assert.equal(v.perpsEnabled, false); assert.match(v.perpsControlNonce!, /^[a-f0-9-]{36}$/); return v.perpsControlNonce; };
test("self-hosted absent wallet kill advances a revision; a second kill advances it again", async (t) => {
    const home = fixture(t), file = join(home, "accounts", "perps", "settings.json");
    assert.deepEqual(await stopLocalPerpsWallet(), { grant: "none", paper: "none" });
    const first = nonce(JSON.parse(readFileSync(file, "utf8")));
    await stopLocalPerpsWallet();
    assert.notEqual(nonce(JSON.parse(readFileSync(file, "utf8"))), first);
});
test("self-hosted retry after grant removal and failed settings creation cannot succeed with null revision", async (t) => {
    const home = fixture(t), dir = join(home, "accounts", "perps"), file = join(dir, "settings.json");
    mkdirSync(dir, { recursive: true });
    mkdirSync(file);
    writeFileSync(join(dir, "grant.json"), JSON.stringify({ smartAccount: OWNER, owner: OWNER, purpose: "perps", serialized: "test", demoOwnerPrivateKey: `0x${"33".repeat(32)}` }));
    await assert.rejects(stopLocalPerpsWallet(), /practice perpetuals could NOT be switched off/);
    rmSync(file, { recursive: true });
    assert.deepEqual(await stopLocalPerpsWallet(), { grant: "none", paper: "none" });
    nonce(JSON.parse(readFileSync(file, "utf8")));
});
test("hosted absent wallet kill creates a sealed disabled revision", async (t) => {
    fixture(t);
    const store = new FileSettingsStore("perps");
    useSettingsStoreForTest(store, "perps");
    assert.equal(await stopPerpsForKill(OWNER, { store: { revokeForKill: async () => "absent" } }), "none");
    nonce(await store.get(OWNER));
});
test("hosted incomplete kill retry records the off generation after the grant is already gone", async (t) => {
    fixture(t);
    const store = new FileSettingsStore("perps");
    useSettingsStoreForTest(store, "perps");
    let removed = false;
    const grant = { revokeForKill: async () => { const result = removed ? "absent" : "removed"; removed = true; return result as "absent" | "removed"; } };
    const real = store.disablePerpsForKill.bind(store);
    store.disablePerpsForKill = async () => { throw Error("settings unavailable"); };
    await assert.rejects(stopPerpsForKill(OWNER, { store: grant }), /practice perpetuals could NOT be switched off/);
    assert.equal(removed, true);
    store.disablePerpsForKill = real;
    assert.equal(await stopPerpsForKill(OWNER, { store: grant }), "none");
    nonce(await store.get(OWNER));
});
