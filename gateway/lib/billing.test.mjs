/**
 * Billing: configuration, the ledger and its replay invariants, plan rules and
 * metering, against real temp directories. Payments against a fake chain are in
 * billing-payments.test.mjs; the operator CLI in billing-cli.test.mjs.
 *
 * `node --test lib/billing.test.mjs`
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBilling, dataDirProblem, isPlatformFailure, openLedger, parseBillingConfig, quotaHeaders, replayLedger, upgradeRaw } from "./billing.mjs";
import { ONE_TOKEN, PERIOD_MS, PLANS } from "./billing-plans.mjs";

const P = PERIOD_MS;
const DAY = 86_400_000;
const T = (n) => BigInt(n) * ONE_TOKEN;
const OWNER = `0x${"a1".repeat(20)}`;
const OTHER = `0x${"b2".repeat(20)}`;
const TREASURY = `0x${"7e".repeat(20)}`;
const START = 1_800_000_000_000;

const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));
async function tempDir() {
  const d = await mkdtemp(path.join(tmpdir(), "merrymen-billing-"));
  dirs.push(d);
  return d;
}

async function fixture({ mode = "observe", plans, keys = [], dir, ...rest } = {}) {
  dir ??= await tempDir();
  const clock = { t: START };
  const logs = [];
  const registry = new Map(keys.map((k) => [k.keyId, k]));
  const boot = (extra = {}) => createBilling({ dataDir: dir, dataDirPersistent: true, mode, now: () => clock.t, log: (l) => logs.push(l), timers: false,
    keyRegistry: async () => registry, ...(plans ? { plans } : {}), ...rest, ...extra });
  const f = { dir, clock, logs, registry, file: path.join(dir, "billing.jsonl"), billing: await boot() };
  f.restart = async (extra) => { f.billing = await boot(extra); return f.billing; };
  f.advance = (ms) => { clock.t += ms; };
  f.raw = () => readFile(f.file, "utf8").catch((err) => { if (err.code === "ENOENT") return ""; throw err; });
  f.records = async () => (await f.raw()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  f.charges = async () => (await f.records()).filter((r) => r.type === "charge");
  f.account = async (owner = OWNER, name = "Acme") => {
    const r = await f.billing.createAccount(owner, name);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json;
  };
  /** Credit the way an operator does: an adjustment appended by another process, picked up by the tail. */
  f.grant = async (tokens, owner = OWNER) => {
    const ledger = await openLedger({ dataDir: dir, now: () => clock.t, log: () => {} });
    const acct = ledger.state.byOwner.get(owner);
    await ledger.enqueue(() => ledger.append({ type: "adjustment", account_id: acct.account_id, amount_raw: (typeof tokens === "bigint" ? tokens : T(tokens)).toString(), note: "test", operator: true }));
    await f.billing.tail();
  };
  f.plan = (tier, confirm = true, owner = OWNER) => f.billing.choosePlan(owner, { tier, confirm });
  f.view = (owner = OWNER) => f.billing.accountView(owner).json;
  return f;
}

// ── configuration ────────────────────────────────────────────────────────────

test("billing is off unless asked for, and off without an explicit data directory", () => {
  assert.equal(parseBillingConfig({}).mode, "off");
  const noDir = parseBillingConfig({ MERRYMEN_BILLING: "observe" });
  assert.equal(noDir.mode, "off");
  assert.match(noDir.notes.join("\n"), /MERRYMEN_DATA_DIR set explicitly/);
  assert.equal(parseBillingConfig({ MERRYMEN_BILLING: "observe", MERRYMEN_DATA_DIR: "/data" }).mode, "observe");
  const typo = parseBillingConfig({ MERRYMEN_BILLING: "enforcing", MERRYMEN_DATA_DIR: "/data" });
  assert.equal(typo.mode, "off");
  assert.match(typo.notes[0], /not off, observe or enforce/);
  assert.equal(parseBillingConfig({ MERRYMEN_BILLING: " Observe ", MERRYMEN_DATA_DIR: "/v" }).dataDir, "/v");
});

test("enforce needs a treasury and a start block, or it runs observe", () => {
  const base = { MERRYMEN_BILLING: "enforce", MERRYMEN_DATA_DIR: "/data" };
  const none = parseBillingConfig(base);
  assert.equal(none.mode, "observe");
  assert.equal(none.treasury, null);
  const noStart = parseBillingConfig({ ...base, MERRYMEN_PAYMENTS_TREASURY: TREASURY });
  assert.equal(noStart.mode, "observe", "a treasury without a start block would credit every old transfer");
  assert.equal(noStart.treasury, null);
  assert.match(noStart.notes.join("\n"), /needs MERRYMEN_PAYMENTS_START_BLOCK/);
  const full = parseBillingConfig({ ...base, MERRYMEN_PAYMENTS_TREASURY: TREASURY.toUpperCase().replace("0X", "0x"), MERRYMEN_PAYMENTS_START_BLOCK: "1234" });
  assert.equal(full.mode, "enforce");
  assert.equal(full.treasury, TREASURY);
  assert.equal(full.startBlock, 1234);
});

test("a treasury that is not a usable address is treated as unset, and previous ones are cleaned", () => {
  const base = { MERRYMEN_BILLING: "observe", MERRYMEN_DATA_DIR: "/d", MERRYMEN_PAYMENTS_START_BLOCK: "1" };
  for (const bad of ["0x1234", `0x${"0".repeat(40)}`, "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32", "treasury"]) {
    const c = parseBillingConfig({ ...base, MERRYMEN_PAYMENTS_TREASURY: bad });
    assert.equal(c.treasury, null, bad);
    assert.match(c.notes.join("\n"), /not a usable address/);
  }
  const old = `0x${"01".repeat(20)}`;
  const c = parseBillingConfig({ ...base, MERRYMEN_PAYMENTS_TREASURY: TREASURY,
    MERRYMEN_PAYMENTS_PREVIOUS_TREASURIES: ` ${old}, ${old.toUpperCase().replace("0X", "0x")},nonsense,${TREASURY},` });
  assert.deepEqual(c.previousTreasuries, [old], "deduplicated, the current one and junk dropped");
  assert.deepEqual(parseBillingConfig({ ...base, MERRYMEN_PAYMENTS_PREVIOUS_TREASURIES: old }).previousTreasuries, [],
    "a previous treasury means nothing without a current one");
});

test("confirmation depth and age default to 64 blocks and 120 s; the payments RPC falls back to the gateway's", () => {
  const c = parseBillingConfig({ MERRYMEN_GATEWAY_RPC: "https://gw.example" });
  assert.equal(c.minConfirmations, 64);
  assert.equal(c.minAgeSec, 120);
  assert.equal(c.rpc, "https://gw.example");
  assert.equal(parseBillingConfig({ MERRYMEN_GATEWAY_RPC: "https://gw", MERRYMEN_PAYMENTS_RPC: "https://pay" }).rpc, "https://pay");
  const set = parseBillingConfig({ MERRYMEN_PAYMENTS_MIN_CONFIRMATIONS: "128", MERRYMEN_PAYMENTS_MIN_AGE_SEC: "0" });
  assert.equal(set.minConfirmations, 128);
  assert.equal(set.minAgeSec, 0);
  const bad = parseBillingConfig({ MERRYMEN_PAYMENTS_MIN_CONFIRMATIONS: "0", MERRYMEN_PAYMENTS_MIN_AGE_SEC: "-5" });
  assert.equal(bad.minConfirmations, 64);
  assert.equal(bad.minAgeSec, 120);
  assert.equal(bad.notes.length, 2);
});

test("a data directory that cannot be used turns billing off at boot", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, "not-a-dir"), "x");
  const logs = [];
  const b = await createBilling({ dataDir: path.join(dir, "not-a-dir", "sub"), mode: "observe", dataDirPersistent: true, timers: false, log: (l) => logs.push(l), keyRegistry: async () => new Map() });
  assert.equal(b.mode, "off");
  assert.match(logs.join("\n"), /cannot be read \(ENOTDIR\).*billing is off/);
  const ro = await tempDir();
  await chmod(ro, 0o500);
  try {
    const r = await createBilling({ dataDir: ro, mode: "observe", dataDirPersistent: true, timers: false, log: (l) => logs.push(l), keyRegistry: async () => new Map() });
    if (process.getuid?.() !== 0) { assert.equal(r.mode, "off"); assert.match(logs.join("\n"), /is not writable \(EACCES\).*billing is off/); }
  } finally { await chmod(ro, 0o700); }
});

test("billing never creates its data directory: a missing one turns billing off and stays missing", async () => {
  // MERRYMEN_DATA_DIR=/data with no volume attached: a directory billing made
  // itself would sit on the container's disk, and the next deploy would wipe
  // the ledger and make every past transfer creditable again.
  const missing = path.join(await tempDir(), "data");
  const logs = [];
  const b = await createBilling({ dataDir: missing, mode: "enforce", dataDirPersistent: true, treasury: TREASURY, startBlock: 1, timers: false,
    log: (l) => logs.push(l), keyRegistry: async () => new Map() });
  assert.equal(b.mode, "off");
  assert.match(logs.join("\n"), /data does not exist .*billing is off/);
  await assert.rejects(stat(missing), { code: "ENOENT" }, "the check created nothing");
  // Nor does a developer creating an account: that would write the ledger onto
  // the container's disk, and the next deploy would wipe the account.
  const created = await b.createAccount(`0x${"ab".repeat(20)}`, "Prism");
  assert.equal(created.status, 503); assert.equal(created.json.error.code, "billing_unavailable");
  await assert.rejects(stat(missing), { code: "ENOENT" }, "account creation created nothing either");
  // Billing left off by the operator is not a storage refusal: accounts still work.
  const plain = await createBilling({ dataDir: await tempDir(), mode: "off", timers: false, log: () => {}, keyRegistry: async () => new Map() });
  assert.equal((await plain.createAccount(`0x${"ab".repeat(20)}`, "Prism")).status, 201);
});

test("billing needs its data directory on a mounted volume, unless the operator says the disk itself persists", async () => {
  const at = (devs) => async (p) => {
    if (!Object.hasOwn(devs, p)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { dev: devs[p].dev, isDirectory: () => devs[p].dir !== false };
  };
  assert.match(await dataDirProblem("/data", { statFn: at({ "/data": { dev: 1 }, "/": { dev: 1 } }) }), /on the container's own disk/);
  assert.equal(await dataDirProblem("/data", { statFn: at({ "/data": { dev: 7 }, "/": { dev: 1 } }) }), null, "a volume mounted there");
  assert.equal(await dataDirProblem("/data/gateway", { statFn: at({ "/data/gateway": { dev: 7 }, "/": { dev: 1 } }) }), null, "a directory inside a volume");
  assert.equal(await dataDirProblem("/data", { persistent: true, statFn: at({ "/data": { dev: 1 }, "/": { dev: 1 } }) }), null, "MERRYMEN_DATA_DIR_PERSISTENT=1");
  assert.match(await dataDirProblem("/data", { persistent: true, statFn: at({ "/": { dev: 1 } }) }), /does not exist/);
  assert.match(await dataDirProblem("/data", { statFn: at({ "/data": { dev: 7, dir: false }, "/": { dev: 1 } }) }), /is not a directory/);
  assert.equal(parseBillingConfig({ MERRYMEN_DATA_DIR_PERSISTENT: " 1 " }).dataDirPersistent, true);
  assert.equal(parseBillingConfig({ MERRYMEN_DATA_DIR_PERSISTENT: "yes" }).dataDirPersistent, false);
  assert.equal(parseBillingConfig({}).dataDirPersistent, false);
  // createBilling makes the same check on the real disk, without the override.
  const dir = await tempDir();
  const own = (await stat(dir)).dev === (await stat(path.parse(dir).root)).dev;
  const logs = [];
  const b = await createBilling({ dataDir: dir, mode: "observe", timers: false, log: (l) => logs.push(l), keyRegistry: async () => new Map() });
  assert.equal(b.mode, own ? "off" : "observe", logs.join("\n"));
  if (own) assert.match(logs.join("\n"), /on the container's own disk.*billing is off/);
});

test("each change to where payments go leaves a config line in the ledger, and an unchanged boot leaves none", async () => {
  const opts = { treasury: TREASURY, startBlock: 100, previousTreasuries: [] };
  const f = await fixture(opts);
  let configs = (await f.records()).filter((r) => r.type === "config");
  assert.deepEqual(configs.map((c) => [c.treasury, c.previous, c.start_block]), [[TREASURY, [], 100]]);
  await f.restart();
  await f.restart({ previousTreasuries: [] });
  assert.equal((await f.records()).filter((r) => r.type === "config").length, 1);
  const moved = `0x${"7f".repeat(20)}`;
  await f.restart({ treasury: moved, previousTreasuries: [TREASURY] });
  configs = (await f.records()).filter((r) => r.type === "config");
  assert.deepEqual(configs.at(-1), { ...configs.at(-1), treasury: moved, previous: [TREASURY], start_block: 100 });
  assert.match(f.logs.join("\n"), /PAYMENTS CONFIG RECORDED: treasury 0x7f/);
  const off = await fixture({ mode: "off", ...opts });
  assert.equal(await off.raw(), "", "billing off writes nothing at boot");
});

test("while the config line cannot be written, nothing else is written either", async () => {
  // Only the config line fails (a full disk at the wrong moment, say): every other
  // write would succeed, and must still wait, so no account, payment or charge
  // lands under a treasury the ledger does not name.
  let failConfig = false;
  const writeLine = async (file, line) => {
    if (failConfig && line.includes('"type":"config"')) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    return appendFile(file, line, { flush: true });
  };
  const f = await fixture({ treasury: TREASURY, startBlock: 100, previousTreasuries: [], writeLine });
  const moved = `0x${"7c".repeat(20)}`;
  failConfig = true;
  await f.restart({ treasury: moved, writeLine });
  const refused = await f.billing.createAccount(`0x${"cd".repeat(20)}`, "Too early");
  assert.equal(refused.status, 503); assert.equal(refused.json.error.code, "billing_unavailable");
  assert.equal((await f.records()).filter((r) => r.type === "account").length, 0, "no account under the unrecorded treasury");
  failConfig = false;
  assert.equal((await f.billing.createAccount(`0x${"cd".repeat(20)}`, "Now")).status, 201);
  assert.deepEqual((await f.records()).filter((r) => r.type === "config" || r.type === "account").map((r) => r.treasury ?? r.type),
    [TREASURY, moved, "account"], "the config line first, then the account");
});

test("a config line a dead writer's lock kept out at boot is written later, by the tail or before a payment", async () => {
  const f = await fixture({ treasury: TREASURY, startBlock: 100, previousTreasuries: [] });
  const configs = async () => (await f.records()).filter((r) => r.type === "config").map((c) => c.treasury);
  const moved = `0x${"7f".repeat(20)}`;
  // The old process was killed mid-append, holding billing.jsonl.lock, and the
  // deploy that replaced it also moved the treasury.
  await writeFile(`${f.file}.lock`, "");
  await f.restart({ treasury: moved, lockWaitMs: 50 });
  assert.deepEqual(await configs(), [TREASURY]);
  assert.match(f.logs.join("\n"), /could not record the payments config/);
  await f.billing.tail();
  assert.deepEqual(await configs(), [TREASURY], "still locked: still waiting");
  await rm(`${f.file}.lock`);
  await f.billing.tail();
  assert.deepEqual(await configs(), [TREASURY, moved], "written once the lock is gone");
  assert.match(f.logs.join("\n"), /PAYMENTS CONFIG RECORDED: treasury 0x7f/);
  await f.billing.tail();
  assert.deepEqual(await configs(), [TREASURY, moved], "and only once");

  // The same wait, ended by the next write the ledger takes rather than the tail.
  const back = `0x${"7d".repeat(20)}`;
  await writeFile(`${f.file}.lock`, "");
  await f.restart({ treasury: back, lockWaitMs: 50 });
  await rm(`${f.file}.lock`);
  await f.account();
  assert.deepEqual((await f.records()).filter((r) => r.type === "config" || r.type === "account").map((r) => r.treasury ?? r.type),
    [TREASURY, moved, back, "account"], "recorded before the next record");
});

// ── accounts ─────────────────────────────────────────────────────────────────

test("one account per wallet, named by the app-name rule, kept across restarts", async () => {
  const f = await fixture();
  const created = await f.account(OWNER, "  Acme Labs  ");
  assert.match(created.account.id, /^acct_[0-9a-f]{24}$/);
  assert.equal(created.account.name, "Acme Labs");
  assert.equal(created.account.wallet, OWNER);
  assert.equal(created.account.created_at, new Date(START).toISOString());
  assert.equal(created.plan.id, "free");
  assert.equal(created.plan.selected, "free");
  const again = await f.billing.createAccount(OWNER.toUpperCase().replace("0X", "0x"), "Second");
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, "account_exists");
  for (const name of ["", "   ", "x".repeat(49), "Bad\u0007", "Half \ud800", 42, undefined]) {
    const r = await f.billing.createAccount(OTHER, name);
    assert.equal(r.status, 400, String(name));
    assert.equal(r.json.error.code, "invalid_name");
  }
  assert.equal((await f.billing.createAccount("0x1234", "Short")).json.error.code, "invalid_address");
  assert.equal(f.billing.hasAccount(OWNER), true);
  assert.equal(f.billing.hasAccount(OTHER), false);
  await f.restart();
  assert.equal(f.billing.hasAccount(OWNER), true);
  assert.equal(f.view().account.id, created.account.id);
  assert.equal(f.billing.accountView(OTHER).status, 404);
  assert.equal(f.billing.accountView(OTHER).json.error.code, "account_missing");
});

test("concurrent account creation for one wallet writes one account", async () => {
  const f = await fixture();
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => f.billing.createAccount(OWNER, `App ${i}`)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 9);
  assert.equal((await f.records()).filter((r) => r.type === "account").length, 1);
});

test("accounts work with billing off; plans and payments do not", async () => {
  const f = await fixture({ mode: "off" });
  await f.account();
  assert.equal((await f.plan("crumbs", false)).json.error.code, "billing_off");
  assert.equal((await f.billing.submitPayment(OWNER, `0x${"ab".repeat(32)}`)).json.error.code, "billing_off");
  assert.equal(f.billing.plansView().json.treasury, null);
  assert.deepEqual(f.billing.plansView().json.billing, { mode: "off", enforced: false });
});

// ── the ledger ───────────────────────────────────────────────────────────────

test("a torn final line is cut before the next append, so the record after it survives a restart", async () => {
  const f = await fixture();
  await f.account();
  // A write that died part-way: half a record and no newline.
  await appendFile(f.file, '{"id":"0123456789abcdef0123456789abcdef","type":"adjustm');
  assert.equal((await f.plan("crumbs")).status, 200);
  const raw = await f.raw();
  assert.ok(raw.endsWith("\n") && !raw.includes("adjustm"), "the fragment must be removed, not glued to");
  assert.match(f.logs.join("\n"), /torn line/);
  await f.restart();
  assert.equal(f.billing.blocked, null, "nothing unreadable remains");
  assert.equal(f.view().plan.selected, "crumbs", "the select written after the torn line is intact");
});

test("a line another process is still writing is never cut as torn: repair and append wait for its lock", async () => {
  // The operator CLI appends to this file too. Seen mid-write (a line that
  // crosses a page is copied in two steps), its line ends without a newline,
  // like a torn one; cutting it then removed the CLI's record once its write
  // completed. A writer holds billing.jsonl.lock from repair to append.
  const f = await fixture();
  await f.account();
  const acct = (await f.records()).find((r) => r.type === "account");
  const lock = `${f.file}.lock`;
  await writeFile(lock, "", { flag: "wx" }); // the CLI is mid-append
  const cli = `${JSON.stringify({ id: "f".repeat(32), type: "adjustment", at: START, account_id: acct.account_id, amount_raw: T(5).toString(), note: "cli", operator: true })}\n`;
  await appendFile(f.file, cli.slice(0, 40));
  const gateway = f.plan("crumbs"); // the gateway's own append, meanwhile
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok((await f.raw()).endsWith(cli.slice(0, 40)), "the gateway waits; it does not cut the line being written");
  await appendFile(f.file, cli.slice(40));
  await rm(lock);
  assert.equal((await gateway).status, 200);
  await f.billing.tail();
  assert.equal(f.billing.blocked, null);
  assert.deepEqual((await f.records()).map((r) => r.type), ["config", "account", "adjustment", "select"]);
  assert.equal(f.view().credit_tokens, "5", "the CLI's record survived");
  await assert.rejects(stat(lock), { code: "ENOENT" }, "the gateway released its own lock");
});

test("a lock left by a writer that died is broken once stale; one held too long refuses the write without failing the ledger", async () => {
  const f = await fixture({ lockWaitMs: 300 });
  await f.account();
  const lock = `${f.file}.lock`;
  await writeFile(lock, "");
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  assert.equal((await f.plan("crumbs")).status, 200, "a minute-old lock is a dead writer's");
  await writeFile(lock, ""); // fresh, and never released
  const started = Date.now();
  const busy = await f.plan("loaf");
  assert.deepEqual([busy.status, busy.json.error.code], [503, "billing_unavailable"]);
  assert.ok(Date.now() - started < 3_000, "the wait is bounded");
  assert.equal(f.billing.blocked, null, "nothing was written, so nothing needs repair");
  assert.match(f.logs.join("\n"), /locked by another writer/);
  await rm(lock);
  assert.equal((await f.plan("loaf")).status, 200);
});

test("a failed append refuses billing writes until the ledger is repaired, then they resume", async () => {
  let mode = "ok";
  const writeLine = async (file, line) => {
    if (mode === "torn") { mode = "ok"; await appendFile(file, line.slice(0, 20)); throw Object.assign(new Error("no space"), { code: "ENOSPC" }); }
    if (mode === "landed") { mode = "ok"; await appendFile(file, line); throw Object.assign(new Error("fsync"), { code: "EIO" }); }
    return appendFile(file, line, { flush: true });
  };
  const f = await fixture({ writeLine });
  mode = "torn";
  const torn = await f.billing.createAccount(OWNER, "Acme");
  assert.equal(torn.status, 503);
  assert.equal(torn.json.error.code, "billing_unavailable");
  assert.ok((await f.raw()).endsWith("\n"), "the half-written line is cut");
  assert.equal(f.billing.hasAccount(OWNER), false);
  assert.equal(f.billing.blocked, null, "a repair that succeeded lets writes resume");
  await f.account();
  // The bytes all landed but the write still reported failure: the index is
  // rebuilt from disk, so a retry sees the account rather than writing a second.
  mode = "landed";
  assert.equal((await f.billing.createAccount(OTHER, "Other")).status, 503);
  assert.equal(f.billing.hasAccount(OTHER), true);
  assert.equal((await f.billing.createAccount(OTHER, "Other")).json.error.code, "account_exists");
  assert.equal((await f.records()).filter((r) => r.type === "account").length, 2);
});

test("while the ledger cannot be repaired, every billing write answers billing_unavailable", async () => {
  let fail = false;
  // The volume turns read-only mid-write, so the repair after it fails too.
  const writeLine = async (file, line) => {
    if (fail) { fail = false; await chmod(file, 0o444); throw Object.assign(new Error("io"), { code: "EIO" }); }
    return appendFile(file, line, { flush: true });
  };
  const f = await fixture({ writeLine });
  await f.account();
  fail = true;
  try {
    assert.equal((await f.plan("crumbs")).json.error.code, "billing_unavailable");
    assert.equal(f.billing.blocked, "failed");
    assert.match(f.logs.join("\n"), /ledger repair failed/);
    assert.equal((await f.plan("crumbs")).json.error.code, "billing_unavailable", "still refused: the repair has not succeeded");
    assert.equal(f.billing.blocked, "failed");
  } finally {
    await chmod(f.file, 0o644);
  }
  // The 10 s tail retries the repair too, so writes do not wait for a customer.
  await f.billing.tail();
  assert.equal(f.billing.blocked, null);
  assert.equal((await f.plan("crumbs")).status, 200, "a successful repair lets writes resume");
});

/** A ledger line as the writer would produce it. */
let seq = 0;
const line = (rec) => `${JSON.stringify({ id: (++seq).toString(16).padStart(32, "0"), at: START + seq, ...rec })}\n`;
const ACCT = "acct_" + "1".repeat(24);
const payment = (extra = {}) => ({ type: "payment", account_id: ACCT, owner: OWNER, chain_id: 4663, token: "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32",
  recipient: TREASURY, tx_hash: `0x${"cd".repeat(32)}`, block_number: 10, block_hash: `0x${"ef".repeat(32)}`, amount_raw: T(100_000).toString(), log_indexes: [0], ...extra });
const charge = (extra = {}) => ({ type: "charge", account_id: ACCT, charge_id: `chg_${"2".repeat(24)}`, period_id: `per_${"3".repeat(24)}`,
  reason: "activate", tier: "crumbs", price_raw: T(100_000).toString(), tier_price_raw: T(100_000).toString(), requests: 50_000, rpm: 60,
  starts_at: START, ends_at: START + P, ...extra });

test("replay enforces the invariants itself: a transfer, a record id and a charge id each count once", () => {
  const first = line(payment());
  const firstId = JSON.parse(first).id;
  const text = [
    line({ type: "account", account_id: ACCT, owner: OWNER, name: "Acme" }),
    first,
    // The same transfer again: a retry after a lost response, written twice.
    line(payment({ amount_raw: T(100_000).toString() })),
    // A repeated record id, whatever it carries.
    `${JSON.stringify({ id: firstId, at: START + 50, type: "adjustment", account_id: ACCT, amount_raw: T(5).toString(), note: "x", operator: true })}\n`,
    line(charge()),
    // The same charge id again.
    line(charge({ period_id: `per_${"4".repeat(24)}` })),
    // Times that are not safe integers.
    line({ type: "adjustment", account_id: ACCT, amount_raw: T(7).toString(), note: "x", operator: true, at: 1.5 }),
    line({ type: "adjustment", account_id: ACCT, amount_raw: T(7).toString(), note: "x", operator: true, at: 2 ** 53 }),
    line({ type: "select", account_id: "acct_" + "9".repeat(24), tier: "loaf" }),
    line({ type: "account", account_id: "acct_" + "8".repeat(24), owner: OWNER, name: "Second" }),
  ].join("");
  const logs = [];
  const { state } = replayLedger(Buffer.from(text), { log: (l) => logs.push(l) });
  const acct = state.byOwner.get(OWNER);
  assert.equal(acct.credit, 0n, "one payment of 100k, one charge of 100k");
  assert.equal(acct.periods.length, 1);
  assert.equal(state.ignored, 7);
  assert.match(logs.join("\n"), /already credited/);
  assert.match(logs.join("\n"), /repeated id/);
  assert.match(logs.join("\n"), /repeated charge/);
  assert.match(logs.join("\n"), /not a safe integer/);
  assert.match(logs.join("\n"), /unknown account/);
  assert.match(logs.join("\n"), /already has an account/);
  assert.equal(state.corrupt, null);
});

test("a charge beyond everything paid is corruption: replay stops there and billing writes are refused", async () => {
  const f = await fixture();
  await writeFile(f.file, [
    line({ type: "account", account_id: ACCT, owner: OWNER, name: "Acme" }),
    line({ type: "adjustment", account_id: ACCT, amount_raw: T(50_000).toString(), note: "x", operator: true }),
    line(charge()), // 100k charged on 50k: a payment line is missing
    line({ type: "account", account_id: "acct_" + "5".repeat(24), owner: OTHER, name: "Later" }),
  ].join(""));
  await f.restart();
  assert.equal(f.billing.blocked, "corrupt");
  assert.match(f.logs.join("\n"), /LEDGER CORRUPT at billing\.jsonl line 3/);
  // Reads and metering go on with the records before the bad line.
  assert.equal(f.view().credit_raw, T(50_000).toString());
  assert.equal(f.view().plan.id, "free");
  assert.equal(f.billing.hasAccount(OTHER), false);
  assert.equal(f.billing.reserve({ owner: OWNER, keyId: "k" }).ok, true);
  const before = await f.raw();
  assert.equal((await f.plan("crumbs")).json.error.code, "billing_unavailable");
  assert.equal((await f.billing.createAccount(`0x${"c3".repeat(20)}`, "New")).json.error.code, "billing_unavailable");
  assert.equal(f.billing.needsSettle(OWNER), false);
  assert.equal(await f.raw(), before);
});

test("negative credit from a reversal or an operator debit is not corruption; only charges are checked", () => {
  const text = [
    line({ type: "account", account_id: ACCT, owner: OWNER, name: "Acme" }),
    line(payment()),
    line(charge()),
    line({ type: "adjustment", account_id: ACCT, amount_raw: T(-30_000).toString(), note: "x", operator: true }),
  ].join("");
  const { state } = replayLedger(Buffer.from(text));
  assert.equal(state.corrupt, null);
  assert.equal(state.byOwner.get(OWNER).credit, T(-30_000));
});

test("an unreadable complete line is corruption, never skipped", () => {
  const text = [line({ type: "account", account_id: ACCT, owner: OWNER, name: "Acme" }), '{"id":"x","type":"pay\n',
    line({ type: "account", account_id: "acct_" + "5".repeat(24), owner: OTHER, name: "Later" })].join("");
  const { state } = replayLedger(Buffer.from(text));
  assert.deepEqual(state.corrupt, { line: 2, reason: "unreadable line" });
  assert.equal(state.byOwner.has(OTHER), false);
  // A torn LAST line, with no newline, is simply not read.
  const torn = replayLedger(Buffer.from(`${line({ type: "account", account_id: ACCT, owner: OWNER, name: "A" })}{"id":"x`));
  assert.equal(torn.state.corrupt, null);
  assert.equal(torn.state.byOwner.has(OWNER), true);
});

test("billing time never runs behind the ledger, across a clock step back and a restart", async () => {
  const f = await fixture();
  f.advance(10_000);
  await f.account();
  f.clock.t = START - 60_000; // NTP, or a redeploy on a host whose clock is behind
  assert.equal(f.billing.now(), START + 10_000);
  await f.account(OTHER, "Other");
  const [a, b] = (await f.records()).filter((r) => r.type === "account");
  assert.ok(b.at >= a.at, "a later record never carries an earlier time");
  await f.restart();
  assert.equal(f.billing.now(), START + 10_000);
});

test("one record written while the host clock ran far ahead does not pin billing time there", async () => {
  const f = await fixture();
  await f.account();
  await f.grant(200_000);
  await f.plan("crumbs"); // paid for [START, START + 30 days)
  // The host clock jumps a year ahead for a moment (a bad NTP step), long
  // enough for one write, and is then corrected.
  f.clock.t = START + 365 * DAY;
  await f.account(OTHER, "Other");
  f.clock.t = START + DAY;
  assert.ok(f.billing.now() <= START + DAY + 5 * 60_000, `billing time ${new Date(f.billing.now()).toISOString()} follows the clock`);
  assert.equal(f.billing.planFor(OWNER).id, "crumbs", "the paid period has 29 days left, not none");
  assert.equal(f.billing.needsSettle(OWNER), false, "and nothing renews it a year early");
  assert.match(f.logs.join("\n"), /ahead of this host's clock/);
  // The same after a restart, which replays that record.
  await f.restart();
  assert.ok(f.billing.now() <= START + DAY + 5 * 60_000);
  assert.equal(await f.billing.settle(OWNER), 0);
  assert.deepEqual((await f.charges()).map((c) => c.reason), ["activate"]);
});

test("the tail takes the operator CLI's lines, and treats anything else as a second writer", async () => {
  const f = await fixture();
  await f.account();
  await f.grant(250_000);
  assert.equal(f.view().credit_raw, T(250_000).toString());
  // A comp from the CLI: a free period of a tier, picked up without a restart.
  const ledger = await openLedger({ dataDir: f.dir, now: () => f.clock.t, log: () => {} });
  const acct = ledger.state.byOwner.get(OWNER);
  await ledger.enqueue(() => ledger.append({ type: "charge", account_id: acct.account_id, charge_id: `chg_${"6".repeat(24)}`,
    period_id: `per_${"6".repeat(24)}`, reason: "comp", tier: "loaf", price_raw: "0", tier_price_raw: T(400_000).toString(),
    requests: 250_000, rpm: 120, starts_at: f.clock.t, ends_at: f.clock.t + 7 * DAY }));
  assert.equal(f.billing.planFor(OWNER).id, "free", "not seen before the tail");
  await f.billing.tail();
  assert.equal(f.billing.planFor(OWNER).id, "loaf");
  assert.equal(f.billing.blocked, null);
  // A payment appended by another process is a second gateway on this volume.
  await ledger.enqueue(() => ledger.append(payment({ account_id: acct.account_id })));
  const r = await f.billing.tail();
  assert.equal(r.rejected, 1);
  assert.equal(f.billing.blocked, "foreign_writer");
  assert.match(f.logs.join("\n"), /ANOTHER PROCESS APPENDED A payment RECORD/);
  assert.equal(f.view().credit_raw, T(250_000).toString(), "the foreign payment is not credited");
  assert.equal((await f.plan("feast")).json.error.code, "billing_unavailable");
});

test("the tail picks up an operator line that landed between two of the gateway's own", async () => {
  const f = await fixture();
  await f.account();
  const ledger = await openLedger({ dataDir: f.dir, now: () => f.clock.t, log: () => {} });
  const acct = ledger.state.byOwner.get(OWNER);
  await ledger.enqueue(() => ledger.append({ type: "adjustment", account_id: acct.account_id, amount_raw: T(100_000).toString(), note: "x", operator: true }));
  await f.plan("loaf"); // written after the operator's line, before any tail
  await f.billing.tail();
  assert.equal(f.view().credit_raw, T(100_000).toString());
  assert.equal(f.view().plan.selected, "loaf");
  assert.equal(f.billing.blocked, null);
});

// ── plans and settle ─────────────────────────────────────────────────────────

test("credit before any selection waits; selecting a plan previews, then activates for 30 days", async () => {
  const f = await fixture();
  await f.account();
  await f.grant(250_000);
  assert.equal(f.view().plan.selected, "free");
  assert.equal(f.billing.needsSettle(OWNER), false, "credit with nothing selected just accumulates");
  const before = await f.raw();
  const preview = await f.plan("crumbs", false);
  assert.deepEqual(preview.json, { preview: true, tier: "crumbs", effect: "activate_now", charge_now_raw: T(100_000).toString(),
    charge_now_tokens: "100000", charge_now_tier: null, due_raw: null, due_tokens: null, starts_at: new Date(START).toISOString(),
    ends_at: new Date(START + P).toISOString(), period_requests: 50_000 });
  assert.equal(await f.raw(), before, "a preview appends nothing");
  const view = (await f.plan("crumbs")).json;
  assert.equal(view.plan.id, "crumbs");
  assert.equal(view.plan.ends_at, new Date(START + P).toISOString());
  assert.equal(view.credit_raw, T(150_000).toString());
  const [c] = await f.charges();
  assert.deepEqual({ ...c, id: undefined, at: undefined, charge_id: undefined, period_id: undefined, account_id: undefined }, {
    id: undefined, at: undefined, charge_id: undefined, period_id: undefined, account_id: undefined, type: "charge", reason: "activate",
    tier: "crumbs", price_raw: T(100_000).toString(), tier_price_raw: T(100_000).toString(), requests: 50_000, tier_requests: 50_000, rpm: 60,
    starts_at: START, ends_at: START + P });
  assert.match(c.charge_id, /^chg_[0-9a-f]{24}$/);
  assert.match(c.period_id, /^per_[0-9a-f]{24}$/);
  assert.equal((await f.plan("crumbs")).status, 200);
  assert.equal((await f.records()).filter((r) => r.type === "select").length, 1, "a select is written only when it changes");
  assert.equal((await f.plan("bogus", false)).json.error.code, "invalid_tier");
  assert.equal((await f.plan("constructor", false)).json.error.code, "invalid_tier");
  assert.equal((await f.billing.choosePlan(OTHER, { tier: "crumbs" })).json.error.code, "account_missing");
});

test("a lapsed plan renews from NOW: no back-dating, and an idle gap is never paid for", async () => {
  const f = await fixture();
  await f.account();
  await f.grant(250_000);
  await f.plan("crumbs");
  f.advance(P + 5 * DAY);
  const view = f.view();
  assert.equal(view.plan.id, "free");
  assert.equal(view.plan.renews_on_next_request, true);
  assert.equal(f.billing.needsSettle(OWNER), true);
  assert.equal(await f.billing.prepare(OWNER), true);
  const renew = (await f.charges()).at(-1);
  assert.equal(renew.reason, "renew");
  assert.equal(renew.starts_at, START + P + 5 * DAY);
  assert.equal(renew.ends_at, START + 2 * P + 5 * DAY);
  assert.equal(f.view().credit_raw, T(50_000).toString());
  assert.equal(f.billing.needsSettle(OWNER), false);
});

test("a renewal the selection cannot fund keeps the tier that ended, and falls to Free only when neither is funded", async () => {
  const f = await fixture();
  await f.account();
  await f.grant(200_000);
  await f.plan("crumbs"); // 100k left
  await f.plan("feast"); // an upgrade nobody paid for
  assert.equal((await f.charges()).length, 1);
  f.advance(P);
  await f.billing.prepare(OWNER);
  const renew = (await f.charges()).at(-1);
  assert.deepEqual([renew.reason, renew.tier], ["renew", "crumbs"]);
  assert.equal(f.view().plan.selected, "feast", "the upgrade stays pending");
  f.advance(P);
  assert.equal(f.billing.needsSettle(OWNER), false);
  await f.billing.settle(OWNER);
  assert.equal((await f.charges()).length, 2);
  assert.equal(f.view().plan.id, "free");
});

/** A comp as billing-cli.mjs writes it, from another process, picked up by the gateway's tail. */
async function comp(f, tier, days, owner = OWNER, { tail = true } = {}) {
  const ledger = await openLedger({ dataDir: f.dir, now: () => f.clock.t, log: () => {} });
  const acct = ledger.state.byOwner.get(owner);
  const hex = (n) => n.toString(16).padStart(24, "0");
  const n = Math.floor(Math.random() * 2 ** 40);
  await ledger.enqueue(() => ledger.append({ type: "charge", account_id: acct.account_id, charge_id: `chg_${hex(n)}`, period_id: `per_${hex(n)}`,
    reason: "comp", tier, price_raw: "0", tier_price_raw: PLANS[tier].price_raw.toString(), requests: PLANS[tier].requests,
    tier_requests: PLANS[tier].requests, rpm: PLANS[tier].rpm, starts_at: f.clock.t, ends_at: f.clock.t + days * DAY, note: "test" }));
  if (tail) await f.billing.tail();
}

test("a renewal never spends credit on a comped tier the developer did not choose", async () => {
  const f = await fixture();
  await f.account();
  await f.plan("feast"); // selected, and paid toward, but not yet affordable
  await f.grant(500_000);
  await comp(f, "loaf", 30);
  assert.equal(f.billing.planFor(OWNER).id, "loaf");
  f.advance(30 * DAY);
  // The selection cannot be funded, and Loaf was a gift: nothing renews.
  assert.equal(f.billing.needsSettle(OWNER), false);
  assert.equal(await f.billing.settle(OWNER), 0);
  assert.deepEqual([f.view().plan.id, f.view().plan.selected, f.view().credit_tokens], ["free", "feast", "500000"]);
  assert.deepEqual([f.view().due_for, f.view().due_tokens], ["renewal", "500000"]);
  assert.deepEqual((await f.charges()).map((c) => c.reason), ["comp"]);
});

test("a comp the developer upgraded is theirs: a renewal falls back to the tier they paid for", async () => {
  const f = await fixture();
  await f.account();
  await f.grant(750_000);
  await comp(f, "crumbs", 30);
  await f.plan("loaf"); // (400,000 − 100,000) for the whole comp: 450,000 left
  assert.deepEqual((await f.charges()).map((c) => [c.reason, c.tier]), [["comp", "crumbs"], ["upgrade", "loaf"]]);
  await f.plan("feast"); // a dearer selection the credit cannot cover (600,000 now, 1,000,000 to renew)
  f.advance(30 * DAY);
  await f.billing.prepare(OWNER);
  const renew = (await f.charges()).at(-1);
  assert.deepEqual([renew.reason, renew.tier], ["renew", "loaf"]);
  assert.equal(f.view().credit_tokens, "50000");
});

test("a comp over a running paid period never hides it, and never charges an upgrade to what was paid for", async () => {
  const f = await fixture();
  await f.account();
  await f.grant(1_200_000);
  await f.plan("feast"); // 200,000 left
  await comp(f, "loaf", 3);
  const plan = f.billing.planFor(OWNER);
  assert.deepEqual([plan.id, plan.requests, plan.rpm, plan.ends_at], ["feast", 1_000_000, 300, START + P], "the paid Feast, not the cheaper comp");
  assert.equal(f.billing.needsSettle(OWNER), false);
  assert.equal(await f.billing.settle(OWNER), 0, "no 'upgrade' of the comp back to the Feast already paid for");
  assert.deepEqual([f.view().plan.id, f.view().credit_tokens], ["feast", "200000"]);

  // A dearer comp over a cheaper paid period gives the better tier while it
  // runs; the paid period resumes, with its own usage, when the comp ends.
  await f.account(OTHER, "Other");
  await f.grant(100_000, OTHER);
  await f.plan("crumbs", true, OTHER);
  f.billing.reserve({ owner: OTHER, keyId: "k" });
  await comp(f, "feast", 3, OTHER);
  assert.equal(f.billing.planFor(OTHER).id, "feast");
  assert.equal(f.billing.meta(OTHER).billing.requests_used, 0, "the comp is its own window");
  assert.equal(await f.billing.settle(OTHER), 0);
  f.advance(3 * DAY);
  assert.deepEqual([f.billing.planFor(OTHER).id, f.billing.meta(OTHER).billing.requests_used], ["crumbs", 1]);
  assert.equal(await f.billing.settle(OTHER), 0);
  assert.deepEqual((await f.charges()).map((c) => [c.reason, c.tier]), [["activate", "feast"], ["comp", "loaf"], ["activate", "crumbs"], ["comp", "feast"]]);
});

test("settle reads an operator's comp before it charges, without waiting for the 10 s tail", async () => {
  const f = await fixture();
  await f.account();
  await f.grant(200_000);
  await f.plan("crumbs"); // 100,000 left: enough to renew
  f.advance(P);
  assert.equal(f.billing.needsSettle(OWNER), true);
  await comp(f, "feast", 30, OWNER, { tail: false }); // the CLI's line, not yet tailed
  await f.billing.prepare(OWNER);
  assert.deepEqual((await f.charges()).map((c) => c.reason), ["activate", "comp"], "the comp covers it: no renewal paid for alongside it");
  assert.deepEqual([f.view().plan.id, f.view().credit_tokens], ["feast", "100000"]);
});

test("selecting Free cancels the renewal: the running period ends and its credit stays", async () => {
  const f = await fixture();
  await f.account();
  await f.grant(200_000);
  await f.plan("crumbs");
  const preview = (await f.plan("free", false)).json;
  assert.equal(preview.effect, "cancel_renewal");
  assert.equal(preview.starts_at, new Date(START + P).toISOString());
  assert.equal(preview.charge_now_raw, "0");
  await f.plan("free");
  assert.equal(f.view().plan.id, "crumbs", "the paid period runs out");
  f.advance(P);
  assert.equal(f.billing.needsSettle(OWNER), false);
  await f.billing.settle(OWNER);
  assert.equal(f.view().plan.id, "free");
  assert.equal(f.view().credit_raw, T(100_000).toString());
  assert.equal(f.view().due_raw, null);
});

test("a preview names a fallback renewal it would charge, and the request quota the change gives", async () => {
  // Crumbs paid with 250k, renewal cancelled (Free), period over, 150k of credit left.
  const f = await fixture();
  await f.account();
  await f.grant(250_000);
  await f.plan("crumbs");
  await f.plan("free");
  f.advance(P);
  await f.billing.settle(OWNER);
  assert.deepEqual([f.view().plan.id, f.view().credit_tokens], ["free", "150000"]);
  // Feast cannot be afforded, so confirming it renews the tier that ended: that 100k must be named.
  const feast = (await f.plan("feast", false)).json;
  assert.deepEqual([feast.effect, feast.charge_now_tokens, feast.charge_now_tier, feast.due_tokens], ["waiting_for_payment", "100000", "crumbs", "850000"]);
  assert.equal(feast.period_requests, 1_000_000, "paid now, the renewed period moves to Feast for all of its 30 days");
  // A plan credit covers names nothing else.
  const crumbs = (await f.plan("crumbs", false)).json;
  assert.deepEqual([crumbs.effect, crumbs.charge_now_tier, crumbs.period_requests], ["activate_now", null, 50_000]);
  // Mid-period, an upgrade's quota is the time-left share, now or once paid.
  await f.plan("crumbs");
  await f.grant(200_000); // 250k: Loaf's half period (150k) is covered, Feast's (450k) is not
  f.advance(P / 2);
  const now = (await f.plan("loaf", false)).json;
  assert.deepEqual([now.effect, now.charge_now_tier, now.period_requests], ["upgrade_now", null, 150_000]);
  const later = (await f.plan("feast", false)).json;
  assert.deepEqual([later.effect, later.period_requests], ["waiting_for_payment", 50_000 + 475_000]);
  const back = (await f.plan("free", false)).json;
  assert.deepEqual([back.effect, back.period_requests], ["cancel_renewal", 1_000]);
});

test("the account view names the plan a waiting charge is for", async () => {
  const f = await fixture();
  await f.account();
  await f.grant(800_000);
  await f.plan("loaf");
  assert.equal(f.view().plan.renews_into, null, "nothing waits while the period runs");
  f.advance(P);
  const view = f.view();
  assert.deepEqual([view.plan.id, view.plan.renews_on_next_request, view.plan.renews_into], ["free", true, "loaf"]);
});

test("a cheaper tier waits for the renewal", async () => {
  const f = await fixture();
  await f.account();
  await f.grant(600_000);
  await f.plan("loaf"); // 200k left
  const preview = (await f.plan("crumbs", false)).json;
  assert.deepEqual([preview.effect, preview.charge_now_raw, preview.due_raw], ["at_renewal", "0", null]);
  assert.equal(preview.starts_at, new Date(START + P).toISOString());
  assert.equal(preview.ends_at, new Date(START + 2 * P).toISOString());
  await f.plan("crumbs");
  assert.equal(f.view().plan.id, "loaf");
  assert.equal(f.billing.needsSettle(OWNER), false);
  f.advance(P);
  await f.billing.prepare(OWNER);
  assert.deepEqual([(await f.charges()).at(-1).reason, (await f.charges()).at(-1).tier], ["renew", "crumbs"]);
  assert.equal(f.view().credit_raw, T(100_000).toString());
});

test("an upgrade is ONE ledger line on the same period: usage carries over and a second settle writes nothing", async () => {
  const f = await fixture();
  await f.account();
  await f.grant(500_000);
  await f.plan("crumbs"); // 400k left
  const period = (await f.charges())[0].period_id;
  for (let i = 0; i < 3; i++) f.billing.reserve({ owner: OWNER, keyId: "key1" });
  f.advance(P / 2);
  const preview = (await f.plan("loaf", false)).json;
  assert.equal(preview.effect, "upgrade_now");
  assert.equal(preview.charge_now_raw, T(150_000).toString(), "(400k − 100k) × half a period");
  assert.equal(preview.ends_at, new Date(START + P).toISOString(), "the period keeps its end");
  const lines = (await f.records()).length;
  await f.plan("loaf");
  const added = (await f.records()).slice(lines);
  assert.deepEqual(added.map((r) => [r.type, r.reason]), [["select", undefined], ["charge", "upgrade"]]);
  const up = added[1];
  assert.equal(up.period_id, period);
  assert.equal(up.ends_at, START + P);
  assert.equal(up.price_raw, T(150_000).toString());
  assert.equal(up.tier_price_raw, T(400_000).toString());
  // Half a period of Loaf on top of Crumbs: 50,000 + (250,000 − 50,000) / 2.
  assert.deepEqual([up.tier, up.requests, up.tier_requests, up.rpm], ["loaf", 150_000, 250_000, 120]);
  assert.equal(f.view().credit_raw, T(250_000).toString());
  // Settle again, now and later in the period: nothing more to write.
  assert.equal(f.billing.needsSettle(OWNER), false);
  assert.equal(await f.billing.settle(OWNER), 0);
  f.advance(DAY);
  assert.equal(await f.billing.settle(OWNER), 0);
  await f.billing.flush();
  await f.restart();
  assert.equal(await f.billing.settle(OWNER), 0, "replay sees the upgrade as applied");
  assert.equal((await f.charges()).length, 2);
  // The window is the period's, so the count carries over; the rate is Loaf's,
  // the quota what the upgrade bought for the half period left.
  const plan = f.billing.planFor(OWNER);
  assert.deepEqual([plan.id, plan.requests, plan.rpm, plan.starts_at, plan.ends_at], ["loaf", 150_000, 120, START, START + P]);
  assert.equal(f.billing.reserve({ owner: OWNER, keyId: "key1" }).headers["x-merrymen-quota-remaining"], String(150_000 - 4));
});

test("a late upgrade raises the request quota only for the time it paid for, as it does the price", async () => {
  // Crumbs, then Feast with two days left: (1,000,000 − 100,000) × 2/30 =
  // 60,000. Feast's FULL million requests for that would be most of a Feast
  // period for 6% of its price, every month (select Crumbs again and repeat).
  const f = await fixture();
  await f.account();
  await f.grant(2_000_000);
  await f.plan("crumbs");
  f.advance(P - 2 * DAY);
  const preview = (await f.plan("feast", false)).json;
  assert.deepEqual([preview.effect, preview.charge_now_raw], ["upgrade_now", T(60_000).toString()]);
  await f.plan("feast");
  const up = (await f.charges()).at(-1);
  const more = Math.floor((1_000_000 - 50_000) * (2 * DAY) / P); // Feast's extra requests, for two days of thirty
  assert.equal(more, 63_333);
  assert.deepEqual([up.reason, up.price_raw, up.requests, up.tier_requests, up.rpm], ["upgrade", T(60_000).toString(), 50_000 + more, 1_000_000, 300]);
  const plan = f.billing.planFor(OWNER);
  assert.deepEqual([plan.id, plan.requests, plan.rpm], ["feast", 50_000 + more, 300]);
  assert.equal(f.view().usage.limit, 50_000 + more);
  await f.restart();
  assert.equal(f.billing.planFor(OWNER).requests, 50_000 + more, "replayed as recorded");
  // The renewal is a whole new period at the selected tier's whole quota.
  f.advance(2 * DAY);
  await f.billing.prepare(OWNER);
  const renew = (await f.charges()).at(-1);
  assert.deepEqual([renew.reason, renew.tier, renew.requests, renew.tier_requests], ["renew", "feast", 1_000_000, 1_000_000]);
});

test("an upgrade credit cannot cover waits for payment, and what is due only falls as the period runs", async () => {
  const f = await fixture();
  await f.account();
  await f.grant(100_000);
  await f.plan("crumbs"); // 0 left
  const preview = (await f.plan("loaf", false)).json;
  assert.equal(preview.effect, "waiting_for_payment");
  assert.equal(preview.due_raw, T(300_000).toString());
  const lines = (await f.records()).length;
  await f.plan("loaf");
  assert.deepEqual((await f.records()).slice(lines).map((r) => r.type), ["select"]);
  assert.equal(f.view().due_for, "upgrade");
  assert.equal(f.view().due_raw, T(300_000).toString());
  f.advance(P / 3);
  const due = BigInt(f.view().due_raw);
  assert.equal(due, upgradeRaw(T(400_000), T(100_000), START + P, START + P / 3));
  assert.ok(due < T(300_000));
  assert.equal(f.view().due_tokens, String((due + ONE_TOKEN - 1n) / ONE_TOKEN), "what to send is rounded up to a whole token");
  // Paying exactly what was quoted earlier always suffices.
  await f.grant(T(300_000));
  assert.equal(f.billing.needsSettle(OWNER), true);
  await f.billing.prepare(OWNER);
  assert.equal((await f.charges()).at(-1).reason, "upgrade");
  assert.equal(f.view().credit_raw, (T(300_000) - due).toString(), "the surplus stays as credit");
});

test("a paid period keeps what it was sold with when the table changes; a removed tier renews into Free", async () => {
  const f = await fixture();
  await f.account();
  await f.grant(300_000);
  await f.plan("crumbs");
  const edited = { ...PLANS, crumbs: { ...PLANS.crumbs, requests: 10, rpm: 5, price_raw: T(150_000) } };
  await f.restart({ plans: edited });
  const plan = f.billing.planFor(OWNER);
  assert.deepEqual([plan.requests, plan.rpm], [50_000, 60], "the recorded entitlement, not the table's");
  // Same tier at a new price is not an upgrade: it applies at renewal.
  assert.equal(f.billing.needsSettle(OWNER), false);
  f.advance(P);
  await f.billing.prepare(OWNER);
  const renew = (await f.charges()).at(-1);
  assert.deepEqual([renew.reason, renew.price_raw, renew.requests], ["renew", T(150_000).toString(), 10]);
  const { crumbs, ...removed } = PLANS;
  await f.restart({ plans: removed });
  assert.equal(f.billing.planFor(OWNER).id, "crumbs", "a removed tier keeps its period until it ends");
  f.advance(P);
  await f.billing.settle(OWNER);
  assert.equal(f.view().plan.id, "free");
  assert.equal((await f.charges()).length, 2);
  assert.match(f.logs.join("\n"), /selected crumbs, which is no longer a plan/);
});

test("while credit is negative nothing is charged, and the view shows the shortfall", async () => {
  const f = await fixture();
  await f.account();
  await f.grant(100_000);
  await f.plan("crumbs");
  await f.grant(-50_000);
  assert.equal(f.view().credit_tokens, "-50000");
  await f.plan("loaf");
  assert.equal((await f.charges()).length, 1);
  assert.equal(f.view().due_raw, T(350_000).toString(), "the upgrade plus the shortfall");
  f.advance(P);
  assert.equal(f.billing.needsSettle(OWNER), false);
  assert.equal(await f.billing.settle(OWNER), 0);
  assert.equal(f.view().due_raw, T(450_000).toString(), "a renewal at Loaf plus the shortfall");
  assert.equal(f.view().due_for, "renewal");
});

test("settle is idempotent, and twenty requests at a renewal boundary make one charge", async () => {
  const f = await fixture();
  await f.account();
  await f.plan("crumbs");
  await f.grant(1_000_000);
  const settled = await Promise.all(Array.from({ length: 20 }, () => f.billing.prepare(OWNER)));
  assert.ok(settled.every(Boolean));
  assert.equal((await f.charges()).length, 1);
  const lines = (await f.raw()).length;
  assert.equal(await f.billing.settle(OWNER), 0);
  f.advance(1);
  assert.equal(await f.billing.settle(OWNER), 0);
  assert.equal((await f.raw()).length, lines);
});

test("a metered request waits at most the settle budget, then is served on the state before it", async () => {
  let hold = null;
  const writeLine = async (file, l) => { if (l.includes('"type":"charge"') && hold) await hold; return appendFile(file, l, { flush: true }); };
  const f = await fixture({ writeLine, settleWaitMs: 30 });
  await f.account();
  await f.plan("crumbs");
  let release;
  hold = new Promise((r) => { release = r; });
  await f.grant(100_000);
  const started = Date.now();
  assert.equal(await f.billing.prepare(OWNER), false, "fails open");
  assert.ok(Date.now() - started < 1_000);
  assert.equal(f.billing.planFor(OWNER).id, "free");
  release();
  await f.billing.settle(OWNER);
  assert.equal(f.billing.planFor(OWNER).id, "crumbs");
  assert.equal((await f.charges()).length, 1);
});

test("reads never append: views, previews, meta and the settle check leave the ledger byte-identical", async () => {
  const f = await fixture();
  await f.account();
  await f.grant(1_000_000);
  await f.plan("crumbs");
  await f.plan("loaf"); // upgraded at once, 600k left; let the period lapse with a renewal due
  f.advance(P + DAY);
  const before = await f.raw();
  assert.equal(f.view().plan.renews_on_next_request, true);
  f.billing.accountView(OWNER);
  f.billing.plansView();
  f.billing.meta(OWNER);
  f.billing.planFor(OWNER);
  f.billing.needsSettle(OWNER);
  f.billing.hasAccount(OWNER);
  for (const tier of Object.keys(PLANS)) assert.equal((await f.plan(tier, false)).status, 200);
  await f.billing.flush();
  await f.billing.tail(); // queued behind anything a read might have started
  assert.equal(await f.raw(), before);
  assert.equal(f.view().plan.id, "free", "projected, not applied");
});

test("with billing off, settle never appends, even with credit and a selection", async () => {
  const f = await fixture();
  await f.account();
  await f.plan("crumbs");
  await f.grant(200_000);
  await f.restart({ mode: "off" });
  const before = await f.raw();
  assert.equal(f.billing.needsSettle(OWNER), false);
  assert.equal(await f.billing.settle(OWNER), 0);
  assert.equal(await f.billing.prepare(OWNER), true);
  assert.equal(await f.raw(), before);
  assert.equal(f.view().renews_on_next_request, undefined);
  assert.equal(f.view().plan.renews_on_next_request, false);
  assert.equal(f.view().due_raw, null);
});

// ── metering ─────────────────────────────────────────────────────────────────

const small = { ...PLANS, free: { ...PLANS.free, requests: 3 } };

test("enforce refuses a spent quota with 402 and structured fields, and does not count the refusal", async () => {
  const f = await fixture({ mode: "enforce", plans: small });
  for (let i = 0; i < 3; i++) assert.equal(f.billing.reserve({ owner: OWNER, keyId: "k1" }).ok, true);
  const refused = f.billing.reserve({ owner: OWNER, keyId: "k1" });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 402);
  const resets = START - (START % P) + P; // no account or key: epoch-aligned windows
  assert.deepEqual(refused.error, { code: "quota_exhausted", message: refused.error.message, plan: "free", limit: 3, used: 3,
    resets_at: new Date(resets).toISOString(), upgrade_url: "https://merrymen.dev/api#plans" });
  assert.deepEqual(refused.headers, { "x-merrymen-quota-limit": "3", "x-merrymen-quota-remaining": "0",
    "x-merrymen-quota-reset": String(Math.ceil(resets / 1000)), "x-merrymen-quota-enforced": "true",
    "retry-after": String(Math.ceil((resets - START) / 1000)) });
  assert.equal(f.billing.meta(OWNER).billing.requests_used, 3, "a 402 is not counted");
  f.billing.release(f.billing.reserve({ owner: OTHER, keyId: "k2" }).ticket);
  assert.equal(f.billing.meta(OTHER).billing.requests_used, 0, "another wallet has its own quota");
});

test("a spent quota on the dearest plan does not send the developer to a larger plan that does not exist", async () => {
  const tiny = { ...PLANS, free: { ...PLANS.free, requests: 2 }, feast: { ...PLANS.feast, requests: 2 } };
  const f = await fixture({ mode: "enforce", plans: tiny });
  await f.account();
  assert.equal(f.billing.reserve({ owner: OWNER, keyId: "k1" }).ok, true);
  assert.equal(f.billing.reserve({ owner: OWNER, keyId: "k1" }).ok, true);
  const free = f.billing.reserve({ owner: OWNER, keyId: "k1" }).error;
  assert.match(free.message, /^This account has used its 2 requests on Free until .*\. Choose a larger plan at https:\/\/merrymen\.dev\/api#plans\.$/);
  await f.grant(1_000_000);
  assert.equal((await f.plan("feast")).json.plan.id, "feast");
  assert.equal(f.billing.reserve({ owner: OWNER, keyId: "k1" }).ok, true);
  assert.equal(f.billing.reserve({ owner: OWNER, keyId: "k1" }).ok, true);
  const top = f.billing.reserve({ owner: OWNER, keyId: "k1" });
  assert.equal(top.status, 402);
  const ends = new Date(START + P).toISOString();
  assert.equal(top.error.message, `This account has used its 2 requests on Feast until ${ends}. Feast is the largest plan, so its quota resets then; there is no larger plan to move to.`);
  assert.doesNotMatch(top.error.message, /Choose a larger plan/);
  // The structured fields keep their contract: partners read these, not the prose.
  assert.deepEqual({ ...top.error, message: undefined }, { code: "quota_exhausted", message: undefined, plan: "feast", limit: 2, used: 2, resets_at: ends,
    upgrade_url: "https://merrymen.dev/api#plans" });
});

test("observe counts past the limit without refusing, and remaining never goes below zero", async () => {
  const f = await fixture({ plans: small });
  let last;
  for (let i = 0; i < 5; i++) last = f.billing.reserve({ owner: OWNER, keyId: "k1" });
  assert.equal(last.ok, true);
  assert.equal(last.headers["x-merrymen-quota-remaining"], "0");
  assert.equal(last.headers["x-merrymen-quota-enforced"], "false");
  assert.equal(f.billing.meta(OWNER).billing.requests_used, 5);
});

test("the check and the count are one synchronous step, so the limit holds under any concurrency", async () => {
  const f = await fixture({ mode: "enforce", plans: small });
  const results = await Promise.all(Array.from({ length: 50 }, async () => f.billing.reserve({ owner: OWNER, keyId: "k" })));
  assert.equal(results.filter((r) => r.ok).length, 3);
});

test("a platform failure gives its unit back, never below zero; a partner's own mistake stays counted", async () => {
  const f = await fixture({ mode: "enforce", plans: small });
  const tickets = [0, 1, 2].map(() => f.billing.reserve({ owner: OWNER, keyId: "k" }).ticket);
  assert.equal(f.billing.reserve({ owner: OWNER, keyId: "k" }).ok, false);
  f.billing.release(tickets[0]);
  assert.equal(f.billing.reserve({ owner: OWNER, keyId: "k" }).ok, true);
  for (let i = 0; i < 10; i++) f.billing.release(tickets[1]);
  assert.equal(f.billing.meta(OWNER).billing.requests_used, 0);
  f.billing.release(undefined);
  f.billing.release({ key: "nope|1", keyId: "k" });
  for (const [status, code, want] of [[500, "x", true], [503, "upstream_unavailable", true], [502, undefined, true],
    [409, "conversation_busy", true], [409, "enrollment_busy", true], [400, "upstream_invalid_response", true],
    [409, "identity_conflict", false], [400, "bad_request", false], [404, "not_found", false], [403, "forbidden_scope", false],
    [429, "rate_limited", false], [200, undefined, false], [201, undefined, false]]) {
    assert.equal(isPlatformFailure(status, code), want, `${status} ${code}`);
  }
});

test("operator keys and billing off are never metered", async () => {
  const f = await fixture({ mode: "enforce", plans: small });
  for (const owner of [null, undefined, "", "not-a-wallet"]) {
    assert.deepEqual(f.billing.reserve({ owner, keyId: "op" }), { ok: true, metered: false, headers: {} });
    assert.deepEqual(f.billing.meta(owner), { billing: null, rate_per_min: null, headers: {} });
  }
  const off = await fixture({ mode: "off", plans: small });
  for (let i = 0; i < 5; i++) assert.equal(off.billing.reserve({ owner: OWNER, keyId: "k" }).metered, false);
  assert.equal(off.billing.meta(OWNER).billing, null);
  await off.billing.flush();
  await assert.rejects(stat(path.join(off.dir, "usage.json")), { code: "ENOENT" });
});

test("rpm and the quota come from the plan, paid ones from the charge, and /meta reports them without counting", async () => {
  const f = await fixture();
  await f.account();
  assert.deepEqual([f.billing.planFor(OWNER).rpm, f.billing.planFor(OWNER).requests], [30, 1_000]);
  await f.grant(400_000);
  await f.plan("loaf");
  const meta = f.billing.meta(OWNER);
  assert.equal(meta.rate_per_min, 120);
  assert.deepEqual(meta.billing, { mode: "observe", enforced: false, plan: "loaf", requests_limit: 250_000, requests_used: 0,
    resets_at: new Date(START + P).toISOString(), plan_ends_at: new Date(START + P).toISOString(), renews_on_next_request: false });
  assert.deepEqual(meta.headers, quotaHeaders({ limit: 250_000, used: 0, resetsAt: START + P, enforced: false }));
  assert.equal(f.billing.meta(OWNER).billing.requests_used, 0, "/meta is not metered");
});

test("a Free window is anchored at the first key or account, of any status, and never moves", async () => {
  const A = START - 40 * DAY;
  const keys = [
    { keyId: "k1", owner: OWNER, status: "revoked", created_at: new Date(A).toISOString() },
    { keyId: "k2", owner: OWNER, status: "active", created_at: new Date(A + 5 * DAY).toISOString() },
    { keyId: "k3", owner: OTHER, status: "active", created_at: "2026-10-01" },
  ];
  const f = await fixture({ keys });
  // 40 days after the first key: the second window, from A + 30 days.
  assert.equal(f.billing.planFor(OWNER).starts_at, A + P);
  for (let i = 0; i < 2; i++) f.billing.reserve({ owner: OWNER, keyId: "k2", keyCreatedAt: keys[1].created_at });
  // Creating an account later does not move the window or refill the quota.
  await f.account();
  assert.equal(f.billing.planFor(OWNER).starts_at, A + P);
  assert.equal(f.view().usage.used, 2);
  assert.equal(f.view().usage.resets_at, new Date(A + 2 * P).toISOString());
  // Nor does a restart that reads the same registry.
  await f.billing.flush();
  await f.restart();
  assert.equal(f.billing.planFor(OWNER).starts_at, A + P);
  assert.equal(f.view().usage.used, 2);
  // Windows roll every 30 days from the anchor.
  f.advance(P);
  assert.equal(f.billing.planFor(OWNER).starts_at, A + 2 * P);
  // A date-only created_at (CLI keys) still anchors.
  assert.equal(f.billing.planFor(OTHER).starts_at % DAY, Date.parse("2026-10-01") % DAY);
});

test("an owner the registry has not seen yet is anchored at the key that made the request", async () => {
  const f = await fixture();
  const K = START - 3 * DAY;
  f.billing.reserve({ owner: OWNER, keyId: "fresh", keyCreatedAt: new Date(K).toISOString() });
  assert.equal(f.billing.planFor(OWNER).starts_at, K);
  // An owner with no key time and no account: windows aligned to the epoch.
  assert.equal(f.billing.planFor(OTHER).starts_at, START - (START % P));
});

test("a paid period is its own usage window, and Free resumes its own when it ends", async () => {
  const f = await fixture();
  await f.account();
  for (let i = 0; i < 4; i++) f.billing.reserve({ owner: OWNER, keyId: "k" });
  await f.grant(100_000);
  await f.plan("crumbs");
  assert.equal(f.billing.meta(OWNER).billing.requests_used, 0);
  f.billing.reserve({ owner: OWNER, keyId: "k" });
  assert.equal(f.billing.meta(OWNER).billing.requests_used, 1);
  f.advance(P / 2);
  assert.equal(f.billing.meta(OWNER).billing.requests_used, 1);
  f.advance(P / 2);
  // Free again (the account was created at START, so its window is [START + P, START + 2P)).
  assert.equal(f.billing.planFor(OWNER).id, "free");
  assert.equal(f.billing.planFor(OWNER).starts_at, START + P);
});

test("usage is saved atomically, survives a restart, is broken down by key, and old windows are pruned", async () => {
  const f = await fixture();
  await f.account();
  for (let i = 0; i < 3; i++) f.billing.reserve({ owner: OWNER, keyId: "aaaa" });
  f.billing.reserve({ owner: OWNER, keyId: "bbbb" });
  await f.billing.flush();
  const usageFile = path.join(f.dir, "usage.json");
  const saved = JSON.parse(await readFile(usageFile, "utf8"));
  assert.equal(saved.v, 1);
  assert.deepEqual(Object.values(saved.windows)[0].keys, { aaaa: 3, bbbb: 1 });
  await assert.rejects(stat(`${usageFile}.tmp`), { code: "ENOENT" });
  await f.restart();
  assert.deepEqual(f.view().usage, { used: 4, limit: 1_000, resets_at: new Date(START + P).toISOString(),
    by_key: [{ key_id: "aaaa", used: 3 }, { key_id: "bbbb", used: 1 }] });
  // Nothing new counted: flush does not rewrite the file.
  await rm(usageFile);
  await f.billing.flush();
  await assert.rejects(stat(usageFile), { code: "ENOENT" });
  // Two periods later the old window is dropped on the next write.
  f.advance(2 * P + 1);
  f.billing.reserve({ owner: OWNER, keyId: "aaaa" });
  await f.billing.flush();
  const pruned = JSON.parse(await readFile(usageFile, "utf8"));
  assert.deepEqual(Object.keys(pruned.windows), [`${OWNER}|${START + 2 * P}`]);
});

test("usage.json is replaced by a rename, never written in place: a failed write leaves the last save whole", async () => {
  const f = await fixture();
  await f.account();
  const usageFile = path.join(f.dir, "usage.json");
  f.billing.reserve({ owner: OWNER, keyId: "k" });
  await f.billing.flush();
  const first = await stat(usageFile);
  const saved = await readFile(usageFile, "utf8");
  f.billing.reserve({ owner: OWNER, keyId: "k" });
  await f.billing.flush();
  assert.notEqual((await stat(usageFile)).ino, first.ino, "a new file renamed over the old one");
  const second = await readFile(usageFile, "utf8");
  assert.notEqual(second, saved);
  // The next write cannot be made (its temp path is taken by a directory):
  // the file a restart reads is still the whole last save, not a torn one.
  await mkdir(`${usageFile}.tmp`);
  f.billing.reserve({ owner: OWNER, keyId: "k" });
  await f.billing.flush();
  assert.equal(await readFile(usageFile, "utf8"), second);
  assert.match(f.logs.join("\n"), /could not write usage\.json/);
  // And the count is not lost: it is written once the path is free.
  await rm(`${usageFile}.tmp`, { recursive: true });
  await f.billing.flush();
  assert.equal(JSON.parse(await readFile(usageFile, "utf8")).windows[`${OWNER}|${START}`].total, 3);
});

test("an unreadable usage.json starts the counts empty and says so", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, "usage.json"), "{torn");
  const f = await fixture({ dir });
  assert.match(f.logs.join("\n"), /usage\.json is unreadable/);
  assert.equal(f.billing.meta(OWNER).billing.requests_used, 0);
});

test("close lets a queued write finish and saves usage", async () => {
  const f = await fixture();
  await f.account();
  f.billing.reserve({ owner: OWNER, keyId: "k" });
  const pending = f.billing.choosePlan(OWNER, { tier: "crumbs", confirm: true });
  await f.billing.close();
  assert.equal((await pending).status, 200);
  assert.equal(JSON.parse(await readFile(path.join(f.dir, "usage.json"), "utf8")).windows[`${OWNER}|${START}`].total, 1);
});

test("GET /plans lists the table in raw and whole tokens, with no treasury until payments are ready", async () => {
  const f = await fixture();
  const view = f.billing.plansView();
  assert.equal(view.status, 200);
  assert.deepEqual(view.json, {
    billing: { mode: "observe", enforced: false }, period_days: 30,
    currency: { symbol: "MERRYMEN", address: "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32", chain_id: 4663, decimals: 18,
      explorer_url: "https://robinhoodchain.blockscout.com/token/0xa15cd06dd305269a0f48bebeb30aa3588fba7b32" },
    treasury: null, confirmations: { blocks: 64, min_age_sec: 120 },
    plans: [
      { id: "free", name: "Free", price_tokens: "0", price_raw: "0", requests: 1_000, rpm: 30 },
      { id: "crumbs", name: "Crumbs", price_tokens: "100000", price_raw: T(100_000).toString(), requests: 50_000, rpm: 60 },
      { id: "loaf", name: "Loaf", price_tokens: "400000", price_raw: T(400_000).toString(), requests: 250_000, rpm: 120 },
      { id: "feast", name: "Feast", price_tokens: "1000000", price_raw: T(1_000_000).toString(), requests: 1_000_000, rpm: 300 },
    ],
  });
});

test("history lists payments, charges, reversals and adjustments newest first, at most 50, without operator notes", async () => {
  const f = await fixture();
  await f.account();
  for (let i = 0; i < 55; i++) await f.grant(1);
  await f.plan("free");
  const h = f.view().history;
  assert.equal(h.length, 50);
  assert.deepEqual(h[0], { type: "adjustment", at: new Date(START).toISOString(), amount_raw: ONE_TOKEN.toString(), amount_tokens: "1" });
  assert.ok(!JSON.stringify(h).includes("note"));
});
