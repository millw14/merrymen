/**
 * What the signed-in console draws for each account and billing state.
 * Rendered to static markup (no DOM library: the site's own dependencies are
 * next and react), so these pin the words and the presence or absence of the
 * controls that move money: no Pay button for the wrong wallet or network, no
 * treasury from the static table, no key creation before an account exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FALLBACK_PLANS, TOKEN, UNIT, normalizeAccount, normalizePlans, type PayCheck, type PlansView } from '../../lib/developer-billing';
import { AccountPanel, WalletPay, loadAccount, type AccountState } from './AccountPanel';
import { KeyForm, keyLimits, testSummary } from './DeveloperConsole';

// tsx compiles JSX to React.createElement; Next's own build does not need this.
(globalThis as unknown as { React: typeof React }).React = React;

const WALLET = '0x1111111111111111111111111111111111111111';
const TREASURY = '0x3333333333333333333333333333333333333333';
const live = (mode: 'off' | 'observe' | 'enforce' = 'enforce', over: Record<string, unknown> = {}) => normalizePlans({
  billing: { mode, enforced: mode === 'enforce' }, period_days: 30, treasury: TREASURY,
  currency: { symbol: 'MERRYMEN', address: TOKEN.address, chain_id: 4663, decimals: 18, explorer_url: '' }, confirmations: { blocks: 64, min_age_sec: 120 },
  plans: FALLBACK_PLANS.plans, ...over,
})!;
const view = (over: Record<string, unknown> = {}) => normalizeAccount({
  account: { id: 'acct_1', name: 'Prism', wallet: WALLET, created_at: '2026-10-01T00:00:00.000Z' },
  plan: { id: 'free', name: 'Free', starts_at: null, ends_at: null, selected: 'crumbs', renews_on_next_request: false },
  credit_raw: (60_000n * UNIT).toString(), due_raw: (40_000n * UNIT - 5n).toString(),
  usage: { used: 120, limit: 1000, resets_at: '2026-10-31T00:00:00.000Z', by_key: [{ key_id: 'key_a', used: 120 }] },
  history: [{ type: 'payment', at: '2026-10-02T09:30:00.000Z', amount_tokens: '60000', tx_hash: '0x' + 'cd'.repeat(32) }], ...over,
})!;
const html = <P extends object>(type: React.FunctionComponent<P>, props: P) => renderToStaticMarkup(createElement(type, props));
const noop = () => {}, run = async () => {};
const panel = (state: AccountState, plans: PlansView = live()) => html(AccountPanel, { address: WALLET, plans, state, keys: [{ key_id: 'key_a', name: 'Prism backend', status: 'active' }], busy: '', run, defaultName: 'Prism backend', onAccount: noop, onPlans: noop, reload: run, onSignedOut: noop });
/** Copy that must never appear: burn, price or yield stories, fiat, and refunds nobody gets. */
const BANNED = /burn|buyback|buy back|deflation|circulation|supports the token|worth|best value|\$\s?\d|USD|price (goes|rises)|returns|refund/i;

test('Pay with wallet is drawn only when the check passed; every refusal says why and offers the fix', () => {
  const amount = 40_000n * UNIT;
  const draw = (check: PayCheck | null, balance: bigint | null = null) => html(WalletPay, { check, amount, busy: '', balance, onConnect: noop, onSwitch: noop, onPay: noop });
  assert.match(draw({ ok: true }), /Pay 40,000 MERRYMEN with wallet/);
  assert.match(draw({ ok: true }, 250_000n * UNIT), /holds 250,000 MERRYMEN; after this payment it holds 210,000/);
  assert.match(draw({ ok: true }, 10_000n * UNIT), /holds 10,000 MERRYMEN, less than this payment/);
  assert.match(draw(null), /Checking your browser wallet/); assert.doesNotMatch(draw(null), /<button/);
  const refusals: [PayCheck, RegExp | null][] = [
    [{ ok: false, reason: 'no_provider', message: 'No browser wallet on this page.' }, null],
    [{ ok: false, reason: 'not_connected', message: 'Connect 0x1111…1111.' }, /Connect wallet/],
    [{ ok: false, reason: 'wrong_account', message: 'Your wallet is set to 0x2222…2222.' }, null],
    [{ ok: false, reason: 'wrong_chain', message: 'Your wallet is on another network.' }, /Switch to Robinhood Chain/],
  ];
  for (const [check, button] of refusals) {
    const out = draw(check);
    assert.doesNotMatch(out, /Pay 40,000/, check.ok ? '' : check.reason);
    assert.ok(out.includes((check as { message: string }).message));
    if (button) assert.match(out, button); else assert.doesNotMatch(out, /<button/);
  }
});

test('the payment panel asks for the amount due rounded up, from the signed-in wallet, with manual steps', () => {
  const page = panel({ kind: 'ready', view: view() });
  assert.match(page, /Pay 40,000 MERRYMEN/);
  assert.ok(page.includes(TREASURY)); assert.ok(page.includes(TOKEN.address));
  assert.match(page, /Merrymen payments wallet/); assert.match(page, /Robinhood Chain \(chain ID 4663\)/);
  assert.match(page, /Send only from 0x1111…1111\. A transfer from any other wallet, an exchange, a smart account or a swap cannot be credited/);
  assert.match(page, /Already sent\? Paste the transaction hash\./);
  assert.match(page, /Paying moves MERRYMEN out of your wallet\. Merry Circle tiers and hosted energy follow the balance you hold\./);
  // Named for assistive technology: the panel is a region with its heading, and each Copy says what it copies.
  assert.match(page, /<section class="dev-pay" aria-labelledby="dev-pay-title"><h3 id="dev-pay-title">Pay 40,000 MERRYMEN<\/h3>/);
  assert.match(page, /aria-label="Copy amount"/); assert.match(page, /aria-label="Copy Merrymen payments wallet address"/);
  // The usage meter, per-key use and history.
  assert.match(page, /120 of 1,000 requests/); assert.match(page, /Prism backend/); assert.match(page, /aria-valuenow="120"/);
  assert.match(page, /Choose a plan/); assert.match(page, /Payment received/); assert.match(page, /\+60,000/);
  // History reads newest first, as the gateway sends it.
  const history = [{ type: 'charge', at: '2026-10-05T00:00:00.000Z', amount_tokens: '100000', tier: 'crumbs', reason: 'activate' }, { type: 'payment', at: '2026-10-01T00:00:00.000Z', amount_tokens: '100000', tx_hash: '0x' + 'cd'.repeat(32) }];
  const listed = panel({ kind: 'ready', view: view({ history }) });
  assert.ok(listed.indexOf('Crumbs started') < listed.indexOf('Payment received'), 'newest first');
  assert.doesNotMatch(page, BANNED);
});

test('no payment panel without a live treasury, and nothing at all to pay when billing is off', () => {
  for (const plans of [FALLBACK_PLANS, live('observe', { treasury: null })]) {
    const page = panel({ kind: 'ready', view: view() }, plans);
    assert.ok(!page.includes(TREASURY)); assert.doesNotMatch(page, /Pay 40,000|Paste the transaction hash/);
  }
  assert.match(panel({ kind: 'ready', view: view() }, live('observe', { treasury: null })), /Payments are not open yet/);
  const off = panel({ kind: 'ready', view: view() }, live('off'));
  assert.match(off, /Paid plans are coming soon/); assert.doesNotMatch(off, /Choose a plan|Pay 40,000|requests used/i);
  // The plans fell back while the account answered: billing may be on, so neither "coming soon" nor a way to pay, and no per-key rate.
  const unknown = panel({ kind: 'ready', view: view() }, FALLBACK_PLANS);
  assert.match(unknown, /Plan details could not be loaded just now\. Reload the page to choose a plan or pay/); assert.doesNotMatch(unknown, /coming soon|Payments are not open/);
  assert.equal(keyLimits(FALLBACK_PLANS, { kind: 'ready', view: view() }), 'Up to 5 active keys · Create, read and chat scopes · Plan limits could not be loaded just now');
  // Just after a payment starts Crumbs the gateway already reports the next period's price as due, for renewal:
  // that is owed when this period ends, not now, and must not read as a bill for the payment just made.
  const running = { id: 'crumbs', name: 'Crumbs', starts_at: '2026-10-01T00:00:00.000Z', ends_at: '2026-10-31T00:00:00.000Z', selected: 'crumbs', renews_on_next_request: false };
  const renewal = panel({ kind: 'ready', view: view({ plan: running, credit_raw: '0', due_raw: (100_000n * UNIT).toString(), due_for: 'renewal' }) });
  assert.match(renewal, /To renew on 31 Oct 2026: 100,000 MERRYMEN/); assert.doesNotMatch(renewal, /Due: |Pay 100,000 MERRYMEN/);
  assert.match(renewal, /Renew for the next period: 100,000 MERRYMEN<\/h3>/); assert.match(renewal, /runs until 31 Oct 2026 either way, and nothing is owed before then/);
  // Activation is due now, as is a renewal once the plan has lapsed to Free.
  for (const due_for of ['activation', 'renewal', undefined]) {
    const now = panel({ kind: 'ready', view: view({ credit_raw: '0', due_raw: (100_000n * UNIT).toString(), due_for }) });
    assert.match(now, /Due: 100,000 MERRYMEN/, String(due_for)); assert.match(now, /<h3 id="dev-pay-title">Pay 100,000 MERRYMEN<\/h3>/, String(due_for));
  }
  // Nothing due, nothing to pay.
  assert.doesNotMatch(panel({ kind: 'ready', view: view({ due_raw: null }) }), /Pay |Paste the transaction hash/);
  // A shortfall is said plainly.
  assert.match(panel({ kind: 'ready', view: view({ credit_raw: (-5n * UNIT).toString(), due_raw: null }) }), /-5 <small>MERRYMEN<\/small>[\s\S]*A reversed payment left a shortfall/);
});

test('without an account the console asks for one, and key creation waits for it', () => {
  const create = panel({ kind: 'missing' });
  assert.match(create, /Create your developer account/); assert.match(create, /value="Prism backend"/); assert.match(create, /Create account/);
  assert.equal(panel({ kind: 'unsupported' }), '');
  assert.match(panel({ kind: 'error', message: 'Billing is unavailable.' }), /Billing is unavailable\.[\s\S]*Try again/);
  const form = (needsAccount: boolean) => html(KeyForm, { name: 'Prism', setName: noop, rotateApp: '', busy: '', needsAccount, onSubmit: noop, onCancelRotate: noop });
  const waiting = form(true);
  assert.match(waiting, /<input[^>]*disabled=""/); assert.match(waiting, /<button class="dev-primary" disabled="">/);
  assert.match(waiting, /Create your developer account above to create keys\. Keys you already have keep working\./);
  const open = form(false);
  assert.doesNotMatch(open, /disabled/); assert.doesNotMatch(open, /developer account above/);
});

test('the key footnote states the limit that applies: per key with billing off, the shared plan with it on', () => {
  // The per-key rate is true only with billing off, so the footnote comes from keyLimits.
  assert.ok(readFileSync(new URL('./DeveloperConsole.tsx', import.meta.url), 'utf8').includes('<p className="dev-small">{keyLimits(plans, account)}</p>'));
  assert.equal(keyLimits(live('off'), { kind: 'missing' }), 'Up to 5 active keys · 30 requests/minute per key · Create, read and chat scopes');
  assert.equal(keyLimits(FALLBACK_PLANS, { kind: 'loading' }), 'Up to 5 active keys · 30 requests/minute per key · Create, read and chat scopes');
  assert.match(keyLimits(live(), { kind: 'missing' }), /Free: 30 requests\/minute and 1,000 requests per 30 days, shared by all your keys/);
  const crumbs = view({ plan: { id: 'crumbs', name: 'Crumbs', starts_at: '2026-10-01T00:00:00.000Z', ends_at: '2026-10-31T00:00:00.000Z', selected: 'crumbs' }, usage: { used: 1, limit: 50_000, by_key: [] } });
  assert.match(keyLimits(live(), { kind: 'ready', view: crumbs }), /Crumbs: 60 requests\/minute and 50,000 requests per 30 days/);
  assert.equal(testSummary({ name: 'Prism', rate_per_min: 60, billing: { requests_used: 1200, requests_limit: 50_000 } }), '200 OK · Prism · 60 requests/minute · 1,200 of 50,000 requests used');
  assert.equal(testSummary({ name: 'Prism', rate_per_min: 30, billing: null }), '200 OK · Prism · 30 requests/minute');
});

test('account loading tells a missing account from a gateway without accounts, and passes an ended session up', async () => {
  const oldFetch = globalThis.fetch;
  const answer = (status: number, body: unknown) => { globalThis.fetch = async () => Response.json(body, { status }); };
  try {
    answer(404, { error: { code: 'account_missing', message: 'Create your developer account' } });
    assert.deepEqual(await loadAccount(), { kind: 'missing' });
    // Today's gateway: GET /account is an ordinary 404, and keys must keep working.
    answer(404, { error: { code: 'not_found', message: 'Not found' } });
    assert.deepEqual(await loadAccount(), { kind: 'unsupported' });
    answer(503, { error: { code: 'billing_unavailable', message: 'Billing is unavailable.' } });
    assert.deepEqual(await loadAccount(), { kind: 'error', message: 'Billing is unavailable.' });
    answer(200, { account: 'nope' });
    assert.equal((await loadAccount()).kind, 'error');
    answer(200, { account: { id: 'acct_1', name: 'Prism', wallet: WALLET }, plan: { id: 'free', name: 'Free', selected: 'free' }, credit_raw: '0', due_raw: null });
    assert.equal((await loadAccount()).kind, 'ready');
    answer(401, { error: { code: 'signed_out', message: 'Sign in' } });
    await assert.rejects(loadAccount(), (e: { code?: string }) => e.code === 'signed_out');
  } finally { globalThis.fetch = oldFetch; }
});

test('nothing the console imports reads a server secret', () => {
  for (const file of ['./DeveloperConsole.tsx', './AccountPanel.tsx', './PlansSection.tsx', './developer-client.ts', '../../lib/developer-billing.ts', '../../lib/pending-payments.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    // DeveloperConsole's sample code mentions process.env.MERRYMEN_API_KEY as text for the reader's backend; that is not a read.
    assert.ok(!/from ["'][^"']*developer-gateway["']|process\.env\.(?!MERRYMEN_API_KEY\b)/.test(source), file);
  }
});

test('the billing sources carry no invisible or bidirectional characters', () => {
  // Written as \u escapes where they are matched; a literal one reads differently than it runs.
  for (const file of ['./DeveloperConsole.tsx', './AccountPanel.tsx', './PlansSection.tsx', './developer-client.ts', '../../lib/developer-billing.ts', '../../lib/pending-payments.ts', '../../lib/developer-gateway.ts', './developer/[action]/route.ts']) {
    assert.ok(!/[\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/.test(readFileSync(new URL(file, import.meta.url), 'utf8')), file);
  }
});
