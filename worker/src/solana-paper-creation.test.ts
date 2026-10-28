import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { base58Encode } from "../../packages/core/src/ids";
import { SqlSolanaBindingStore } from "../../web/src/lib/solana-binding-store";
import { wrapSqlite, type Db } from "./db";
import { ensureSolanaTradingSchema, SolanaTradingStore } from "./solana-trading-store";

const tenant: `0x${string}` = `0x${"31".repeat(20)}`;
const owner = base58Encode(new Uint8Array(32).fill(31));
const now = 1_000_000;
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: now + 60_000 };
function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }

for (const change of ["mode", "limits", "expiry"] as const) {
  test(`paper creation rechecks ${change} after waiting for the settings lock`, async t => {
    const raw = new DatabaseSync(":memory:"); t.after(() => raw.close());
    const db = wrapSqlite(raw); let clock = now;
    const binding = new SqlSolanaBindingStore(async () => db, "sqlite", () => clock);
    await binding.bind(tenant, "did:privy:creation", owner);
    await binding.settings(tenant, owner, 0, "paper", limits);
    await ensureSolanaTradingSchema(db);
    const store = new SolanaTradingStore(db, { tenant, owner }, () => clock);
    const entered = gate(), release = gate();
    const update = db.tx(async (tx: Db) => {
      await tx.prepare("UPDATE solana_wallet_bindings SET revision=revision WHERE tenant=?").run(tenant);
      entered.open(); await release.promise;
      if (change === "mode") await tx.prepare("UPDATE solana_wallet_bindings SET requested_mode='live',revision=revision+1 WHERE tenant=?").run(tenant);
      if (change === "limits") await tx.prepare("UPDATE solana_wallet_bindings SET limits_json=?,revision=revision+1 WHERE tenant=?")
        .run(JSON.stringify({ ...limits, perTradeUsdg: "1000000" }), tenant);
      if (change === "expiry") clock = limits.expiresAtMs;
    });
    await entered.promise;
    const creation = store.createPaper("1000000000", limits);
    // Attach rejection handling before releasing the competing settings write.
    const refused = assert.rejects(creation, change === "mode" ? /selected Solana mode/ : change === "limits" ? /limits changed/ : /expiry|expired|expiration/i);
    release.open(); await update; await refused;
    assert.equal(await store.paper().get(owner), null);
  });
}

test("paper creation uses the current locked consent once and never refills", async t => {
  const raw = new DatabaseSync(":memory:"); t.after(() => raw.close());
  const db = wrapSqlite(raw), binding = new SqlSolanaBindingStore(async () => db, "sqlite", () => now);
  await binding.bind(tenant, "did:privy:creation", owner); await binding.settings(tenant, owner, 0, "paper", limits);
  await ensureSolanaTradingSchema(db);
  const store = new SolanaTradingStore(db, { tenant, owner }, () => now);
  const book = await store.createPaper("1000000000", limits);
  assert.equal(book.cashRaw, "1000000000"); assert.deepEqual(book.limits, limits);
  await assert.rejects(store.createPaper("2000000000", limits), /cannot be refilled/);
  assert.equal((await store.paper().get(owner))!.cashRaw, "1000000000");
});
