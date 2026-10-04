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
  mock.method(grants.getGrantStore(), "get", async (tenant: `0x${string}`) => {
    asked.push(tenant);
    return null;
  });
  mock.method(grants.getGrantStore(), "remove", async (tenant: string) => { removed.push(tenant); });
  mock.method(grants.getGrantStore(), "stopForReplacement", async (...args: unknown[]) => {
    replacements.push(args);
    if (replacementError) throw new Error("database unavailable");
    return replacementState;
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
beforeEach(() => { asked.length = 0; removed.length = 0; replacements.length = 0; replacementState = "stopped"; replacementError = false; });

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
