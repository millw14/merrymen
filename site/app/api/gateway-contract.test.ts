/**
 * The site reading the gateway's own billing answers.
 *
 * The console and the Plans section take every billing answer through a
 * reader (normalizePlans, normalizeAccount, normalizePreview, paymentOutcome),
 * and each drops what it cannot read. A field renamed on the gateway would
 * not crash the page: it would quietly show "coming soon", "nothing due" or
 * "busy" to a developer who has paid. So this asks the gateway's real billing
 * module, with a temporary ledger and a fake Robinhood Chain (a JSON-RPC
 * server read through a real viem client; nothing reaches a real chain and no
 * key exists), and checks that the site reads each answer as it must.
 *
 * Skipped while gateway/lib/billing.mjs is not on this branch: the site and
 * gateway tracks merge later, and from then on a change on either side that
 * breaks the other fails here. The specifiers are variables, so the site's own
 * type check never resolves a gateway file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FALLBACK_PLANS, UNIT, amountToSend, endMessage, historyLabel, normalizeAccount, normalizePlans, normalizePreview, paymentOutcome, paymentsReady,
  previewSentence, renewalBy, stillDue, waitingMessage, type PaymentOutcome, type WatchEnd,
} from '../../lib/developer-billing';
import { loadAccount } from './AccountPanel';
import { testSummary } from './DeveloperConsole';

const lib = (file: string) => new URL(`../../../gateway/lib/${file}`, import.meta.url);
const OWNER = '0x' + 'a1'.repeat(20), OTHER = '0x' + 'b2'.repeat(20), TREASURY = '0x' + '7e'.repeat(20);
const START = 1_800_000_000_000;
type Answer = { status: number; json: unknown };
type Waiting = Extract<PaymentOutcome, { kind: 'pending' | 'retry' }>;
type Ended = Exclude<WatchEnd, { kind: 'signed_out' | 'cancelled' }>;

test('the console reads the gateway\'s billing answers as a developer must see them', async t => {
  if (!existsSync(lib('billing.mjs')) || !existsSync(lib('fake-rpc.test-helper.mjs'))) return t.skip('gateway billing is not on this branch');
  const { createBilling, createPaymentsClient } = await import(lib('billing.mjs').href);
  const { startFakeChain, transferLog } = await import(lib('fake-rpc.test-helper.mjs').href);
  const rpc = await startFakeChain({ head: 1_000, time: START / 1000 });
  const dirs = [await mkdtemp(path.join(tmpdir(), 'merrymen-site-contract-')), await mkdtemp(path.join(tmpdir(), 'merrymen-site-contract-off-'))];
  const clock = { t: START }, oldFetch = globalThis.fetch, logs: string[] = [];
  const said = () => `gateway log: ${JSON.stringify(logs.slice(-3))}`;
  /** The console's GET /account, answered with what the gateway answered. */
  const served = async (answer: Answer) => {
    // Only for this one call: viem reads the fake chain with the real fetch.
    globalThis.fetch = async () => Response.json(answer.json, { status: answer.status });
    try { return await loadAccount(); } finally { globalThis.fetch = oldFetch; }
  };
  const read = (answer: Answer) => paymentOutcome(answer.status, answer.json);
  const options = { dataDirPersistent: true, previousTreasuries: [], startBlock: 100, minConfirmations: 3, minAgeSec: 60, now: () => clock.t, log: (l: string) => logs.push(l), timers: false, keyRegistry: async () => new Map() };
  const billing = await createBilling({ ...options, dataDir: dirs[0], mode: 'observe', treasury: TREASURY, publicClient: createPaymentsClient(rpc.url, { timeoutMs: 5_000 }) });
  const off = await createBilling({ ...options, dataDir: dirs[1], mode: 'off', treasury: TREASURY, publicClient: null });
  try {
    // GET /plans: live, payable, and the very table the site falls back to.
    const plans = normalizePlans(billing.plansView().json)!;
    assert.ok(plans !== null, 'GET /plans is readable');
    assert.equal(paymentsReady(plans), true); assert.equal(plans.treasury, TREASURY);
    assert.deepEqual(plans.plans, FALLBACK_PLANS.plans); assert.deepEqual(plans.confirmations, { blocks: 3, min_age_sec: 60 });
    // With billing off the Plans section says "coming soon" and offers nothing to pay.
    assert.equal(paymentsReady(normalizePlans(off.plansView().json)!), false);

    // GET /account before there is one: the console asks for one, rather than taking this for a gateway without accounts.
    assert.deepEqual(await served(billing.accountView(OWNER)), { kind: 'missing' });
    assert.equal((await billing.createAccount(OWNER, 'Prism')).status, 201);
    const start = await served(billing.accountView(OWNER));
    assert.equal(start.kind, 'ready');
    const first = start.kind === 'ready' ? start.view : null;
    assert.deepEqual([first?.account.name, first?.plan.id, first?.due_raw, first?.usage?.limit], ['Prism', 'free', null, 1_000]);

    // POST /plan without confirm is a preview the developer agrees to; with confirm the amount due appears.
    const preview = normalizePreview((await billing.choosePlan(OWNER, { tier: 'crumbs' })).json)!;
    assert.ok(preview !== null, 'the preview is readable');
    assert.equal(previewSentence(preview, plans.plans[1], 'Free'), 'Crumbs starts as soon as 100,000 MERRYMEN arrives. Confirm, then pay below.');
    const chosen = normalizeAccount((await billing.choosePlan(OWNER, { tier: 'crumbs', confirm: true })).json)!;
    assert.equal(chosen.plan.selected, 'crumbs'); assert.equal(amountToSend(chosen.due_raw), 100_000n * UNIT);
    // Pay reads GET /account again at the click: with nothing in between, the payment goes ahead.
    const drawn = normalizeAccount(billing.accountView(OWNER).json)!;
    assert.deepEqual(stillDue(billing.accountView(OWNER).json, drawn), { ok: true });

    // POST /payments, a hash not on chain yet: keep checking.
    let outcome = read(await billing.submitPayment(OWNER, '0x' + '9'.repeat(64)));
    assert.deepEqual(outcome, { kind: 'pending', stage: 'not_found_yet', readyInSec: null, retryAfterSec: null }, said());
    assert.equal(waitingMessage(outcome as Waiting), 'Waiting for Robinhood Chain to include your transaction…');
    // On chain, not yet deep or old enough: keep checking, and say roughly how long.
    const hash = rpc.chain.mine({ logs: [transferLog({ from: OWNER, to: TREASURY, value: 100_000n * UNIT })] });
    outcome = read(await billing.submitPayment(OWNER, hash));
    assert.equal(outcome.kind, 'pending'); assert.equal(outcome.kind === 'pending' && outcome.stage, 'confirming');
    assert.equal(waitingMessage(outcome as Waiting, plans.confirmations!.min_age_sec), 'Confirming on Robinhood Chain (about 1 min)…');
    // Deep and old enough: credited, Crumbs starts, and the account view comes back with it.
    rpc.chain.advance(3); clock.t += 60_000;
    outcome = read(await billing.submitPayment(OWNER, hash));
    assert.equal(outcome.kind, 'credited', said());
    const after = outcome.kind === 'credited' ? outcome.account : null;
    assert.deepEqual([after?.plan.id, after?.credit_raw, after?.usage?.limit], ['crumbs', '0', 50_000]);
    // Already the next period's price is "due": for renewal, which the console must not read as owed now.
    assert.deepEqual([after?.due_raw, after?.due_for], [(100_000n * UNIT).toString(), 'renewal']);
    assert.equal(renewalBy(after!), after?.plan.ends_at, 'owed when this period ends, not now');
    // A tab still showing the activation as due would now pay for the next period, 30 days early: refused.
    const stale = stillDue(billing.accountView(OWNER).json, drawn);
    assert.equal(stale.ok, false); assert.equal(!stale.ok && stale.account?.due_for, 'renewal');
    assert.deepEqual(after?.history.map(h => historyLabel(h, plans.plans)), ['Crumbs started', 'Payment received'], 'newest first');
    assert.equal(after?.history[1].tx_hash, hash);
    assert.equal(endMessage(outcome as Ended, OWNER), 'Payment credited.');
    // Submitting it again changes nothing and says so.
    outcome = read(await billing.submitPayment(OWNER, hash));
    assert.equal(endMessage(outcome as Ended, OWNER), 'This payment was already credited.');

    // Refusals that are verdicts on the transfer end the check, in the gateway's own words.
    const theirs = rpc.chain.mine({ logs: [transferLog({ from: OTHER, to: TREASURY, value: 100_000n * UNIT })] });
    rpc.chain.advance(3); clock.t += 60_000;
    outcome = read(await billing.submitPayment(OWNER, theirs));
    assert.equal(outcome.kind, 'failed'); assert.equal(outcome.kind === 'failed' && outcome.reason, 'wrong_sender');
    assert.ok(endMessage(outcome as Ended, OWNER).includes(OWNER), 'names the signed-in wallet');
    assert.equal(read(await billing.submitPayment(OWNER, '0x1234')).kind, 'failed', 'not a hash at all');
    // Answers that say nothing about the transfer keep the hash: another wallet without an account, billing switched off.
    assert.equal(read(await billing.submitPayment(OTHER, hash)).kind, 'unchecked');
    const paused = read(await off.submitPayment(OWNER, hash));
    assert.equal(paused.kind, 'retry');
    assert.match(waitingMessage(paused as Waiting), /^Payments are paused on our side just now\. This payment is saved/);

    // /meta, as the key test shows it: the plan's shared rate and this period's requests.
    const meta = billing.meta(OWNER, new Date(START).toISOString());
    assert.equal(testSummary({ name: 'Prism', rate_per_min: meta.rate_per_min, billing: meta.billing }), '200 OK · Prism · 60 requests/minute · 0 of 50,000 requests used');

    // An upgrade's price falls by the second as its period runs: a click seconds after the page drew it still pays
    // what the button said, and a page left open for days is refused and shown the new amount.
    assert.equal((await billing.choosePlan(OWNER, { tier: 'loaf', confirm: true })).status, 200, said());
    const quoted = normalizeAccount(billing.accountView(OWNER).json)!;
    assert.equal(quoted.due_for, 'upgrade', said());
    clock.t += 10_000;
    assert.notEqual(normalizeAccount(billing.accountView(OWNER).json)!.due_raw, quoted.due_raw, 'the price fell');
    assert.deepEqual(stillDue(billing.accountView(OWNER).json, quoted), { ok: true });
    clock.t += 3 * 86_400_000;
    assert.equal(stillDue(billing.accountView(OWNER).json, quoted).ok, false);
  } finally {
    globalThis.fetch = oldFetch;
    await billing.close(); await off.close(); await rpc.close();
    await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
  }
});
