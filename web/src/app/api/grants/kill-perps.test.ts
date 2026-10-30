/**
 * THE KILL MATRIX, WEB: "Kill all agents" (DELETE /api/grants, delete-agent)
 * and Start over (POST /api/grants/discard, which owners are told is the kill
 * switch) against a Spot-only, a Perps-only and a two-wallet owner, hosted and
 * self-hosted. The phone apps send the kill's same request (PR #358's body),
 * so the hosted rows are theirs too. worker/src/perps-kill.test.ts and
 * perps-kill-hosted.integration.test.ts hold the rest of the matrix: the
 * hosted and self-hosted Telegram kills and `merrymen kill`.
 *
 * Every row: each wallet the owner has is stopped, the answer says what was
 * done, a half that fails is reported incomplete (never done) and a retry
 * finishes it, and a Spot-only owner's kill makes no Perps directory and gets
 * exactly the answer it always got.
 *
 * Driven through the real handler over real file-backed stores (the
 * single-service hosted deploy) and a real self-hosted home.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { StoredGrant } from "@merrymen/core";

const ORIGIN = "https://app.merrymen.dev";
const ENV = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_GRANT_FILE", "MERRYMEN_SESSION_SECRET", "MERRYMEN_STORE_DEK", "DATABASE_URL"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let home = "";
let route: typeof import("./route");
let discard: typeof import("./discard/route");
let auth: typeof import("@/lib/auth");
let stores: typeof import("../../../../../worker/src/grant-store");

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-grants-kill-perps-"));
  process.env.MERRYMEN_HOME = home;
  for (const k of ["MERRYMEN_HOSTED", "MERRYMEN_GRANT_FILE", "DATABASE_URL"] as const) delete process.env[k];
  process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
  process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
  route = await import("./route");
  discard = await import("./discard/route");
  auth = await import("@/lib/auth");
  // Through require: the route reaches the worker's stores by require, and a
  // stub on the ESM instance is one the route never calls.
  stores = createRequire(import.meta.url)("../../../../../worker/src/grant-store.ts") as typeof import("../../../../../worker/src/grant-store");
});
after(() => {
  mock.restoreAll();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const key = (byte: string) => `0x${byte.repeat(32)}` as `0x${string}`;
const grant = (tenant: `0x${string}`, account: `0x${string}`, sessionKey: `0x${string}`, extra: Partial<StoredGrant> = {}): StoredGrant => ({
  owner: tenant, smartAccount: account, chainId: 4663, demoSessionPrivateKey: sessionKey,
  sessionKeyAddress: privateKeyToAccount(sessionKey).address, serialized: `permission-${account}`,
  grantedAt: 1, expiresAt: 9_999_999_999, grantFeatures: ["tradeable-v2"],
  caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 4 },
  ...extra,
});
type Owner = "spot-only" | "perps-only" | "two-wallet";
const OWNERS: Owner[] = ["spot-only", "perps-only", "two-wallet"];
const hasSpot = (o: Owner) => o !== "perps-only";
const hasPerps = (o: Owner) => o !== "spot-only";
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });

describe("hosted: Kill all agents (and the phones' Stop) reaches every wallet", () => {
  const T = addr(0x11), SPOT = addr(0x22), PERPS = addr(0x33);
  /** Exactly what the web kill switch and both phone apps send. */
  const kill = () => route.DELETE(new Request(`${ORIGIN}/api/grants`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(T)}` },
    body: JSON.stringify({ purpose: "delete-agent", expectedTenant: T }),
  }));
  const set = async (owner: Owner) => {
    await stores.getGrantStore("spot").remove(T);
    await stores.getGrantStore("perps").remove(T);
    rmSync(path.join(home, "tenants-perps"), { recursive: true, force: true });
    if (hasSpot(owner)) await stores.getGrantStore("spot").put(T, grant(T, SPOT, key("ab")));
    if (hasPerps(owner)) await stores.getGrantStore("perps").put(T, grant(T, PERPS, key("cd"), { purpose: "perps" }));
  };
  beforeEach(() => { process.env.MERRYMEN_HOSTED = "1"; });

  for (const owner of OWNERS) {
    it(`${owner}: every wallet it has is stopped, and the answer says so`, async () => {
      await set(owner);
      const res = await json(await kill());
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body, hasPerps(owner) ? { ok: true, perps: "stopped" } : { ok: true }, "a Spot-only owner gets exactly the answer it always got");
      assert.equal(await stores.getGrantStore("spot").hasStoredGrant(T), false);
      assert.equal(await stores.getGrantStore("perps").hasStoredGrant(T), false);
      if (!hasPerps(owner)) assert.equal(existsSync(path.join(home, "tenants-perps")), false, "a Spot-only kill makes no Perps directory");
      // A retry is safe, and still done.
      assert.deepEqual((await json(await kill())), { status: 200, body: { ok: true } });
    });
  }

  for (const owner of ["perps-only", "two-wallet"] as const) {
    it(`${owner}: a Perps half that fails is "incomplete", never done; the Spot half still lands; a retry finishes it`, async () => {
      await set(owner);
      const down = mock.method(stores.getGrantStore("perps"), "revokeForKill", async () => { throw new Error("database unavailable"); });
      let res: Awaited<ReturnType<typeof json>>;
      try { res = await json(await kill()); } finally { down.mock.restore(); }
      assert.equal(res.status, 503);
      assert.match(String(res.body.error), /^Kill incomplete: .*your Perps wallet's grant could not be revoked yet\. Try the kill again\.$/);
      assert.equal(res.body.ownerFacing, true);
      assert.equal(res.body.perps, "not-stopped");
      assert.equal(res.body.ok, undefined);
      assert.equal(await stores.getGrantStore("spot").hasStoredGrant(T), false, "the Spot grant went regardless");
      assert.equal(await stores.getGrantStore("perps").hasStoredGrant(T), true);
      assert.deepEqual(await json(await kill()), { status: 200, body: { ok: true, perps: "stopped" } });
      assert.equal(await stores.getGrantStore("perps").hasStoredGrant(T), false);
    });
  }

  // ── SLICE 3: the paper stand-down, from the dashboard ─────────────────
  it("perps-only with practice perpetuals on: the kill revokes the grant and switches them off; the rest of its settings stay", async () => {
    const settings = createRequire(import.meta.url)("../../../../../worker/src/settings-store.ts") as typeof import("../../../../../worker/src/settings-store");
    await set("perps-only");
    const owner = { perpsEnabled: true, perpsMarkets: ["BTC-PERP"], perpsMaxLeverage: 2 };
    await settings.getSettingsStore("perps").put(T, owner);
    assert.deepEqual(await json(await kill()), { status: 200, body: { ok: true, perps: "stopped" } });
    const saved = await settings.getSettingsStore("perps").get(T);
    assert.ok(saved);
    const { perpsControlNonce, ...ownerFields } = saved;
    assert.equal(typeof perpsControlNonce, "string");
    assert.deepEqual(ownerFields, { ...owner, perpsEnabled: false });
    // Perps settings that cannot be read: the grant still goes, the kill says
    // what is left — never that a revoked grant may still sign.
    await set("perps-only");
    writeFileSync(path.join(home, "tenant-settings-perps", `${T.toLowerCase()}.json`), "{ torn");
    const res = await json(await kill());
    assert.equal(res.status, 503);
    assert.match(String(res.body.error), /^Kill incomplete: your Robinhood Chain agent is stopped, but your Perps wallet's practice perpetuals could not be switched off yet\./);
    assert.doesNotMatch(String(res.body.error), /grant could not be revoked/);
    assert.equal(res.body.perps, "not-stopped");
    assert.equal(await stores.getGrantStore("perps").hasStoredGrant(T), false, "the grant went regardless");
    rmSync(path.join(home, "tenant-settings-perps"), { recursive: true, force: true });
  });

  it("a kill whose Spot store fails still revokes the Perps grant, and is still an error", async () => {
    await set("two-wallet");
    const down = mock.method(stores.getGrantStore("spot"), "remove", async () => { throw new Error("database unavailable"); });
    try { await assert.rejects(kill(), /database unavailable/); } finally { down.mock.restore(); }
    assert.equal(await stores.getGrantStore("perps").hasStoredGrant(T), false, "the Perps half ran first-class, not after Spot");
  });

  it("another tenant's Perps wallet is never touched", async () => {
    const U = addr(0x44);
    await set("two-wallet");
    await stores.getGrantStore("perps").put(U, grant(U, addr(0x45), key("ef"), { purpose: "perps" }));
    assert.equal((await kill()).status, 200);
    assert.ok(await stores.getGrantStore("perps").get(U));
  });

  /** The web's Start over, which owners are told is the kill switch. */
  const startOver = () => discard.POST(new Request(`${ORIGIN}/api/grants/discard`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(T)}` },
    body: JSON.stringify({ expectedTenant: T }),
  }));
  for (const owner of OWNERS) {
    it(`Start over, ${owner}: every wallet's grant is revoked too, and a Spot-only owner's answer is unchanged`, async () => {
      await set(owner);
      const res = await json(await startOver());
      assert.equal(res.status, 200, JSON.stringify(res.body));
      // No Postgres here, so the practice reset is not queued: said, and not thrown.
      assert.deepEqual(res.body, hasPerps(owner) ? { ok: true, paperReset: hasSpot(owner) ? "failed" : "no-agent", perps: "stopped" }
        : { ok: true, paperReset: "failed" });
      assert.equal(await stores.getGrantStore("spot").hasStoredGrant(T), false);
      assert.equal(await stores.getGrantStore("perps").hasStoredGrant(T), false);
      if (!hasPerps(owner)) assert.equal(existsSync(path.join(home, "tenants-perps")), false);
    });
  }

  it("Start over whose Perps half fails is incomplete, never done; the Spot grant still goes; a retry finishes it", async () => {
    await set("two-wallet");
    const down = mock.method(stores.getGrantStore("perps"), "revokeForKill", async () => { throw new Error("database unavailable"); });
    let res: Awaited<ReturnType<typeof json>>;
    try { res = await json(await startOver()); } finally { down.mock.restore(); }
    assert.equal(res.status, 503);
    assert.match(String(res.body.error), /^Start over incomplete: .*your Perps wallet's grant could not be revoked yet\. Try again\.$/);
    assert.equal(res.body.perps, "not-stopped");
    assert.equal(await stores.getGrantStore("spot").hasStoredGrant(T), false);
    assert.equal((await json(await startOver())).body.perps, "stopped");
    assert.equal(await stores.getGrantStore("perps").hasStoredGrant(T), false);
  });
});

describe("self-hosted: Kill all agents reaches the local Perps wallet", () => {
  const SPOT = addr(0x52), PERPS = addr(0x53);
  const spotFile = () => path.join(home, "grant.json");
  const perpsHome = () => path.join(home, "accounts", "perps");
  const perpsFile = () => path.join(perpsHome(), "grant.json");
  const local = (account: `0x${string}`, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ smartAccount: account, serialized: "0xserialized", chainId: 4663, demoOwnerPrivateKey: key("77"), ...extra });
  const kill = () => route.DELETE(new Request(`${ORIGIN}/api/grants`, { method: "DELETE" }));
  const set = (owner: Owner) => {
    for (const p of [spotFile(), path.join(home, "grants"), path.join(home, "accounts"), path.join(home, "paused")]) rmSync(p, { recursive: true, force: true });
    if (hasSpot(owner)) writeFileSync(spotFile(), local(SPOT));
    if (hasPerps(owner)) {
      mkdirSync(perpsHome(), { recursive: true });
      writeFileSync(perpsFile(), local(PERPS, { purpose: "perps" }));
    }
  };
  beforeEach(() => { delete process.env.MERRYMEN_HOSTED; });

  for (const owner of OWNERS) {
    it(`${owner}: every local wallet's grant is archived, then removed`, async () => {
      set(owner);
      const res = await json(await kill());
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body, hasPerps(owner) ? { ok: true, perps: "stopped" } : { ok: true });
      assert.equal(existsSync(spotFile()), false);
      assert.equal(existsSync(perpsFile()), false);
      if (hasSpot(owner)) assert.equal(readFileSync(path.join(home, "grants", `${SPOT}.json`), "utf8"), local(SPOT), "Spot's owner key is kept");
      if (hasPerps(owner)) assert.equal(readFileSync(path.join(perpsHome(), "grants", `${PERPS}.json`), "utf8"), local(PERPS, { purpose: "perps" }), "and the Perps wallet's, in its own home");
      else {
        const off = JSON.parse(readFileSync(path.join(perpsHome(), "settings.json"), "utf8"));
        assert.equal(off.perpsEnabled, false, "a Spot-only kill invalidates delayed Perps enables too");
        assert.equal(typeof off.perpsControlNonce, "string");
      }
    });
  }

  it("a Spot permission replacement removes only the Spot grant: the Perps wallet is not a renewal's to touch", async () => {
    set("two-wallet");
    const res = await json(await route.DELETE(new Request(`${ORIGIN}/api/grants`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ purpose: "permission-replacement", expectedAccount: SPOT }),
    })));
    assert.deepEqual(res, { status: 200, body: { ok: true } });
    assert.equal(existsSync(spotFile()), false, "a self-hosted renewal still removes grant.json, as it always did");
    assert.equal(readFileSync(perpsFile(), "utf8"), local(PERPS, { purpose: "perps" }), "and leaves the Perps grant exactly as it was");
    // Anything else, an unreadable body included, is the kill it always was.
    set("two-wallet");
    const killed = await json(await route.DELETE(new Request(`${ORIGIN}/api/grants`, { method: "DELETE", body: "{ not json" })));
    assert.deepEqual(killed, { status: 200, body: { ok: true, perps: "stopped" } });
    assert.equal(existsSync(perpsFile()), false);
  });

  const startOver = () => discard.POST(new Request(`${ORIGIN}/api/grants/discard`, { method: "POST" }));
  for (const owner of OWNERS) {
    it(`Start over, ${owner}: every local wallet's grant is archived, then removed`, async () => {
      set(owner);
      const res = await json(await startOver());
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.perps, hasPerps(owner) ? "stopped" : undefined);
      assert.equal(existsSync(spotFile()), false);
      assert.equal(existsSync(perpsFile()), false);
      if (hasPerps(owner)) assert.ok(existsSync(path.join(perpsHome(), "grants", `${PERPS}.json`)));
      else {
        const off = JSON.parse(readFileSync(path.join(perpsHome(), "settings.json"), "utf8"));
        assert.equal(off.perpsEnabled, false);
        assert.equal(typeof off.perpsControlNonce, "string");
      }
    });
  }

  it("a Perps owner key that cannot be archived keeps that grant, pauses its home, and the kill is incomplete", async () => {
    set("two-wallet");
    writeFileSync(path.join(perpsHome(), "grants"), "not a directory");
    const res = await json(await kill());
    assert.equal(res.status, 503);
    assert.match(String(res.body.error), /Kill incomplete: .*your Perps wallet's grant could not be revoked yet\. Your Perps wallet's grant was NOT revoked: the archive could not be written/);
    assert.equal(res.body.perps, "not-stopped");
    assert.equal(existsSync(perpsFile()), true, "the Perps owner key is not lost");
    assert.equal(readFileSync(path.join(perpsHome(), "paused"), "utf8"), "paused by a kill that could not archive the owner key, so it kept the grant");
    assert.equal(existsSync(spotFile()), false, "the Spot grant still went");
    // Fixed, the retry finishes it, and lifts the pause the refused kill left.
    rmSync(path.join(perpsHome(), "grants"));
    assert.deepEqual(await json(await kill()), { status: 200, body: { ok: true, perps: "stopped" } });
    assert.equal(existsSync(path.join(perpsHome(), "paused")), false);
  });

  it("a Spot grant the kill has to keep (409) still says the Perps wallet was stopped", async () => {
    set("two-wallet");
    writeFileSync(spotFile(), JSON.stringify({ smartAccount: "not-an-address", serialized: "0xs", chainId: 4663 }));
    const res = await json(await kill());
    assert.equal(res.status, 409);
    assert.match(String(res.body.error), /The grant was NOT deleted[\s\S]*Your Perps wallet's grant was revoked\.$/);
    assert.equal(res.body.perps, "stopped");
    assert.equal(existsSync(perpsFile()), false);
    assert.ok(readdirSync(path.join(perpsHome(), "grants")).includes(`${PERPS}.json`));
  });
});
