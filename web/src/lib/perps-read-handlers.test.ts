import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { mintSession, SESSION_COOKIE } from "./auth";
import { resetGrantStoreForTest } from "../../../worker/src/grant-store";
import { selectPerpsAccount, withPerpsReadDb } from "../app/api/perps/read-store";
import { readPerpsAccountResponse, readPerpsActivityResponse, readPerpsChartResponse, perpsReadDeps } from "../app/api/perps/read-handlers";
import { readPerpsAccount } from "./perps-account";
import { readPerpsActivity } from "./perps-activity";
import { readChartResponse } from "./perps-chart-response";
import { GET as accountGET } from "../app/api/perps/account/route";
import { GET as activityGET } from "../app/api/perps/activity/route";
import { GET as chartGET } from "../app/api/perps/chart/route";
import { GET as marketGET } from "../app/api/perps/market/route";
const addr = (n: string) => `0x${n.repeat(40)}` as `0x${string}`;
const A = addr("a"), B = addr("b"), OWNER = addr("c"), NOW = 1_790_000_000_000;
const env = { ...process.env };
let home: string;
before(() => { home = mkdtempSync(path.join(tmpdir(), "perps-private-reads-")); process.env.MERRYMEN_HOME = home; process.env.MERRYMEN_SESSION_SECRET = "x".repeat(40); delete process.env.DATABASE_URL; delete process.env.MERRYMEN_HOSTED; resetGrantStoreForTest(); });
after(() => { for (const k of ["MERRYMEN_HOME", "MERRYMEN_SESSION_SECRET", "MERRYMEN_HOSTED", "MERRYMEN_PERPS", "DATABASE_URL"]) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } resetGrantStoreForTest(); rmSync(home, { recursive: true, force: true }); });
const request = (query = "", tenant?: `0x${string}`) => new Request(`http://localhost/api/perps/account?wallet=perps${query}`, { headers: tenant ? { cookie: `${SESSION_COOKIE}=${mintSession(tenant)}` } : {} });
const identity = { state: "ready" as const, owner: OWNER, account: { smartAccount: A, chainId: 4663 } };
const report = { v: 1, mode: "paper", blocker: null, venueReadAt: NOW, protectAt: NOW, accountIndex: null, positions: [], openNotionalMicro: "0", collateralMicro: "100000000", inTransitMicro: "0", minLiqDistanceBps: null, stopsMissing: 0, incident: false };
it("all read routes reject missing/ambiguous wallet and are 404 off before auth or storage", async () => {
  for (const GET of [accountGET, activityGET, chartGET, marketGET]) {
    for (const q of ["", "?wallet=spot", "?wallet=perps&wallet=spot", "?Wallet=perps"]) assert.equal((await GET(new Request(`http://localhost/api/perps/account${q}`))).status, 400);
    process.env.MERRYMEN_HOSTED = "1";
    for (const value of [undefined, "off", "live", "typo"]) {
      if (value === undefined) delete process.env.MERRYMEN_PERPS; else process.env.MERRYMEN_PERPS = value;
      const res = await GET(request()); assert.equal(res.status, 404); assert.equal(res.headers.get("cache-control"), "private, no-store");
    }
  }
  process.env.MERRYMEN_PERPS = "paper";
  for (const GET of [accountGET, activityGET, chartGET]) assert.equal((await GET(request())).status, 401);
  delete process.env.MERRYMEN_HOSTED;
});
it("selection never falls back to Spot and distinguishes missing, malformed, wrong-purpose and inaccessible grants", async () => {
  writeFileSync(path.join(home, "grant.json"), JSON.stringify({ smartAccount: B, chainId: 4663 }));
  assert.equal((await selectPerpsAccount(request())).state, "not-configured");
  const dir = path.join(home, "accounts/perps"); mkdirSync(dir, { recursive: true });
  for (const value of ["{", JSON.stringify({ smartAccount: B, chainId: 4663 }), "null"]) {
    writeFileSync(path.join(dir, "grant.json"), value); assert.equal((await selectPerpsAccount(request())).state, "unread");
  }
  writeFileSync(path.join(dir, "grant.json"), JSON.stringify({ purpose: "perps", smartAccount: A, chainId: 4663, demoOwnerPrivateKey: "never-return" }));
  assert.deepEqual(await selectPerpsAccount(request()), { ...identity, owner: null });
  assert.doesNotMatch(JSON.stringify(await selectPerpsAccount(request())), /never-return/);
});
it("local selection keeps a stopped renewal distinct from missing, under the writer lock", async () => {
  const dir = path.join(home, "accounts/perps"), file = path.join(dir, "grant.json"), binding = path.join(dir, "permission-replacement.json");
  const { withLocalStateLock } = await import("../../../worker/src/local-state-lock");
  const { retainLocalPerpsBinding } = await import("../../../worker/src/local-perps-binding");
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writing = withLocalStateLock(home, async () => {
    rmSync(file); entered(); await gate;
    retainLocalPerpsBinding({ purpose: "perps", owner: OWNER, smartAccount: A, sessionKeyAddress: B, chainId: 4663 }, dir);
  });
  await ready; let finished = false;
  const reading = selectPerpsAccount(request()).then(value => { finished = true; return value; });
  try { await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(finished, false); }
  finally { release(); await writing; }
  assert.equal((await reading).state, "unread");
  writeFileSync(binding, "{broken"); assert.equal((await selectPerpsAccount(request())).state, "unread");
  rmSync(binding); assert.equal((await selectPerpsAccount(request())).state, "not-configured");
});
it("hosted selection follows the signed tenant's Perps store only; corrupt records are unread", async () => {
  process.env.MERRYMEN_HOSTED = "1";
  for (const dir of ["tenants", "tenants-perps"]) mkdirSync(path.join(home, dir), { recursive: true });
  const record = (purpose: string, smartAccount: string) => ({ tenant: OWNER, grant: { purpose, smartAccount, chainId: 4663 }, updatedAt: Date.now() });
  writeFileSync(path.join(home, "tenants", `${OWNER}.json`), JSON.stringify(record("spot", B)));
  assert.equal((await selectPerpsAccount(request("", OWNER))).state, "not-configured");
  writeFileSync(path.join(home, "tenants-perps", `${OWNER}.json`), JSON.stringify(record("perps", A)));
  assert.deepEqual(await selectPerpsAccount(request("", OWNER)), identity);
  assert.equal((await selectPerpsAccount(request("", B))).state, "not-configured");
  writeFileSync(path.join(home, "tenants-perps", `${OWNER}.json`), "{bad");
  assert.equal((await selectPerpsAccount(request("", OWNER))).state, "unread");
  delete process.env.MERRYMEN_HOSTED;
});
it("a corrupt existing Perps ledger is unreadable, while a missing file remains missing", async () => {
  assert.equal(await withPerpsReadDb(async db => db), null);
  const file = path.join(home, "accounts/perps/merrymen.db"); writeFileSync(file, "corrupt sqlite");
  await assert.rejects(withPerpsReadDb(async db => { if (!db) return "missing"; return db.prepare("SELECT * FROM agents").all(); }));
  rmSync(file); mkdirSync(file); await assert.rejects(withPerpsReadDb(async () => "missing")); rmSync(file, { recursive: true });
});
it("account, activity and chart bind every row to the selected account and paper mode", async () => {
  const raw = new DatabaseSync(":memory:");
  try {
    raw.exec("CREATE TABLE agents(smart_account TEXT,mode TEXT,perps TEXT); CREATE TABLE perp_fills(agent_id TEXT,mode TEXT,market_id INTEGER,epoch INTEGER,venue_trade_id TEXT,side_role TEXT,side TEXT,base TEXT,price TEXT,position_before TEXT,realized_micro TEXT,fee_micro TEXT,attribution TEXT,trade_type TEXT,venue_ts_ms INTEGER); CREATE TABLE perp_funding(agent_id TEXT,mode TEXT,market_id INTEGER,epoch INTEGER,funding_id TEXT,funding_hour INTEGER,payment_micro TEXT)");
    raw.prepare("INSERT INTO agents VALUES(?,?,?)").run(A, "paper", JSON.stringify({ ...report, privateKey: "secret" }));
    for (const [account, mode, id] of [[A, "paper", "mine"], [A, "live", "live-secret"], [B, "paper", "other-secret"]])
      raw.prepare("INSERT INTO perp_fills VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(account, mode, 1, 1, id, "bid", "long", "100", "1000000", "0", null, "0", "intent", "trade", NOW - 1000);
    const db = wrapSqlite(raw);
    const deps = { ...perpsReadDeps, select: async () => identity, now: () => NOW, db: async <T>(fn: (db: Db | null) => Promise<T>) => fn(db), spec: async () => ({ marketId: 1, priceDecimals: 1, sizeDecimals: 5 }) as any, candles: async () => ({ state: "none" as const, bars: [], gaps: [], stale: true, asOfMs: null }) };
    const account = await (await readPerpsAccountResponse(request(), deps)).json();
    assert.ok(readPerpsAccount(account)); assert.equal(account.report.state, "ok"); assert.equal(account.activityCounts.paper, 1); assert.doesNotMatch(JSON.stringify(account), /secret/);
    const q = { market: "BTC-PERP", book: "paper" as const };
    const activity = await (await readPerpsActivityResponse(request("&market=BTC-PERP&book=paper"), deps)).json();
    assert.ok(readPerpsActivity(activity, q)); assert.deepEqual(activity.account, identity.account); assert.equal(activity.owner, OWNER); assert.equal(activity.items.length, 1); assert.match(activity.items[0].id, /mine/);
    const chart = await (await readPerpsChartResponse(request("&market=BTC-PERP&book=paper&window=24h"), false, deps)).json();
    assert.ok(readChartResponse(chart, { ...q, window: "24h" })); assert.deepEqual(chart.account, identity.account); assert.equal(chart.entries.length, 1); assert.match(chart.entries[0].id, /mine/);
    assert.doesNotMatch(JSON.stringify({ activity, chart }), /other-secret|live-secret/);
    for (const reader of [readPerpsAccountResponse, readPerpsActivityResponse]) {
      const res = await reader(request(reader === readPerpsAccountResponse ? "" : "&market=all&book=paper"), { ...deps, db: async () => { throw new Error("secret URL"); } });
      const body = await res.json(); assert.doesNotMatch(JSON.stringify(body), /secret URL/); assert.equal(reader === readPerpsAccountResponse ? body.report.state : body.state, "unreadable");
    }
  } finally { raw.close(); }
});
it("signed-out public preview cannot select an account and its quota cannot be bypassed using a forwarded IP", async () => {
  process.env.MERRYMEN_HOSTED = "1";
  const deps = { ...perpsReadDeps, select: async () => { throw new Error("private selection called"); }, db: async () => { throw new Error("private ledger called"); }, now: () => NOW, spec: async () => null };
  const req = request("&market=BTC-PERP&window=24h");
  const res = await readPerpsChartResponse(req, true, deps); assert.equal(res.status, 200);
  const body = await res.json(); assert.equal(body.owner, null); assert.equal(body.account, null); assert.deepEqual(body.entries, []);
  for (let i = 1; i < 60; i++) assert.equal((await readPerpsChartResponse(new Request(req, { headers: { "x-forwarded-for": `192.0.2.${i}` } }), true, deps)).status, 200);
  const blocked = await readPerpsChartResponse(req, true, deps); assert.equal(blocked.status, 429); assert.ok(blocked.headers.get("retry-after"));
  for (const extra of ["&agent=" + B, "&owner=" + B, "&book=paper", "&window=7d"]) assert.equal((await readPerpsChartResponse(request("&market=BTC-PERP&window=24h" + extra), true, deps)).status, 400);
  delete process.env.MERRYMEN_HOSTED;
});
it("private wire readers reject absent or malformed identity", () => {
  const common = { owner: "not-an-address", account: null, state: "unreadable", generatedAtMs: NOW, market: "BTC-PERP", book: "paper", window: "24h", items: [], unknownRows: 0, truncated: false };
  assert.equal(readPerpsActivity(common, { market: "BTC-PERP", book: "paper" }), null);
  assert.equal(readPerpsActivity({ ...common, owner: null, account: { smartAccount: B, chainId: "4663" } }, { market: "BTC-PERP", book: "paper" }), null);
});
