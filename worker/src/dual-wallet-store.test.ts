/**
 * ONE LOGIN, TWO WALLETS, ON THE FILE BACKEND (self-hosted tests and the
 * single-service hosted deploy). The Perps wallet's grant lives beside the
 * Spot one and never touches it: creating, renewing and revoking Perps leaves
 * the Spot record byte for byte as it was, and the cross-wallet rules are
 * decided under the one writer lock both wallets share.
 *
 * MERRYMEN_HOME is set before the stores resolve their directories; node's
 * --test runs each file in its own process, so it never leaks.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { StoredGrant } from "../../packages/core/src/index";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-dual-wallet-"));
process.env.MERRYMEN_HOME = HOME;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 4).toString("base64");
const { FileGrantStore, GrantReplacementConflict, GrantWalletConflict, getGrantStore } = await import("./grant-store");
const { FileSettingsStore } = await import("./settings-store");
const { purposeHome } = await import("./home");
after(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const key = (byte: string) => `0x${byte.repeat(32)}` as `0x${string}`;
/** A Privy or external owner: the login's own wallet owns both of its wallets. */
const grant = (tenant: `0x${string}`, account: `0x${string}`, sessionKey: `0x${string}`, extra: Partial<StoredGrant> = {}): StoredGrant => ({
  owner: tenant, smartAccount: account, chainId: 4663, demoSessionPrivateKey: sessionKey,
  sessionKeyAddress: privateKeyToAccount(sessionKey).address, serialized: `permission-${account}-${sessionKey.slice(2, 6)}`,
  grantedAt: 1, expiresAt: 9_999_999_999, caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 4 },
  ...extra,
});
const spotFile = (tenant: string) => path.join(HOME, "tenants", `${tenant}.json`);
const perpsFile = (tenant: string) => path.join(HOME, "tenants-perps", `${tenant}.json`);

describe("a Spot-only fleet", () => {
  it("a kill's Perps lookup makes nothing: no directory, no lock file, no table", async () => {
    const perps = new FileGrantStore("perps");
    assert.equal(await perps.revokeForKill(addr(1)), "absent");
    assert.equal(await perps.revokeForKill(addr(1), 1_000), "absent");
    assert.deepEqual(readdirSync(HOME), [], "nothing at all was created in the home");
  });
  it("every Perps read answers empty without making anything either", async () => {
    const perps = new FileGrantStore("perps");
    assert.equal(await perps.get(addr(1)), null);
    assert.equal(await perps.hasStoredGrant(addr(1)), false);
    assert.deepEqual(await perps.listTenants(), []);
    assert.deepEqual(await perps.listTenantExpiries(), []);
    assert.equal(await perps.tenantForAccount(addr(2)), null);
    assert.deepEqual(readdirSync(HOME), []);
  });
});

describe("one login, two wallets", () => {
  const T = addr(0x11), SPOT = addr(0x22), PERPS = addr(0x33);
  const spot = new FileGrantStore("spot"), perps = new FileGrantStore("perps");

  it("creating, renewing and revoking the Perps wallet leaves the Spot record byte for byte", async () => {
    await spot.put(T, grant(T, SPOT, key("ab")));
    const before = readFileSync(spotFile(T), "utf8");
    await perps.put(T, grant(T, PERPS, key("cd"), { purpose: "perps" }));
    assert.equal((await perps.get(T))?.smartAccount, PERPS);
    assert.equal((await spot.get(T))?.smartAccount, SPOT);
    assert.equal(await spot.tenantForAccount(PERPS), T, "either store answers for either wallet's account");
    assert.equal(await perps.tenantForAccount(SPOT), T);
    assert.deepEqual((await perps.listTenantExpiries()).map((r) => [r.tenant, r.purpose]), [[T, "perps"]]);
    assert.deepEqual((await spot.listTenantExpiries()).map((r) => [r.tenant, r.purpose]), [[T, "spot"]]);
    assert.ok(!readFileSync(perpsFile(T), "utf8").includes(key("cd").slice(2)), "the Perps session key is sealed at rest");

    // RENEWAL: stop for replacement, then a fresh key. The stopped key never arms again.
    assert.equal(await perps.stopForReplacement(T, PERPS, privateKeyToAccount(key("cd")).address), "stopped");
    assert.equal(await perps.get(T), null, "a stopped Perps grant hands out no key");
    assert.ok((await perps.listTenants()).includes(T), "and keeps its place, as a Spot stop does");
    await assert.rejects(perps.put(T, grant(T, PERPS, key("cd"), { purpose: "perps" })), GrantReplacementConflict);
    await perps.put(T, grant(T, PERPS, key("ef"), { purpose: "perps" }));
    assert.equal((await perps.get(T))?.demoSessionPrivateKey, key("ef"));
    assert.equal(readFileSync(spotFile(T), "utf8"), before, "renewing Perps did not touch Spot");

    // REVOCATION, the kill's way: gone, and Spot still byte for byte.
    assert.equal(await perps.revokeForKill(T), "removed");
    assert.equal(await perps.get(T), null);
    assert.equal(await perps.revokeForKill(T), "absent", "a retry finds nothing left");
    assert.equal(readFileSync(spotFile(T), "utf8"), before);
  });

  it("a Spot renewal and a Spot kill leave the Perps record alone", async () => {
    await perps.put(T, grant(T, PERPS, key("12"), { purpose: "perps" }));
    const before = readFileSync(perpsFile(T), "utf8");
    assert.equal(await spot.stopForReplacement(T, SPOT, privateKeyToAccount(key("ab")).address), "stopped");
    await spot.put(T, grant(T, SPOT, key("34")));
    await spot.remove(T);
    assert.equal(readFileSync(perpsFile(T), "utf8"), before);
    await perps.remove(T);
  });

  it("a grant only lands in the wallet it names", async () => {
    const U = addr(0x44);
    await assert.rejects(perps.put(U, grant(U, addr(0x45), key("56"))), /for the spot wallet, not the perps wallet/);
    await assert.rejects(spot.put(U, grant(U, addr(0x45), key("56"), { purpose: "perps" })), /for the perps wallet, not the spot wallet/);
    await assert.rejects(spot.put(U, grant(U, addr(0x45), key("56"), { purpose: "other" as never })), /wallet purpose/);
    assert.equal(existsSync(spotFile(U)), false);
    assert.equal(existsSync(perpsFile(U)), false);
  });

  it("a moved record is never handed out as the other wallet's", async () => {
    const U = addr(0x46);
    await perps.put(U, grant(U, addr(0x47), key("57"), { purpose: "perps" }));
    const record = JSON.parse(readFileSync(perpsFile(U), "utf8")) as { grant: { purpose?: string } };
    delete record.grant.purpose;
    writeFileSync(perpsFile(U), JSON.stringify(record));
    assert.equal(await perps.get(U), null);
    assert.equal(await perps.hasStoredGrant(U), true, "but it is not read as absent");
    await perps.remove(U);
  });
});

describe("the cross-wallet rules, decided under the lock both wallets share", () => {
  const spot = new FileGrantStore("spot"), perps = new FileGrantStore("perps");

  it("refuses a second owner key, a shared account, and Perps beside a Spot grant with perpetuals", async () => {
    const T = addr(0x51);
    await spot.put(T, grant(T, addr(0x52), key("61")));
    await assert.rejects(perps.put(T, grant(T, addr(0x53), key("62"), { purpose: "perps", owner: addr(0x54) })), (e: unknown) =>
      e instanceof GrantWalletConflict && (e.code === "perps-owner" || e.code === "owner-differs"));
    await assert.rejects(perps.put(T, grant(T, addr(0x52), key("62"), { purpose: "perps" })), (e: unknown) =>
      e instanceof GrantWalletConflict && e.code === "account-shared");
    const V = addr(0x55);
    await spot.put(V, grant(V, addr(0x56), key("63"), { grantFeatures: ["tradeable-v2", "perp-lighter-v1"] }));
    await assert.rejects(perps.put(V, grant(V, addr(0x57), key("64"), { purpose: "perps" })), (e: unknown) =>
      e instanceof GrantWalletConflict && e.code === "legacy-perps");
    assert.equal(existsSync(perpsFile(T)), false);
    assert.equal(existsSync(perpsFile(V)), false);
  });

  it("a Spot grant cannot take another owner key, or the account, of an existing Perps wallet", async () => {
    const T = addr(0x58);
    await perps.put(T, grant(T, addr(0x59), key("65"), { purpose: "perps" }));
    await assert.rejects(spot.put(T, grant(T, addr(0x5a), key("66"), { owner: addr(0x5b) })), (e: unknown) =>
      e instanceof GrantWalletConflict && e.code === "owner-differs");
    await assert.rejects(spot.put(T, grant(T, addr(0x59), key("66"))), (e: unknown) =>
      e instanceof GrantWalletConflict && e.code === "account-shared");
    await assert.rejects(spot.put(T, grant(T, addr(0x5a), key("66"), { grantFeatures: ["perp-lighter-v1"] })), (e: unknown) =>
      e instanceof GrantWalletConflict && e.code === "legacy-perps");
    assert.equal(existsSync(spotFile(T)), false);
  });

  it("a Perps wallet is owned by the login's own wallet, never a browser key", async () => {
    const T = addr(0x5c);
    await assert.rejects(perps.put(T, grant(T, addr(0x5d), key("67"), { purpose: "perps", owner: addr(0x5e) })), (e: unknown) =>
      e instanceof GrantWalletConflict && e.code === "perps-owner");
  });

  it("refuses another login's claim on either wallet's account", async () => {
    const T = addr(0x60), U = addr(0x61);
    await perps.put(T, grant(T, addr(0x62), key("68"), { purpose: "perps" }));
    await assert.rejects(spot.put(U, grant(U, addr(0x62), key("69"))), (e: unknown) => e instanceof GrantWalletConflict && e.code === "account-claimed");
    await assert.rejects(perps.put(U, grant(U, addr(0x62), key("69"), { purpose: "perps" })), (e: unknown) => e instanceof GrantWalletConflict && e.code === "account-claimed");
    assert.equal(await spot.tenantForAccount(addr(0x62)), T);
  });

  it("two first setups racing with different owner keys: exactly one lands", async () => {
    const T = addr(0x70);
    const result = await Promise.allSettled([
      spot.put(T, grant(T, addr(0x71), key("71"), { owner: addr(0x7e) })),
      perps.put(T, grant(T, addr(0x72), key("72"), { purpose: "perps" })),
    ]);
    // The Spot one may be a browser-key owner; the Perps one is the login's
    // wallet. One owner per login, whichever wrote first.
    assert.equal(result.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(result));
    assert.notEqual(existsSync(spotFile(T)), existsSync(perpsFile(T)));
  });

  it("an unreadable record of the other wallet refuses, never reads as none", async () => {
    const T = addr(0x73);
    writeFileSync(spotFile(T), "{ not json");
    await assert.rejects(perps.put(T, grant(T, addr(0x74), key("73"), { purpose: "perps" })));
    assert.equal(existsSync(perpsFile(T)), false);
    rmSync(spotFile(T));
  });
});

describe("each wallet's settings, one login's holder claims", () => {
  it("keeps strategies and budgets apart, shares the holder wallet, and a Perps removal leaves Spot's", async () => {
    const T = addr(0x81);
    const s = new FileSettingsStore("spot"), p = new FileSettingsStore("perps");
    await s.put(T, { strategy: "trencher", slippageBps: 100 });
    await p.put(T, { strategy: "momentum", slippageBps: 30 });
    assert.equal((await s.get(T))?.strategy, "trencher");
    assert.equal((await p.get(T))?.slippageBps, 30);
    await p.remove(T);
    assert.equal(await p.get(T), null);
    assert.equal((await s.get(T))?.strategy, "trencher");
    const holder = addr(0x82);
    assert.deepEqual(await s.claimHolder(holder, T), { ok: true, fresh: true });
    assert.deepEqual(await p.claimHolder(holder, T), { ok: true, fresh: false }, "a holder wallet is the login's, not a wallet's");
  });
});

describe("the wallet has to be named", () => {
  it("getGrantStore keeps one store per wallet and refuses an unknown one", () => {
    assert.equal(getGrantStore("spot"), getGrantStore("spot"));
    assert.notEqual(getGrantStore("spot"), getGrantStore("perps"));
    assert.equal(getGrantStore("perps").wallet, "perps");
    assert.throws(() => getGrantStore("other" as never), /wallet purpose/);
    assert.throws(() => new FileSettingsStore("other" as never), /wallet purpose/);
  });
  it("a self-hosted Perps wallet has a complete home of its own, and Spot's paths do not move", () => {
    assert.equal(purposeHome("spot"), HOME);
    assert.equal(purposeHome("perps"), path.join(HOME, "accounts", "perps"));
    assert.throws(() => purposeHome("other" as never), /wallet purpose/);
  });
});
