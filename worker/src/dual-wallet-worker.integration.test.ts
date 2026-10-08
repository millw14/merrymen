import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StoredGrant } from "../../packages/core/src/index";
import { workerExecutionKey, workerOwner, workerPurpose, grantMatchesWorkerExecution, perpsWorkerSettings } from "./worker-execution";
import { leaseKey } from "./tenant-lease";
import { mergeSettings, readSettingsFile, resolveConfig } from "./settings";
import { homePaths } from "./home";
import { sealPerpKey } from "./perps/key-seal";

const fleet = mkdtempSync(path.join(os.tmpdir(), "merrymen-dual-worker-"));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
delete process.env.DATABASE_URL;
const { getGrantStore } = await import("./grant-store");
const { getSettingsStore } = await import("./settings-store");
const { childHome, childEnv, adoptChildForTest, reconcile, honourPendingKills } = await import("./orchestrator");
const { writeKillRequest } = await import("./kill-request");
const { loadArmableGrant } = await import("./grant");
after(() => rmSync(fleet, { recursive: true, force: true }));

const OWNER = "0x00000000000000000000000000000000000000a1" as const;
const SPOT = "0x00000000000000000000000000000000000000b1" as const;
const PERPS = "0x00000000000000000000000000000000000000c1" as const;
const spotKey = workerExecutionKey(OWNER);
const perpsKey = workerExecutionKey(OWNER, "perps");
const VENUE_PUBLIC = `0x${("01" + "00".repeat(7)).repeat(5)}` as `0x${string}`;
const VENUE_PRIVATE = `0x${"ab".repeat(40)}` as `0x${string}`;
function grant(purpose: "spot" | "perps"): StoredGrant {
  const now = Math.floor(Date.now() / 1000);
  return { purpose, smartAccount: purpose === "spot" ? SPOT : PERPS, owner: OWNER,
    serialized: `test-signed-${purpose}`, chainId: 4663, grantedAt: now, expiresAt: now + 86_400,
    caps: { perTradeUsdg: 10, dailyUsdg: 20, maxOpsPerDay: 10, maxDrawdownPct: 5, expiryDays: 1 },
    grantFeatures: purpose === "perps" ? ["perp-lighter-v1"] : [], grantTokens: [], sessionKeyAddress: OWNER,
    ...(purpose === "perps" ? { perp: { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: VENUE_PUBLIC,
      apiKeySealed: sealPerpKey(VENUE_PRIVATE, { tenant: OWNER, smartAccount: PERPS, apiPublicKey: VENUE_PUBLIC, apiKeyIndex: 16 }, Buffer.alloc(32, 7)) } } : {}),
    demoSessionPrivateKey: `0x${(purpose === "spot" ? "a3" : "b4").repeat(32)}`,
  } as StoredGrant;
}
function fakeProcess() {
  const signals: unknown[] = [];
  return { signals, kill(signal?: NodeJS.Signals | number) { signals.push(signal); return true; } };
}

test("one login has two execution slots, but authenticated and cryptographic owner stays unchanged", () => {
  assert.equal(spotKey, OWNER);
  assert.equal(perpsKey, `${OWNER}:perps`);
  assert.equal(workerOwner(perpsKey), OWNER);
  assert.equal(workerPurpose(perpsKey), "perps");
  assert.notEqual(childHome(spotKey), childHome(perpsKey));
  assert.notEqual(leaseKey(spotKey), leaseKey(perpsKey));
  assert.equal(grantMatchesWorkerExecution(perpsKey, grant("spot")), false);
  assert.equal(grantMatchesWorkerExecution(spotKey, grant("perps")), false);
  assert.equal(grantMatchesWorkerExecution(perpsKey, grant("perps")), true);
  assert.equal(grantMatchesWorkerExecution(spotKey, {}), true, "legacy grants remain Spot");
  assert.equal(grantMatchesWorkerExecution(spotKey, { purpose: "unknown" }), false);
  assert.throws(() => workerExecutionKey("../../another-owner", "perps"));
});

test("a Perps child cannot inherit Spot file overrides or change to a Spot producer", () => {
  const previous = { grant: process.env.MERRYMEN_GRANT_FILE, settings: process.env.MERRYMEN_SETTINGS_FILE, owner: process.env.MERRYMEN_RECOVER_OWNER_KEY };
  process.env.MERRYMEN_GRANT_FILE = "/spot/grant.json";
  process.env.MERRYMEN_SETTINGS_FILE = "/spot/settings.json";
  process.env.MERRYMEN_RECOVER_OWNER_KEY = "must-not-reach-worker";
  try {
    const env = childEnv(perpsKey);
    assert.equal(env.MERRYMEN_GRANT_FILE, path.join(childHome(perpsKey), "grant.json"));
    assert.equal(env.MERRYMEN_SETTINGS_FILE, path.join(childHome(perpsKey), "settings.json"));
    assert.equal(env.MERRYMEN_WALLET_PURPOSE, "perps");
    assert.equal(env.MERRYMEN_RECOVER_OWNER_KEY, undefined);
    assert.equal(env.MERRYMEN_STORE_DEK, undefined);
    assert.equal(env.MERRYMEN_TG_GROUPS, "0");
    assert.equal(mergeSettings({ strategy: "trencher" }, env).strategy, "perps-only");
    assert.equal(mergeSettings({}, env).strategy, "perps-only", "missing settings cannot restore the Spot default");
    const settings = perpsWorkerSettings({ strategy: "llm-strategist", telegramBotToken: "spot-bot", holderAddress: OWNER, perpsMaxCollateralUsdg: 31, liveTradingEnabled: false });
    assert.equal(settings.telegramBotToken, undefined);
    assert.equal(settings.holderAddress, undefined);
    assert.equal(settings.perpsMaxCollateralUsdg, 31);
    assert.equal(settings.liveTradingEnabled, false, "separation grants no live consent");
  } finally {
    for (const [name, value] of [["MERRYMEN_GRANT_FILE", previous.grant], ["MERRYMEN_SETTINGS_FILE", previous.settings], ["MERRYMEN_RECOVER_OWNER_KEY", previous.owner]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  }
});

test("the real reconcile hands each worker only its scoped session and settings; killing Perps preserves Spot", async () => {
  const spot = getGrantStore(), perps = getGrantStore("perps");
  const spotGrant = grant("spot"), perpsGrant = grant("perps");
  await spot.put(OWNER, spotGrant);
  await perps.put(OWNER, perpsGrant);
  await getSettingsStore().put(OWNER, { strategy: "trencher", perpsMaxCollateralUsdg: 97 });
  await getSettingsStore("perps").put(OWNER, { strategy: "trencher", perpsMaxCollateralUsdg: 13 });
  const spotProc = fakeProcess(), perpsProc = fakeProcess();
  for (const key of [spotKey, perpsKey]) mkdirSync(childHome(key), { recursive: true });
  adoptChildForTest(spotKey, SPOT, spotProc);
  adoptChildForTest(perpsKey, PERPS, perpsProc);
  try {
    await reconcile();
    const spotCopy = JSON.parse(readFileSync(path.join(childHome(spotKey), "grant.json"), "utf8"));
    const perpsCopy = JSON.parse(readFileSync(path.join(childHome(perpsKey), "grant.json"), "utf8"));
    assert.equal(spotCopy.smartAccount, SPOT);
    assert.equal(perpsCopy.smartAccount, PERPS);
    assert.equal(perpsCopy.demoSessionPrivateKey, perpsGrant.demoSessionPrivateKey);
    assert.notEqual(perpsCopy.demoSessionPrivateKey, spotGrant.demoSessionPrivateKey);
    assert.equal(JSON.parse(readFileSync(path.join(childHome(perpsKey), "perp-key.json"), "utf8")).privateKey, VENUE_PRIVATE);
    assert.equal(existsSync(path.join(childHome(spotKey), "perp-key.json")), false, "Perps venue credentials never reach the Spot worker");
    const settings = JSON.parse(readFileSync(path.join(childHome(perpsKey), "settings.json"), "utf8"));
    assert.equal(settings.strategy, "perps-only");
    assert.equal(settings.perpsMaxCollateralUsdg, 13);
    writeKillRequest(childHome(perpsKey), perpsGrant, Math.floor(Date.now() / 1000));
    await honourPendingKills();
    assert.equal(await perps.get(OWNER), null);
    assert.equal((await spot.get(OWNER))?.smartAccount, SPOT);
    await reconcile();
    assert.equal(spotProc.signals.length, 0);
    assert.ok(perpsProc.signals.length > 0);
    assert.equal(JSON.parse(readFileSync(path.join(childHome(spotKey), "grant.json"), "utf8")).smartAccount, SPOT);
  } finally {
    await spot.remove(OWNER);
    await perps.remove(OWNER);
    await reconcile();
  }
});

test("the child refuses to arm another purpose even if its grant file is misdirected", () => {
  const file = path.join(fleet, "purpose-arm.json");
  process.env.MERRYMEN_GRANT_FILE = file;
  process.env.MERRYMEN_WALLET_PURPOSE = "perps";
  try {
    writeFileSync(file, JSON.stringify(grant("spot")));
    assert.equal(loadArmableGrant(), null);
    writeFileSync(file, JSON.stringify(grant("perps")));
    assert.equal(loadArmableGrant()?.smartAccount, PERPS);
  } finally {
    delete process.env.MERRYMEN_GRANT_FILE;
    delete process.env.MERRYMEN_WALLET_PURPOSE;
  }
});

test("self-hosted Perps config is read from its own home without changing the main process scope", () => {
  const spot = path.join(fleet, "main-settings-override.json");
  const perps = homePaths.settings("perps");
  mkdirSync(path.dirname(perps), { recursive: true });
  writeFileSync(spot, JSON.stringify({ strategy: "trencher", perpsMaxCollateralUsdg: 91 }));
  writeFileSync(perps, JSON.stringify({ strategy: "llm-strategist", perpsMaxCollateralUsdg: 17 }));
  process.env.MERRYMEN_SETTINGS_FILE = spot;
  try {
    assert.equal(readSettingsFile().perpsMaxCollateralUsdg, 91);
    assert.equal(readSettingsFile("perps").perpsMaxCollateralUsdg, 17);
    assert.equal(resolveConfig("perps").strategy, "perps-only");
    assert.equal(resolveConfig("perps").perpsMaxCollateralUsdg, 17);
    assert.equal(resolveConfig().strategy, "trencher");
    assert.equal(process.env.MERRYMEN_WALLET_PURPOSE, undefined);
  } finally { delete process.env.MERRYMEN_SETTINGS_FILE; }
});
