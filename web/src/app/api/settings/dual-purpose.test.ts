import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { before, after, it } from "node:test";
import { mintSession } from "@/lib/auth";
import { getSettingsStore, resetSettingsStoreForTest } from "@merrymen/settings-store";
const keys = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL"] as const, saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
const owner = `0x${"aa".repeat(20)}` as const, other = `0x${"bb".repeat(20)}` as const;
let home: string, GET: (r: Request) => Promise<Response>, PUT: typeof GET;
function request(purpose: string, body?: object, tenant: string | null = owner) { return new Request(`http://localhost/api/settings${purpose ? `?purpose=${purpose}` : ""}`, { method: body ? "PUT" : "GET", headers: tenant ? { cookie: `mm_session=${mintSession(tenant as `0x${string}`)}` } : {}, ...(body ? { body: JSON.stringify(body) } : {}) }); }
before(async () => { home = await mkdtemp(path.join(os.tmpdir(), "mm-dual-settings-")); process.env.MERRYMEN_HOME = home; process.env.MERRYMEN_HOSTED = "1"; process.env.MERRYMEN_SESSION_SECRET = "a".repeat(64); delete process.env.DATABASE_URL; resetSettingsStoreForTest(); ({ GET, PUT } = await import("./route")); });
after(async () => { resetSettingsStoreForTest(); for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } await rm(home, { recursive: true, force: true }); });
it("one session saves independent allocation limits, while dedicated Perps cannot enable a Spot strategy", async () => {
 assert.equal((await PUT(request("", { owner, strategy: "trencher", perpsMaxCollateralUsdg: 45 }))).status, 200);
 assert.equal((await PUT(request("perps", { owner, perpsMaxCollateralUsdg: 20, perpsEnabled: true }))).status, 200);
 assert.equal((await getSettingsStore().get(owner))?.perpsMaxCollateralUsdg, 45);
 assert.equal((await getSettingsStore("perps").get(owner))?.perpsMaxCollateralUsdg, 20);
 assert.equal((await getSettingsStore("perps").get(owner))?.strategy, "perps-only");
 const view = await (await GET(request("perps"))).json(); assert.equal(view.owner, owner); assert.deepEqual(view.strategies, { builtin: ["perps-only"], custom: [] });
 assert.equal((await PUT(request("perps", { owner, strategy: "trencher", perpsEnabled: false }))).status, 400);
 assert.equal((await getSettingsStore("perps").get(owner))?.perpsEnabled, false);
 assert.equal((await getSettingsStore("perps").get(owner))?.strategy, "perps-only");
 assert.equal((await getSettingsStore().get(owner))?.strategy, "trencher");
});
it("purpose validation and the authenticated owner guard run before writes", async () => {
 assert.equal((await PUT(request("perps", { owner, perpsMaxCollateralUsdg: 99 }, other))).status, 409);
 assert.equal((await PUT(request("perps", { owner, perpsMaxCollateralUsdg: 99 }, null))).status, 401);
 for (const purpose of ["other", "perps&purpose=spot"]) {
  assert.equal((await GET(request(purpose))).status, 400); assert.equal((await PUT(request(purpose, { owner, perpsMaxCollateralUsdg: 99 }))).status, 400);
 }
 assert.equal(await getSettingsStore("perps").get(other), null);
});
it("self-hosted Perps writes its own home and never overwrites Spot settings", async () => {
 process.env.MERRYMEN_HOSTED = "0";
 assert.equal((await PUT(request("", { strategy: "steady-basket", perpsMaxCollateralUsdg: 50 }))).status, 200);
 const before = await readFile(path.join(home, "settings.json"), "utf8");
 assert.equal((await PUT(request("perps", { perpsMaxCollateralUsdg: 25 }))).status, 200);
 assert.equal(await readFile(path.join(home, "settings.json"), "utf8"), before);
 assert.equal(JSON.parse(await readFile(path.join(home, "accounts", "perps", "settings.json"), "utf8")).strategy, "perps-only");
});
