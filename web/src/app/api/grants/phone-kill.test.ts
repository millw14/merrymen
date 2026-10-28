/**
 * THE PHONES' STOP BUTTONS, SENT AS EACH APP SENDS THEM, AGAINST THE HOSTED SERVER.
 *
 * Since PR #251 (2026-10-04) the hosted DELETE /api/grants refuses a body that
 * does not name its purpose, so an old renewal tab cannot discard a grant by
 * accident. The web kill switch names it ("delete-agent"); the phones never
 * did. iOS "Stand down agent" (AccountScreens.swift) sent `{}`, and Android
 * "Stop my agent" (MerrymenApi.revokeGrant) sent a null body, which sendJson
 * turns into `{}`. Both were refused 400, the Robinhood grant and the Solana
 * strategy kept trading, and the phone showed "Reload your wallet", which no
 * phone screen can act on.
 *
 * Each request carries its app's own headers and goes through the hosted API
 * guard (middleware) before the route, so a refusal can only come from the
 * route's own rules.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, it, mock } from "node:test";
import { NextRequest } from "next/server";

const ORIGIN = "https://app.merrymen.dev";
const OWNER = `0x${"c".repeat(40)}` as `0x${string}`;
const OTHER = `0x${"d".repeat(40)}` as `0x${string}`;
const saved = Object.fromEntries(
  ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_PUBLIC_ORIGIN", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_STORE_DEK"]
    .map((key) => [key, process.env[key]]),
);

let home: string;
let DELETE: (req: Request) => Promise<Response>;
let middleware: typeof import("@/middleware").middleware;
let auth: typeof import("@/lib/auth");
const removed: string[] = [];
const replacements: unknown[][] = [];
const solanaStopped: string[] = [];
const perpsAsked: string[] = [];

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-grant-phone-kill-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_PUBLIC_ORIGIN = ORIGIN;
  process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
  process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
  process.env.DATABASE_URL = "postgres://127.0.0.1:1/never-connected";

  auth = await import("@/lib/auth");
  const grants = createRequire(import.meta.url)("../../../../../worker/src/grant-store.ts") as typeof import("../../../../../worker/src/grant-store");
  grants.resetGrantStoreForTest();
  mock.method(grants.getGrantStore("spot"), "remove", async (tenant: string) => { removed.push(tenant); });
  mock.method(grants.getGrantStore("spot"), "stopForReplacement", async (...args: unknown[]) => { replacements.push(args); return "stopped"; });
  // The kill's Perps half runs on every phone stop too; this owner has no Perps wallet.
  mock.method(grants.getGrantStore("perps"), "revokeForKill", async (tenant: string) => { perpsAsked.push(tenant); return "absent" as const; });
  // …and its paper strategy is turned off (slice 3): no Perps settings either, on a database never connected.
  const settings = createRequire(import.meta.url)("../../../../../worker/src/settings-store.ts") as typeof import("../../../../../worker/src/settings-store");
  settings.resetSettingsStoreForTest();
  mock.method(settings.getSettingsStore("perps") as InstanceType<typeof settings.PgSettingsStore>, "disablePerpsForKill", async () => "none" as const);
  const solana = await import("@/lib/solana-binding-store");
  mock.method(solana.getSolanaBindingStore(), "disableForKill", async (tenant: string) => { solanaStopped.push(tenant); return true; });
  ({ DELETE } = await import("./route"));
  // The middleware reads MERRYMEN_HOSTED and the public origin once, at import.
  ({ middleware } = await import("@/middleware"));
});

after(() => {
  mock.restoreAll();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => { removed.length = 0; replacements.length = 0; solanaStopped.length = 0; perpsAsked.length = 0; });

/** One phone's stop button: the headers its client puts on the request, signed in as `tenant`. */
interface Phone { app: string; headers: (tenant: `0x${string}`) => Record<string, string> }
const PHONES: Phone[] = [
  // API.raw (ios-native/Sources/API.swift): the stored session cookie, JSON
  // both ways, and the site's own Origin on every write.
  {
    app: "iOS Stand down agent",
    headers: (tenant) => ({
      accept: "application/json", "content-type": "application/json",
      cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(tenant)}`, origin: ORIGIN,
    }),
  },
  // MerrymenApi.sendJson over the app's cookie jar; MerrymenHeaders adds the
  // user-agent and accept, and deliberately no Origin (net/Http.kt).
  {
    app: "Android Stop my agent",
    headers: (tenant) => ({
      accept: "application/json", "content-type": "application/json; charset=utf-8", "user-agent": "merrymen-android/0.4.1",
      cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(tenant)}`,
    }),
  },
];

/** Through the hosted API guard first, which must let it by, then the route. */
async function stop(phone: Phone, tenant: `0x${string}`, body: string): Promise<Response> {
  const init = () => ({ method: "DELETE", headers: { host: new URL(ORIGIN).host, ...phone.headers(tenant) }, body });
  const guard = middleware(new NextRequest(`${ORIGIN}/api/grants`, init()));
  assert.equal(guard.headers.get("x-middleware-next"), "1", `${phone.app}: the hosted API guard passes it on (got ${guard.status})`);
  return DELETE(new Request(`${ORIGIN}/api/grants`, init()));
}

it("the phones' stop as they shipped it ({}) is refused 400, and the agent keeps trading on both chains", async () => {
  for (const phone of PHONES) {
    const response = await stop(phone, OWNER, "{}");
    assert.equal(response.status, 400, phone.app);
    const body = await response.json() as { error: string; ownerFacing: boolean };
    assert.equal(body.error, "Reload your wallet before stopping or renewing. Nothing was deleted.", phone.app);
    assert.equal(body.ownerFacing, true, phone.app);
  }
  assert.deepEqual(removed, [], "the Robinhood grant was never removed");
  assert.deepEqual(solanaStopped, [], "and the Solana strategy was never stopped");
  assert.deepEqual(perpsAsked, [], "nor was the Perps wallet asked to stop");
  assert.deepEqual(replacements, []);
});

it("the phones' stop naming delete-agent and the signed-in wallet removes the grant, stops the Solana strategy and reaches the Perps wallet", async () => {
  for (const phone of PHONES) {
    removed.length = 0; solanaStopped.length = 0; perpsAsked.length = 0;
    const response = await stop(phone, OWNER, JSON.stringify({ purpose: "delete-agent", expectedTenant: OWNER }));
    assert.equal(response.status, 200, phone.app);
    assert.deepEqual(await response.json(), { ok: true }, phone.app);
    assert.deepEqual(removed, [OWNER], `${phone.app}: the Robinhood grant is removed`);
    assert.deepEqual(solanaStopped, [OWNER], `${phone.app}: the Solana strategy is stopped`);
    assert.deepEqual(perpsAsked, [OWNER], `${phone.app}: the Perps half runs as well`);
  }
  assert.deepEqual(replacements, [], "a kill is never taken for a permission replacement");
});

it("a phone whose session became another wallet since the tap is refused 409, and stops nobody", async () => {
  for (const phone of PHONES) {
    const response = await stop(phone, OTHER, JSON.stringify({ purpose: "delete-agent", expectedTenant: OWNER }));
    assert.equal(response.status, 409, phone.app);
  }
  assert.deepEqual(removed, []);
  assert.deepEqual(solanaStopped, []);
  assert.deepEqual(perpsAsked, []);
});
