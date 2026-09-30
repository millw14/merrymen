import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import {
  LighterApiArgumentError,
  clearLighterCooldown,
  createLighterApi,
  lighterCooldownFile,
  publishLighterCooldown,
  readLighterCooldown,
  resetLighterApiState,
  type LighterApiOptions,
  type LighterFetch,
  type LighterResult,
} from "./api";
import { parseOrderBookDetails } from "./markets";

/**
 * Every test drives the client through a fake fetch that records what was
 * sent and answers with real `Response` objects (so bodies are real streams,
 * the way bounded-read.ts sees them in production). No network, ever.
 */

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const fixture = (f: string) => readFileSync(path.join(FIXTURES, f), "utf8");
const DEC = parseOrderBookDetails(JSON.parse(fixture("orderBookDetails.perp.json")))!.decimals;

const ROOT = mkdtempSync(path.join(os.tmpdir(), "merrymen-lighter-api-"));
const HOME = path.join(ROOT, "children", "tenant-a");
const FLEET = path.join(ROOT, "fleet");
const priorFleet = process.env.MERRYMEN_FLEET_HOME;
process.env.MERRYMEN_FLEET_HOME = FLEET;
after(() => {
  if (priorFleet === undefined) delete process.env.MERRYMEN_FLEET_HOME;
  else process.env.MERRYMEN_FLEET_HOME = priorFleet;
  rmSync(ROOT, { recursive: true, force: true });
});

let clock = 1_790_700_000_000;
beforeEach(() => {
  resetLighterApiState();
  clearLighterCooldown(HOME);
  clock += 3_600_000; // every test starts outside any earlier minute
});

type Init = Parameters<LighterFetch>[1];
interface Call {
  url: URL;
  init: Init;
}

function fake(handler: (url: URL, init: Init) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn: LighterFetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    return handler(u, init);
  };
  return { fn, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const L1 = "0x8e93b78ef08d5e36da2e2473cd9027f8c286c176";
const AUTH = `${Math.floor(clock / 1000) + 3600}:22149:16:${"ab".repeat(80)}`;
const HASH = "1d806b896ed335c5c943e0beac9b5ab886a460c62c6aacdee5035b087ac5f4bb5e32507566babdd0";
/** An address-keyed client authenticates every request (ONE IDENTITY in api.ts). */
const A = { auth: AUTH } as const;

function api(fn: LighterFetch, over: Partial<LighterApiOptions> = {}) {
  return createLighterApi({ home: HOME, budgetKey: L1, fetchFn: fn, now: () => clock, ...over });
}

function err<T, E>(r: LighterResult<T, E>) {
  assert.equal(r.ok, false, "expected a failure");
  if (r.ok) throw new Error("unreachable");
  return r.error;
}

// ── reads parse through the strict parsers ──────────────────────────────────

test("reads return parsed values, with the venue's Date for skew", async () => {
  const f = fake((u) => {
    if (u.pathname === "/api/v1/orderBookDetails") return json(200, fixture("orderBookDetails.perp.json"), { date: "Tue, 29 Sep 2026 16:30:00 GMT" });
    if (u.pathname === "/api/v1/account") return json(200, fixture("account.22149.isolated.json"));
    return json(404, { code: 404, message: "no" });
  });
  const a = api(f.fn);
  const obd = await a.orderBookDetails(undefined, A);
  assert.ok(obd.ok);
  assert.equal(obd.value.markets.size, 57);
  assert.equal(obd.serverDateMs, Date.parse("Tue, 29 Sep 2026 16:30:00 GMT"));
  assert.equal(f.calls[0]!.url.origin, "https://api.rh.lighter.xyz");
  assert.equal(f.calls[0]!.url.searchParams.get("filter"), "perp");
  const acct = await a.account({ by: "index", accountIndex: 22149 }, DEC, { auth: AUTH });
  assert.ok(acct.ok);
  assert.equal(acct.value.venueValueMicro, 150_857_032n);
  const call = f.calls[1]!;
  assert.equal(call.url.searchParams.get("by"), "index");
  assert.equal(call.url.searchParams.get("value"), "22149");
  // The token is a header, never a query parameter, and redirects are refused.
  assert.equal(call.init.headers.authorization, AUTH);
  assert.equal(call.url.search.includes("ab".repeat(20)), false);
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.method, "GET");
  // Asked for 22149, answered for someone else: not an answer.
  const other = await a.account({ by: "index", accountIndex: 22150 }, DEC, A);
  assert.equal(err(other).kind, "malformed");
});

test("query parameter names match the venue's", async () => {
  const f = fake(() => json(200, { code: 200, r: "1h", c: [] }));
  const a = api(f.fn);
  await a.markPriceCandles({ marketId: 1, resolution: "4h", startSec: 1_790_000_000, endSec: 1_790_600_000, countBack: 200, priceDecimals: 1 }, A);
  await a.fundings({ marketId: 1, resolution: "1h", startSec: 1_790_000_000, endSec: 1_790_600_000, countBack: 48 }, A);
  await a.apikeys(22149, 16, A);
  await a.nextNonce(22149, 16, A);
  await a.orderBookOrders(1, 20, DEC.get(1)!, A);
  await a.trades({ accountIndex: 22149, limit: 100, orderIndex: "7599824390440187" }, DEC, { auth: AUTH });
  await a.positionFunding({ accountIndex: 22149, limit: 50 }, DEC, { auth: AUTH });
  await a.accountActiveOrders(22149, DEC, { auth: AUTH }, 1);
  await a.withdrawHistory({ accountIndex: 22149, filter: "pending" }, { auth: AUTH });
  await a.accountsByL1Address(L1.toUpperCase().replace("0X", "0x"), A);
  await a.tx(`0x${HASH.toUpperCase()}`, A);
  const q = f.calls.map((c) => [c.url.pathname, Object.fromEntries(c.url.searchParams)]);
  assert.deepEqual(q, [
    ["/api/v1/markPriceCandles", { market_id: "1", resolution: "4h", start_timestamp: "1790000000", end_timestamp: "1790600000", count_back: "200" }],
    ["/api/v1/fundings", { market_id: "1", resolution: "1h", start_timestamp: "1790000000", end_timestamp: "1790600000", count_back: "48" }],
    ["/api/v1/apikeys", { account_index: "22149", api_key_index: "16" }],
    ["/api/v1/nextNonce", { account_index: "22149", api_key_index: "16" }],
    ["/api/v1/orderBookOrders", { market_id: "1", limit: "20" }],
    ["/api/v1/trades", { account_index: "22149", sort_by: "timestamp", limit: "100", market_type: "perp", order_index: "7599824390440187" }],
    ["/api/v1/positionFunding", { account_index: "22149", limit: "50" }],
    ["/api/v1/accountActiveOrders", { account_index: "22149", market_type: "perp", market_id: "1" }],
    ["/api/v1/withdraw/history", { account_index: "22149", filter: "pending" }],
    ["/api/v1/accountsByL1Address", { l1_address: L1 }],
    ["/api/v1/tx", { by: "hash", value: HASH }],
  ]);
});

// ── the error taxonomy ──────────────────────────────────────────────────────

test("/tx: HTTP 400 code 21500 is not-found; nothing else is", async () => {
  const notFound = fake(() => json(400, fixture("tx.notfound.json")));
  const nf = err(await api(notFound.fn).tx(HASH, A));
  assert.equal(nf.kind, "not-found");
  assert.equal(nf.retryable, false);
  // Another 400 on /tx is a rejection…
  const other = err(await api(fake(() => json(400, { code: 21100, message: "bad hash" })).fn).tx(HASH, A));
  assert.deepEqual([other.kind, other.kind === "rejected" ? other.code : null], ["rejected", 21100]);
  // …21500 in a 200, or from any other endpoint, is not not-found…
  assert.equal(err(await api(fake(() => json(200, { code: 21500, message: "x" })).fn).tx(HASH, A)).kind, "rejected");
  assert.equal(err(await api(fake(() => json(400, { code: 21500, message: "x" })).fn).account({ by: "index", accountIndex: 1 }, DEC, A)).kind, "rejected");
  // …and a 5xx, a timeout or an unreadable body is unknown, never not-found.
  assert.equal(err(await api(fake(() => json(503, "busy")).fn).tx(HASH, A)).kind, "unavailable");
  assert.equal(err(await api(fake(() => json(400, "<html>blocked</html>")).fn).tx(HASH, A)).kind, "unavailable");
  assert.equal(err(await api(fake(() => json(200, { code: 200, hash: "nope" })).fn).tx(HASH, A)).kind, "malformed");
  const ok = await api(fake(() => json(200, fixture("tx.1d806b89.json"))).fn).tx(HASH, A);
  assert.ok(ok.ok);
  assert.equal(ok.value.status, "executed");
});

test("4xx with a venue code is rejected (with the market); without one it is unavailable", async () => {
  const r = err(await api(fake(() => json(400, { code: 21602, message: "invalid market index" })).fn).orderBookOrders(3, 10, DEC.get(3)!, A));
  assert.equal(r.kind, "rejected");
  if (r.kind === "rejected") {
    assert.equal(r.code, 21602);
    assert.equal(r.marketId, 3);
    assert.match(r.detail, /invalid market index/);
  }
  const blocked = err(await api(fake(() => new Response("<html>403 ERROR</html>", { status: 403, headers: { "content-type": "text/html" } })).fn).orderBooks(A));
  assert.equal(blocked.kind, "unavailable");
  assert.equal(blocked.retryable, true);
});

test("5xx, network failure and timeout are unavailable", async () => {
  assert.equal(err(await api(fake(() => json(502, { code: 502 })).fn).withdrawalDelay(A)).kind, "unavailable");
  const net = err(
    await api(
      fake(() => {
        throw new TypeError("fetch failed");
      }).fn,
    ).withdrawalDelay(A),
  );
  assert.equal(net.kind, "unavailable");
  const hang = fake((_u, init) => new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))));
  const t0 = Date.now();
  const to = err(await api(hang.fn, { timeoutMs: 40 }).withdrawalDelay(A));
  assert.equal(to.kind, "unavailable");
  assert.match(to.detail, /timed out after 40 ms/);
  assert.ok(Date.now() - t0 < 2_000);
  // Headers promptly, then a body that never ends: the same deadline holds.
  const trickle = fake(() => new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('{"seconds":')) }), { status: 200 }));
  const tb = err(await api(trickle.fn, { timeoutMs: 40 }).withdrawalDelay(A));
  assert.equal(tb.kind, "unavailable");
  assert.match(tb.detail, /timed out/);
});

test("malformed: bad JSON, an answer the parser refuses, an oversized body, a venue error in a 200", async () => {
  assert.equal(err(await api(fake(() => json(200, "{not json")).fn).withdrawalDelay(A)).kind, "malformed");
  assert.equal(err(await api(fake(() => json(200, { seconds: "1114" })).fn).withdrawalDelay(A)).kind, "malformed");
  const big = err(await api(fake(() => json(200, fixture("orderBookDetails.perp.json"))).fn, { maxBytes: 10_000 }).orderBookDetails(undefined, A));
  assert.equal(big.kind, "malformed");
  const inA200 = err(await api(fake(() => json(200, { code: 20001, message: "auth required for main accounts" })).fn).positionFunding({ accountIndex: 1, limit: 10 }, DEC, { auth: AUTH }));
  assert.deepEqual([inA200.kind, inA200.kind === "rejected" ? inA200.code : null], ["rejected", 20001]);
  const ok = await api(fake(() => json(200, fixture("withdrawalDelay.json"))).fn).withdrawalDelay(A);
  assert.deepEqual(ok.ok && ok.value, 1114);
});

// ── the fleet cooldown ──────────────────────────────────────────────────────

test("429 publishes a ≥60 s fleet cooldown; other requests stop, exits still go", async () => {
  const f = fake((u) => (u.pathname === "/api/v1/orderBooks" ? json(429, "slow down") : json(200, fixture("withdrawalDelay.json"))));
  const a = api(f.fn);
  const r = err(await a.orderBooks(A));
  assert.equal(r.kind, "rate-limited");
  if (r.kind === "rate-limited") {
    assert.equal(r.source, "venue");
    assert.equal(r.status, 429);
    assert.ok(r.retryAfterMs >= 60_000);
  }
  // The file is in the FLEET home, where every child reads it — not the child's own.
  const file = lighterCooldownFile(HOME);
  assert.equal(path.dirname(file), FLEET);
  assert.ok(existsSync(file));
  const until = readLighterCooldown(HOME, clock);
  assert.ok(until !== null && until >= clock + 60_000);
  // A non-exit read is not sent at all.
  const n = f.calls.length;
  const held = err(await a.withdrawalDelay(A));
  assert.deepEqual([held.kind, held.kind === "rate-limited" ? held.source : null], ["rate-limited", "cooldown"]);
  assert.equal(f.calls.length, n);
  // Another client in another process sees the same file.
  resetLighterApiState();
  const b = api(f.fn, { budgetKey: "0x0000000000000000000000000000000000000002" });
  assert.equal(err(await b.withdrawalDelay(A)).kind, "rate-limited");
  assert.equal(f.calls.length, n);
  // An exit is still attempted.
  const exit = await b.withdrawalDelay({ exit: true, auth: AUTH });
  assert.ok(exit.ok);
  assert.equal(f.calls.length, n + 1);
  // And after the cooldown, everything resumes.
  clock += 61_000;
  assert.ok((await b.withdrawalDelay(A)).ok);
});

test("405 is a rate limit too, and so is venue code 23000 in any status", async () => {
  const r405 = err(await api(fake(() => json(405, "")).fn).orderBooks(A));
  assert.deepEqual([r405.kind, r405.kind === "rate-limited" ? r405.status : null], ["rate-limited", 405]);
  assert.ok(readLighterCooldown(HOME, clock) !== null);
  resetLighterApiState();
  clearLighterCooldown(HOME);
  const r23 = err(await api(fake(() => json(400, { code: 23000, message: "Too Many Requests!" })).fn).orderBooks(A));
  assert.equal(r23.kind, "rate-limited");
  assert.ok(readLighterCooldown(HOME, clock) !== null);
});

test("a cooldown file claiming more than 10 minutes, or corrupt, is advice ignored", async () => {
  const f = fake(() => json(200, fixture("withdrawalDelay.json")));
  publishLighterCooldown(HOME, clock + 24 * 3_600_000, "a broken writer");
  assert.equal(readLighterCooldown(HOME, clock), null);
  assert.ok((await api(f.fn).withdrawalDelay(A)).ok);
  writeFileSync(lighterCooldownFile(HOME), "{torn");
  assert.equal(readLighterCooldown(HOME, clock), null);
  assert.ok((await api(f.fn).withdrawalDelay(A)).ok);
  publishLighterCooldown(HOME, clock + 30_000, "a sibling");
  assert.equal(err(await api(f.fn).withdrawalDelay(A)).kind, "rate-limited");
});

// ── the per-address budget ──────────────────────────────────────────────────

test("the budget: 60/min per address by default, the last 20 only for exits, shared by clients of one address", async () => {
  const f = fake(() => json(200, fixture("withdrawalDelay.json")));
  const a = api(f.fn);
  const b = api(f.fn); // same L1 address: the same venue bucket
  for (let i = 0; i < 40; i++) assert.ok((await (i % 2 ? a : b).withdrawalDelay(A)).ok, `request ${i}`);
  const refused = err(await a.withdrawalDelay(A));
  assert.deepEqual([refused.kind, refused.kind === "rate-limited" ? refused.source : null], ["rate-limited", "budget"]);
  assert.equal(f.calls.length, 40);
  // The reserve is there for exits…
  for (let i = 0; i < 20; i++) assert.ok((await a.withdrawalDelay({ exit: true, auth: AUTH })).ok, `exit ${i}`);
  // …and even exits stop at the venue's own limit.
  assert.equal(err(await b.withdrawalDelay({ exit: true, auth: AUTH })).kind, "rate-limited");
  assert.equal(f.calls.length, 60);
  // A different address has its own bucket.
  assert.ok((await api(f.fn, { budgetKey: "0x0000000000000000000000000000000000000003" }).withdrawalDelay(A)).ok);
  // A rolling minute later the window has emptied.
  clock += 60_001;
  assert.ok((await a.withdrawalDelay(A)).ok);
});

test("budget options are validated", () => {
  const f = fake(() => json(200, {}));
  assert.throws(() => api(f.fn, { budgetPerMinute: 10, exitReservePerMinute: 10 }), LighterApiArgumentError);
  assert.throws(() => api(f.fn, { budgetKey: "" }), LighterApiArgumentError);
  // An identity the venue counts by, or none: not a tenant id, not a typo.
  assert.throws(() => api(f.fn, { budgetKey: "tenant-a" }), LighterApiArgumentError);
  assert.throws(() => api(f.fn, { budgetKey: "0x1234" }), LighterApiArgumentError);
  assert.doesNotThrow(() => api(f.fn, { budgetKey: "public" }));
});

// ── sendTx ──────────────────────────────────────────────────────────────────

const TX = { txType: 14, txInfo: '{"AccountIndex":22149,"Nonce":1}', txHash: HASH };

test("sendTx posts the exact bytes form-urlencoded and returns the venue's receipt", async () => {
  const f = fake(() => json(200, { code: 200, message: "{\"ratelimit\": \"didn't use volume quota\"}", tx_hash: HASH, predicted_execution_time_ms: 1_790_700_000_300, volume_quota_remaining: 12 }));
  const r = await api(f.fn).sendTx(TX, { exit: true, auth: AUTH });
  assert.ok(r.ok);
  assert.deepEqual(r.value, { txHash: HASH, predictedExecutionMs: 1_790_700_000_300, volumeQuotaRemaining: 12 });
  const c = f.calls[0]!;
  assert.equal(c.init.method, "POST");
  assert.equal(c.url.pathname, "/api/v1/sendTx");
  assert.equal(c.url.search, "");
  assert.equal(c.init.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(c.init.headers.authorization, AUTH);
  const form = new URLSearchParams(c.init.body);
  assert.equal(form.get("tx_type"), "14");
  assert.equal(form.get("tx_info"), TX.txInfo);
  assert.equal(form.has("price_protection"), false);
});

test("sendTx is never retried, whatever comes back", async () => {
  for (const answer of [
    () => json(500, "oops"),
    () => json(429, ""),
    () => json(400, fixture("sendTx.400.invalid-market.json")),
    () => json(200, "{garbage"),
    () => {
      throw new TypeError("socket hang up");
    },
  ]) {
    resetLighterApiState();
    clearLighterCooldown(HOME);
    const f = fake(answer);
    const r = await api(f.fn).sendTx(TX, { exit: true });
    assert.equal(r.ok, false);
    assert.equal(f.calls.length, 1);
  }
  resetLighterApiState();
  const refused = err(await api(fake(() => json(400, fixture("sendTx.400.invalid-market.json"))).fn).sendTx(TX));
  assert.deepEqual([refused.kind, refused.kind === "refused-send" ? refused.code : null], ["refused-send", 21602]);
});

test("sendTx: an echoed hash that is not ours is ambiguous (malformed), never success", async () => {
  const f = fake(() => json(200, { code: 200, tx_hash: "43de174b14e98b35fce519602dee70feb317bc2950e49e685b5a5bc87e8d4b1eea2c598006acc8e2", predicted_execution_time_ms: 1 }));
  assert.equal(err(await api(f.fn).sendTx(TX)).kind, "malformed");
});

test("sendTx refuses what the worker never sends, before sending", async () => {
  const f = fake(() => json(200, {}));
  const a = api(f.fn);
  for (const txType of [8, 9, 12, 17, 29, 41, 42, 45]) assert.throws(() => a.sendTx({ ...TX, txType }), LighterApiArgumentError);
  assert.throws(() => a.sendTx({ ...TX, txHash: "0x12" }), LighterApiArgumentError);
  assert.throws(() => a.sendTx({ ...TX, txInfo: "" }), LighterApiArgumentError);
  assert.equal(f.calls.length, 0);
});

// ── auth handling ───────────────────────────────────────────────────────────

test("auth-gated endpoints refuse to go without a token; a malformed token is never sent or shown", async () => {
  const f = fake(() => json(200, { code: 200, orders: [] }));
  const a = api(f.fn);
  assert.throws(() => a.accountActiveOrders(22149, DEC, {} as { auth: string }), LighterApiArgumentError);
  const bad = `${"x".repeat(10)}:${"cd".repeat(80)}`;
  assert.throws(
    () => a.withdrawalDelay({ auth: bad }),
    (e: unknown) => e instanceof LighterApiArgumentError && !e.message.includes("cdcd"),
  );
  assert.equal(f.calls.length, 0);
});

test("a venue message echoing the token or a key is scrubbed from the error", async () => {
  const f = fake(() => json(400, { code: 21120, message: `invalid signature for ${AUTH} key 0x${"ef".repeat(40)}` }));
  const r = err(await api(f.fn).sendTx(TX, { auth: AUTH }));
  assert.equal(r.kind, "refused-send");
  assert.ok(!r.detail.includes("abab"));
  assert.ok(!r.detail.includes("efef"));
});

test("argument guards throw before anything is sent", () => {
  const f = fake(() => json(200, {}));
  const a = api(f.fn);
  assert.throws(() => a.orderBookOrders(1, 251, DEC.get(1)!, A), LighterApiArgumentError);
  assert.throws(() => a.orderBookOrders(1.5, 10, DEC.get(1)!, A), LighterApiArgumentError);
  assert.throws(() => a.account({ by: "index", accountIndex: 0 }, DEC, A), LighterApiArgumentError);
  assert.throws(() => a.account({ by: "l1_address", l1Address: "0x12" }, DEC, A), LighterApiArgumentError);
  assert.throws(() => a.tx("abc", A), LighterApiArgumentError);
  assert.throws(() => a.nextNonce(22149, 255, A), LighterApiArgumentError);
  assert.throws(() => a.trades({ accountIndex: 22149, limit: 10, orderIndex: "1; drop" }, DEC, { auth: AUTH }), LighterApiArgumentError);
  assert.throws(() => a.markPriceCandles({ marketId: 1, resolution: "1h", startSec: 10, endSec: 5, countBack: 1, priceDecimals: 1 }, A), LighterApiArgumentError);
  assert.equal(f.calls.length, 0);
});

// ── one identity per client ─────────────────────────────────────────────────

test("an address-keyed client never sends an unauthenticated request — it would count against the shared egress IP", async () => {
  // Hosted children share one egress IP. Each child's own budget allows
  // 60/min for its address, but unauthenticated reads also count per IP, and
  // nothing here bounds their SUM: the first 429/405 blocks every tenant.
  const f = fake(() => json(200, fixture("withdrawalDelay.json")));
  const a = api(f.fn);
  const unauthenticated: Array<[string, () => unknown]> = [
    ["account", () => a.account({ by: "index", accountIndex: 22149 }, DEC)],
    ["accountsByL1Address", () => a.accountsByL1Address(L1)],
    ["apikeys", () => a.apikeys(22149, 255)],
    ["nextNonce", () => a.nextNonce(22149, 16)],
    ["tx", () => a.tx(HASH)],
    ["orderBookDetails", () => a.orderBookDetails()],
    ["withdrawalDelay", () => a.withdrawalDelay()],
    ["exit read", () => a.account({ by: "index", accountIndex: 22149 }, DEC, { exit: true })],
  ];
  for (const [what, call] of unauthenticated) {
    assert.throws(call, (e: unknown) => e instanceof LighterApiArgumentError && e.field === "auth", what);
  }
  assert.equal(f.calls.length, 0, "nothing was sent");
  // sendTx is counted per L1 address only (the venue's rate-limit page): no token needed.
  const s = fake(() => json(200, { code: 200, tx_hash: HASH }));
  assert.ok((await api(s.fn).sendTx(TX, { exit: true })).ok);
  assert.equal(s.calls[0]!.init.headers.authorization, undefined);
});

test("the public client reads market data without a token, and never carries one or sends a tx", async () => {
  const f = fake(() => json(200, fixture("withdrawalDelay.json")));
  const p = api(f.fn, { budgetKey: "public" });
  assert.ok((await p.withdrawalDelay()).ok);
  assert.equal(f.calls[0]!.init.headers.authorization, undefined);
  assert.throws(() => p.withdrawalDelay({ auth: AUTH }), (e: unknown) => e instanceof LighterApiArgumentError && e.field === "auth");
  assert.throws(() => p.account({ by: "index", accountIndex: 22149 }, DEC, { auth: AUTH }), LighterApiArgumentError);
  assert.throws(() => p.sendTx(TX), (e: unknown) => e instanceof LighterApiArgumentError && e.field === "budgetKey");
  assert.equal(f.calls.length, 1);
});

// ── a sendTx refusal resolves nothing ───────────────────────────────────────

test("sendTx: a refusal is `refused-send`, never `rejected` — a duplicate of executed bytes is refused too", async () => {
  // Rule 9 re-sends persisted bytes. If the first send timed out but the tx
  // executed, the re-send is refused (21104 invalid nonce, 21728 client order
  // index exists). Reading that as "the nonce is free" would sign a second
  // open beside the executed one — so no sendTx answer says "dead".
  for (const [code, maybe] of [
    [21104, true],
    [21728, true],
    [21602, false],
    [21120, false],
  ] as const) {
    resetLighterApiState();
    const r = err(await api(fake(() => json(400, { code, message: "refused" })).fn).sendTx(TX, { exit: true }));
    assert.equal(r.kind, "refused-send", String(code));
    if (r.kind === "refused-send") {
      assert.equal(r.code, code);
      assert.equal(r.maybeExecuted, maybe, String(code));
      assert.equal(r.retryable, false);
      assert.match(r.detail, /resolve the row by hash/);
    }
  }
  // A venue error code inside a 200 is the same refusal, not a receipt.
  resetLighterApiState();
  const in200 = err(await api(fake(() => json(200, { code: 21104, message: "invalid nonce" })).fn).sendTx(TX));
  assert.deepEqual([in200.kind, in200.kind === "refused-send" ? in200.maybeExecuted : null], ["refused-send", true]);
  // The same codes on a READ are still plain rejections.
  resetLighterApiState();
  assert.equal(err(await api(fake(() => json(400, { code: 21104, message: "x" })).fn).nextNonce(22149, 16, A)).kind, "rejected");
});

test("clockSkewMs: the venue's Date minus ours, mid-second, from the last dated answer — null when unmeasured or old", async () => {
  // Our clock runs 3.2 s behind the venue's: its Date says …:00, and its true
  // time was somewhere in that second, so the estimate takes the middle.
  const venueDate = Date.parse("Tue, 29 Sep 2026 16:30:00 GMT");
  let dated = true;
  const f = fake(() => json(200, { code: 200, nonce: 7 }, dated ? { date: new Date(venueDate).toUTCString() } : {}));
  const a = api(f.fn);
  assert.equal(a.clockSkewMs(), null, "nothing measured is not a skew of 0");
  clock = venueDate - 2_700;
  assert.ok((await a.nextNonce(22149, 16, A)).ok);
  assert.equal(a.clockSkewMs(), 3_200);
  // A refusal carries the venue's clock as well as an answer does.
  const r = api(fake(() => json(503, "down", { date: new Date(venueDate).toUTCString() })).fn);
  assert.equal((await r.nextNonce(22149, 16, A)).ok, false);
  assert.equal(r.clockSkewMs(), 3_200);
  // An undated answer does not erase the last measurement…
  dated = false;
  assert.ok((await a.nextNonce(22149, 16, A)).ok);
  assert.equal(a.clockSkewMs(), 3_200);
  // …but an old one is no measurement at all.
  clock += 10 * 60_000 + 1;
  assert.equal(a.clockSkewMs(), null);
  assert.equal(a.clockSkewMs(60 * 60_000), 3_200);
});
