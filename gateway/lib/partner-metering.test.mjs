/**
 * Metering in the partner gate: lib/partner-api.mjs wired to the real billing
 * core (lib/billing.mjs) on a temp directory. The core's own rules are tested
 * in billing.test.mjs; this file proves the GATE uses them: what is counted,
 * what gives its unit back, which rate and bucket a key gets, what /meta says,
 * and that billing off leaves the gate exactly as it was.
 *
 * `node --test lib/partner-metering.test.mjs`
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBilling, openLedger } from "./billing.mjs";
import { ONE_TOKEN, PERIOD_MS, PLANS, TOKEN } from "./billing-plans.mjs";
import { createPartnerApi } from "./partner-api.mjs";

const OWNER = `0x${"a1".repeat(20)}`;
const START = 1_800_000_000_000;
const T = (n) => (BigInt(n) * ONE_TOKEN).toString();
/** Free with a quota a test can spend. */
const SMALL = { ...PLANS, free: { ...PLANS.free, requests: 3 } };
const key = (keyId, extra = {}) => ({ keyId, appId: `app_${keyId}`, name: keyId, scopes: ["read:agents", "write:agents", "chat:agents"],
  rpm: 30, owner: OWNER, created_at: new Date(START - 3_600_000).toISOString(), ...extra });

const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

/** A rate-limit store that enforces, and remembers which bucket and limit each hit used. */
function countingStore() {
  const counts = new Map();
  const hits = [];
  return { hits, durable: false, async rateHit(k, limit) {
    hits.push({ key: k, limit });
    const n = (counts.get(k) ?? 0) + 1;
    counts.set(k, n);
    return n <= limit;
  } };
}

async function fixture({ mode = "enforce", plans = SMALL, keys = [key("k1")], forward = async () => ({ status: 200, json: { agents: [] } }), billing: wired = true, ...billingOptions } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "merrymen-metering-"));
  dirs.push(dir);
  const clock = { t: START };
  const logs = [];
  const registry = new Map(keys.map((k) => [k.keyId, k]));
  const boot = () => createBilling({ dataDir: dir, dataDirPersistent: true, mode, plans, now: () => clock.t, log: (l) => logs.push(l), timers: false, keyRegistry: async () => registry, ...billingOptions });
  const f = { dir, clock, logs, store: countingStore(), forwards: [], file: path.join(dir, "billing.jsonl") };
  f.forward = forward;
  const partners = { verify: async (raw) => { const k = registry.get(raw.replace(/^tok_/, "")); return k ? { ok: true, key: { ...k } } : { ok: false, status: 401, code: "unauthorized" }; },
    allows: (k, scope) => k.scopes.includes(scope) };
  /** A new partner API on the same billing: picks up f.store and whether f.forward is set. */
  f.rewire = () => {
    f.api = createPartnerApi({ partners, store: f.store, billing: f.billing,
      forward: f.forward && (async (req) => { f.forwards.push(req); return f.forward(req); }) });
  };
  /** A new process: billing replays the ledger. */
  f.reboot = async () => { f.billing = wired ? await boot() : null; f.rewire(); };
  await f.reboot();
  f.call = (route, { method = "GET", keyId = "k1" } = {}) => f.api.handle({ method, pathname: `/partner/v1${route}`, authorization: `Bearer tok_${keyId}`, ip: "203.0.113.9" });
  f.used = () => f.billing.meta(OWNER).billing.requests_used;
  f.raw = () => readFile(f.file, "utf8").catch(() => "");
  /** Credit as an operator grants it: an adjustment from another process, picked up by the tail. */
  f.grant = async (tokens) => {
    const ledger = await openLedger({ dataDir: dir, now: () => clock.t, log: () => {} });
    const acct = ledger.state.byOwner.get(OWNER);
    await ledger.enqueue(() => ledger.append({ type: "adjustment", account_id: acct.account_id, amount_raw: T(tokens), note: "test", operator: true }));
    await f.billing.tail();
  };
  return f;
}

const quota = (r) => Object.fromEntries(Object.entries(r.headers ?? {}).filter(([k]) => k.startsWith("x-merrymen-quota")));

test("a metered request counts before it is forwarded, carries its quota, and a spent quota is a structured 402 the runtime never sees", async () => {
  const f = await fixture();
  const ok = await f.call("/agents");
  assert.equal(ok.status, 200);
  assert.deepEqual(quota(ok), { "x-merrymen-quota-limit": "3", "x-merrymen-quota-remaining": "2",
    "x-merrymen-quota-reset": String(Math.ceil((START - 3_600_000 + PERIOD_MS) / 1000)), "x-merrymen-quota-enforced": "true" });
  // A partner's own mistake, refused by the runtime or by the gateway, counts.
  f.forward = async () => ({ status: 404, json: { error: { code: "not_found", message: "No such agent" } } });
  assert.equal(quota(await f.call("/agents/pa_1"))["x-merrymen-quota-remaining"], "1");
  assert.equal(quota(await f.call("/nope"))["x-merrymen-quota-remaining"], "0");
  assert.equal(f.forwards.length, 2);

  const refused = await f.call("/agents");
  assert.equal(refused.status, 402);
  assert.equal(f.forwards.length, 2, "an exhausted quota never reaches the runtime");
  const { error } = refused.json;
  assert.match(error.request_id, /^req_[0-9a-f]{12}$/);
  assert.deepEqual(error, { code: "quota_exhausted", message: error.message, request_id: error.request_id, plan: "free", limit: 3, used: 3,
    resets_at: new Date(START - 3_600_000 + PERIOD_MS).toISOString(), upgrade_url: "https://merrymen.dev/api#plans" });
  assert.equal(refused.headers["x-merrymen-quota-remaining"], "0");
  assert.equal(refused.headers["retry-after"], String(Math.ceil((PERIOD_MS - 3_600_000) / 1000)));
  assert.equal(f.used(), 3, "the 402 itself is not counted");

  // /meta is free: it answers, reports the plan, and counts nothing.
  for (let i = 0; i < 3; i++) {
    const meta = await f.call("/meta");
    assert.equal(meta.status, 200);
    assert.equal(meta.json.billing.requests_used, 3);
    assert.equal(meta.headers["x-merrymen-quota-remaining"], "0");
  }
  assert.equal(f.used(), 3);
});

test("a request the platform failed gives its unit back; a relayed Retry-After survives the quota headers", async () => {
  const f = await fixture();
  const failures = [
    { status: 503, json: { error: { code: "upstream_unavailable", message: "x" } } },
    { status: 503, json: { error: { code: "upstream_invalid_response", message: "x" } } },
    { status: 503, json: { error: { code: "runtime_unavailable", message: "x" } } },
    { status: 500, json: { error: { code: "internal", message: "x" } } },
    { status: 409, json: { error: { code: "enrollment_busy", message: "x" } } },
  ];
  for (const failure of failures) {
    f.forward = async () => structuredClone(failure);
    const r = await f.call("/agents", { method: "POST" });
    assert.equal(r.status, failure.status);
    assert.equal(r.headers["x-merrymen-quota-remaining"], "3", failure.json.error.code);
  }
  f.forward = async () => { throw new Error("socket hang up"); };
  assert.equal((await f.call("/agents")).json.error.code, "upstream_unavailable");
  const busy = { status: 409, json: { error: { code: "conversation_busy", message: "x", retry_after: 2 } }, headers: { "retry-after": "2" } };
  f.forward = async () => structuredClone(busy);
  const r = await f.call("/agents/pa_1/messages", { method: "POST" });
  assert.deepEqual(r.headers, { "retry-after": "2", ...quota(r) });
  assert.equal(r.headers["x-merrymen-quota-remaining"], "3");
  assert.equal(f.used(), 0, "nothing the platform failed was counted");

  // No runtime configured at all is the platform's failure too.
  f.forward = null;
  f.rewire();
  assert.equal((await f.call("/agents")).status, 503);
  assert.equal(f.used(), 0);

  // A partner's malformed input, refused by the runtime, is theirs and counts.
  f.forward = async () => ({ status: 400, json: { error: { code: "bad_request", message: "x" } } });
  f.rewire();
  assert.equal((await f.call("/agents", { method: "POST" })).headers["x-merrymen-quota-remaining"], "2");
  assert.equal(f.used(), 1);
});

test("refusals before the meter cost nothing: a wrong key, a missing scope", async () => {
  const f = await fixture({ keys: [key("k1", { scopes: ["read:agents"] })] });
  assert.equal((await f.api.handle({ method: "GET", pathname: "/partner/v1/agents", authorization: "Bearer tok_nobody", ip: "x" })).status, 401);
  const scoped = await f.call("/agents", { method: "POST" });
  assert.equal(scoped.status, 403);
  assert.equal(scoped.headers, undefined);
  assert.equal(f.used(), 0);
  assert.equal(f.forwards.length, 0);
});

test("an account's keys share ONE plan rate, whatever each key stores; a paid plan raises it", async () => {
  const f = await fixture({ plans: PLANS, keys: [key("k1", { rpm: 5 }), key("k2", { rpm: 500 })] });
  for (let i = 0; i < 30; i++) assert.equal((await f.call("/agents", { keyId: i % 2 ? "k1" : "k2" })).status, 200, `request ${i + 1}`);
  const limited = await f.call("/agents", { keyId: "k2" });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.message, "30 requests/minute for this account");
  assert.equal(limited.headers, undefined);
  assert.deepEqual([...new Set(f.store.hits.filter((h) => !h.key.startsWith("pip:")).map((h) => `${h.key} ${h.limit}`))], [`pa:${OWNER} 30`],
    "one bucket per wallet, at the plan's rate; the keys' own rates are not used");
  assert.equal(f.used(), 30, "the rate-limited request was not counted");
  f.store = countingStore(); // the next minute
  f.rewire();
  assert.equal((await f.call("/meta", { keyId: "k1" })).json.rate_per_min, 30);
  assert.equal(f.api.ratePerMin(key("k2", { rpm: 500 })), 30);

  assert.equal((await f.billing.createAccount(OWNER, "Acme")).status, 201);
  await f.grant(100_000);
  assert.equal((await f.billing.choosePlan(OWNER, { tier: "crumbs", confirm: true })).json.plan.id, "crumbs");
  const meta = await f.call("/meta", { keyId: "k2" });
  assert.equal(meta.json.rate_per_min, 60);
  assert.equal(meta.json.billing.plan, "crumbs");
  assert.equal(f.api.ratePerMin(key("k2", { rpm: 500 })), 60);
  assert.deepEqual(f.store.hits.at(-2), { key: `pa:${OWNER}`, limit: 60 });
});

test("observe refuses nothing billing off would answer: each key keeps its own bucket, at its plan's rate when that is higher", async () => {
  // The dry run before enforce. Two keys at 30 a minute each answered 60 a
  // minute with billing off; one shared Free bucket would turn half into 429s
  // the moment observe is switched on.
  const keys = [key("k1"), key("k2")];
  const off = await fixture({ mode: "off", plans: PLANS, keys });
  const observe = await fixture({ mode: "observe", plans: PLANS, keys });
  for (let i = 0; i < 60; i++) {
    const keyId = i % 2 ? "k1" : "k2";
    assert.equal((await off.call("/agents", { keyId })).status, 200, `off, request ${i + 1}`);
    assert.equal((await observe.call("/agents", { keyId })).status, 200, `observe, request ${i + 1}`);
  }
  const perKey = (hits) => hits.filter((h) => !h.key.startsWith("pip:"));
  assert.deepEqual(perKey(observe.store.hits), perKey(off.store.hits), "the same key buckets at the same limits");
  // The per-IP limit only rises: 240 with billing off, as before billing, and 600 once plans bound accounts.
  assert.deepEqual([...new Set(off.store.hits.filter((h) => h.key.startsWith("pip:")).map((h) => h.limit))], [240]);
  assert.deepEqual([...new Set(observe.store.hits.filter((h) => h.key.startsWith("pip:")).map((h) => h.limit))], [600]);
  const limited = await observe.call("/agents", { keyId: "k1" });
  assert.deepEqual([limited.status, limited.json.error.message], [429, "30 requests/minute for this key"]);
  assert.equal(observe.used(), 60, "every answered request is metered");
  // A paid plan's rate, when higher, applies to each key; quotas are never refused.
  assert.equal((await observe.billing.createAccount(OWNER, "Acme")).status, 201);
  await observe.grant(400_000);
  assert.equal((await observe.billing.choosePlan(OWNER, { tier: "loaf", confirm: true })).json.plan.id, "loaf");
  assert.equal((await observe.call("/meta", { keyId: "k1" })).json.rate_per_min, 120);
  assert.equal(observe.api.ratePerMin(key("k2")), 120);
  assert.deepEqual(observe.store.hits.at(-1), { key: "pip:203.0.113.9", limit: 600 });
  assert.deepEqual(observe.store.hits.at(-2), { key: "p:k1", limit: 120 });
});

test("with billing off, or no billing at all, one address keeps the per-IP limit from before billing: 240 a minute", async () => {
  // Off must be exactly the gateway from before billing. No plan bounds an
  // account then, so a higher per-IP limit would only let one address put more
  // load on the process that also serves the holder routes.
  const keys = Array.from({ length: 9 }, (_, i) => key(`k${i}`));
  for (const f of [await fixture({ mode: "off", plans: PLANS, keys }), await fixture({ billing: false, keys })]) {
    let ok = 0, refused = 0;
    for (let i = 0; i < 270; i++) {
      const r = await f.call("/agents", { keyId: `k${i % 9}` });
      if (r.status === 200) ok += 1;
      else if (r.status === 429 && r.json.error.message === "too many requests from this address") refused += 1;
    }
    assert.deepEqual([ok, refused], [240, 30]);
  }
});

test("a Feast account's 300 a minute is reachable from one backend: the per-IP limit is 600", async () => {
  // A partner usually calls from one server. At the old 240 per IP, the top
  // plan sold a rate its buyer could not reach; the plan, not the address,
  // must be what stops it.
  const f = await fixture({ plans: PLANS });
  assert.equal((await f.billing.createAccount(OWNER, "Acme")).status, 201);
  await f.grant(1_000_000);
  assert.equal((await f.billing.choosePlan(OWNER, { tier: "feast", confirm: true })).json.plan.id, "feast");
  f.store = countingStore(); // a fresh minute
  f.rewire();
  for (let i = 0; i < 300; i++) assert.equal((await f.call("/agents")).status, 200, `request ${i + 1}`);
  const limited = await f.call("/agents");
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.message, "300 requests/minute for this account");
  assert.deepEqual([...new Set(f.store.hits.filter((h) => h.key.startsWith("pip:")).map((h) => h.limit))], [600]);
  assert.equal(f.used(), 300, "the rate-limited request was not counted");
});

test("at a renewal the rate is the plan the renewal makes: a busy paid account is not held to Free's 30 a minute", async () => {
  const f = await fixture({ plans: PLANS });
  assert.equal((await f.billing.createAccount(OWNER, "Acme")).status, 201);
  await f.grant(2_000_000);
  assert.equal((await f.billing.choosePlan(OWNER, { tier: "feast", confirm: true })).json.plan.id, "feast");
  // The period's last minute, and a busy one: 100 requests, well inside Feast's 300.
  f.clock.t = START + PERIOD_MS - 30_000;
  f.store = countingStore();
  f.rewire();
  for (let i = 0; i < 100; i++) assert.equal((await f.call("/agents")).status, 200, `request ${i + 1}`);
  // The period ends inside that same rate-limit minute, with credit for the renewal.
  f.clock.t = START + PERIOD_MS + 1;
  assert.equal(f.billing.needsSettle(OWNER), true);
  const meta = await f.call("/meta");
  assert.equal(meta.status, 200, JSON.stringify(meta.json));
  assert.deepEqual([meta.json.rate_per_min, meta.json.billing.plan, meta.json.billing.renews_on_next_request], [300, "free", true],
    "the rate the next request gets; the plan as it stands until that request renews it");
  assert.equal(await f.raw().then((t) => t.split("\n").filter((l) => l.includes('"type":"charge"')).length), 1, "/meta renewed nothing");
  const r = await f.call("/agents");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.headers["x-merrymen-quota-limit"], "1000000", "counted against the renewed period");
  const charges = (await f.raw()).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.type === "charge");
  assert.deepEqual(charges.map((c) => [c.reason, c.tier]), [["activate", "feast"], ["renew", "feast"]]);
  assert.deepEqual([...new Set(f.store.hits.filter((h) => !h.key.startsWith("pip:")).map((h) => h.limit))], [300], "never checked at Free's rate");
});

test("an operator key (no owner) is never metered and keeps its own rate and bucket", async () => {
  const op = key("op1", { owner: null, rpm: 500 });
  const f = await fixture({ keys: [op] });
  for (let i = 0; i < 5; i++) {
    const r = await f.call("/agents", { keyId: "op1" });
    assert.equal(r.status, 200);
    assert.equal(r.headers, undefined);
  }
  const meta = await f.call("/meta", { keyId: "op1" });
  assert.equal(meta.json.rate_per_min, 500);
  assert.equal(meta.json.billing, null);
  assert.equal(meta.headers, undefined);
  assert.deepEqual(f.store.hits.find((h) => !h.key.startsWith("pip:")), { key: "p:op1", limit: 500 });
  await f.billing.flush();
  await assert.rejects(stat(path.join(f.dir, "usage.json")), { code: "ENOENT" });
});

test("with billing off, an owned key gets exactly the gate it had before billing", async () => {
  const today = await fixture({ billing: false, plans: SMALL });
  const off = await fixture({ mode: "off", plans: SMALL });
  const strip = (r) => (r.json?.error ? { ...r, json: { error: { ...r.json.error, request_id: "-" } } } : r);
  for (let i = 0; i < 6; i++) {
    for (const [route, method] of [["/agents", "GET"], ["/meta", "GET"], ["/nope", "GET"], ["/agents", "PUT"]]) {
      assert.deepEqual(strip(await off.call(route, { method })), strip(await today.call(route, { method })), `${method} ${route}`);
    }
  }
  assert.deepEqual(off.store.hits, today.store.hits, "same buckets, same limits: the key's own 30/min");
  assert.ok(off.store.hits.every((h) => h.key === "p:k1" || h.key.startsWith("pip:")));
  const meta = await off.call("/meta");
  assert.deepEqual(meta, { status: 200, json: { key_id: "k1", app_id: "app_k1", name: "k1", scopes: key("k1").scopes, rate_per_min: 30,
    api_version: "2026-10-08", billing: null } });
  assert.equal(off.forwards.length, 6, "past a quota of three: nothing refused");
  await off.billing.flush();
  await assert.rejects(stat(path.join(off.dir, "usage.json")), { code: "ENOENT" });
  assert.equal(await off.raw(), "", "and the ledger is untouched");
});

test("a metered request makes the charge a crash left undone; /meta, a 429 and a 403 never do", async () => {
  // The crash: a payment line was appended, and the process died before the
  // activation that should have followed it. Nothing replays the payment; the
  // next metered request settles the account instead.
  const f = await fixture({ mode: "observe", plans: PLANS, keys: [key("k1"), key("k2", { scopes: ["read:agents"] })] });
  assert.equal((await f.billing.createAccount(OWNER, "Acme")).status, 201);
  await f.billing.choosePlan(OWNER, { tier: "crumbs", confirm: true });
  await f.billing.close();
  const ledger = await openLedger({ dataDir: f.dir, now: () => f.clock.t, log: () => {} });
  const acct = ledger.state.byOwner.get(OWNER);
  await ledger.enqueue(() => ledger.append({ type: "payment", account_id: acct.account_id, owner: OWNER, chain_id: TOKEN.chainId, token: TOKEN.address,
    recipient: `0x${"7e".repeat(20)}`, tx_hash: `0x${"ab".repeat(32)}`, block_number: 1_000, block_hash: `0x${"cd".repeat(32)}`,
    amount_raw: T(100_000), log_indexes: [0] }));
  f.clock.t += 1_000;
  await f.reboot();

  const before = await f.raw();
  const meta = await f.call("/meta");
  assert.equal(meta.json.billing.plan, "free");
  assert.equal(meta.json.billing.renews_on_next_request, true);
  assert.equal((await f.call("/agents", { method: "POST", keyId: "k2" })).status, 403);
  assert.equal(meta.json.rate_per_min, 60, "rate-limited at the plan the due activation makes");
  // Past that 60 a minute: the 429 that follows is a refusal too, and makes no charge.
  for (let i = 0; i < 59; i++) assert.equal((await f.call("/meta")).status, 200);
  assert.equal((await f.call("/agents")).status, 429);
  await f.billing.tail();
  assert.equal(await f.raw(), before, "reads and refusals appended nothing");

  f.store = countingStore(); // the next minute
  f.rewire();
  const served = await f.call("/agents");
  assert.equal(served.status, 200);
  assert.equal(served.headers["x-merrymen-quota-limit"], "50000", "counted against the plan the payment bought");
  const charges = (await f.raw()).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === "charge");
  assert.deepEqual(charges.map((c) => [c.reason, c.tier, c.price_raw]), [["activate", "crumbs", T(100_000)]]);
  await f.call("/agents");
  assert.equal((await f.raw()).split("\n").filter((l) => l.includes('"type":"charge"')).length, 1, "settled once");
});

test("a served request's count is on disk before the answer, so a crash cannot forget it", async () => {
  // Codex review on #308 (P1): counts used to reach usage.json only every 10 s,
  // so a crash right after answering handed those requests out again.
  const f = await fixture();
  const answers = await Promise.all([f.call("/agents"), f.call("/agents")]);
  assert.deepEqual(answers.map((r) => r.status), [200, 200]);
  const saved = JSON.parse(await readFile(path.join(f.dir, "usage.json"), "utf8"));
  assert.equal(Object.values(saved.windows).reduce((n, w) => n + w.total, 0), 2, "both counts were written before either answer");
  await f.reboot(); // a crash: no close(), no shutdown flush
  assert.equal(f.used(), 2);
  assert.equal((await f.call("/agents")).status, 200);
  assert.equal((await f.call("/agents")).status, 402, "the third of three was the last, after the crash as before");
});

test("a count that cannot be written is not served under enforce, and is served under observe", async () => {
  for (const mode of ["enforce", "observe"]) {
    const f = await fixture({ mode });
    // usage.json's temp file cannot be created: every usage write fails.
    await mkdir(path.join(f.dir, "usage.json.tmp"));
    const r = await f.call("/agents");
    if (mode === "enforce") {
      assert.equal(r.status, 503); assert.equal(r.json.error.code, "billing_unavailable"); assert.match(r.json.error.request_id, /^req_/);
      assert.equal(f.forwards.length, 0, "never reached the runtime");
      assert.equal(f.used(), 0, "the unit was given back");
    } else {
      assert.equal(r.status, 200, "observe refuses nothing");
      assert.equal(f.used(), 1);
    }
    await rm(path.join(f.dir, "usage.json.tmp"), { recursive: true });
    assert.equal((await f.call("/agents")).status, 200, `${mode}: served again once usage can be written`);
  }
});

test("a steady stream of counted requests shares usage writes, so waiting does not grow with the stream", async () => {
  // A one-flag version let each finished write release only the request that
  // started it: with requests every 2 ms and 20 ms writes, waits grew with the
  // stream (measured: median 356 ms, worst 673 ms over 300 requests) instead of
  // staying near one or two writes (31 ms, 53 ms).
  const usageWrite = async (file, text) => { await new Promise((r) => setTimeout(r, 20)); await writeFile(file, text); };
  const big = { ...SMALL, free: { ...SMALL.free, requests: 1_000, rpm: 10_000 } };
  const f = await fixture({ plans: big, usageWrite });
  const waits = [];
  const calls = [];
  for (let i = 0; i < 200; i++) {
    const t0 = Date.now();
    calls.push(f.call("/agents").then((r) => { waits.push(Date.now() - t0); return r; }));
    await new Promise((r) => setTimeout(r, 2));
  }
  const answers = await Promise.all(calls);
  assert.ok(answers.every((r) => r.status === 200));
  assert.equal(f.used(), 200);
  assert.ok(Math.max(...waits) < 250, `longest wait ${Math.max(...waits)} ms`);
});

test("a usage write that stalls is refused within the bound under enforce, and never holds observe", async () => {
  const stall = () => new Promise(() => {});
  for (const mode of ["enforce", "observe"]) {
    const f = await fixture({ mode, usageWrite: stall, usageWaitMs: 50 });
    const started = Date.now();
    const r = await f.call("/agents");
    assert.ok(Date.now() - started < 1_000, `${mode}: answered without waiting on the stalled disk`);
    if (mode === "enforce") {
      assert.equal(r.status, 503); assert.equal(r.json.error.code, "billing_unavailable");
      assert.equal(f.forwards.length, 0); assert.equal(f.used(), 0, "given back");
    } else {
      assert.equal(r.status, 200); assert.equal(f.used(), 1);
    }
  }
});

test("a request still waiting for its count to land is given back by shutdown, and not forwarded after", async () => {
  let release;
  const usageWrite = (file, text) => new Promise((resolve) => { release = async () => { await writeFile(file, text); resolve(); }; });
  const f = await fixture({ usageWrite, usageWaitMs: 5_000 });
  const pending = f.call("/agents");
  await new Promise((r) => setTimeout(r, 20)); // it is now waiting on the write
  assert.equal(f.api.releaseUnfinished(), 1, "shutdown sees the request that is waiting");
  await release();
  const r = await pending;
  assert.equal(r.status, 503); assert.equal(r.json.error.code, "upstream_unavailable");
  assert.equal(f.forwards.length, 0, "never forwarded after shutdown gave it back");
  assert.equal(f.used(), 0, "given back once, not twice");
});
