/**
 * Payments: read-only verification of a $MERRYMEN transfer, against a fake
 * JSON-RPC chain over HTTP through a real viem client. Nothing here reaches a
 * real chain or holds a key; the gateway never sends a transaction.
 *
 * `node --test lib/billing-payments.test.mjs`
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBilling, createPaymentsClient, matchTransfers } from "./billing.mjs";
import { ONE_TOKEN, PERIOD_MS, TOKEN } from "./billing-plans.mjs";
import { TRANSFER_TOPIC, startFakeChain, transferLog } from "./fake-rpc.test-helper.mjs";

const T = (n) => BigInt(n) * ONE_TOKEN;
const OWNER = `0x${"a1".repeat(20)}`;
const OTHER = `0x${"b2".repeat(20)}`;
const TREASURY = `0x${"7e".repeat(20)}`;
const OLD_TREASURY = `0x${"6d".repeat(20)}`;
const START = 1_800_000_000_000;

const cleanup = [];
after(() => Promise.all(cleanup.map((fn) => fn())));

async function fixture({ minConfirmations = 3, minAgeSec = 60, chainId = TOKEN.chainId, startBlock = 100, writeLine, readTimeoutMs = 10_000, ...rest } = {}) {
  const rpc = await startFakeChain({ chainId, head: 1_000, time: START / 1000 });
  const dir = await mkdtemp(path.join(tmpdir(), "merrymen-payments-"));
  cleanup.push(rpc.close, () => rm(dir, { recursive: true, force: true }));
  const clock = { t: START };
  const logs = [];
  const boot = (extra = {}) => createBilling({ dataDir: dir, mode: "observe", treasury: TREASURY, previousTreasuries: [OLD_TREASURY],
    // The transport times out with the read, as in production, so an
    // abandoned request does not linger for viem to dedupe the next one onto.
    startBlock, minConfirmations, minAgeSec, readTimeoutMs, publicClient: createPaymentsClient(rpc.url, { timeoutMs: readTimeoutMs }), now: () => clock.t,
    log: (l) => logs.push(l), timers: false, keyRegistry: async () => new Map(), ...(writeLine ? { writeLine } : {}), ...rest, ...extra });
  const f = { rpc, chain: rpc.chain, dir, clock, logs, file: path.join(dir, "billing.jsonl"), billing: await boot() };
  f.restart = async (extra) => { f.billing = await boot(extra); return f.billing; };
  f.records = async () => (await readFile(f.file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  f.payments = async () => (await f.records()).filter((r) => r.type === "payment");
  /** A transfer mined at the head, from OWNER to the treasury unless told otherwise. */
  f.pay = ({ tokens = 100_000, from = OWNER, to = TREASURY, logs: l, ...mine } = {}) =>
    f.chain.mine({ logs: l ?? [transferLog({ from, to, value: typeof tokens === "bigint" ? tokens : T(tokens) })], ...mine });
  /** Deep and old enough to credit. */
  f.settleChain = () => { f.chain.advance(minConfirmations); f.clock.t += minAgeSec * 1000; };
  f.submit = (hash, owner = OWNER) => f.billing.submitPayment(owner, hash);
  f.view = (owner = OWNER) => f.billing.accountView(owner).json;
  if (!rest.noAccount) assert.equal((await f.billing.createAccount(OWNER, "Acme")).status, 201);
  return f;
}

test("a transfer is pending until it is 64 blocks deep AND two minutes old, then credited from the receipt", async () => {
  const f = await fixture({ minConfirmations: 64, minAgeSec: 120 });
  const unknown = await f.submit(`0x${"9".repeat(64)}`);
  assert.equal(unknown.status, 202);
  assert.deepEqual({ ...unknown.json, message: undefined }, { code: "payment_pending", message: undefined, tx_hash: `0x${"9".repeat(64)}`, stage: "not_found_yet" });
  const hash = f.pay();
  let r = await f.submit(hash);
  assert.equal(r.status, 202);
  assert.deepEqual([r.json.stage, r.json.confirmations, r.json.needed], ["confirming", 1, 64]);
  assert.equal(r.json.ready_in_sec, 120);
  f.chain.advance(62);
  r = await f.submit(hash);
  assert.deepEqual([r.status, r.json.confirmations], [202, 63]);
  f.chain.advance(1);
  f.clock.t += 119_000;
  r = await f.submit(hash);
  assert.deepEqual([r.status, r.json.confirmations, r.json.ready_in_sec], [202, 64, 1], "deep enough, not yet old enough");
  assert.deepEqual(await f.payments(), [], "nothing is written while pending");
  f.clock.t += 1_000;
  r = await f.submit(hash);
  assert.equal(r.status, 200);
  assert.equal(r.json.already, false);
  assert.deepEqual(r.json.payment, { tx_hash: hash, amount_raw: T(100_000).toString(), amount_tokens: "100000", block_number: 1_000 });
  assert.equal(r.json.credit_raw, T(100_000).toString());
  const [p] = await f.payments();
  const receipt = await createPaymentsClient(f.rpc.url).getTransactionReceipt({ hash });
  assert.deepEqual({ ...p, id: undefined, at: undefined }, { id: undefined, at: undefined, type: "payment", owner: OWNER, chain_id: 4663,
    token: TOKEN.address, recipient: TREASURY, tx_hash: hash, block_number: 1_000, block_hash: receipt.blockHash,
    amount_raw: T(100_000).toString(), log_indexes: [0], account_id: f.view().account.id });
});

test("one transfer submitted in lower, upper and mixed case is credited exactly once", async () => {
  const f = await fixture();
  const hash = f.pay();
  f.settleChain();
  const upper = `0x${hash.slice(2).toUpperCase()}`;
  const mixed = `0X${[...hash.slice(2)].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join("")}`;
  const first = await f.submit(hash);
  assert.equal(first.json.already, false);
  for (const variant of [upper, mixed, ` ${hash} `]) {
    const again = await f.submit(variant);
    assert.equal(again.status, 200, variant);
    assert.equal(again.json.already, true, variant);
  }
  // Concurrent submissions, before anything is credited, also make one row.
  const g = await fixture();
  const h = g.pay();
  g.settleChain();
  const results = await Promise.all([h, `0x${h.slice(2).toUpperCase()}`, h, `0X${h.slice(2)}`].map((x) => g.submit(x)));
  assert.equal(results.filter((x) => x.json.already === false).length, 1);
  for (const fx of [f, g]) {
    assert.equal((await fx.payments()).length, 1);
    assert.equal(fx.view().credit_raw, T(100_000).toString());
  }
  // And after a restart the receipt's key is still the one that counts.
  await f.restart();
  assert.equal((await f.submit(upper)).json.already, true);
  assert.equal((await f.payments()).length, 1);
});

test("every matching transfer in a transaction is summed into one row; others in it do not count", async () => {
  const f = await fixture();
  const hash = f.pay({ logs: [
    transferLog({ from: OWNER, to: TREASURY, value: T(60_000), logIndex: 4 }),
    transferLog({ from: OTHER, to: TREASURY, value: T(50_000), logIndex: 5 }),
    transferLog({ from: OWNER, to: TREASURY, value: 0n, logIndex: 6 }),
    transferLog({ from: OWNER, to: OLD_TREASURY, value: T(40_000), logIndex: 7 }),
    transferLog({ from: OWNER, to: OTHER, value: T(9_999), logIndex: 8 }),
  ] });
  f.settleChain();
  const r = await f.submit(hash);
  assert.equal(r.json.payment.amount_raw, T(100_000).toString());
  const [p] = await f.payments();
  assert.deepEqual(p.log_indexes, [4, 7]);
  assert.equal(p.recipient, TREASURY);
  // The other sender's transfer in the same transaction is theirs to claim.
  assert.equal((await f.billing.createAccount(OTHER, "Other")).status, 201);
  assert.equal((await f.submit(hash, OTHER)).json.payment.amount_raw, T(50_000).toString());
  assert.equal((await f.payments()).length, 2);
});

test("a transfer to a previous treasury is still credited, and records which address it paid", async () => {
  const f = await fixture();
  const hash = f.pay({ to: OLD_TREASURY });
  f.settleChain();
  assert.equal((await f.submit(hash)).status, 200);
  assert.equal((await f.payments())[0].recipient, OLD_TREASURY);
  assert.equal(f.billing.plansView().json.treasury, TREASURY, "only the current treasury is shown");
});

test("each transfer that is not a payment is refused with its reason, and nothing is written", async () => {
  const f = await fixture();
  const before = (await f.records()).length;
  const cases = [
    ["wrong_token", { logs: [transferLog({ from: OWNER, to: TREASURY, value: T(1), address: OTHER })] }],
    ["wrong_token", { logs: [transferLog({ from: OWNER, to: TREASURY, value: T(1), topics: [TRANSFER_TOPIC, `0x${"0".repeat(24)}${OWNER.slice(2)}`, `0x${"0".repeat(24)}${TREASURY.slice(2)}`, `0x${"0".repeat(63)}1`] })] }],
    ["wrong_token", { logs: [transferLog({ from: OWNER, to: TREASURY, value: T(1), data: "0x01" })] }],
    ["wrong_token", { logs: [transferLog({ from: OWNER, to: TREASURY, value: T(1), removed: true })] }],
    ["wrong_token", { logs: [] }],
    ["wrong_sender", { from: OTHER }],
    ["wrong_sender", { from: OWNER, to: OWNER }],
    ["wrong_recipient", { to: OTHER }],
  ];
  for (const [reason, tx] of cases) {
    const hash = f.pay(tx);
    f.settleChain();
    const r = await f.submit(hash);
    assert.equal(r.status, 422, reason);
    assert.deepEqual([r.json.error.code, r.json.error.reason], ["payment_not_found", reason], JSON.stringify(tx).slice(0, 80));
  }
  const sender = await f.submit(f.pay({ from: OTHER }));
  assert.ok(sender.json.error.message.includes(OWNER), "wrong_sender names the signed-in wallet");
  const old = f.pay({ blockNumber: 99 });
  f.settleChain();
  assert.deepEqual([(await f.submit(old)).json.error.reason], ["before_start_block"]);
  const small = f.pay({ tokens: ONE_TOKEN - 1n });
  f.settleChain();
  assert.equal((await f.submit(small)).json.error.code, "payment_too_small");
  const zero = f.pay({ tokens: 0n });
  f.settleChain();
  assert.equal((await f.submit(zero)).json.error.code, "payment_too_small");
  const reverted = f.pay({ status: "0x0" });
  f.settleChain();
  const failed = await f.submit(reverted);
  assert.deepEqual([failed.status, failed.json.error.code], [422, "payment_failed"]);
  const many = f.pay({ logs: Array.from({ length: 257 }, (_, i) => transferLog({ from: OWNER, to: TREASURY, value: T(1), logIndex: i })) });
  f.settleChain();
  assert.equal((await f.submit(many)).json.error.code, "payment_unsupported");
  assert.equal((await f.records()).length, before);
  assert.equal(f.view().credit_raw, "0");
});

test("the start block itself is open: a transfer mined in it is credited, one block earlier is not", async () => {
  const f = await fixture({ startBlock: 100 });
  const before = f.pay({ blockNumber: 99 });
  const first = f.pay({ blockNumber: 100 });
  f.settleChain();
  assert.deepEqual([(await f.submit(before)).status, (await f.submit(before)).json.error.reason], [422, "before_start_block"]);
  const r = await f.submit(first);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.payment.block_number, r.json.credit_tokens], [100, "100000"]);
});

test("a transfer's age is measured on the host's clock, not on billing time held ahead after a clock step back", async () => {
  const f = await fixture({ minAgeSec: 60 });
  f.clock.t = START + 4 * 60_000;
  assert.equal((await f.billing.createAccount(OTHER, "Other")).status, 201); // the ledger's latest record: 4 min on
  f.clock.t = START; // the host clock steps back 4 minutes
  assert.equal(f.billing.now(), START + 4 * 60_000, "billing time does not run backwards");
  const hash = f.pay(); // stamped START: no time at all has passed for it
  f.chain.advance(3);
  const r = await f.submit(hash);
  assert.deepEqual([r.status, r.json.stage, r.json.ready_in_sec], [202, "confirming", 60], "not yet the minute old the reorg margin asks for");
});

test("refusals that need no chain read: a malformed hash, no account, no treasury, billing off", async () => {
  const f = await fixture();
  for (const bad of ["", "0x1234", `0x${"g".repeat(64)}`, `${"a".repeat(66)}`, 42, null]) {
    const r = await f.submit(bad);
    assert.deepEqual([r.status, r.json.error.code], [400, "invalid_tx_hash"], String(bad));
  }
  assert.equal((await f.submit(`0x${"1".repeat(64)}`, OTHER)).json.error.code, "account_missing");
  const calls = f.chain.calls.length;
  await f.restart({ treasury: null });
  assert.equal(f.billing.paymentsReady, false);
  assert.deepEqual([(await f.submit(`0x${"1".repeat(64)}`)).status, (await f.submit(`0x${"1".repeat(64)}`)).json.error.code], [503, "payments_unavailable"]);
  assert.equal(f.billing.plansView().json.treasury, null);
  await f.restart({ mode: "off" });
  assert.equal((await f.submit(`0x${"1".repeat(64)}`)).json.error.code, "billing_off");
  assert.equal(f.chain.calls.length, calls, "none of these touched the chain");
});

test("an RPC on another chain makes payments unavailable, at boot and before each credit", async () => {
  const wrong = await fixture({ chainId: 1 });
  assert.equal(wrong.billing.paymentsReady, false);
  assert.match(wrong.logs.join("\n"), /answers chain 1, not 4663/);
  assert.equal(wrong.billing.plansView().json.treasury, null);
  assert.equal((await wrong.submit(wrong.pay())).json.error.code, "payments_unavailable");
  const f = await fixture();
  const hash = f.pay();
  f.settleChain();
  f.chain.chainId = 46630; // the RPC was repointed at testnet after boot
  const r = await f.submit(hash);
  assert.deepEqual([r.status, r.json.error.code], [503, "payments_unavailable"]);
  assert.deepEqual(await f.payments(), []);
  f.chain.chainId = 4663;
  assert.equal((await f.submit(hash)).status, 200);
});

test("an RPC failure answers chain_unavailable and never relays the RPC's words or address", async () => {
  const f = await fixture({ readTimeoutMs: 100 });
  const hash = f.pay();
  f.settleChain();
  f.chain.down = true;
  const r = await f.submit(hash);
  assert.deepEqual([r.status, r.json.error.code], [503, "chain_unavailable"]);
  for (const text of [JSON.stringify(r.json), f.logs.join("\n")]) {
    assert.ok(!text.includes("SECRET-KEY") && !text.includes("rpc.example") && !text.includes(f.rpc.url) && !text.includes("exploded"), text);
  }
  f.chain.down = false;
  f.chain.delayMs = 400;
  const started = Date.now();
  const slow = await f.submit(hash);
  assert.equal(slow.json.error.code, "chain_unavailable");
  assert.ok(Date.now() - started < 400 * 3, "each read is cut off at its timeout");
  f.chain.delayMs = 0;
  assert.equal((await f.submit(hash)).status, 200);
  assert.equal((await f.payments()).length, 1);
});

test("a gateway that could not reach the RPC at boot checks the chain before crediting instead", async () => {
  const f = await fixture();
  f.chain.down = true;
  await f.restart();
  assert.match(f.logs.join("\n"), /could not confirm the payments RPC's chain at boot/);
  assert.equal(f.billing.paymentsReady, true);
  f.chain.down = false;
  f.chain.chainId = 1;
  const hash = f.pay();
  f.settleChain();
  assert.equal((await f.submit(hash)).json.error.code, "payments_unavailable");
});

test("a receipt for a different transaction than the one asked about is an RPC fault, never a credit", async () => {
  const f = await fixture();
  const real = f.pay();
  f.settleChain();
  const asked = `0x${"5".repeat(64)}`;
  f.chain.alias(asked, real);
  const r = await f.submit(asked);
  assert.deepEqual([r.status, r.json.error.code], [503, "chain_unavailable"]);
  assert.deepEqual(await f.payments(), []);
  assert.equal((await f.submit(real)).status, 200);
});

test("a receipt whose block the RPC no longer has is not credited yet", async () => {
  const f = await fixture();
  const hash = f.pay();
  f.chain.pin(hash);
  f.chain.reorgBlock(1_000);
  f.settleChain();
  const r = await f.submit(hash);
  assert.deepEqual([r.status, r.json.stage, r.json.confirmations], [202, "confirming", 0]);
  assert.deepEqual(await f.payments(), []);
});

test("a payment activates the selected plan in the same request", async () => {
  const f = await fixture();
  const preview = (await f.billing.choosePlan(OWNER, { tier: "crumbs", confirm: true })).json;
  assert.equal(preview.due_raw, T(100_000).toString());
  assert.equal(preview.due_for, "activation");
  const hash = f.pay();
  f.settleChain();
  const r = await f.submit(hash);
  assert.equal(r.json.plan.id, "crumbs");
  assert.equal(r.json.credit_raw, "0");
  assert.equal(r.json.due_for, "renewal");
});

test("a crash between the payment line and the activation is repaired by the next metered request", async () => {
  let crash = false;
  const writeLine = async (file, line) => {
    // The process dies right after the payment is durable, before the charge.
    if (crash && line.includes('"type":"charge"')) throw Object.assign(new Error("killed"), { code: "EKILLED" });
    return appendFile(file, line, { flush: true });
  };
  const f = await fixture({ writeLine });
  await f.billing.choosePlan(OWNER, { tier: "crumbs", confirm: true });
  const hash = f.pay();
  f.settleChain();
  crash = true;
  await f.submit(hash);
  crash = false;
  assert.deepEqual((await f.records()).map((r) => r.type).filter((t) => t !== "config"), ["account", "select", "payment"]);
  await f.restart(); // a new process, from the file alone
  assert.equal(f.view().plan.id, "free");
  assert.equal(f.view().plan.renews_on_next_request, true);
  assert.equal(f.billing.needsSettle(OWNER), true);
  assert.equal(await f.billing.prepare(OWNER), true); // a partner request arrives
  assert.equal(f.billing.planFor(OWNER).id, "crumbs");
  assert.equal((await f.records()).filter((r) => r.type === "charge").length, 1);
  // Resubmitting the hash answers already, and does not charge again.
  assert.equal((await f.submit(hash)).json.already, true);
  assert.equal((await f.records()).filter((r) => r.type === "charge").length, 1);
});

test("an already-credited hash still settles: a plan chosen since then activates on resubmission", async () => {
  const f = await fixture();
  const hash = f.pay();
  f.settleChain();
  await f.submit(hash);
  // Selected through a path that did not settle (an operator's view of an
  // older gateway, say): written straight into the ledger.
  const id = f.view().account.id;
  await appendFile(f.file, `${JSON.stringify({ id: "f".repeat(32), type: "select", at: START, account_id: id, tier: "crumbs" })}\n`);
  await f.restart();
  const calls = f.chain.calls.length;
  const r = await f.submit(hash);
  assert.equal(r.json.already, true);
  assert.equal(r.json.plan.id, "crumbs");
  assert.equal(f.chain.calls.length, calls, "an already-credited hash is answered without the chain");
});

test("a reorg that moves a credited transfer reverses it; credit goes negative and nothing is charged until it is final again", async () => {
  const f = await fixture();
  await f.billing.choosePlan(OWNER, { tier: "crumbs", confirm: true });
  const hash = f.pay();
  f.settleChain();
  assert.equal((await f.submit(hash)).json.plan.id, "crumbs");
  // Within the half hour, the sequencer re-includes the transaction elsewhere.
  f.chain.move(hash, 1_010);
  f.clock.t += 60_000;
  assert.deepEqual((await f.billing.reconcile()).map((x) => [x.tx_hash, x.why, x.reversed]), [[hash, "block_changed", false]]);
  f.clock.t += 5 * 60_000;
  const findings = await f.billing.reconcile();
  assert.deepEqual(findings.map((x) => [x.tx_hash, x.why, x.reversed]), [[hash, "block_changed", true]], "the next run agrees");
  const reversal = (await f.records()).filter((r) => r.type === "reversal");
  assert.equal(reversal.length, 1);
  assert.equal(reversal[0].amount_raw, T(100_000).toString());
  assert.equal(reversal[0].payment_id, (await f.payments())[0].id);
  const view = f.view();
  assert.equal(view.credit_tokens, "-100000");
  assert.equal(view.plan.id, "crumbs", "the running period is not taken away");
  assert.equal(view.history[0].type, "reversal");
  assert.equal(view.history[0].tx_hash, hash);
  assert.equal(await f.billing.reconcile().then((x) => x.length), 0, "reversed once");
  await f.billing.choosePlan(OWNER, { tier: "loaf", confirm: true });
  f.clock.t += PERIOD_MS;
  assert.equal(f.billing.needsSettle(OWNER), false);
  assert.equal((await f.records()).filter((r) => r.type === "charge").length, 1);
  // Once final in its new block, the same hash is credited again: net, once.
  f.settleChain();
  const again = await f.submit(hash);
  assert.equal(again.json.already, false);
  assert.equal((await f.payments()).at(-1).block_number, 1_010);
  await f.restart();
  assert.equal(f.view().credit_raw, "0");
  assert.equal((await f.submit(hash)).json.already, true);
});

test("reconciliation reverses a dropped transfer, but not on a lagging node, an RPC error, or past its window", async () => {
  const f = await fixture();
  const hash = f.pay();
  f.settleChain();
  await f.submit(hash);
  const block = (await f.payments())[0].block_number;
  const head = f.chain.head;
  f.chain.drop(hash);
  f.chain.head = BigInt(block - 1); // a node that has not reached the payment's block
  assert.deepEqual(await f.billing.reconcile(), []);
  f.chain.head = head;
  f.chain.down = true;
  assert.deepEqual(await f.billing.reconcile(), []);
  assert.match(f.logs.join("\n"), /reconcile skipped: chain unreadable/);
  // An RPC repointed at another chain finds no receipt for anything: that is
  // not evidence that every payment vanished.
  f.chain.down = false;
  f.chain.chainId = 46630;
  assert.deepEqual(await f.billing.reconcile(), []);
  assert.match(f.logs.join("\n"), /reconcile skipped: the payments RPC answers chain 46630/);
  f.chain.chainId = 4663;
  // An error reading one receipt leaves that payment for the next run.
  f.chain.failing.add("eth_getTransactionReceipt");
  assert.deepEqual(await f.billing.reconcile(), []);
  assert.match(f.logs.join("\n"), /reconcile could not re-read/);
  f.chain.failing.clear();
  assert.deepEqual((await f.billing.reconcile({ dryRun: true })).map((x) => x.why), ["receipt_missing"]);
  assert.equal((await f.records()).filter((r) => r.type === "reversal").length, 0, "a dry run writes nothing");
  f.clock.t += 31 * 60_000;
  assert.deepEqual(await f.billing.reconcile(), [], "older than half an hour: not re-checked");
  assert.deepEqual((await f.billing.reconcile({ all: true })).map((x) => [x.why, x.reversed]), [["receipt_missing", false]]);
  assert.equal(f.view().credit_raw, T(100_000).toString(), "not on one run");
  assert.deepEqual((await f.billing.reconcile({ all: true })).map((x) => [x.why, x.reversed]), [["receipt_missing", true]]);
  assert.equal(f.view().credit_raw, "0");
});

test("reconciliation reverses a transfer whose receipt now reverts or pays a different amount", async () => {
  const f = await fixture();
  const a = f.pay();
  const b = f.pay({ tokens: 200_000 });
  f.settleChain();
  await f.submit(a);
  await f.submit(b);
  const receipts = f.chain;
  // Same block, rewritten history: one now reverts, the other moved less.
  receipts.mine({ hash: a, status: "0x0", blockNumber: 1_000, logs: [] });
  receipts.mine({ hash: b, blockNumber: 1_000, logs: [transferLog({ from: OWNER, to: TREASURY, value: T(150_000) })] });
  assert.equal((await f.billing.reconcile()).length, 2);
  assert.equal(f.view().credit_raw, T(300_000).toString(), "nothing is reversed on one run");
  const found = await f.billing.reconcile();
  assert.deepEqual(found.map((x) => [x.why, x.reversed]).sort(), [["amount_changed", true], ["reverted", true]]);
  assert.equal(f.view().credit_raw, "0");
});

test("one inconsistent RPC read never reverses a real payment: the chain must agree with itself, twice", async () => {
  const f = await fixture();
  await f.billing.choosePlan(OWNER, { tier: "crumbs", confirm: true });
  const hash = f.pay();
  f.settleChain();
  assert.equal((await f.submit(hash)).json.plan.id, "crumbs");
  const reversals = async () => (await f.records()).filter((r) => r.type === "reversal").length;

  // A receipt index that lags (a load-balanced RPC's other backend): no
  // receipt, but the block that holds the payment is still the same block.
  f.chain.hide(hash);
  assert.deepEqual(await f.billing.reconcile(), []);
  assert.deepEqual(await f.billing.reconcile(), []);
  f.chain.unhide(hash);

  // The receipt still names the credited block, but one read of that block
  // answers another hash: the RPC disagrees with itself.
  f.chain.pin(hash);
  const credited = f.chain.block(1_000);
  f.chain.reorgBlock(1_000);
  assert.deepEqual(await f.billing.reconcile(), []);
  f.chain.block(1_000).hash = credited.hash;

  // The receipt names another block, which, read on its own, has another hash.
  f.chain.mine({ hash, blockNumber: 1_010, logs: [transferLog({ from: OWNER, to: TREASURY, value: T(100_000) })] });
  f.chain.pin(hash);
  f.chain.reorgBlock(1_010);
  assert.deepEqual(await f.billing.reconcile(), []);
  assert.equal(await reversals(), 0);
  assert.equal(f.view().credit_raw, "0");

  // A real drop is reversed only once a second run, five minutes on, agrees;
  // one that comes back in between is not reversed at all.
  f.chain.mine({ hash, blockNumber: 1_000, logs: [transferLog({ from: OWNER, to: TREASURY, value: T(100_000) })] });
  f.chain.block(1_000).hash = credited.hash;
  f.chain.drop(hash);
  let found = await f.billing.reconcile();
  assert.deepEqual(found.map((x) => [x.why, x.reversed]), [["receipt_missing", false]]);
  assert.equal(await reversals(), 0, "one run is not enough");
  assert.match(f.logs.join("\n"), /checking it again before reversing/);
  f.chain.mine({ hash, blockNumber: 1_000, logs: [transferLog({ from: OWNER, to: TREASURY, value: T(100_000) })] });
  f.chain.block(1_000).hash = credited.hash;
  f.clock.t += 5 * 60_000;
  assert.deepEqual(await f.billing.reconcile(), [], "it stands again");
  assert.equal(await reversals(), 0);

  // Found near the end of its half hour, it is still checked a second time after it.
  f.chain.drop(hash);
  f.clock.t += 22 * 60_000;
  assert.deepEqual((await f.billing.reconcile()).map((x) => x.reversed), [false]);
  f.clock.t += 6 * 60_000;
  found = await f.billing.reconcile();
  assert.deepEqual(found.map((x) => [x.tx_hash, x.why, x.reversed]), [[hash, "receipt_missing", true]]);
  assert.equal(await reversals(), 1);
  assert.equal(f.view().credit_tokens, "-100000");
});

test("matchTransfers reads addresses from the topics, not the receipt's sender", () => {
  const recipients = new Set([TREASURY]);
  const log = transferLog({ from: OWNER, to: TREASURY, value: T(5) });
  assert.deepEqual(matchTransfers([log], { owner: OWNER, recipients }), { amount: T(5), logIndexes: [0], recipient: TREASURY });
  // A topic with junk in its top 12 bytes is not an address.
  const dirty = { ...log, topics: [TRANSFER_TOPIC, `0x${"f".repeat(24)}${OWNER.slice(2)}`, log.topics[2]] };
  assert.equal(matchTransfers([dirty], { owner: OWNER, recipients }).reason, "wrong_token");
  assert.equal(matchTransfers(undefined, { owner: OWNER, recipients }).reason, "wrong_token");
});
