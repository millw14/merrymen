import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { pilotFixture } from "@/lib/perps-pilot-fixture";
import { mintSession } from "@/lib/auth";
import { isPerpsPilotAdmin, readPilotBody } from "@/lib/perps-pilot-api";
import { GET } from "./route";
import { POST as redeem } from "./redeem/route";
import { GET as adminGet, POST as adminPost } from "./admin/route";
import { GET as offered } from "../offered/route";
import { getSettingsStore, resetSettingsStoreForTest, type FileSettingsStore } from "@merrymen/settings-store";

const ORIGIN = "https://app.example.test", APP = "pilot-test-app";
const ADMIN: `0x${string}` = `0x${"a1".repeat(20)}`, ALICE: `0x${string}` = `0x${"b2".repeat(20)}`, BOB: `0x${string}` = `0x${"c3".repeat(20)}`;
const DID = "did:privy:pilot-alice", BOB_DID = "did:privy:pilot-bob";
const env = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_PUBLIC_ORIGIN", "MERRYMEN_SESSION_SECRET", "MERRYMEN_PERPS", "MERRYMEN_PERPS_PILOT_ADMINS", "MERRYMEN_PERPS_PAPER_TENANTS", "DATABASE_URL", "NEXT_PUBLIC_PRIVY_APP_ID", "PRIVY_APP_SECRET", "PRIVY_VERIFICATION_KEY"];
const saved = Object.fromEntries(env.map(key => [key, process.env[key]]));
const home = mkdtempSync(path.join(tmpdir(), "merrymen-pilot-api-"));
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
let pilot: ReturnType<typeof pilotFixture>;
const require = createRequire(import.meta.url);
const identities = require("../../../../../../worker/src/identity-store.ts") as typeof import("../../../../../../worker/src/identity-store");
const privy = require("../../../../lib/privy.ts") as typeof import("../../../../lib/privy");

function token(did = DID) {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url"), now = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: "ES256", typ: "JWT" })}.${b64({ sid: "pilot-session", sub: did, iss: "privy.io", aud: APP, iat: now, exp: now + 600 })}`;
  return `${data}.${sign("sha256", Buffer.from(data), { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
function request(endpoint: string, owner: `0x${string}` | null = ALICE, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/perps/${endpoint}?wallet=perps`, { method: body === undefined ? "GET" : "POST", headers: {
    ...(owner ? { cookie: `mm_session=${mintSession(owner)}` } : {}), origin: ORIGIN, "content-type": "application/json", ...headers,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const useCode = (code: string, owner = ALICE, bearer = token(), extra: Record<string, unknown> = {}) => redeem(request("pilot/redeem", owner, { code, expectedTenant: owner, ...extra }, { authorization: `Bearer ${bearer}` }));
async function invite() { return pilot.store.createInvite({ actor: ADMIN, maxUses: 1, expiresAt: Date.now() + 60_000 }); }

before(async () => {
  Object.assign(process.env, { MERRYMEN_HOME: home, MERRYMEN_HOSTED: "1", MERRYMEN_PUBLIC_ORIGIN: ORIGIN,
    MERRYMEN_SESSION_SECRET: "pilot-session-secret-which-is-long-enough", NEXT_PUBLIC_PRIVY_APP_ID: APP,
    PRIVY_APP_SECRET: "fixture-only-secret", PRIVY_VERIFICATION_KEY: keys.publicKey.export({ type: "spki", format: "pem" }).toString() });
  delete process.env.DATABASE_URL;
  identities.resetIdentityStoreForTest(); privy.resetPrivyClientForTest();
  await identities.getIdentityStore().resolveOrClaimDid(ALICE, { did: DID, provider: "email", subject: DID });
  await identities.getIdentityStore().resolveOrClaimDid(BOB, { did: BOB_DID, provider: "email", subject: BOB_DID });
});
beforeEach(() => {
  pilot?.close(); pilot = pilotFixture();
  resetSettingsStoreForTest(); rmSync(path.join(home, "tenant-settings-perps"), { recursive: true, force: true });
  process.env.MERRYMEN_PERPS = "paper"; process.env.MERRYMEN_PERPS_PILOT_ADMINS = ADMIN;
});
after(() => {
  pilot?.close(); identities.resetIdentityStoreForTest(); privy.resetPrivyClientForTest(); resetSettingsStoreForTest(); mock.restoreAll();
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(home, { recursive: true, force: true });
});

describe("pilot enrollment uses verified login authority", () => {
  it("refuses anonymous reads and wallet selectors before accessing admission", async () => {
    assert.equal((await GET(request("pilot", null))).status, 401);
    for (const query of ["", "?wallet=spot", "?Wallet=perps", "?wallet=perps&wallet=spot"]) {
      const response = await GET(new Request(`${ORIGIN}/api/perps/pilot${query}`));
      assert.equal(response.status, 400); assert.equal(response.headers.get("cache-control"), "private, no-store");
    }
  });
  it("submits the verified owner for admin approval without granting access or touching settings", async () => {
    await getSettingsStore("perps").put(ALICE, { perpsEnabled: true, perpsControlNonce: "old", perpsMaxLeverage: 2 });
    const made = await invite();
    const response = await useCode(made.code); assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { tenant: ALICE, status: "pending", revision: 1, paperAvailable: true, admin: false });
    assert.equal((await offered(request("offered"))).status, 403, "an invite never permits signing a grant");
    assert.equal((await useCode(made.code)).status, 200, "lost response can be checked/redeemed by same owner without another use");
    assert.equal((await pilot.store.list()).invites[0]?.uses, 1);
    const listing = await pilot.store.list();
    assert.equal(listing.requests.length, 1); assert.equal(listing.requests[0]?.owner, ALICE);
    assert.equal(listing.requests[0]?.inviteId, made.invite.id); assert.deepEqual(listing.admissions, []);
    assert.deepEqual((await pilot.store.snapshot()).owners, []);
    let authorized = false;
    assert.deepEqual(await pilot.store.withAdmission(ALICE, async () => { authorized = true; }), { allowed: false });
    assert.equal(authorized, false);
    const settings = await getSettingsStore("perps").get(ALICE);
    assert.equal(settings?.perpsEnabled, true); assert.equal(settings?.perpsControlNonce, "old"); assert.equal(settings?.perpsMaxLeverage, 2);
  });
  it("refuses a changed cookie, forged token, foreign DID and self-selected target wallet", async () => {
    const made = await invite();
    assert.equal((await useCode(made.code, BOB, token(), { expectedTenant: ALICE })).status, 409);
    assert.equal((await useCode(made.code, ALICE, "forged-secret-token")).status, 401);
    assert.equal((await useCode(made.code, ALICE, token(BOB_DID))).status, 409);
    assert.equal((await useCode(made.code, ALICE, token(), { owner: BOB })).status, 400);
    assert.equal((await useCode(made.code, ALICE, token(), { status: "allowed" })).status, 400);
    assert.equal((await useCode(made.code, ALICE, token(), { admin: true })).status, 400);
    assert.equal((await pilot.store.list()).invites[0]?.uses, 0);
    assert.deepEqual((await pilot.store.list()).requests, []);
    assert.equal((await pilot.store.get(BOB)).status, "not-admitted");
  });
  it("does not override explicit revocation or expose detailed invite validity", async () => {
    const made = await invite(); await pilot.set(ALICE, "revoked");
    assert.equal((await useCode(made.code)).status, 403);
    assert.equal((await offered(request("offered"))).status, 403);
    assert.equal((await pilot.store.list()).invites[0]?.uses, 0);
    const invalid = await useCode("mmp_invalid", BOB, token(BOB_DID));
    assert.equal(invalid.status, 400); assert.equal((await invalid.json()).code, "invalid-invite");
  });
  it("can register before launch while creation remains globally unavailable", async () => {
    process.env.MERRYMEN_PERPS = "off";
    const made = await invite(), response = await useCode(made.code);
    assert.equal(response.status, 200); assert.equal((await response.json()).paperAvailable, false);
    assert.equal((await offered(request("offered"))).status, 404);
  });
  it("enforces shared failed-attempt budgets without consuming the invitation", async () => {
    for (let i = 0; i < 10; i++) assert.equal((await useCode("bad")).status, 400);
    const made = await invite(), response = await useCode(made.code);
    assert.equal(response.status, 429); assert.ok(Number(response.headers.get("retry-after")) > 0);
    assert.equal((await pilot.store.list()).invites[0]?.uses, 0);
  });
});

describe("pilot administration is separate from membership", () => {
  it("only an admin can see pending wallets and approve one without approving the rest", async () => {
    const first = await invite(), second = await invite();
    assert.equal((await useCode(first.code)).status, 200);
    assert.equal((await useCode(second.code, BOB, token(BOB_DID))).status, 200);
    const denied = await adminGet(request("pilot/admin"));
    assert.equal(denied.status, 403); assert.ok(!(await denied.text()).includes(BOB));
    const listing = await (await adminGet(request("pilot/admin", ADMIN))).json();
    assert.deepEqual(listing.requests.map((row: { owner: string }) => row.owner).sort(), [ALICE, BOB].sort());
    assert.equal(listing.requestLimit, 1000); assert.deepEqual(listing.admissions, []);
    const action = { action: "set-admission", expectedTenant: ALICE, owner: ALICE, status: "allowed", expectedRevision: listing.revision };
    assert.equal((await adminPost(request("pilot/admin", ALICE, action))).status, 403, "requesting access never confers admin authority");
    await getSettingsStore("perps").put(ALICE, { perpsEnabled: true, perpsControlNonce: "old", perpsMaxLeverage: 2 });
    assert.equal((await adminPost(request("pilot/admin", ADMIN, { ...action, expectedTenant: ADMIN }))).status, 200);
    assert.equal((await pilot.store.get(ALICE)).status, "allowed"); assert.equal((await pilot.store.get(BOB)).status, "pending");
    assert.equal((await offered(request("offered"))).status, 200);
    assert.deepEqual((await pilot.store.list()).requests.map(row => row.owner), [BOB]);
    const settings = await getSettingsStore("perps").get(ALICE);
    assert.equal(settings?.perpsEnabled, false); assert.notEqual(settings?.perpsControlNonce, "old"); assert.equal(settings?.perpsMaxLeverage, 2);
  });
  it("rejecting a pending wallet blocks resubmission and stale approval", async () => {
    const first = await invite(), second = await invite(); await useCode(first.code);
    const revision = (await pilot.store.list()).revision;
    const action = { action: "set-admission", expectedTenant: ADMIN, owner: ALICE, expectedRevision: revision };
    assert.equal((await adminPost(request("pilot/admin", ADMIN, { ...action, status: "revoked" }))).status, 200);
    assert.equal((await pilot.store.get(ALICE)).status, "revoked"); assert.deepEqual((await pilot.store.list()).requests, []);
    assert.equal((await useCode(second.code)).status, 403);
    assert.equal((await adminPost(request("pilot/admin", ADMIN, { ...action, status: "allowed" }))).status, 409);
    assert.equal((await offered(request("offered"))).status, 403);
  });
  it("denies members, malformed role lists and unset configuration", async () => {
    await pilot.set(ALICE, "allowed");
    assert.equal((await adminGet(request("pilot/admin"))).status, 403);
    for (const raw of ["", "*", `${ADMIN},bad`, Array(21).fill(ADMIN).join(",")]) {
      process.env.MERRYMEN_PERPS_PILOT_ADMINS = raw; assert.equal(isPerpsPilotAdmin(ADMIN), false);
      assert.equal((await adminGet(request("pilot/admin", ADMIN))).status, 403);
    }
  });
  it("creates a code once; lists no code, code hash, secret, or audit payload", async () => {
    const response = await adminPost(request("pilot/admin", ADMIN, { action: "create-invite", expectedTenant: ADMIN, maxUses: 1, expiresInDays: 7 }));
    assert.equal(response.status, 201, await response.clone().text());
    const made = await response.json(), listing = await adminGet(request("pilot/admin", ADMIN));
    assert.match(made.code, /^mmp_/); assert.equal(made.invite.revoked, false);
    const text = await listing.text(); assert.ok(!text.includes(made.code)); assert.ok(!/code_hash|codeHash|audit|bootstrap_digest/.test(text));
    assert.equal(listing.headers.get("cache-control"), "private, no-store");
  });
  it("refuses stale approval after a newer revoke and preserves membership", async () => {
    const revision = (await pilot.store.snapshot()).revision; await pilot.set(ALICE, "revoked");
    const response = await adminPost(request("pilot/admin", ADMIN, { action: "set-admission", expectedTenant: ADMIN, owner: ALICE, status: "allowed", expectedRevision: revision }));
    assert.equal(response.status, 409); assert.equal((await pilot.store.get(ALICE)).status, "revoked");
  });
  it("a deliberate re-admission clears old entry permission before access is restored", async () => {
    await pilot.set(ALICE, "revoked");
    await getSettingsStore("perps").put(ALICE, { perpsEnabled: true, perpsControlNonce: "old" });
    const response = await adminPost(request("pilot/admin", ADMIN, { action: "set-admission", expectedTenant: ADMIN, owner: ALICE, status: "allowed", expectedRevision: (await pilot.store.snapshot()).revision }));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await pilot.store.get(ALICE)).status, "allowed");
    const settings = await getSettingsStore("perps").get(ALICE);
    assert.equal(settings?.perpsEnabled, false); assert.notEqual(settings?.perpsControlNonce, "old");
  });
  it("a failed approval restriction leaves the request pending and no authority granted", async () => {
    const made = await invite();
    const fail = mock.method(getSettingsStore("perps") as FileSettingsStore, "disablePerpsForKill", async () => { throw new Error("private database failure"); });
    try {
      assert.equal((await useCode(made.code)).status, 200, "submitting a request does not change trading settings");
      const response = await adminPost(request("pilot/admin", ADMIN, { action: "set-admission", expectedTenant: ADMIN, owner: ALICE, status: "allowed", expectedRevision: (await pilot.store.snapshot()).revision }));
      assert.equal(response.status, 503); assert.ok(!(await response.text()).includes("private database failure"));
      assert.equal((await pilot.store.get(ALICE)).status, "pending"); assert.equal((await pilot.store.list()).invites[0]?.uses, 1);
      assert.equal((await pilot.store.list()).requests.length, 1); assert.deepEqual((await pilot.store.snapshot()).owners, []);
    } finally { fail.mock.restore(); }
  });
  it("revokes an invitation without granting access to its pending requests", async () => {
    const made = await invite(); await useCode(made.code);
    assert.equal((await adminPost(request("pilot/admin", ADMIN, { action: "revoke-invite", expectedTenant: ADMIN, id: made.invite.id }))).status, 200);
    assert.equal((await pilot.store.get(ALICE)).status, "pending");
    assert.equal((await offered(request("offered"))).status, 403);
    assert.equal((await useCode(made.code, BOB, token(BOB_DID))).status, 400);
  });
  it("rejects cross-site mutations, malformed bodies and switched admin accounts", async () => {
    const body = { action: "create-invite", expectedTenant: ADMIN, maxUses: 1, expiresInDays: 7 };
    assert.equal((await adminPost(request("pilot/admin", ADMIN, body, { origin: "https://evil.test" }))).status, 403);
    assert.equal((await adminPost(request("pilot/admin", ADMIN, { ...body, expectedTenant: ALICE }))).status, 409);
    assert.equal((await adminPost(request("pilot/admin", ADMIN, { ...body, maxUses: 101 }))).status, 400);
    assert.equal((await adminPost(request("pilot/admin", ADMIN, { ...body, expiresInDays: 31 }))).status, 400);
    assert.equal((await adminPost(request("pilot/admin", ADMIN, { ...body, extraneous: "x".repeat(5000) }))).status, 413);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(4097)); controller.close(); } });
    const streamed = await readPilotBody(new Request(ORIGIN, { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit));
    assert.ok(streamed instanceof Response); assert.equal(streamed.status, 413);
  });
  it("redacts shared-store failures and never treats unknown access as allowed", async () => {
    const fail = mock.method(pilot.store, "get", async () => { throw new Error("postgres://private:credential@internal"); });
    try {
      const response = await GET(request("pilot")); assert.equal(response.status, 503); assert.ok(!(await response.text()).includes("credential"));
      assert.equal((await offered(request("offered"))).status, 503);
    } finally { fail.mock.restore(); }
  });
});
