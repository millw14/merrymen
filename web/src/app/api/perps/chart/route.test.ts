import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";

import { mintSession } from "@/lib/auth";
import { resetGrantStoreForTest } from "@merrymen/grant-store";
const envKeys = ["MERRYMEN_HOSTED", "MERRYMEN_HOME", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_STORE_DEK"] as const;
const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let home: string;
let GET: (req: Request) => Promise<Response>;
const url = "http://localhost/api/perps/chart?market=BTC-PERP&book=paper&window=24h";
const AGENT = "0xa6e17a1b2c3d4e5f60718293a4b5c6d7e8f90124";

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), "mm-perp-chart-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_SESSION_SECRET = "a".repeat(64);
  delete process.env.DATABASE_URL;
  delete process.env.MERRYMEN_STORE_DEK;
  resetGrantStoreForTest();
  ({ GET } = await import("./route"));
});

after(async () => {
  for (const key of envKeys) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetGrantStoreForTest();
  await rm(home, { recursive: true, force: true });
});

describe("GET /api/perps/chart owner perimeter", () => {
  it("returns 401 before parsing params or reading any agent for a signed-out hosted request", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    const res = await GET(new Request(`${url}&agent=0xdead`));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "not signed in", code: "not-signed-in" });
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  });

  it("rejects account selectors and unknown markets; missing local grant has stable unavailable schema", async () => {
    delete process.env.MERRYMEN_HOSTED;
    const rejected = await GET(new Request(`${url}&agent=0xdead`));
    assert.equal(rejected.status, 400);
    assert.equal(rejected.headers.get("Cache-Control"), "private, no-store");
    assert.equal((await GET(new Request(url.replace("BTC-PERP", "UNKNOWN-PERP")))).status, 400);

    const empty = await GET(new Request(url));
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get("Cache-Control"), "private, no-store");
    const body = await empty.json() as Record<string, unknown>;
    assert.equal(body.state, "not-configured");
    assert.equal(body.market, "BTC-PERP");
    assert.equal(body.book, "paper");
    assert.deepEqual(body.entries, []);
    assert.equal(typeof body.generatedAtMs, "number");
    assert.deepEqual(body.candles, { state: "unreadable", bars: [], gaps: [], stale: true, asOfMs: null });
  });

  it("reads the local agent's exact fill and vetted venue mark candles without an external call", async () => {
    delete process.env.MERRYMEN_HOSTED;
    await writeFile(path.join(home, "grant.json"), JSON.stringify({ smartAccount: AGENT }));
    const db = new DatabaseSync(path.join(home, "merrymen.db"));
    const fillAt = Date.now() - 30 * 60_000;
    try {
      db.exec(`CREATE TABLE perp_fills (
        agent_id TEXT, mode TEXT, epoch INTEGER, venue_trade_id TEXT, side_role TEXT,
        market_id INTEGER, base TEXT, price TEXT, position_before TEXT, attribution TEXT, venue_ts_ms INTEGER
      )`);
      db.prepare(`INSERT INTO perp_fills VALUES (?, 'paper', 2, 'own-fill', 'bid', 1, '100', '832186', '0', 'intent', ?)`)
        .run(AGENT, fillAt);
      db.prepare(`INSERT INTO perp_fills VALUES (?, 'paper', 2, 'other-agent', 'bid', 1, '100', '999999', '0', 'intent', ?)`)
        .run("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", fillAt);
      db.prepare(`INSERT INTO perp_fills VALUES (?, 'live', 2, 'other-book', 'bid', 1, '100', '999999', '0', 'intent', ?)`)
        .run(AGENT, fillAt);
    } finally { db.close(); }

    const details = readFileSync(path.resolve(import.meta.dirname,
      "../../../../../../worker/src/perps/fixtures/orderBookDetails.perp.json"), "utf8");
    const step = 300_000;
    const t = Math.floor(Date.now() / step) * step;
    const candle = (time: number) => ({ t: time, o: 83218.6, h: 83230, l: 83210, c: 83225 });
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    let candlesUnavailable = false;
    globalThis.fetch = async (input, init) => {
      const u = new URL(String(input));
      calls.push(u.pathname);
      assert.equal(init?.method, "GET");
      if (u.pathname === "/api/v1/orderBookDetails") return new Response(details, { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.pathname === "/api/v1/markPriceCandles") return candlesUnavailable
        ? Response.json({ code: 503, message: "venue unavailable" }, { status: 503 })
        : Response.json({ code: 200, r: "5m", c: [candle(t - 2 * step), candle(t - step)] });
      throw new Error(`unexpected venue route ${u.pathname}`);
    };
    try {
      const res = await GET(new Request(url));
      assert.equal(res.status, 200);
      const body = await res.json() as Record<string, any>;
      assert.equal(body.state, "ok");
      assert.equal(body.candles.state, "ok");
      assert.equal(body.candles.bars.length, 2);
      assert.equal(body.candles.bars[0].open, 83218.6);
      assert.deepEqual(body.entries.map((e: Record<string, unknown>) => [e.id, e.priceExact, e.timeMs]),
        [["2:own-fill:bid", "83218.6", fillAt]]);
      assert.deepEqual(calls, ["/api/v1/orderBookDetails", "/api/v1/markPriceCandles"]);
      // Hosted identity comes from the signed session → grant-store mapping,
      // even though both accounts share the same public candle-cache entry.
      process.env.MERRYMEN_HOSTED = "1";
      const owners = ["0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "0xcccccccccccccccccccccccccccccccccccccccc"] as const;
      await mkdir(path.join(home, "tenants"));
      for (let i = 0; i < owners.length; i++) await writeFile(path.join(home, "tenants", `${owners[i]}.json`), JSON.stringify({
        tenant: owners[i], grant: { smartAccount: i === 0 ? AGENT : "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, sealedSessionKey: "0x01", updatedAt: 1,
      }));
      for (let i = 0; i < owners.length; i++) {
        const hosted = await (await GET(new Request(url, { headers: { cookie: `mm_session=${mintSession(owners[i])}` } }))).json() as Record<string, any>;
        assert.equal(hosted.state, "ok");
        assert.deepEqual(hosted.entries.map((entry: { id: string }) => entry.id), [i === 0 ? "2:own-fill:bid" : "2:other-agent:bid"]);
      }
      assert.deepEqual(calls, ["/api/v1/orderBookDetails", "/api/v1/markPriceCandles"], "only public candles and specs are shared between tenants");
      delete process.env.MERRYMEN_HOSTED;
      candlesUnavailable = true;
      // A same-window read is correctly served from the shared public candle
      // cache. Change window to force a distinct venue read while keeping the
      // same owner-scoped execution tape.
      const degraded = await (await GET(new Request(url.replace("window=24h", "window=7d")))).json() as Record<string, any>;
      assert.equal(degraded.state, "ok", "the local execution history is still readable");
      assert.equal(degraded.candles.state, "unreadable", "a venue failure is never an empty/flat chart");
      assert.equal(degraded.entries.length, 1);
    } finally { globalThis.fetch = originalFetch; }
  });
});
