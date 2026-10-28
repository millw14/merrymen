import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, it, mock } from "node:test";

const ORIGIN = "https://app.merrymen.dev";
const A = `0x${"a".repeat(40)}` as `0x${string}`;
const B = `0x${"b".repeat(40)}` as `0x${string}`;
const saved = Object.fromEntries(
  ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_STORE_DEK"].map((key) => [key, process.env[key]]),
);

let home: string;
let GET: (req: Request) => Promise<Response>;
let DELETE: (req: Request) => Promise<Response>;
let auth: typeof import("@/lib/auth");
const asked: string[] = [];
const removed: string[] = [];
const replacements: unknown[][] = [];
let replacementState: "stopped" | "absent" | "changed" = "stopped";
let replacementError = false;
const solanaStopped: string[] = [];
let solanaDown = false;
let removeDown = false;
/** Every tenant whose Perps wallet a kill asked about: none of these owners has one. */
const perpsAsked: string[] = [];

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-grant-tenant-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
  process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
  process.env.DATABASE_URL = "postgres://127.0.0.1:1/never-connected";

  auth = await import("@/lib/auth");
  const grants = createRequire(import.meta.url)("../../../../../worker/src/grant-store.ts") as typeof import("../../../../../worker/src/grant-store");
  grants.resetGrantStoreForTest();
  mock.method(grants.getGrantStore("spot"), "get", async (tenant: `0x${string}`) => {
    asked.push(tenant);
    return null;
  });
  mock.method(grants.getGrantStore("spot"), "remove", async (tenant: string) => { if (removeDown) throw new Error("database unavailable"); removed.push(tenant); });
  mock.method(grants.getGrantStore("spot"), "stopForReplacement", async (...args: unknown[]) => {
    replacements.push(args);
    if (replacementError) throw new Error("database unavailable");
    return replacementState;
  });
  // The kill's Perps half (perps-kill.ts) reads the Perps grant store, which here
  // has no database either. Stood in like the Spot one: a Spot-only owner.
  mock.method(grants.getGrantStore("perps"), "revokeForKill", async (tenant: string) => { perpsAsked.push(tenant); return "absent" as const; });
  // …and its paper strategy is turned off (slice 3): no Perps settings either, on a database never connected.
  const settings = createRequire(import.meta.url)("../../../../../worker/src/settings-store.ts") as typeof import("../../../../../worker/src/settings-store");
  settings.resetSettingsStoreForTest();
  mock.method(settings.getSettingsStore("perps") as InstanceType<typeof settings.PgSettingsStore>, "disablePerpsForKill", async () => "none" as const);
  const solana = await import("@/lib/solana-binding-store");
  mock.method(solana.getSolanaBindingStore(), "disableForKill", async (tenant: string) => {
    if (solanaDown) throw new Error("database unavailable");
    solanaStopped.push(tenant); return true;
  });
  ({ GET, DELETE } = await import("./route"));
});

after(() => {
  mock.restoreAll();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => { asked.length = 0; removed.length = 0; replacements.length = 0; replacementState = "stopped"; replacementError = false; solanaStopped.length = 0; solanaDown = false; removeDown = false; perpsAsked.length = 0; });

it("binds an empty hosted grant response to the tenant authenticated by the cookie", async () => {
  for (const tenant of [A, B]) {
    const request = new Request(`${ORIGIN}/api/grants`, {
      headers: { cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(tenant)}` },
    });
    const response = await GET(request);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { exists: false, tenant });
  }
  assert.deepEqual(asked, [A, B], "the store is queried with the cookie tenant only");
});

it("binds a signed-out hosted response to null without reading any grant", async () => {
  const response = await GET(new Request(`${ORIGIN}/api/grants`));
  assert.deepEqual(await response.json(), { exists: false, tenant: null });
  assert.deepEqual(asked, []);
});

it("a stop cannot remove a different tenant after a login switches", async () => {
  const request = (expectedTenant: unknown) => new Request(`${ORIGIN}/api/grants`, {
    method: "DELETE", headers: { cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(B)}`, "content-type": "application/json" },
    body: JSON.stringify({ expectedTenant, purpose: "delete-agent" }),
  });
  for (const expected of [A, null, 42]) {
    assert.equal((await DELETE(request(expected))).status, 409);
    assert.deepEqual(removed, []);
  }
  assert.equal((await DELETE(request(B))).status, 200);
  assert.deepEqual(removed, [B]);
  assert.deepEqual(solanaStopped, [B], "kill all agents stops the same tenant's Solana strategy");
  assert.deepEqual(perpsAsked, [B], "and reaches the same tenant's Perps wallet, and no other");
});

it("kill all agents stops the Solana strategy even when the Robinhood grant cannot be removed", async () => {
  const request = new Request(`${ORIGIN}/api/grants`, {
    method: "DELETE", headers: { cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(A)}`, "content-type": "application/json" },
    body: JSON.stringify({ expectedTenant: A, purpose: "delete-agent" }),
  });
  removeDown = true;
  await assert.rejects(DELETE(request), /database unavailable/, "the Robinhood failure is still an error");
  assert.deepEqual(removed, []); assert.deepEqual(solanaStopped, [A], "but the Solana strategy is off");
  assert.deepEqual(perpsAsked, [A], "and the Perps wallet is reached too");
});

it("kill all agents is reported incomplete, never done, while the Solana strategy could not be stopped", async () => {
  const request = () => new Request(`${ORIGIN}/api/grants`, {
    method: "DELETE", headers: { cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(A)}`, "content-type": "application/json" },
    body: JSON.stringify({ expectedTenant: A, purpose: "delete-agent" }),
  });
  solanaDown = true;
  const failed = await DELETE(request());
  assert.equal(failed.status, 503);
  const body = await failed.json() as { error: string; ownerFacing: boolean; ok?: boolean };
  assert.match(body.error, /Kill incomplete/); assert.equal(body.ownerFacing, true); assert.equal(body.ok, undefined);
  solanaDown = false;
  assert.equal((await DELETE(request())).status, 200, "the retry finishes it");
  assert.deepEqual(removed, [A, A]); assert.deepEqual(solanaStopped, [A]);
});

const replacementRequest = (body: unknown, tenant: string | null = A) => new Request(`${ORIGIN}/api/grants`, {
  method: "DELETE",
  headers: { "content-type": "application/json", ...(tenant ? { cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(tenant as `0x${string}`)}` } : {}) },
  body: JSON.stringify(body),
});

it("permission replacement uses the authenticated tenant and retains the destructive kill as a separate path", async () => {
  const response = await DELETE(replacementRequest({ expectedTenant: A, purpose: "permission-replacement", expectedAccount: B, expectedSession: A }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, replacement: true, state: "stopped" });
  assert.deepEqual(replacements, [[A, B, A]]);
  assert.deepEqual(removed, []);
});

it("an oversized stop body is refused with 413 before it is parsed, and nothing is stopped or removed", async () => {
  const big = { expectedTenant: A, purpose: "delete-agent", pad: "x".repeat(8 * 1024) };
  const response = await DELETE(replacementRequest(big));
  assert.equal(response.status, 413);
  assert.match(((await response.json()) as { error: string }).error, /too large\. Nothing was deleted/);
  assert.deepEqual(removed, []); assert.deepEqual(replacements, []); assert.deepEqual(solanaStopped, []); assert.deepEqual(perpsAsked, []);
  // Just under the limit is an ordinary stop.
  const fits = { expectedTenant: A, purpose: "delete-agent", pad: "" };
  fits.pad = "x".repeat(8 * 1024 - JSON.stringify(fits).length);
  assert.equal((await DELETE(replacementRequest(fits))).status, 200);
  assert.deepEqual(removed, [A]);
});

it("a legacy open renewal tab's bare DELETE cannot erase its agent or group approvals", async () => {
  const response = await DELETE(replacementRequest({ expectedTenant: A }));
  assert.equal(response.status, 400);
  const body = await response.json() as { error: string; ownerFacing: boolean };
  assert.match(body.error, /Reload your wallet/);
  assert.equal(body.ownerFacing, true);
  assert.deepEqual(replacements, []);
  assert.deepEqual(removed, []);
});

it("requires an identified account and refuses malformed or unknown stop purposes without deleting anything", async () => {
  for (const body of [
    { purpose: "permission-replacement" }, { purpose: "permission-replacement", expectedAccount: 1 },
    { purpose: "permission-replacement", expectedAccount: B, expectedSession: null },
    { purpose: "permission-replacement", expectedAccount: B, expectedSession: "0x" },
    { purpose: "keep-everything", expectedAccount: B },
  ]) {
    assert.equal((await DELETE(replacementRequest(body))).status, 400);
  }
  assert.deepEqual(replacements, []);
  assert.deepEqual(removed, []);
});

it("a switched login and a signed-out request cannot replace another tenant's permission", async () => {
  const body = { expectedTenant: A, purpose: "permission-replacement", expectedAccount: B };
  assert.equal((await DELETE(replacementRequest(body, B))).status, 409);
  assert.equal((await DELETE(replacementRequest(body, null))).status, 401);
  assert.deepEqual(replacements, []);
  assert.deepEqual(removed, []);
});

it("a concurrent new permission refuses the stale stop, while a missing grant is an idempotent stop", async () => {
  replacementState = "changed";
  assert.equal((await DELETE(replacementRequest({ purpose: "permission-replacement", expectedAccount: B }))).status, 409);
  replacementState = "absent";
  const response = await DELETE(replacementRequest({ purpose: "permission-replacement", expectedAccount: B }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, replacement: true, state: "absent" });
  assert.deepEqual(removed, []);
});

it("failed persistence does not claim an accepted stop or fall back to destructive deletion", async () => {
  replacementError = true;
  const response = await DELETE(replacementRequest({ purpose: "permission-replacement", expectedAccount: B }));
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { ownerFacing: boolean }).ownerFacing, true);
  assert.deepEqual(removed, []);
});
