import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { before, after, it } from "node:test";
import { mintSession } from "@/lib/auth";
import { resetGrantStoreForTest } from "@merrymen/grant-store";
import { readPerpsActivity } from "@/lib/perps-activity";
const keys = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_STORE_DEK"] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const oldFetch = globalThis.fetch;
const A = `0x${"aa".repeat(20)}` as const, B = `0x${"bb".repeat(20)}` as const;
const agentA = `0x${"cc".repeat(20)}`, agentB = `0x${"dd".repeat(20)}`;
let home: string, calls = 0;
let market: (req: Request) => Promise<Response>, chart: typeof market, activity: typeof market;
const now = Date.now(), time = Math.floor(now / 3600_000) * 3600_000;
const req = (route: string, owner?: typeof A | typeof B) => new Request(`http://localhost/api/perps/${route}`, { headers: owner ? { cookie: `mm_session=${mintSession(owner)}` } : {} });
before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "mm-perps-data-"));
  process.env.MERRYMEN_HOME = home; process.env.MERRYMEN_HOSTED = "1"; process.env.MERRYMEN_SESSION_SECRET = "a".repeat(64);
  delete process.env.DATABASE_URL; delete process.env.MERRYMEN_STORE_DEK; resetGrantStoreForTest();
  const details = readFileSync(path.resolve(import.meta.dirname, "../../../../../../worker/src/perps/fixtures/orderBookDetails.perp.json"), "utf8");
  globalThis.fetch = async input => {
    calls++; const u = new URL(String(input));
    if (u.pathname.endsWith("orderBookDetails")) return new Response(details, { headers: { "Content-Type": "application/json" } });
    assert.ok(u.pathname.endsWith("markPriceCandles"));
    return Response.json({ code: 200, r: "5m", c: [{ t: Math.floor(now / 300_000) * 300_000 - 300_000, o: 80000, h: 80100, l: 79900, c: 80050 }] });
  };
  ({ GET: market } = await import("./route")); ({ GET: chart } = await import("../chart/route")); ({ GET: activity } = await import("../activity/route"));
});
after(async () => {
  globalThis.fetch = oldFetch; resetGrantStoreForTest();
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  await rm(home, { recursive: true, force: true });
});
it("public market works signed out without a ledger or grant and cannot accept an owner selector", async () => {
  const response = await market(req("market?market=BTC-PERP&window=24h"));
  const data = await response.json();
  assert.equal(data.candles.state, "ok"); assert.equal(data.state, "not-configured"); assert.deepEqual(data.entries, []);
  assert.equal("positions" in data, false);
  assert.equal((await market(req(`market?market=BTC-PERP&window=24h&agent=${agentA}`))).status, 400);
  assert.equal((await chart(req("chart?market=BTC-PERP&book=paper&window=24h"))).status, 401);
  assert.equal((await activity(req("activity?market=BTC-PERP&book=paper"))).status, 401);
});
it("public candles remain visible when an authenticated owner's ledger is unavailable", async () => {
  await mkdir(path.join(home, "tenants"));
  for (const [tenant, agent] of [[A, agentA], [B, agentB]]) await writeFile(path.join(home, "tenants", `${tenant}.json`), JSON.stringify({ tenant, grant: { smartAccount: agent }, sealedSessionKey: "0x01" }));
  const data = await (await chart(req("chart?market=BTC-PERP&book=paper&window=24h", A))).json();
  assert.equal(data.state, "unreadable"); assert.equal(data.candles.state, "ok"); assert.deepEqual(data.entries, []);
  assert.equal(calls, 2, "owner reads share only already cached public facts");
  const result = await (await activity(req("activity?market=BTC-PERP&book=paper", A))).json();
  assert.equal(result.state, "unreadable");
});
it("actual fill and funding activity isolates tenant, market and book and keeps exact values", async () => {
  const db = new DatabaseSync(path.join(home, "merrymen.db"));
  db.exec(`CREATE TABLE perp_fills (agent_id TEXT,mode TEXT,market_id INTEGER,epoch INTEGER,venue_trade_id TEXT,side_role TEXT,side TEXT,base TEXT,price TEXT,position_before TEXT,realized_micro TEXT,fee_micro TEXT,attribution TEXT,trade_type TEXT,venue_ts_ms INTEGER);
    CREATE TABLE perp_funding (agent_id TEXT,mode TEXT,market_id INTEGER,epoch INTEGER,funding_id TEXT,funding_hour INTEGER,payment_micro TEXT);`);
  const insert = db.prepare("INSERT INTO perp_fills VALUES (?,?,?,2,?,'ask','long','100','832186','100','123456','12','venue-stop','trade',?)");
  insert.run(agentA, "paper", 1, "a-close", time + 1000); insert.run(agentB, "paper", 1, "b-close", time + 1000);
  insert.run(agentA, "live", 1, "a-live", time + 1000); insert.run(agentA, "paper", 0, "a-other-market", time + 1000);
  db.prepare("INSERT INTO perp_funding VALUES (?,'paper',1,2,'a-funding',?,'-101')").run(agentA, time / 1000);
  db.close();
  const q = { market: "BTC-PERP", book: "paper" as const };
  const response = await activity(req("activity?market=BTC-PERP&book=paper", A));
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  const data = readPerpsActivity(await response.json(), q)!;
  assert.ok(data); assert.equal(data.state, "ok"); assert.equal(data.items.length, 2);
  const fill = data.items[0]; assert.equal(fill.kind, "fill");
  if (fill.kind === "fill") { assert.equal(fill.effect, "close"); assert.equal(fill.priceExact, "83218.6"); assert.equal(fill.sizeExact, "0.00100"); assert.equal(fill.realizedMicro, "123456"); }
  assert.equal(data.items[1].kind, "funding");
  const other = await (await activity(req("activity?market=BTC-PERP&book=paper", B))).json();
  assert.deepEqual(other.items.map((row: { id: string }) => row.id), ["fill:2:b-close:ask"]);
  const live = await (await activity(req("activity?market=BTC-PERP&book=live", A))).json();
  assert.deepEqual(live.items.map((row: { id: string }) => row.id), ["fill:2:a-live:ask"]);
  assert.equal((await activity(req(`activity?market=BTC-PERP&book=paper&agent=${agentB}`, A))).status, 400);
});
it("all-market activity retains each actual market but never another owner or book", async () => {
  const q = { market: "all", book: "paper" as const };
  const data = readPerpsActivity(await (await activity(req("activity?market=all&book=paper", A))).json(), q)!;
  assert.ok(data); assert.equal(data.state, "ok"); assert.equal(data.items.length, 3);
  assert.deepEqual(new Set(data.items.map(item => item.market)), new Set(["BTC-PERP", "ETH-PERP"]));
  assert.equal(data.items.some(item => item.id.includes("b-close") || item.id.includes("a-live")), false);
  const other = readPerpsActivity(await (await activity(req("activity?market=all&book=paper", B))).json(), q)!;
  assert.equal(other.items.length, 1); assert.ok(other.items[0].id.includes("b-close"));
});
