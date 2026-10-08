/**
 * MERRYMEN-PAID PLANS, END TO END, THROUGH THE REAL ENTRYPOINT.
 *
 * server.mjs is spawned as it runs in production, on a temp data directory,
 * with a partner key owned by a test wallet. Its payments RPC is a fake
 * Robinhood Chain served over HTTP (lib/fake-rpc.test-helper.mjs), read by the
 * gateway's real viem client; its partner bridge talks to a stub web runtime on
 * localhost. Nothing here reaches a real chain, holds a real key, or sends a
 * transaction: the gateway only ever reads one.
 *
 * What only this file can show is the WIRING: env to config, one billing core
 * shared by the partner gate and the developer API, signals that save usage,
 * and a restart that replays the ledger into the same credit, plan and counts.
 *
 * `node --test billing-server.test.mjs`
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ONE_TOKEN, PERIOD_MS } from "./lib/billing-plans.mjs";
import { hashSecret, makeKey } from "./lib/partners.mjs";
import { startFakeChain, transferLog } from "./lib/fake-rpc.test-helper.mjs";

const SECRET = "billing-server-test-gateway-secret-32-bytes+";
const PORTAL = "billing-server-test-portal-secret-32-bytes++";
const BRIDGE = "billing-server-test-bridge-secret-32-bytes++";
const TREASURY = `0x${"7e".repeat(20)}`;

const cleanup = [];
after(async () => { for (const fn of cleanup.reverse()) await fn(); });

const freePort = () => new Promise((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });

/** The hosted web runtime the bridge forwards to. `reply` decides each answer; `seen` counts what arrived. */
async function startWeb() {
  const web = { seen: [], reply: () => ({ status: 200, body: { agents: [] } }) };
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      web.seen.push(`${req.method} ${req.url}`);
      const { status, body, headers = {} } = web.reply(req);
      res.writeHead(status, { "content-type": typeof body === "string" ? "text/html" : "application/json", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return Object.assign(web, { origin: `http://127.0.0.1:${server.address().port}` });
}

/** server.mjs as a child process. Resolves once it is listening. */
async function startGateway(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], { stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, PORT: String(port), MERRYMEN_GATEWAY_UPSTREAM_KEY: "unused", MERRYMEN_GATEWAY_SECRET: SECRET,
      MERRYMEN_GATEWAY_RPC: "http://127.0.0.1:9", ...env } });
  let out = "", err = "";
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  cleanup.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (c) => { out += c; if (out.includes("listening")) resolve(); });
    child.stderr.on("data", (c) => { err += c; });
    exited.then(({ code }) => reject(new Error(`gateway exited ${code}: ${out}${err}`)));
  });
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin, stdout: () => out, stderr: () => err,
    /** Send a signal and wait for the process to end. */
    stop: (signal = "SIGTERM") => { child.kill(signal); return exited; },
  };
}

/** A partner request with a key, read back as {status, json, headers}. */
async function partner(gw, key, route, { method = "GET", body } = {}) {
  const r = await fetch(`${gw.origin}/partner/v1${route}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: await r.json(), headers: Object.fromEntries(r.headers) };
}

/** The portal's server: the bearer, and the developer's session once signed in. */
function developer(gw, wallet) {
  const d = { session: "" };
  d.call = async (route, body) => {
    const r = await fetch(`${gw.origin}/developer/v1${route}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${PORTAL}`, "x-developer-session": d.session, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, json: await r.json() };
  };
  /** A real sign-in: the wallet signs the exact message the gateway issued. */
  d.signIn = async () => {
    const c = await d.call("/challenge", { address: wallet.address });
    assert.equal(c.status, 200);
    const v = await d.call("/verify", { challenge: c.json.challenge, signature: await wallet.signMessage({ message: c.json.message }) });
    assert.equal(v.status, 200, JSON.stringify(v.json));
    d.session = v.json.session;
  };
  return d;
}

const quota = (h) => [h["x-merrymen-quota-limit"], h["x-merrymen-quota-remaining"], h["x-merrymen-quota-enforced"]];
const ledger = async (dir) => (await readFile(path.join(dir, "billing.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("an account pays, its plan lifts a spent quota, failures do not count, and a SIGTERM and a restart keep everything", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "merrymen-billing-server-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  // Blocks are stamped ten minutes back, so depth alone decides when a transfer is final.
  const rpc = await startFakeChain({ head: 5_000, time: Math.floor(Date.now() / 1000) - 600 });
  cleanup.push(rpc.close);
  const web = await startWeb();
  const wallet = privateKeyToAccount(generatePrivateKey());
  const owner = wallet.address.toLowerCase();

  // A key from before accounts, in the env registry, owned by the wallet. Its
  // Free window began an hour ago, and 996 of its 1,000 requests are spent
  // (as the last process left usage.json), so a few calls reach the limit.
  const { key, keyId, secret } = makeKey();
  const anchor = Date.now() - 3_600_000;
  await writeFile(path.join(dir, "usage.json"), JSON.stringify({ v: 1, windows: {
    [`${owner}|${anchor}`]: { end: anchor + PERIOD_MS, total: 996, keys: { [keyId]: 996 } } } }));
  const env = {
    MERRYMEN_DATA_DIR: dir, MERRYMEN_DEVELOPER_PORTAL_SECRET: PORTAL,
    MERRYMEN_PARTNER_BRIDGE_SECRET: BRIDGE, MERRYMEN_PARTNER_APP_ORIGIN: web.origin,
    MERRYMEN_PARTNER_KEYS: JSON.stringify([{ keyId, appId: "acme-production", owner: wallet.address, name: "Acme backend", hash: hashSecret(SECRET, secret),
      scopes: ["read:agents", "write:agents", "chat:agents"], rpm: 30, status: "active", created_at: new Date(anchor).toISOString() }]),
    MERRYMEN_BILLING: "enforce", MERRYMEN_PAYMENTS_TREASURY: TREASURY, MERRYMEN_PAYMENTS_START_BLOCK: "100",
    // Its own RPC: the gateway's (a closed port above) is the holder gate's, never asked about payments.
    MERRYMEN_PAYMENTS_RPC: rpc.url, MERRYMEN_PAYMENTS_MIN_CONFIRMATIONS: "3", MERRYMEN_PAYMENTS_MIN_AGE_SEC: "0",
  };
  let gw = await startGateway(env);
  assert.match(gw.stdout(), new RegExp(`partner billing: enforce, quotas enforced; payments to ${TREASURY}`));
  assert.ok(rpc.chain.calls.includes("eth_chainId"), "the payments RPC's chain is checked at boot");

  // ── Free, nearly spent ──
  let meta = await partner(gw, key, "/meta");
  assert.equal(meta.status, 200);
  assert.deepEqual([meta.json.rate_per_min, meta.json.billing.plan, meta.json.billing.requests_used, meta.json.billing.enforced], [30, "free", 996, true]);
  assert.deepEqual(quota(meta.headers), ["1000", "4", "true"]);
  let r = await partner(gw, key, "/agents");
  assert.equal(r.status, 200);
  assert.deepEqual(quota(r.headers), ["1000", "3", "true"]);
  assert.equal(r.headers["x-merrymen-quota-reset"], String(Math.ceil((anchor + PERIOD_MS) / 1000)));

  // The platform failing is not the partner's request: each gives its unit back.
  for (const [reply, status] of [
    [{ status: 503, body: { error: { code: "runtime_unavailable", message: "Worker state unreadable" } } }, 503],
    [{ status: 409, body: { error: { code: "conversation_busy", message: "Busy", retry_after: 2 } }, headers: { "retry-after": "2" } }, 409],
    [{ status: 502, body: "<html>Bad gateway</html>" }, 503],
  ]) {
    web.reply = () => reply;
    r = await partner(gw, key, "/agents/pa_123456789abc/messages", { method: "POST", body: { message: "hi", request_id: "msg_1" } });
    assert.equal(r.status, status);
    assert.equal(r.headers["x-merrymen-quota-remaining"], "3", JSON.stringify(reply.body));
  }
  assert.equal(r.headers["retry-after"], undefined);
  web.reply = () => ({ status: 409, body: { error: { code: "conversation_busy", message: "Busy", retry_after: 2 } }, headers: { "retry-after": "2" } });
  assert.equal((await partner(gw, key, "/agents/pa_123456789abc/messages", { method: "POST", body: {} })).headers["retry-after"], "2", "a relayed Retry-After survives the quota headers");
  // A partner's own mistake counts.
  web.reply = () => ({ status: 404, body: { error: { code: "not_found", message: "No such agent" } } });
  assert.deepEqual(quota((await partner(gw, key, "/agents/pa_000000000000")).headers), ["1000", "2", "true"]);
  web.reply = () => ({ status: 200, body: { agents: [] } });
  await partner(gw, key, "/agents");
  assert.deepEqual(quota((await partner(gw, key, "/agents")).headers), ["1000", "0", "true"]);

  const forwarded = web.seen.length;
  const spent = await partner(gw, key, "/agents");
  assert.equal(spent.status, 402);
  assert.equal(web.seen.length, forwarded, "a spent quota never reaches the runtime");
  const { error } = spent.json;
  assert.deepEqual(error, { code: "quota_exhausted", message: error.message, request_id: error.request_id, plan: "free", limit: 1000, used: 1000,
    resets_at: new Date(anchor + PERIOD_MS).toISOString(), upgrade_url: "https://merrymen.dev/api#plans" });
  assert.match(error.request_id, /^req_[0-9a-f]{12}$/);
  assert.deepEqual(quota(spent.headers), ["1000", "0", "true"]);
  assert.ok(Number(spent.headers["retry-after"]) > 0);
  assert.equal((await partner(gw, key, "/meta")).json.billing.requests_used, 1000, "/meta answers a spent key, and counts nothing");

  // ── the developer: sign in, an account, a plan, a payment ──
  const dev = developer(gw, wallet);
  const chainCalls = rpc.chain.calls.length;
  await dev.signIn();
  assert.equal(rpc.chain.calls.length, chainCalls, "sign-in never asks a chain anything");
  assert.equal((await dev.call("/keys", { name: "Second app" })).json.error.code, "account_required");
  const keys = await dev.call("/keys");
  assert.deepEqual(keys.json.keys.map((k) => [k.key_id, k.rate_per_min]), [[keyId, 30]], "a key from before accounts is listed with the rate it gets");

  const plans = await dev.call("/plans");
  assert.deepEqual([plans.json.billing, plans.json.treasury, plans.json.confirmations], [{ mode: "enforce", enforced: true }, TREASURY, { blocks: 3, min_age_sec: 0 }]);
  assert.equal((await dev.call("/account", { name: "Acme" })).status, 201);
  assert.equal((await dev.call("/account", { name: "Acme again" })).json.error.code, "account_exists");
  const preview = await dev.call("/plan", { tier: "crumbs" });
  assert.deepEqual([preview.json.effect, preview.json.due_tokens], ["waiting_for_payment", "100000"]);
  assert.equal((await dev.call("/plan", { tier: "crumbs", confirm: true })).json.plan.selected, "crumbs");

  assert.equal((await dev.call("/payments", { tx_hash: `0x${"9".repeat(64)}` })).json.stage, "not_found_yet");
  // Letters in it, so its capitalised spelling below is a different string.
  const hash = rpc.chain.mine({ hash: `0x${"ab12cd34".repeat(8)}`, logs: [transferLog({ from: owner, to: TREASURY, value: 100_000n * ONE_TOKEN })] });
  const pending = await dev.call("/payments", { tx_hash: hash });
  assert.equal(pending.status, 202);
  assert.deepEqual([pending.json.code, pending.json.stage, pending.json.confirmations, pending.json.needed], ["payment_pending", "confirming", 1, 3]);
  rpc.chain.advance(2);
  const credited = await dev.call("/payments", { tx_hash: hash });
  assert.equal(credited.status, 200, JSON.stringify(credited.json));
  assert.deepEqual([credited.json.already, credited.json.payment.amount_tokens, credited.json.plan.id, credited.json.credit_tokens], [false, "100000", "crumbs", "0"]);
  const capitals = `0x${hash.slice(2).toUpperCase()}`;
  assert.notEqual(capitals, hash);
  const again = await dev.call("/payments", { tx_hash: capitals });
  assert.deepEqual([again.status, again.json.already, again.json.credit_tokens], [200, true, "0"], "the same transfer in capitals is the same transfer");

  // ── the plan, as the partner sees it ──
  r = await partner(gw, key, "/agents");
  assert.equal(r.status, 200, "the paid plan lifts the spent Free quota");
  assert.deepEqual(quota(r.headers), ["50000", "49999", "true"]);
  await partner(gw, key, "/agents");
  meta = await partner(gw, key, "/meta");
  assert.deepEqual([meta.json.rate_per_min, meta.json.billing.plan, meta.json.billing.requests_used], [60, "crumbs", 2]);
  assert.equal((await dev.call("/keys")).json.keys[0].rate_per_min, 60);
  assert.equal((await dev.call("/keys", { name: "Second app" })).status, 201);

  // ── SIGTERM saves the counts; a restart replays the ledger ──
  await partner(gw, key, "/agents"); // the last count before the signal
  assert.deepEqual(await gw.stop("SIGTERM"), { code: 0, signal: null });
  assert.match(gw.stdout(), /SIGTERM: saving usage counts/);
  const saved = JSON.parse(await readFile(path.join(dir, "usage.json"), "utf8"));
  const periodKey = Object.keys(saved.windows).find((k) => k.includes("|per_"));
  assert.equal(saved.windows[periodKey].total, 3);
  assert.equal(saved.windows[`${owner}|${anchor}`].total, 1000);

  const records = await ledger(dir);
  assert.deepEqual(records.map((x) => x.type), ["config", "account", "select", "payment", "charge"], "one line per state change, and no second payment");

  gw = await startGateway(env);
  assert.equal(gw.stdout().includes("partner billing: enforce"), true);
  meta = await partner(gw, key, "/meta");
  assert.deepEqual([meta.json.billing.plan, meta.json.billing.requests_used, meta.json.rate_per_min], ["crumbs", 3, 60]);
  const back = developer(gw, wallet);
  await back.signIn(); // a memory session store forgets sessions across a restart, by design
  const view = await back.call("/account");
  assert.deepEqual([view.json.plan.id, view.json.plan.selected, view.json.credit_tokens, view.json.usage.used, view.json.usage.limit],
    ["crumbs", "crumbs", "0", 3, 50_000]);
  assert.deepEqual(view.json.history.map((h) => h.type), ["charge", "payment"]);
  assert.equal((await back.call("/payments", { tx_hash: hash })).json.already, true, "a replayed ledger still knows the transfer");
  assert.equal((await ledger(dir)).filter((x) => x.type === "payment").length, 1);
  await gw.stop("SIGINT");
});

test("every degraded billing mode is said at boot", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "merrymen-billing-boot-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const wrongChain = await startFakeChain({ chainId: 1 });
  cleanup.push(wrongChain.close);
  // A file where a directory should be: nothing can be created under it.
  const blocker = path.join(dir, "not-a-directory");
  await writeFile(blocker, "");
  const cases = [
    [{ MERRYMEN_DATA_DIR: dir }, { out: /partner billing: off, nothing is metered/ }],
    [{ MERRYMEN_BILLING: "observe" }, { err: /MERRYMEN_DATA_DIR set explicitly.*billing is off[\s\S]*partner billing: off \(MERRYMEN_BILLING="observe"/ }],
    [{ MERRYMEN_DATA_DIR: dir, MERRYMEN_BILLING: "enforce" }, { err: /running observe[\s\S]*partner billing: observe \(MERRYMEN_BILLING="enforce".*payments UNAVAILABLE/ }],
    [{ MERRYMEN_DATA_DIR: dir, MERRYMEN_BILLING: "enforce", MERRYMEN_PAYMENTS_TREASURY: TREASURY }, { err: /needs MERRYMEN_PAYMENTS_START_BLOCK[\s\S]*partner billing: observe/ }],
    [{ MERRYMEN_DATA_DIR: dir, MERRYMEN_BILLING: "enforce", MERRYMEN_PAYMENTS_TREASURY: TREASURY, MERRYMEN_PAYMENTS_START_BLOCK: "1", MERRYMEN_PAYMENTS_RPC: wrongChain.url },
      { err: /PAYMENTS UNAVAILABLE: the payments RPC answers chain 1[\s\S]*partner billing: enforce, quotas enforced; payments UNAVAILABLE/ }],
    [{ MERRYMEN_DATA_DIR: path.join(blocker, "data"), MERRYMEN_BILLING: "observe" }, { err: /is not writable.*billing is off[\s\S]*partner billing: off/ }],
  ];
  for (const [env, want] of cases) {
    const gw = await startGateway(env);
    if (want.out) assert.match(gw.stdout(), want.out, JSON.stringify(env));
    if (want.err) assert.match(gw.stderr(), want.err, JSON.stringify(env));
    await gw.stop();
  }
});
