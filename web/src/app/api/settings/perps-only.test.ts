import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { before, after, it } from "node:test";
import { mintSession } from "@/lib/auth";
import { getSettingsStore, resetSettingsStoreForTest } from "@merrymen/settings-store";
import { getGrantStore, resetGrantStoreForTest } from "@merrymen/grant-store";
const A = `0x${"aa".repeat(20)}` as const, B = `0x${"bb".repeat(20)}` as const;
const keys = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL"] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
let home: string, PUT: (req: Request) => Promise<Response>, GET: typeof PUT;
const request = (owner: typeof A | typeof B = A, body?: Record<string, unknown>) => new Request("http://localhost/api/settings", {
  method: body ? "PUT" : "GET", headers: { cookie: `mm_session=${mintSession(owner)}` }, ...(body ? { body: JSON.stringify(body) } : {}),
});
before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "mm-perps-only-"));
  process.env.MERRYMEN_HOME = home; process.env.MERRYMEN_HOSTED = "1"; process.env.MERRYMEN_SESSION_SECRET = "a".repeat(64); delete process.env.DATABASE_URL;
  resetSettingsStoreForTest(); resetGrantStoreForTest();
  ({ PUT, GET } = await import("./route"));
  await mkdir(path.join(home, "tenants"));
});
after(async () => {
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  resetSettingsStoreForTest(); resetGrantStoreForTest(); await rm(home, { recursive: true, force: true });
});
it("new owners can save perps-only without changing trading authority, and private GET identifies its owner", async () => {
  const response = await PUT(request(A, { owner: A, strategy: "perps-only", perpsEnabled: true }));
  assert.equal(response.status, 200);
  const settings = await getSettingsStore().get(A);
  assert.equal(settings?.strategy, "perps-only"); assert.equal(settings?.perpsLiveEnabled, undefined);
  assert.equal(await getGrantStore().hasStoredGrant!(A), false);
  const get = await GET(request(A));
  assert.equal(get.headers.get("Cache-Control"), "private, no-store"); assert.equal(get.headers.get("Vary"), "Cookie");
  assert.equal((await get.json()).owner, A);
});
it("existing and malformed grants refuse switching a spot strategy but retain explicit OFF", async () => {
  await getSettingsStore().put(A, { strategy: "steady-basket", perpsEnabled: true });
  const file = path.join(home, "tenants", `${A}.json`);
  for (const content of [JSON.stringify({ tenant: A, grant: { smartAccount: A }, sealedSessionKey: "bad" }), "broken JSON"]) {
    await writeFile(file, content);
    const response = await PUT(request(A, { owner: A, strategy: "perps-only", perpsEnabled: false }));
    assert.equal(response.status, 400);
    assert.equal((await getSettingsStore().get(A))?.strategy, "steady-basket");
    assert.equal((await getSettingsStore().get(A))?.perpsEnabled, false);
    assert.equal(await readFile(file, "utf8"), content);
  }
});
it("already-perps-only owners may keep their selection while another owner stays isolated", async () => {
  await getSettingsStore().put(A, { strategy: "perps-only" });
  assert.equal((await PUT(request(A, { owner: A, strategy: "perps-only" }))).status, 200);
  await getSettingsStore().put(B, { strategy: "steady-basket" });
  assert.equal((await PUT(request(B, { owner: A, strategy: "perps-only" }))).status, 409);
  assert.equal((await getSettingsStore().get(B))?.strategy, "steady-basket");
  assert.equal((await PUT(request(B, { owner: B, strategy: "perps-only" }))).status, 200);
});
it("unavailable grant storage refuses replacing the active spot strategy", async () => {
  await getSettingsStore().put(A, { strategy: "steady-basket" });
  const store = getGrantStore(), original = store.hasStoredGrant;
  store.hasStoredGrant = async () => { throw new Error("storage unavailable"); };
  try {
    assert.equal((await PUT(request(A, { strategy: "perps-only" }))).status, 400);
    assert.equal((await getSettingsStore().get(A))?.strategy, "steady-basket");
  } finally { store.hasStoredGrant = original; }
});
it("local existing or unreadable authority refuses switching; absence permits initial setup", async () => {
  delete process.env.MERRYMEN_HOSTED;
  const grant = path.join(home, "grant.json"), settings = path.join(home, "settings.json");
  await writeFile(settings, JSON.stringify({ strategy: "steady-basket" }));
  await mkdir(grant);
  assert.equal((await PUT(request(A, { strategy: "perps-only" }))).status, 400);
  await rm(grant, { recursive: true });
  await writeFile(grant, "broken JSON");
  assert.equal((await PUT(request(A, { strategy: "perps-only" }))).status, 400);
  await rm(grant);
  assert.equal((await PUT(request(A, { strategy: "perps-only" }))).status, 200);
  assert.equal(JSON.parse(await readFile(settings, "utf8")).strategy, "perps-only");
  process.env.MERRYMEN_HOSTED = "1";
});
