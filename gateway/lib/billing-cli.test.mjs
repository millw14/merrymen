/**
 * The operator CLI (billing-cli.mjs), run as a real process against a temp
 * volume while a gateway's billing reads the same files.
 *
 * `node --test lib/billing-cli.test.mjs`
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createBilling, createPaymentsClient } from "./billing.mjs";
import { ONE_TOKEN, PLANS } from "./billing-plans.mjs";
import { startFakeChain, transferLog } from "./fake-rpc.test-helper.mjs";

const CLI = fileURLToPath(new URL("../billing-cli.mjs", import.meta.url));
const T = (n) => BigInt(n) * ONE_TOKEN;
const OWNER = `0x${"a1".repeat(20)}`;
const TREASURY = `0x${"7e".repeat(20)}`;
const cleanup = [];
after(() => Promise.all(cleanup.map((fn) => fn())));

async function setup(env = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "merrymen-billing-cli-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const billing = await createBilling({ dataDir: dir, mode: "observe", timers: false, log: () => {}, keyRegistry: async () => new Map(), ...env.billing });
  const run = async (...args) => {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args],
        { env: { PATH: process.env.PATH, MERRYMEN_DATA_DIR: dir, MERRYMEN_BILLING: "observe", ...env.process } });
      return { code: 0, stdout, stderr };
    } catch (err) {
      return { code: err.code, stdout: err.stdout, stderr: err.stderr };
    }
  };
  const records = async () => (await readFile(path.join(dir, "billing.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { dir, billing, run, records };
}

test("adjust and comp append through the gateway's writer, and the running gateway picks them up", async () => {
  const s = await setup();
  assert.equal((await s.billing.createAccount(OWNER, "Acme")).status, 201);
  const adjusted = await s.run("adjust", OWNER.toUpperCase().replace("0X", "0x"), "+250000.5", "--note", "paid the old address by hand");
  assert.equal(adjusted.code, 0, adjusted.stderr);
  assert.match(adjusted.stdout, /\+250000\.5 MERRYMEN of API credit, now 250000\.5/);
  const adj = (await s.records()).at(-1);
  assert.deepEqual([adj.type, adj.amount_raw, adj.note, adj.operator], ["adjustment", (T(250_000) + ONE_TOKEN / 2n).toString(), "paid the old address by hand", true]);
  await s.billing.tail();
  assert.equal(s.billing.accountView(OWNER).json.credit_tokens, "250000.5");
  assert.equal(s.billing.blocked, null, "an adjustment is the CLI's to write");

  const comped = await s.run("comp", OWNER, "loaf", "45", "--note", "launch partner");
  assert.equal(comped.code, 0, comped.stderr);
  const c = (await s.records()).at(-1);
  assert.deepEqual([c.type, c.reason, c.tier, c.price_raw, c.tier_price_raw, c.requests, c.tier_requests, c.rpm, c.ends_at - c.starts_at],
    ["charge", "comp", "loaf", "0", PLANS.loaf.price_raw.toString(), 250_000, 250_000, 120, 45 * 86_400_000]);
  await s.billing.tail();
  assert.equal(s.billing.planFor(OWNER).id, "loaf");
  assert.equal(s.billing.accountView(OWNER).json.credit_tokens, "250000.5", "a comp costs nothing");
  assert.equal(s.billing.blocked, null);

  const listed = await s.run("list");
  assert.match(listed.stdout, new RegExp(`${OWNER}\\s+loaf\\s+until \\d{4}-\\d\\d-\\d\\d\\s+credit\\s+250000\\.5\\s+selected free\\s+"Acme"`));
  const shown = await s.run("show", OWNER);
  assert.match(shown.stdout, /plan\s+loaf /);
  assert.match(shown.stdout, /comp/);
  assert.match(shown.stdout, /adjustment\s+250000\.5/);
  // The operator's notes stay in the ledger; the developer's view never carries them.
  assert.ok(!JSON.stringify(s.billing.accountView(OWNER).json).match(/launch partner|old address/));
});

test("the CLI refuses what it cannot write correctly, and writes nothing then", async () => {
  const s = await setup();
  await s.billing.createAccount(OWNER, "Acme");
  const before = (await s.records()).length;
  const refusals = [
    [["adjust", OWNER, "+5"], /--note/],
    [["adjust", OWNER, "5", "--note", "bad\nnote"], /--note/],
    [["adjust", OWNER, "1e5", "--note", "x"], /signed token amount/],
    [["adjust", OWNER, "0", "--note", "x"], /zero/],
    [["adjust", `0x${"b2".repeat(20)}`, "+5", "--note", "x"], /no account for 0xb2/],
    [["adjust", "0x1234", "+5", "--note", "x"], /not a wallet address/],
    [["comp", OWNER, "free", "30", "--note", "x"], /paid tier/],
    [["comp", OWNER, "constructor", "30", "--note", "x"], /paid tier/],
    [["comp", OWNER, "crumbs", "0", "--note", "x"], /1 to 365/],
    [["comp", OWNER, "crumbs", "2.5", "--note", "x"], /1 to 365/],
    [["show", `0x${"b2".repeat(20)}`], /no account/],
    [["frobnicate"], /usage/],
  ];
  for (const [args, message] of refusals) {
    const r = await s.run(...args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr + r.stdout, message, args.join(" "));
  }
  assert.equal((await s.records()).length, before);
  const usage = await s.run();
  assert.equal(usage.code, 0);
  assert.match(usage.stdout, /usage: billing-cli\.mjs/);
});

test("the CLI will not write to a corrupt ledger", async () => {
  const s = await setup();
  await s.billing.createAccount(OWNER, "Acme");
  await appendFile(path.join(s.dir, "billing.jsonl"), "not json\n");
  const r = await s.run("adjust", OWNER, "+5", "--note", "x");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the ledger is corrupt: not writing/);
});

test("reconcile is a dry run: it names a payment the chain no longer holds and writes nothing", async () => {
  const rpc = await startFakeChain({ head: 1_000 });
  cleanup.push(rpc.close);
  const now = { t: Date.now() };
  const s = await setup({
    billing: { treasury: TREASURY, startBlock: 1, minConfirmations: 1, minAgeSec: 0, publicClient: createPaymentsClient(rpc.url), now: () => now.t },
    process: { MERRYMEN_PAYMENTS_RPC: rpc.url, MERRYMEN_PAYMENTS_TREASURY: TREASURY, MERRYMEN_PAYMENTS_START_BLOCK: "1" },
  });
  await s.billing.createAccount(OWNER, "Acme");
  const hash = rpc.chain.mine({ logs: [transferLog({ from: OWNER, to: TREASURY, value: T(100_000) })] });
  assert.equal((await s.billing.submitPayment(OWNER, hash)).status, 200);
  const clean = await s.run("reconcile");
  assert.equal(clean.code, 0, clean.stderr);
  assert.match(clean.stdout, /every recent payment still stands/);
  rpc.chain.drop(hash);
  const before = (await s.records()).length;
  const r = await s.run("reconcile", "--all");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`WOULD REVERSE\\s+${hash}\\s+${OWNER}\\s+100000 MERRYMEN\\s+\\(receipt_missing\\)`));
  assert.match(r.stdout, /dry run: nothing written/);
  assert.equal((await s.records()).length, before);
  const none =await promisify(execFile)(process.execPath, [CLI, "reconcile"], { env: { PATH: process.env.PATH, MERRYMEN_DATA_DIR: s.dir } }).catch((e) => e);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /MERRYMEN_PAYMENTS_RPC/);
});
