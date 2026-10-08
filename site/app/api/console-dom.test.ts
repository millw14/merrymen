/**
 * The console's money paths, clicked in a DOM.
 *
 * The other site tests pin pure helpers and static renders. What they cannot
 * see is the effect code between a click and the gateway: whether a second
 * payment can start while the first is still being checked, whether a hash
 * survives a remount, a stall or a sign-out, whether "Review change" really
 * only previews, and whether key creation really waits for an account. A
 * mistake in any of those is green in a static render and costs a developer
 * a payment nobody credits.
 *
 * The real DeveloperConsole is mounted against a scripted /api/developer and
 * a scripted EIP-1193 wallet; nothing else is replaced. jsdom is a dependency
 * of the repository root, not of the site, and the site's own build type-checks
 * this file: the specifier is a variable so that check never resolves it.
 *
 * BOUNDED, ALWAYS. An earlier version of this file fast-forwarded every long
 * timer while the scripted gateway answered "pending" forever, and the page's
 * checks then ran about every millisecond until the machine ran out of memory.
 * Four things now stop that. The page itself stops after POLL_MAX_CHECKS
 * checks. A timer of a second or more never runs on its own here: it is held
 * until fastForward() fires it, and fastForward() refuses (throws) past
 * LONG_WAIT_CAP of them in one test, and past a fixed number of rounds. The
 * scripted gateway stops answering, parking the caller, past FETCH_CAP
 * requests in one test. And every root is unmounted after every test, failed
 * or not, so no check outlives its test. Every "pending forever" scenario
 * drains its checks and asserts that they stop.
 *
 * NO DOM NODE IN AN ASSERTION. A failing assert.equal(node, undefined) builds
 * its message by inspecting `node` with depth 1000 and every getter called,
 * which walks the whole jsdom window: gigabytes, with no request in sight.
 * Compare booleans, strings and numbers only (canPay(), statusOf(), counts).
 */
import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { FALLBACK_PLANS, POLL_MAX_CHECKS, TOKEN, UNIT, short, type PlansView } from '../../lib/developer-billing';
import { MAX_PENDING, PENDING_KEY } from '../../lib/pending-payments';

const WALLET = '0x1111111111111111111111111111111111111111';
const TREASURY = '0x3333333333333333333333333333333333333333';
const ROTATED = '0x4444444444444444444444444444444444444444';
const HASH_A = '0x' + 'aa'.repeat(32), HASH_B = '0x' + 'bb'.repeat(32), HASH_C = '0x' + 'cc'.repeat(32), HASH_D = '0x' + 'dd'.repeat(32);
const DUE = 100_000n * UNIT;
/** Long waits one test may fire. The most any test here needs is MAX_PENDING × (POLL_MAX_CHECKS − 1) = 195. */
const LONG_WAIT_CAP = 250;
/** Requests one test may make. The busiest here makes about 200. */
const FETCH_CAP = 600;

const plansJson = (over: Record<string, unknown> = {}) => ({
  billing: { mode: 'enforce', enforced: true }, period_days: 30, treasury: TREASURY,
  currency: { symbol: 'MERRYMEN', address: TOKEN.address, chain_id: 4663, decimals: 18, explorer_url: '' }, confirmations: { blocks: 64, min_age_sec: 120 },
  plans: FALLBACK_PLANS.plans.map(p => ({ ...p, price_tokens: String(BigInt(p.price_raw) / UNIT) })), ...over,
});
const accountJson = (over: Record<string, unknown> = {}) => ({
  account: { id: 'acct_1', name: 'Prism', wallet: WALLET, created_at: '2026-10-01T00:00:00.000Z' },
  plan: { id: 'free', name: 'Free', starts_at: null, ends_at: null, selected: 'crumbs', renews_on_next_request: false },
  credit_raw: '0', credit_tokens: '0', due_raw: DUE.toString(), due_tokens: '100000',
  usage: { used: 0, limit: 1000, resets_at: '2026-10-31T00:00:00.000Z', by_key: [] }, history: [], ...over,
});
/** The gateway's 202 for a transfer not on chain yet: it records nothing. */
const pending = { status: 202, body: { code: 'payment_pending', stage: 'not_found_yet', message: 'Not on Robinhood Chain yet. Check again shortly.' } };

type Answer = { status: number; body: unknown };
type Handler = (body: Record<string, unknown> | undefined, call: number) => Answer | Promise<Answer>;
type Root = { render(node: React.ReactNode): void; unmount(): void };
let dom: { window: Window & typeof globalThis & { close(): void } };
let act: typeof React.act;
let createRoot: (el: Element) => Root;
let DeveloperConsole: (props: { initialPlans?: PlansView }) => React.ReactElement;
let normalizePlans: (v: unknown) => PlansView | null;
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
/** Timers of a second or more that the page set: held here, never on the real clock, until fastForward() fires them. */
let held: { id: number; ms: number; fire: () => void }[] = [];
let fired = 0, nextHeld = 1_000_000_000;

/** What reached /api/developer, and the scripted answers by "METHOD action". */
let calls: { method: string; action: string; body: Record<string, unknown> | undefined }[] = [];
let fetches = 0;
let routes: Record<string, Handler> = {};
/** What the wallet was asked to send. */
let sent: unknown[] = [];
/** Set when a guard above trips; afterEach fails the test with it. */
let runaway = '';
const mounted = new Set<Root>();

before(async () => {
  const jsdom = 'jsdom';
  const { JSDOM } = await import(jsdom);
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://merrymen.dev/api', pretendToBeVisual: true });
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'localStorage', 'getComputedStyle']) {
    Object.defineProperty(globalThis, k, { value: (dom.window as unknown as Record<string, unknown>)[k], configurable: true, writable: true });
  }
  const g = globalThis as Record<string, unknown>;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  // tsx compiles JSX to React.createElement; Next's own build does not need this.
  g.React = React;
  act = React.act;
  ({ createRoot } = await import('react-dom/client') as never);
  ({ DeveloperConsole } = await import('./DeveloperConsole') as never);
  ({ normalizePlans } = await import('../../lib/developer-billing'));
  // After the imports, so React and its scheduler keep the real timers they captured.
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if ((ms ?? 0) < 1000) return realSetTimeout(handler, ms, ...args);
    const id = nextHeld++;
    held.push({ id, ms: ms!, fire: () => handler(...args) });
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    const i = held.findIndex(t => t.id === id);
    if (i >= 0) held.splice(i, 1); else realClearTimeout(id as Parameters<typeof clearTimeout>[0]);
  }) as typeof clearTimeout;
  g.fetch = async (url: string, init?: RequestInit) => {
    if (++fetches > FETCH_CAP) {
      runaway ||= `more than ${FETCH_CAP} requests in one test: something is polling without end`;
      // Never answers: the caller parks here instead of looping on.
      return new Promise<Response>(() => {});
    }
    const action = String(url).replace(/^\/api\/developer\//, ''), method = init?.method || 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ method, action, body });
    const handler = routes[`${method} ${action}`];
    if (!handler) return Response.json({ error: { code: 'not_found', message: 'Not found' } }, { status: 404 });
    const answer = await handler(body, calls.filter(c => c.method === method && c.action === action).length);
    return Response.json(answer.body, { status: answer.status });
  };
});
after(() => { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; dom?.window?.close(); });

/** A signed-in wallet with 100,000 MERRYMEN due and payments open; each test changes what it needs. */
beforeEach(() => {
  calls = []; sent = []; fetches = 0; runaway = ''; held = []; fired = 0;
  localStorage.clear();
  routes = {
    'GET plans': () => ({ status: 200, body: plansJson() }),
    'GET keys': () => ({ status: 200, body: { address: WALLET, keys: [] } }),
    'GET account': () => ({ status: 200, body: accountJson() }),
    'POST payments': () => pending,
  };
  wallet([HASH_A, HASH_B]);
});
/** Whatever a test left behind is taken down, so no check outlives it; then any guard that tripped fails it. */
afterEach(async () => {
  for (const root of [...mounted]) await act(async () => { root.unmount(); });
  mounted.clear();
  document.body.innerHTML = '';
  const left = held.length;
  held = [];
  assert.equal(runaway, '', runaway);
  assert.equal(left, 0, 'an unmounted page leaves no wait behind');
});

function wallet(hashes: string[]) {
  const queue = [...hashes];
  (window as unknown as { ethereum: unknown }).ethereum = { async request({ method, params }: { method: string; params?: unknown[] }) {
    if (method === 'eth_accounts') return [WALLET];
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_call') return '0x' + (10_000_000n * UNIT).toString(16);
    if (method === 'eth_sendTransaction') { sent.push(params?.[0]); return queue.shift(); }
    throw Object.assign(new Error(`unexpected ${method}`), { code: -32601 });
  } };
}

/** Lets fetches, effects and renders run, inside act. Held (long) timers do not fire here; see fastForward(). */
async function settle(rounds = 8) { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise(r => realSetTimeout(r, 5)); }); }
/**
 * Fires the held long timers, round after round, until `done()` or `rounds`
 * rounds, and returns their delays in the order they were set. Past
 * LONG_WAIT_CAP fired in one test it throws instead, so a loop that does not
 * stop on its own fails here rather than running on.
 */
async function fastForward(done: () => boolean, rounds = 300): Promise<number[]> {
  const delays: number[] = [];
  for (let round = 0; round < rounds && !done(); round++) {
    for (const timer of held.splice(0)) {
      if (++fired > LONG_WAIT_CAP) {
        runaway ||= `more than ${LONG_WAIT_CAP} long waits fired in one test: a check loop did not stop`;
        throw new Error(runaway);
      }
      delays.push(timer.ms); timer.fire();
    }
    await settle(1);
  }
  return delays;
}
async function mount(plans: PlansView = normalizePlans(plansJson())!) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.add(root);
  await act(async () => { root.render(createElement(DeveloperConsole, { initialPlans: plans })); });
  await settle();
  return { container, unmount: async () => { await act(async () => { root.unmount(); }); mounted.delete(root); container.remove(); } };
}
const text = (el: Element) => el.textContent ?? '';
const buttonFor = (el: Element, words: RegExp) => [...el.querySelectorAll('button')].find(b => words.test(text(b))) as HTMLButtonElement | undefined;
const inputFor = (el: Element, label: RegExp) => [...el.querySelectorAll('label')].find(l => label.test(text(l)))?.querySelector('input') as HTMLInputElement | undefined;
async function click(el: Element | undefined) { assert.ok(el !== undefined, 'nothing to click'); await act(async () => { (el as HTMLElement).click(); }); await settle(); }
async function type(input: HTMLInputElement | undefined, value: string) {
  assert.ok(input !== undefined, 'no such input');
  const set = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { set.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
}
const saved = () => (JSON.parse(localStorage.getItem(PENDING_KEY) || '[]') as { wallet: string; hash: string }[]).map(s => s.hash);
const submitted = () => calls.filter(c => c.action === 'payments').map(c => c.body?.tx_hash);
const checksOf = (hash: string) => submitted().filter(h => h === hash).length;
const save = (...hashes: string[]) => localStorage.setItem(PENDING_KEY, JSON.stringify(hashes.map((hash, i) => ({ wallet: WALLET, hash, at: Date.now() - i * 3 * 86_400_000 }))));
const payButton = (el: Element) => buttonFor(el, /with wallet/);
/** Whether Pay with wallet is drawn. Asserted as a boolean: see "NO DOM NODE IN AN ASSERTION" above. */
const canPay = (el: Element) => payButton(el) !== undefined;
/** The status line of one payment. */
const statusOf = (el: Element, hash: string) => text([...el.querySelectorAll('.dev-pay-status')].find(s => text(s).includes(short(hash))) ?? el.ownerDocument.createElement('i'));

/**
 * For a gateway that answers "pending" forever: fast-forward until every
 * hash in `hashes` has had its POLL_MAX_CHECKS checks, then assert that the
 * checks stopped there, say so on the page, and send nothing more.
 */
async function drain(el: Element, hashes: string[]) {
  await fastForward(() => hashes.every(h => checksOf(h) >= POLL_MAX_CHECKS) && held.length === 0);
  await settle(2);
  assert.deepEqual(hashes.map(checksOf), hashes.map(() => POLL_MAX_CHECKS), 'each pending payment is checked a bounded number of times');
  assert.equal(held.length, 0, 'no check is waiting to run again');
  const before = calls.length;
  await fastForward(() => false, 5);
  assert.equal(calls.length, before, 'and nothing more is sent');
  for (const h of hashes) {
    assert.match(statusOf(el, h), /Still waiting/, short(h));
    assert.ok(!!buttonFor([...el.querySelectorAll('.dev-pay-status')].find(s => text(s).includes(short(h)))!, /^Check again$/), 'with a way to ask again');
  }
}

test('while a payment is being checked no second one is offered, and a pasted hash joins it instead of replacing it', async () => {
  const page = await mount();
  assert.equal(canPay(page.container), true, 'Pay is offered before anything was sent');
  await click(payButton(page.container));
  assert.equal(sent.length, 1); assert.deepEqual(submitted(), [HASH_A]); assert.deepEqual(saved(), [HASH_A]);
  // The gateway records nothing for a 202: the page is the only thing holding HASH_A now.
  assert.equal(canPay(page.container), false, 'no second wallet payment while the first is unanswered');
  assert.match(text(page.container), /Your payment is being checked/); assert.match(text(page.container), /Paying again sends a second payment/);
  assert.doesNotMatch(text(page.container), /Pay 100,000 MERRYMEN/);
  // A hash from elsewhere (a sped-up transaction, a manual send) is added, never swapped in.
  await type(inputFor(page.container, /Paste the transaction hash/), HASH_B);
  await click(buttonFor(page.container, /^Check payment$/));
  assert.deepEqual(saved(), [HASH_A, HASH_B]); assert.deepEqual(submitted(), [HASH_A, HASH_B]);
  assert.ok(text(page.container).includes(short(HASH_A)) && text(page.container).includes(short(HASH_B)), 'both are shown');
  assert.equal(page.container.querySelectorAll('.dev-pay-status').length, 2);
  assert.match(text(page.container), /2 payments are being checked/);
  // The gateway never confirms either: the checks stop, both stay saved, and Pay stays held back.
  await drain(page.container, [HASH_A, HASH_B]);
  assert.deepEqual(saved(), [HASH_A, HASH_B]);
  assert.equal(canPay(page.container), false); assert.match(text(page.container), /2 payments are not credited yet\. Check them again below, or forget them/);
  await page.unmount();
  // Both are checked again after a reload, in the order they were sent.
  calls = [];
  const again = await mount();
  assert.deepEqual(submitted(), [HASH_A, HASH_B]); assert.equal(canPay(again.container), false);
  await drain(again.container, [HASH_A, HASH_B]);
  await again.unmount();
  assert.equal(sent.length, 1, 'the wallet was asked once');
});

test('a hash is forgotten only on a final answer; a stall, a refused check, a sign-out or a day passing keeps it', async () => {
  const answers: Record<string, Answer> = {
    [HASH_A]: { status: 200, body: { already: false, ...accountJson({ due_raw: null, due_tokens: null }) } },
    [HASH_B]: { status: 422, body: { error: { code: 'payment_not_found', reason: 'wrong_recipient', message: 'This transfer did not go to the Merrymen payments wallet.' } } },
    [HASH_C]: { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } },
    [HASH_D]: pending,
  };
  routes['POST payments'] = body => answers[String(body?.tx_hash)];
  // HASH_D was saved nine days ago (save() ages each one): age alone drops nothing.
  save(HASH_A, HASH_B, HASH_C, HASH_D);
  const page = await mount();
  assert.deepEqual(new Set(submitted()), new Set([HASH_A, HASH_B, HASH_C, HASH_D]));
  assert.deepEqual(saved(), [HASH_C, HASH_D], 'credited and refused are answered; the others are not');
  assert.match(statusOf(page.container, HASH_A), /^Credited/);
  // The account view that came with the credit is what the page now shows.
  assert.match(text(page.container), /Nothing due/); assert.doesNotMatch(text(page.container), /Due: 100,000/);
  assert.match(statusOf(page.container, HASH_B), /^Not credited This transfer did not go to the Merrymen payments wallet\./);
  assert.match(statusOf(page.container, HASH_C), /could not be checked just now \(Not found\)\. It is saved here/, 'a refused check is not a refused payment');
  assert.match(statusOf(page.container, HASH_D), /^Checking payment/);
  await drain(page.container, [HASH_D]);
  assert.deepEqual(saved(), [HASH_C, HASH_D], 'a check that ran out keeps its hash');
  await page.unmount();

  // The session ends while a payment is being checked: the console signs out, the hash stays, and checking stops.
  localStorage.clear(); save(HASH_D); calls = [];
  routes['POST payments'] = () => ({ status: 401, body: { error: { code: 'signed_out', message: 'Sign in to manage your API keys' } } });
  const out = await mount();
  assert.match(text(out.container), /Your session ended/); assert.ok(!!buttonFor(out.container, /Connect wallet/));
  assert.deepEqual(saved(), [HASH_D]);
  await fastForward(() => false, 6);
  assert.equal(checksOf(HASH_D), 1, 'nothing is checked while signed out'); assert.equal(held.length, 0);
  await out.unmount();
});

test('a stalled payment holds back Pay until it is checked again or forgotten, and forgetting asks first', async () => {
  routes['POST payments'] = () => ({ status: 404, body: { error: { code: 'not_found', message: 'Not found' } } });
  save(HASH_C);
  const page = await mount();
  assert.equal(canPay(page.container), false); assert.match(text(page.container), /Your payment is not credited yet/);
  await click(buttonFor(page.container, /^Forget this payment$/));
  assert.match(text(page.container), /This payment is not credited\. Once forgotten/); assert.deepEqual(saved(), [HASH_C], 'nothing forgotten on the first click');
  await click(buttonFor(page.container, /^Keep it$/));
  assert.deepEqual(saved(), [HASH_C]); assert.ok(!!buttonFor(page.container, /^Check again$/));
  // Checking again asks the gateway again.
  routes['POST payments'] = () => ({ status: 200, body: { already: false, ...accountJson() } });
  const before = submitted().length;
  await click(buttonFor(page.container, /^Check again$/));
  assert.equal(submitted().length, before + 1); assert.deepEqual(saved(), []);
  assert.equal(canPay(page.container), true, 'answered, so a payment for what is still due may start');
  await page.unmount();

  routes['POST payments'] = () => ({ status: 404, body: { error: { code: 'not_found', message: 'Not found' } } });
  save(HASH_C);
  const again = await mount();
  await click(buttonFor(again.container, /^Forget this payment$/));
  await click(buttonFor(again.container, /^Forget it$/));
  assert.deepEqual(saved(), []); assert.ok(!text(again.container).includes(short(HASH_C)));
  assert.equal(canPay(again.container), true);
  await again.unmount();
});

test('a page that goes away stops checking, and the payment is checked again when it comes back', async () => {
  save(HASH_A);
  const page = await mount();
  assert.equal(checksOf(HASH_A), 1); assert.deepEqual(held.map(t => t.ms), [6000], 'waiting to check again');
  await page.unmount();
  assert.equal(held.length, 0, 'the wait is cleared with the page');
  await fastForward(() => false, 5);
  assert.equal(checksOf(HASH_A), 1, 'nothing is sent for a page that is gone');
  assert.deepEqual(saved(), [HASH_A]);
  calls = [];
  const back = await mount();
  assert.equal(checksOf(HASH_A), 1, 'checked again at once');
  await drain(back.container, [HASH_A]);
  await back.unmount();

  // The page goes while a check is on its way: the answer that arrives later starts nothing.
  let answer: (a: Answer) => void = () => {};
  routes['POST payments'] = () => new Promise<Answer>(resolve => { answer = resolve; });
  calls = [];
  const gone = await mount();
  assert.equal(checksOf(HASH_A), 1); assert.equal(held.length, 0, 'the check is still out');
  await gone.unmount();
  answer(pending);
  await settle(4); await fastForward(() => false, 5);
  assert.equal(checksOf(HASH_A), 1); assert.equal(held.length, 0, 'no wait was started for a page that is gone');
  assert.deepEqual(saved(), [HASH_A]);
});

test(`pasting stops at ${MAX_PENDING} unanswered payments rather than dropping one`, async () => {
  const hashes = Array.from({ length: MAX_PENDING }, (_, i) => '0x' + String(i + 1).repeat(64));
  save(...hashes);
  const page = await mount();
  await type(inputFor(page.container, /Paste the transaction hash/), HASH_B);
  await click(buttonFor(page.container, /^Check payment$/));
  assert.match(text(page.container), new RegExp(`${MAX_PENDING} payments are already waiting`));
  assert.deepEqual(saved(), hashes); assert.ok(!submitted().includes(HASH_B));
  await drain(page.container, hashes);
  await page.unmount();
});

test('checks wait the delays nextPollDelay gives, six seconds then longer, and share them when several run', async () => {
  routes['POST payments'] = (_, call) => call <= 4 ? pending : { status: 200, body: { already: false, ...accountJson({ due_raw: null, due_tokens: null }) } };
  save(HASH_A);
  const page = await mount();
  const delays = await fastForward(() => checksOf(HASH_A) >= 5, 40);
  await settle(2);
  assert.deepEqual(delays, [6000, 6000, 6000, 9000]);
  assert.equal(submitted().length, 5); assert.match(statusOf(page.container, HASH_A), /^Credited/); assert.deepEqual(saved(), []);
  assert.equal(held.length, 0, 'credited: nothing more to wait for');
  await page.unmount();

  // Two at once: each waits twice as long, so together they ask no more often than one.
  routes['POST payments'] = () => pending; calls = [];
  save(HASH_A, HASH_B);
  const two = await mount();
  assert.deepEqual(held.map(t => t.ms), [12_000, 12_000]);
  await drain(two.container, [HASH_A, HASH_B]);
  await two.unmount();
});

test('Pay reads the payment details again: a rotated treasury, a pause or another tab\'s payment sends nothing', async () => {
  for (const [why, later, words] of [
    ['rotated', plansJson({ treasury: ROTATED }), /payments wallet changed since this page loaded, so nothing was sent/],
    ['paused', plansJson({ billing: { mode: 'off', enforced: false } }), /paused just now, so nothing was sent/],
  ] as const) {
    sent = []; calls = [];
    // The page was rendered and loaded with the old details; by the click the gateway has moved on.
    routes['GET plans'] = (_, call) => ({ status: 200, body: call === 1 ? plansJson() : later });
    const page = await mount();
    await click(payButton(page.container));
    assert.equal(sent.length, 0, why); assert.match(text(page.container), words, why);
    assert.equal(calls.filter(c => c.action === 'plans').length, 2, `${why}: read again at the click`);
    if (why === 'rotated') { assert.ok(text(page.container).includes(ROTATED), 'the new treasury is shown'); assert.ok(!text(page.container).includes(TREASURY)); }
    else assert.equal(canPay(page.container), false);
    await page.unmount();
  }
  // Another tab of this browser paid after this one drew its Pay button.
  routes['GET plans'] = () => ({ status: 200, body: plansJson() });
  sent = []; calls = [];
  const tab = await mount();
  save(HASH_C);
  await click(payButton(tab.container));
  assert.equal(sent.length, 0); assert.match(text(tab.container), /A payment from another tab of this browser is being checked/);
  assert.deepEqual(submitted(), [HASH_C], 'and this page checks it too'); assert.equal(canPay(tab.container), false);
  await drain(tab.container, [HASH_C]);
  await tab.unmount();
  // The same details and nothing waiting: the payment goes ahead.
  localStorage.clear(); sent = []; calls = [];
  const page = await mount();
  await click(payButton(page.container));
  assert.equal(sent.length, 1); assert.deepEqual(saved(), [HASH_A]);
  await drain(page.container, [HASH_A]);
  await page.unmount();
});

test('Review change only previews; only Confirm sends confirm:true', async () => {
  routes['GET account'] = () => ({ status: 200, body: accountJson({ plan: { id: 'free', name: 'Free', starts_at: null, ends_at: null, selected: 'free', renews_on_next_request: false }, due_raw: null, due_tokens: null }) });
  routes['POST plan'] = body => body?.confirm === true
    ? { status: 200, body: accountJson() }
    : { status: 200, body: { preview: true, tier: body?.tier, effect: 'waiting_for_payment', charge_now_raw: '0', due_raw: DUE.toString(), due_tokens: '100000', starts_at: null, ends_at: null } };
  const page = await mount();
  const crumbs = [...page.container.querySelectorAll('input[type="radio"]')].find(r => (r as HTMLInputElement).value === 'crumbs');
  await click(crumbs);
  await click(buttonFor(page.container, /^Review change$/));
  const plan = () => calls.filter(c => c.action === 'plan').map(c => c.body);
  assert.deepEqual(plan(), [{ tier: 'crumbs' }], 'the preview carries no confirm');
  assert.match(text(page.container), /Crumbs starts as soon as 100,000 MERRYMEN arrives/);
  await click(buttonFor(page.container, /^Confirm Crumbs$/));
  assert.deepEqual(plan(), [{ tier: 'crumbs' }, { tier: 'crumbs', confirm: true }]);
  assert.equal(canPay(page.container), true, 'what is due now can be paid');
  await page.unmount();
});

test('key creation waits for an account, and a 409 account_required closes it too', async () => {
  routes['GET account'] = () => ({ status: 404, body: { error: { code: 'account_missing', message: 'Create your developer account first.' } } });
  const missing = await mount();
  assert.equal(inputFor(missing.container, /Application name/)?.disabled, true);
  assert.match(text(missing.container), /Create your developer account above to create keys/);
  await missing.unmount();

  // A gateway without accounts on GET /account that still requires one for POST /keys.
  routes['GET account'] = () => ({ status: 404, body: { error: { code: 'not_found', message: 'Not found' } } });
  routes['POST keys'] = () => ({ status: 409, body: { error: { code: 'account_required', message: 'Create your developer account first.' } } });
  const page = await mount();
  const name = inputFor(page.container, /Application name/);
  assert.equal(name?.disabled, false);
  await type(name, 'Prism');
  await click(buttonFor(page.container, /Create API key/));
  assert.equal(calls.filter(c => c.method === 'POST' && c.action === 'keys').length, 1);
  assert.equal(inputFor(page.container, /Application name/)?.disabled, true);
  assert.match(text(page.container), /Create your developer account/);
  await page.unmount();
});
