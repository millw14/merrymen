import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { before, after, it } from "node:test";
import { mintSession } from "@/lib/auth";
import { resetGrantStoreForTest } from "@merrymen/grant-store";
const keys = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_STORE_DEK"] as const;
const saved = Object.fromEntries(keys.map(k => [k, process.env[k]])), oldFetch = globalThis.fetch;
const owner = `0x${"aa".repeat(20)}` as const, other = `0x${"bb".repeat(20)}` as const;
const spot = `0x${"cc".repeat(20)}`, perps = `0x${"dd".repeat(20)}`;
let home: string, account: (req: Request) => Promise<Response>, activity: typeof account, chart: typeof account;
const req = (route: string, tenant = owner) => new Request(`http://localhost/api/perps/${route}`, { headers: { cookie: `mm_session=${mintSession(tenant)}` } });
const fillTime = Date.now() - 60_000;
function seedLedger(file: string, agents: [string, string][]) {
 const db = new DatabaseSync(file);
 db.exec("CREATE TABLE agents (smart_account TEXT, name TEXT, perps TEXT, mode TEXT); CREATE TABLE perp_fills (agent_id TEXT,mode TEXT,market_id INTEGER,epoch INTEGER,venue_trade_id TEXT,side_role TEXT,side TEXT,base TEXT,price TEXT,position_before TEXT,realized_micro TEXT,fee_micro TEXT,attribution TEXT,trade_type TEXT,venue_ts_ms INTEGER); CREATE TABLE perp_funding (agent_id TEXT,mode TEXT,market_id INTEGER,epoch INTEGER,funding_id TEXT,funding_hour INTEGER,payment_micro TEXT)");
 for (const [address, label] of agents) {
  db.prepare("INSERT INTO agents VALUES (?, ?, NULL, 'paper')").run(address, label);
  db.prepare("INSERT INTO perp_fills VALUES (?,'paper',1,1,?,'bid','long','100','832186','0','0','12','intent','trade',?)").run(address, label, fillTime);
 }
 db.close();
}
before(async () => {
 home = await mkdtemp(path.join(os.tmpdir(), "mm-dual-purpose-api-"));
 process.env.MERRYMEN_HOME = home; process.env.MERRYMEN_HOSTED = "1"; process.env.MERRYMEN_SESSION_SECRET = "a".repeat(64);
 delete process.env.DATABASE_URL; delete process.env.MERRYMEN_STORE_DEK; resetGrantStoreForTest();
 for (const [purpose, address, dir] of [["spot", spot, "tenants"], ["perps", perps, "tenants-perps"]]) {
  await mkdir(path.join(home, dir), { recursive: true });
  await writeFile(path.join(home, dir, `${owner}.json`), JSON.stringify({ tenant: owner, grant: { smartAccount: address, chainId: 4663, ...(purpose === "perps" ? { purpose } : {}) }, sealedSessionKey: "test-key" }));
 }
 seedLedger(path.join(home, "merrymen.db"), [[spot, "spot-fill"], [perps, "perps-fill"]]);
 const details = readFileSync(path.resolve(import.meta.dirname, "../../../../../worker/src/perps/fixtures/orderBookDetails.perp.json"), "utf8");
 globalThis.fetch = async input => new URL(String(input)).pathname.endsWith("orderBookDetails") ? new Response(details) : Response.json({ code: 200, r: "5m", c: [] });
 ({ GET: account } = await import("./account/route")); ({ GET: activity } = await import("./activity/route")); ({ GET: chart } = await import("./chart/route"));
});
after(async () => { globalThis.fetch = oldFetch; resetGrantStoreForTest(); for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } await rm(home, { recursive: true, force: true }); });
it("one session selects each independent wallet and its exact private execution history", async () => {
 const a = await (await account(req("account"))).json(), b = await (await account(req("account?purpose=perps"))).json();
 assert.equal(a.account.smartAccount, spot); assert.equal(b.account.smartAccount, perps);
 for (const [suffix, label] of [["", "spot-fill"], ["&purpose=perps", "perps-fill"]]) {
  const response = await activity(req(`activity?market=all&book=paper${suffix}`)), data = await response.json();
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(data.state, "ok"); assert.deepEqual(data.items.map((v: { id: string }) => v.id), [`1:fill:1:${label}:bid`]);
 }
 const privateChart = await (await chart(req("chart?market=BTC-PERP&book=paper&window=24h&purpose=perps"))).json();
 assert.equal(privateChart.state, "ok"); assert.equal(privateChart.entries.length, 1);
 assert.match(JSON.stringify(privateChart.entries), /perps-fill/); assert.doesNotMatch(JSON.stringify(privateChart.entries), /spot-fill/);
 assert.equal((await (await account(req("account?purpose=perps", other as typeof owner))).json()).state, "not-configured");
});
it("duplicate, invalid and account-bearing purpose selectors never select another account", async () => {
 for (const suffix of ["purpose=other", "purpose=perps&purpose=spot", `purpose=perps&agent=${spot}`]) {
  assert.equal((await account(req(`account?${suffix}`))).status, 400);
  assert.equal((await activity(req(`activity?market=all&book=paper&${suffix}`))).status, 400);
  assert.equal((await chart(req(`chart?market=BTC-PERP&book=paper&window=24h&${suffix}`))).status, 400);
 }
});
it("self-hosted Perps reads only its own home and never falls back to the Spot ledger", async () => {
 process.env.MERRYMEN_HOSTED = "0";
 const dir = path.join(home, "accounts", "perps"); await mkdir(dir, { recursive: true });
 await writeFile(path.join(home, "grant.json"), JSON.stringify({ smartAccount: spot, chainId: 4663 }));
 await writeFile(path.join(dir, "grant.json"), JSON.stringify({ purpose: "perps", smartAccount: perps, chainId: 4663 }));
 const absent = await (await activity(req("activity?market=all&book=paper&purpose=perps"))).json();
 assert.equal(absent.state, "unreadable"); assert.deepEqual(absent.items, []);
 seedLedger(path.join(dir, "merrymen.db"), [[perps, "local-perps-fill"]]);
 const data = await (await activity(req("activity?market=all&book=paper&purpose=perps"))).json();
 assert.deepEqual(data.items.map((v: { id: string }) => v.id), ["1:fill:1:local-perps-fill:bid"]);
 assert.equal((await (await account(req("account"))).json()).account.smartAccount, spot);
});
