/**
 * ?wallet=spot|perps ON /api/grants (perps slice 2; rows rewritten in 5b).
 *
 * The selector names which of a login's two wallets a request is about;
 * absent is Spot, so every existing client keeps its account. Here:
 *  - while MERRYMEN_PERPS is not paper, POST makes and renews no Perps wallet
 *    (?wallet=perps with a Perps grant is refused 403 before anything is read
 *    or stored), and a grant naming the other wallet than the request is
 *    refused whatever it says (dual-purpose*.test.ts make one at paper);
 *  - GET ?wallet=perps answers for the Perps wallet, whatever MERRYMEN_PERPS
 *    says, and never with the Spot wallet's status;
 *  - a permission replacement stops exactly the wallet it names, so a Perps
 *    renewal's first step never touches the Spot grant, and the other way round
 *    (run at paper: with perps off a Perps renewal is refused whole, its stop
 *    included, which dual-purpose*.test.ts hold);
 *  - a kill names no wallet (it stops all of them), so a kill that names one
 *    is refused as ambiguous, with nothing deleted; a renewal may name its
 *    wallet, self-hosted as hosted.
 *
 * Hosted runs through the real route over real file-backed stores (the
 * single-service hosted deploy), with a real signed-in session.
 */
import assert from "node:assert/strict";
import { pilotFixture } from "@/lib/perps-pilot-fixture";
let pilot: ReturnType<typeof pilotFixture>;
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { StoredGrant } from "@merrymen/core";

const ORIGIN = "https://app.merrymen.dev";
const ENV = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_GRANT_FILE", "MERRYMEN_SESSION_SECRET", "MERRYMEN_STORE_DEK", "DATABASE_URL", "MERRYMEN_PERPS", "MERRYMEN_PERPS_PAPER_TENANTS"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let home = "";
let route: typeof import("./route");
let auth: typeof import("@/lib/auth");
let stores: typeof import("@merrymen/grant-store");

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-grants-wallet-"));
  process.env.MERRYMEN_HOME = home;
  // MERRYMEN_PERPS unset is off (perps-ceiling.ts): no Perps wallet is made here.
  for (const k of ["MERRYMEN_HOSTED", "MERRYMEN_GRANT_FILE", "DATABASE_URL", "MERRYMEN_PERPS"] as const) delete process.env[k];
  process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
  process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
  route = await import("./route");
  auth = await import("@/lib/auth");
  stores = await import("@merrymen/grant-store");
});
after(() => {
  pilot?.close();
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
const post = (query: string, body: unknown) =>
  route.POST(new Request(`${ORIGIN}/api/grants${query}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
/**
 * A Perps renewal's stop runs only where a Perps wallet can be renewed:
 * MERRYMEN_PERPS=paper, for this test alone (the file runs with it unset).
 */
const atPaper = (t: { after: (fn: () => void) => void }) => {
  process.env.MERRYMEN_PERPS = "paper";
  t.after(() => { delete process.env.MERRYMEN_PERPS; });
};

describe("self-hosted: no Perps wallet is made while perps is off, and the kill names none", () => {
  const grantFile = () => path.join(home, "grant.json");
  const kept = "{\"smartAccount\":\"0x00000000000000000000000000000000000000b2\"}\n";
  beforeEach(() => {
    delete process.env.MERRYMEN_HOSTED;
    writeFileSync(grantFile(), kept);
  });
  const spotGrant = { smartAccount: addr(0xa1), serialized: "0xserialized", chainId: 4663, grantFeatures: ["tradeable-v2"] };

  for (const [what, query, body, status, code] of [
    ["?wallet=perps", "?wallet=perps", spotGrant, 400, "wallet-mismatch"],
    ["?wallet=perps with a Perps grant, perps off", "?wallet=perps", { ...spotGrant, purpose: "perps" }, 403, "perps-wallet-not-offered"],
    ["a Perps grant with no selector", "", { ...spotGrant, purpose: "perps" }, 400, "wallet-mismatch"],
    // The code every wallet-aware route answers a wallet it cannot read with (route-guard.ts walletUnknown).
    ["a wallet nobody knows", "?wallet=solana", spotGrant, 400, "wallet-unknown"],
    ["two wallets at once", "?wallet=spot&wallet=perps", spotGrant, 400, "wallet-unknown"],
    ["a grant naming a wallet nobody knows", "", { ...spotGrant, purpose: "other" }, 400, undefined],
  ] as const) {
    it(`POST ${what}: ${status}, grant.json untouched`, async () => {
      const res = await json(await post(query, body));
      assert.equal(res.status, status, JSON.stringify(res.body));
      if (code) assert.equal(res.body.code, code);
      assert.equal(readFileSync(grantFile(), "utf8"), kept);
    });
  }

  it("POST ?wallet=spot is exactly a POST with no selector", async () => {
    const res = await json(await post("?wallet=spot", spotGrant));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((JSON.parse(readFileSync(grantFile(), "utf8")) as StoredGrant).smartAccount, addr(0xa1));
  });

  it("GET ?wallet=perps answers for the Perps wallet — none here — never with the Spot wallet's status", async () => {
    // grant.json (Spot's) is there; the Perps home is empty, so the answer is
    // that there is no Perps wallet, perps off or not.
    const perps = await json(await route.GET(new Request(`${ORIGIN}/api/grants?wallet=perps`)));
    assert.deepEqual(perps, { status: 200, body: { exists: false } });
    assert.equal((await route.GET(new Request(`${ORIGIN}/api/grants?wallet=nope`))).status, 400);
  });

  it("a kill that names a wallet is refused, and grant.json is kept", async () => {
    for (const query of ["?wallet=spot", "?wallet=perps", "?wallet=nope"]) {
      const res = await route.DELETE(new Request(`${ORIGIN}/api/grants${query}`, { method: "DELETE" }));
      assert.equal(res.status, 400, query);
      assert.match(String((await res.json() as { error: string }).error), /Nothing was deleted/);
      assert.equal(readFileSync(grantFile(), "utf8"), kept);
    }
  });

  // A renewal may name its wallet, as it may hosted, and stops only that one.
  const perpsGrantFile = () => path.join(home, "accounts", "perps", "grant.json");
  const perpsKept = `{"smartAccount":"${addr(0xc3)}","purpose":"perps","owner":"${addr(0xa1)}","sessionKeyAddress":"${addr(0xb2)}","chainId":4663}\n`;
  const renew = (query: string) => route.DELETE(new Request(`${ORIGIN}/api/grants${query}`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "permission-replacement", expectedAccount: addr(0xc3), expectedSession: addr(0xb2) }),
  }));
  const withPerpsGrant = () => {
    rmSync(path.join(home, "accounts"), { recursive: true, force: true });
    mkdirSync(path.dirname(perpsGrantFile()), { recursive: true });
    writeFileSync(perpsGrantFile(), perpsKept);
  };

  it("a renewal that names the Spot wallet stops Spot's grant only", async () => {
    withPerpsGrant();
    const res = await json(await renew("?wallet=spot"));
    assert.deepEqual(res, { status: 200, body: { ok: true } });
    assert.equal(existsSync(grantFile()), false, "Spot's grant.json is archived and removed, as a self-hosted renewal always did");
    assert.equal(readFileSync(perpsGrantFile(), "utf8"), perpsKept, "and the Perps grant is left exactly as it was");
  });

  it("a renewal that names the Perps wallet stops the Perps grant only, and none there is absent", async (t) => {
    atPaper(t);
    withPerpsGrant();
    assert.deepEqual(await json(await renew("?wallet=perps")), { status: 200, body: { ok: true, replacement: true, state: "stopped" } });
    assert.equal(existsSync(perpsGrantFile()), false);
    assert.equal(readFileSync(path.join(home, "accounts", "perps", "grants", `${addr(0xc3)}.json`), "utf8"), perpsKept, "its owner key is kept in its own home");
    assert.equal(readFileSync(grantFile(), "utf8"), kept, "the Spot grant is untouched");
    assert.deepEqual(await json(await renew("?wallet=perps")), { status: 200, body: { ok: true, replacement: true, state: "absent" } });
  });
});

describe("hosted: a permission replacement stops the wallet it names, and only that one", () => {
  const T = addr(0x11), SPOT = addr(0x22), PERPS = addr(0x33);
  const signedIn = () => ({ cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(T)}` });
  const del = (query: string, body: unknown) =>
    route.DELETE(new Request(`${ORIGIN}/api/grants${query}`, { method: "DELETE", headers: { "Content-Type": "application/json", ...signedIn() }, body: JSON.stringify(body) }));

  beforeEach(async () => {
    process.env.MERRYMEN_HOSTED = "1";
    process.env.MERRYMEN_PERPS_PAPER_TENANTS = T;
    pilot?.close(); pilot = pilotFixture([T]);
    await stores.getGrantStore("spot").remove(T);
    await stores.getGrantStore("perps").remove(T);
    await stores.getGrantStore("spot").put(T, grant(T, SPOT, key("ab")));
    await stores.getGrantStore("perps").put(T, grant(T, PERPS, key("cd"), { purpose: "perps" }));
  });

  it("?wallet=perps stops the Perps grant; the Spot grant still signs", async (t) => {
    atPaper(t);
    const res = await json(await del("?wallet=perps", { purpose: "permission-replacement", expectedTenant: T, expectedAccount: PERPS }));
    assert.deepEqual(res, { status: 200, body: { ok: true, replacement: true, state: "stopped" } });
    assert.equal(await stores.getGrantStore("perps").get(T), null, "the Perps key is gone");
    assert.ok((await stores.getGrantStore("perps").listTenants()).includes(T), "its place is kept for the renewal");
    assert.equal((await stores.getGrantStore("spot").get(T))?.demoSessionPrivateKey, key("ab"), "Spot is untouched");
  });

  it("no selector stops the Spot grant, as it always did; the Perps grant still signs", async () => {
    const res = await json(await del("", { purpose: "permission-replacement", expectedTenant: T, expectedAccount: SPOT }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await stores.getGrantStore("spot").get(T), null);
    assert.equal((await stores.getGrantStore("perps").get(T))?.demoSessionPrivateKey, key("cd"));
  });

  it("naming one wallet with the other's account changes nothing", async (t) => {
    atPaper(t);
    const res = await json(await del("?wallet=perps", { purpose: "permission-replacement", expectedTenant: T, expectedAccount: SPOT }));
    assert.equal(res.status, 409);
    assert.ok(await stores.getGrantStore("perps").get(T));
    assert.ok(await stores.getGrantStore("spot").get(T));
  });

  it("a kill aimed at one wallet is refused: both grants are kept", async () => {
    for (const query of ["?wallet=perps", "?wallet=spot"]) {
      const res = await json(await del(query, { purpose: "delete-agent", expectedTenant: T }));
      assert.equal(res.status, 400, query);
      assert.match(String(res.body.error), /stops every wallet[\s\S]*Nothing was deleted/);
    }
    assert.ok(await stores.getGrantStore("spot").get(T));
    assert.ok(await stores.getGrantStore("perps").get(T));
  });

  it("an unknown wallet is refused before the body is read", async () => {
    const res = await json(await del("?wallet=solana", { purpose: "delete-agent", expectedTenant: T }));
    assert.equal(res.status, 400);
    assert.ok(await stores.getGrantStore("spot").get(T));
    assert.ok(existsSync(path.join(home, "tenants-perps", `${T}.json`)));
  });
});
