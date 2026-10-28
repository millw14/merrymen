/**
 * THE KILL MATRIX, HOSTED TELEGRAM: a /kill confirmed in chat (or recorded by
 * the recovery replies) is carried out by the orchestrator's honourKill, and
 * it reaches every wallet a Spot-only, a Perps-only or a two-wallet owner
 * has. web/src/app/api/grants/kill-perps.test.ts holds the web rows and
 * worker/src/perps-kill.test.ts the self-hosted ones.
 *
 * Driven through the real order-ferry pass (honourPendingKills, which is
 * also what reconcile and shutdown call) over real file-backed stores, with
 * a real kill request in the tenant's home. Only the Solana stop and the
 * owner's ✅ are recorded instead of done, and the Perps stop is the real one
 * unless a test makes it fail.
 *
 * MERRYMEN_HOME is per process (node --test forks per file).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { StoredGrant } from "../../packages/core/src/index";

const FLEET = mkdtempSync(path.join(realpathSync(os.tmpdir()), "merrymen-perps-kill-hosted-"));
process.env.MERRYMEN_HOME = FLEET;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 5).toString("base64");

const { honourPendingKills, childHome, setKillConfirmForTest, setSolanaKillForTest, setPerpsKillForTest } = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { KILL_CLOCK_SLACK_SEC, KILL_CONFIRM_OWED, KILL_DONE_PERPS_TEXT, honourKillRequest, killRequested, writeKillRequest } = await import("./kill-request");
const { stopPerpsForKill } = await import("./perps-kill");
const { getSettingsStore } = await import("./settings-store");
after(() => rmSync(FLEET, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const T = "0x00000000000000000000000000000000000000a1" as const;
const SPOT = "0x00000000000000000000000000000000000000c3" as const;
const PERPS = "0x00000000000000000000000000000000000000c4" as const;
const nowSec = () => Math.floor(Date.now() / 1000);
const key = (byte: string) => `0x${byte.repeat(32)}` as `0x${string}`;
const grant = (account: `0x${string}`, sessionKey: `0x${string}`, extra: Partial<StoredGrant> = {}): StoredGrant => ({
  owner: T, smartAccount: account, chainId: 4663, demoSessionPrivateKey: sessionKey,
  sessionKeyAddress: privateKeyToAccount(sessionKey).address, serialized: `permission-${account}`,
  grantedAt: 1, expiresAt: 9_999_999_999, grantFeatures: ["tradeable-v2"],
  caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 4 },
  ...extra,
});
type Owner = "spot-only" | "perps-only" | "two-wallet";
const hasSpot = (o: Owner) => o !== "perps-only";
const hasPerps = (o: Owner) => o !== "spot-only";

/** Every ✅ the orchestrator would have sent, and whether it carried the Perps line. */
const confirmed: Array<{ tenant: string; perps: boolean }> = [];
setKillConfirmForTest(async (tenant, done) => { confirmed.push({ tenant, perps: done?.perps === true }); });
const solanaStops: string[] = [];
let solanaDown = false;
setSolanaKillForTest(async (tenant) => {
  solanaStops.push(tenant);
  if (solanaDown) throw new Error("solana bindings unavailable");
});
/** The real Perps stop, unless `perpsDown`. */
let perpsDown = false;
setPerpsKillForTest(async (tenant, coveredSec) => {
  if (perpsDown) throw new Error("perps grant store unavailable");
  return (await stopPerpsForKill(tenant, { coveredSec })) === "stopped";
});

const spotStore = getGrantStore("spot"), perpsStore = getGrantStore("perps");
async function owner(o: Owner) {
  if (hasSpot(o)) await spotStore.put(T, grant(SPOT, key("ab")));
  if (hasPerps(o)) await perpsStore.put(T, grant(PERPS, key("cd"), { purpose: "perps" }));
}
/** The child's (or the hold process's) side of a confirmed /kill: a request in the tenant's home. */
function telegramKill(killedAt = nowSec()) {
  mkdirSync(childHome(T), { recursive: true });
  writeKillRequest(childHome(T), { smartAccount: SPOT, serialized: "killed-permission" }, killedAt);
}

beforeEach(async () => {
  // A test that broke the Spot grant file on purpose leaves nothing behind for the next.
  rmSync(path.join(FLEET, "tenants", `${T}.json`), { recursive: true, force: true });
  await spotStore.remove(T);
  await perpsStore.remove(T);
  rmSync(path.join(FLEET, "tenants-perps"), { recursive: true, force: true });
  rmSync(path.join(FLEET, "tenant-settings-perps"), { recursive: true, force: true });
  rmSync(childHome(T), { recursive: true, force: true });
  confirmed.length = 0;
  solanaStops.length = 0;
  solanaDown = false;
  perpsDown = false;
});

describe("a hosted Telegram /kill, carried out by the orchestrator", () => {
  for (const o of ["spot-only", "perps-only", "two-wallet"] as const) {
    it(`${o}: every wallet it has is revoked, and the owner is told once, naming the Perps wallet only if it had one`, async () => {
      await owner(o);
      telegramKill();
      await honourPendingKills();
      assert.equal(await spotStore.hasStoredGrant(T), false);
      assert.equal(await perpsStore.hasStoredGrant(T), false);
      assert.deepEqual(solanaStops, [T]);
      assert.deepEqual(confirmed, [{ tenant: T, perps: hasPerps(o) }]);
      if (!hasPerps(o)) assert.equal(existsSync(path.join(FLEET, "tenants-perps")), false, "a Spot-only kill makes no Perps directory");
      if (!hasPerps(o)) assert.equal(existsSync(path.join(FLEET, "tenant-settings-perps")), false, "nor a Perps settings directory");
      // A later pass finds both gone: safe, and no second ✅.
      await honourPendingKills();
      assert.equal(confirmed.length, 1);
    });
  }

  for (const o of ["perps-only", "two-wallet"] as const) {
    it(`${o}: a Perps half that fails keeps the kill pending, never done; the next pass finishes it and owes one ✅`, async () => {
      await owner(o);
      telegramKill();
      perpsDown = true;
      await honourPendingKills();
      assert.equal(await perpsStore.hasStoredGrant(T), true, "not revoked yet");
      assert.equal(await spotStore.hasStoredGrant(T), false, "the Robinhood grant went regardless");
      assert.deepEqual(confirmed, [], "no ✅ while a half is not done");
      assert.equal(killRequested(childHome(T)), true, "the request stays pending, so nothing arms");
      perpsDown = false;
      await honourPendingKills();
      assert.equal(await perpsStore.hasStoredGrant(T), false);
      assert.deepEqual(confirmed, [{ tenant: T, perps: true }]);
    });
  }

  // ── SLICE 3: the paper stand-down ─────────────────────────────────────
  //
  // Hosted, a paper book lives in the tenant's Perps child (slice 4), so here
  // the kill's part is what the stores hold: the Perps grant revoked and the
  // Perps wallet's paper strategy turned off in its own settings, every other
  // setting as the owner left it.
  const perpsSettings = getSettingsStore("perps");
  const OWNER_PERPS = { perpsEnabled: true, perpsMarkets: ["BTC-PERP"], perpsMaxLeverage: 2, agentName: "Little John" };

  it("perps-only, practice perpetuals on: the kill revokes the grant and switches them off, nothing else touched", async () => {
    await owner("perps-only");
    await perpsSettings.put(T, OWNER_PERPS);
    telegramKill();
    await honourPendingKills();
    assert.equal(await perpsStore.hasStoredGrant(T), false);
    assert.deepEqual(await perpsSettings.get(T), { ...OWNER_PERPS, perpsEnabled: false });
    assert.deepEqual(confirmed, [{ tenant: T, perps: true }]);
  });

  it("a Perps grant signed after the kill keeps the settings that came with it", async () => {
    await owner("perps-only");
    await perpsSettings.put(T, OWNER_PERPS);
    telegramKill(nowSec() - 120);
    await honourPendingKills();
    assert.ok(await perpsStore.get(T), "the later grant is kept");
    assert.deepEqual(await perpsSettings.get(T), OWNER_PERPS, "and so is the owner's later decision to trade");
  });

  it("Perps settings it cannot read keep the kill pending, never done; the next pass finishes it and owes one ✅", async () => {
    await owner("perps-only");
    mkdirSync(path.join(FLEET, "tenant-settings-perps"), { recursive: true });
    writeFileSync(path.join(FLEET, "tenant-settings-perps", `${T}.json`), "{ torn");
    telegramKill();
    await honourPendingKills();
    assert.equal(await perpsStore.hasStoredGrant(T), false, "the grant went first");
    assert.deepEqual(confirmed, [], "no ✅ while the paper strategy may still be on");
    assert.equal(killRequested(childHome(T)), true, "the request stays pending");
    await perpsSettings.put(T, OWNER_PERPS);
    await honourPendingKills();
    assert.equal((await perpsSettings.get(T))?.perpsEnabled, false);
    assert.deepEqual(confirmed, [{ tenant: T, perps: true }], "told once, about the grant it revoked");
  });

  it("two-wallet: the Perps grant removed while Solana failed is remembered for the ✅ the next pass sends", async () => {
    await owner("two-wallet");
    telegramKill();
    solanaDown = true;
    await honourPendingKills();
    assert.equal(await perpsStore.hasStoredGrant(T), false, "the Perps half ran, though Solana's failed");
    assert.ok(existsSync(path.join(childHome(T), KILL_CONFIRM_OWED)));
    assert.deepEqual(confirmed, []);
    solanaDown = false;
    await honourPendingKills();
    assert.deepEqual(confirmed, [{ tenant: T, perps: true }], "told once, and told about the Perps wallet");
  });

  it("a Perps grant signed after the kill stays, as a Spot one does", async () => {
    await owner("perps-only");
    telegramKill(nowSec() - 120);
    await honourPendingKills();
    assert.ok(await perpsStore.get(T), "the owner's later Perps grant is kept");
    assert.deepEqual(confirmed, []);
  });

  it("a kill superseded by a Spot re-sign drops the ✅ it owed, so a later kill never claims its Perps revocation", async () => {
    // The Perps grant predates the kill; the Spot one was signed after it.
    await owner("two-wallet");
    const perpsFile = path.join(FLEET, "tenants-perps", `${T}.json`);
    const record = JSON.parse(readFileSync(perpsFile, "utf8")) as { updatedAt: number };
    record.updatedAt = nowSec() - 300;
    writeFileSync(perpsFile, JSON.stringify(record));
    telegramKill(nowSec() - 120);
    solanaDown = true;
    await honourPendingKills();
    assert.equal(await perpsStore.hasStoredGrant(T), false, "the Perps grant the kill covered is revoked");
    assert.ok(existsSync(path.join(childHome(T), KILL_CONFIRM_OWED)), "and a ✅ is owed while Solana's half fails");
    solanaDown = false;
    await honourPendingKills();
    assert.ok(await spotStore.get(T), "superseded: the Spot grant signed after the kill arms");
    assert.equal(existsSync(path.join(childHome(T), KILL_CONFIRM_OWED)), false, "and the superseded kill's owed ✅ is gone");
    assert.deepEqual(confirmed, []);
    // A later kill, of the Spot grant alone, says nothing about a Perps wallet.
    telegramKill(nowSec());
    await honourPendingKills();
    assert.deepEqual(confirmed, [{ tenant: T, perps: false }]);
  });

  it("a Spot grant file that cannot be read never keeps the Perps key stored: the Perps half runs anyway, the kill stays pending", async () => {
    await owner("two-wallet");
    // A Robinhood grant the store cannot read: its removal throws on every pass.
    const spotFile = path.join(FLEET, "tenants", `${T}.json`);
    rmSync(spotFile);
    mkdirSync(spotFile);
    telegramKill();
    await honourPendingKills();
    assert.equal(await perpsStore.hasStoredGrant(T), false, "the Perps grant is revoked although the Spot removal failed");
    assert.deepEqual(solanaStops, [T], "and the Solana half ran too");
    assert.equal(killRequested(childHome(T)), true, "the kill stays pending: it is not done");
    assert.deepEqual(confirmed, []);
    assert.equal(readFileSync(path.join(childHome(T), KILL_CONFIRM_OWED), "utf8"), "perps", "the ✅ it now owes remembers the Perps grant");
    // Repaired, the next pass finishes it and tells the owner once, Perps line included.
    rmSync(spotFile, { recursive: true });
    await honourPendingKills();
    assert.deepEqual(confirmed, [{ tenant: T, perps: true }]);
  });

  it("honourKillRequest runs every half whatever the Robinhood removal did, and names each failure", async () => {
    mkdirSync(childHome(T), { recursive: true });
    const killedAt = nowSec() - 30;
    writeKillRequest(childHome(T), { smartAccount: SPOT, serialized: "killed-permission" }, killedAt);
    const ran: string[] = [];
    const k = await honourKillRequest({ removeUnlessNewer: async () => { throw new Error("grant store unreadable"); } }, T, childHome(T), nowSec(), {
      solana: async () => { ran.push("solana"); throw new Error("solana bindings unavailable"); },
      perps: async (coveredSec) => { ran.push(`perps@${coveredSec - killedAt}`); return false; },
    });
    assert.deepEqual(ran, ["solana", `perps@${KILL_CLOCK_SLACK_SEC}`], "both halves ran, Perps with the kill's own cutoff");
    assert.equal(k.outcome, "failed");
    assert.equal(k.outcome === "failed" && k.error, "grant store unreadable, and the Solana strategy could not be stopped: solana bindings unavailable");
    assert.equal(existsSync(path.join(childHome(T), KILL_CONFIRM_OWED)), false, "nothing was removed, so no ✅ is owed");
  });

  it("the ✅'s Perps line claims only the grant, nothing about where the money is", () => {
    assert.match(KILL_DONE_PERPS_TEXT, /Perps wallet's stored trading grant is deleted too/);
    assert.doesNotMatch(KILL_DONE_PERPS_TEXT, /funds|money|closed|flat/i);
  });
});
