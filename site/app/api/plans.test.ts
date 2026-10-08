/**
 * The public Plans section: read from the gateway on the server, cached for a
 * minute, and the static table whenever that answer is missing or unusable.
 * Rendered to static markup to pin what a signed-out reader sees.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FALLBACK_PLANS, TOKEN, UNIT, normalizePlans } from '../../lib/developer-billing';
import { PLANS_REVALIDATE_SEC, fetchPlans } from '../../lib/developer-gateway';
import { DeveloperConsole } from './DeveloperConsole';
import { PlansSection } from './PlansSection';

// tsx compiles JSX to React.createElement; Next's own build does not need this.
(globalThis as unknown as { React: typeof React }).React = React;

const secret = 'test-only-portal-credential-32-bytes';
const TREASURY = '0x3333333333333333333333333333333333333333';
const answer = {
  billing: { mode: 'enforce', enforced: true }, period_days: 30, treasury: TREASURY,
  currency: { symbol: 'MERRYMEN', address: TOKEN.address, chain_id: 4663, decimals: 18, explorer_url: 'https://robinhoodchain.blockscout.com' },
  confirmations: { blocks: 64, min_age_sec: 120 },
  plans: [{ id: 'free', name: 'Free', price_tokens: '0', price_raw: '0', requests: 1000, rpm: 30 }, { id: 'crumbs', name: 'Crumbs', price_tokens: '100000', price_raw: (100_000n * UNIT).toString(), requests: 50000, rpm: 60 }],
};

/** Runs fetchPlans against a scripted gateway, recording each request. */
async function plansWith(answer: () => Response | Promise<Response>, env: Record<string, string | undefined> = { MERRYMEN_DEVELOPER_PORTAL_SECRET: secret }) {
  const calls: { url: string; init: RequestInit & { next?: { revalidate?: number | false } } }[] = [];
  const oldFetch = globalThis.fetch, oldError = console.error, keys = ['MERRYMEN_DEVELOPER_PORTAL_SECRET', 'MERRYMEN_DEVELOPER_GATEWAY_ORIGIN'];
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const logged: string[] = [];
  for (const k of keys) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return answer(); };
  console.error = (line: string) => { logged.push(line); };
  try { return { plans: await fetchPlans(), calls, logged }; } finally {
    globalThis.fetch = oldFetch; console.error = oldError;
    for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
}

test('plans are read with the portal secret and no session, and cached for a minute', async () => {
  const { plans, calls } = await plansWith(() => Response.json(answer));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ai.merrymen.dev/developer/v1/plans');
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${secret}`);
  assert.equal(headers.get('x-developer-session'), null); assert.equal(headers.get('cookie'), null);
  assert.equal(calls[0].init.next?.revalidate, PLANS_REVALIDATE_SEC); assert.equal(PLANS_REVALIDATE_SEC, 60);
  assert.equal(calls[0].init.cache, undefined, 'no-store would defeat the revalidate');
  assert.equal(plans.source, 'live'); assert.equal(plans.treasury, TREASURY); assert.equal(plans.plans.length, 2);
});

test('the static table stands in for a gateway that cannot answer, and it carries no treasury', async () => {
  for (const [why, answer] of [
    ['down', () => { throw new TypeError('fetch failed'); }],
    ['refusing', () => Response.json({ error: { code: 'signed_out' } }, { status: 401 })],
    ['not JSON', () => new Response('<html>502</html>', { status: 200 })],
    ['malformed', () => Response.json({ ...answer, plans: 'all of them' })],
  ] as const) {
    const { plans, logged } = await plansWith(answer);
    assert.deepEqual(plans, FALLBACK_PLANS, why); assert.equal(plans.treasury, null, why);
    assert.equal(logged.length, 1, why);
  }
  // Without a usable secret nothing is sent at all: the credential never goes to a bad origin.
  for (const env of [{}, { MERRYMEN_DEVELOPER_PORTAL_SECRET: 'short' }, { MERRYMEN_DEVELOPER_PORTAL_SECRET: secret, MERRYMEN_DEVELOPER_GATEWAY_ORIGIN: 'http://gateway.example' }]) {
    const { plans, calls } = await plansWith(() => Response.json(answer), env);
    assert.deepEqual(plans, FALLBACK_PLANS); assert.deepEqual(calls, []);
  }
});

const live = (mode: 'off' | 'observe' | 'enforce' = 'enforce', over: Record<string, unknown> = {}) => normalizePlans({
  billing: { mode, enforced: mode === 'enforce' }, period_days: 30, treasury: TREASURY,
  currency: { symbol: 'MERRYMEN', address: TOKEN.address, chain_id: 4663, decimals: 18, explorer_url: '' }, confirmations: { blocks: 64, min_age_sec: 120 },
  plans: FALLBACK_PLANS.plans, ...over,
})!;
const html = <P extends object>(type: React.FunctionComponent<P>, props: P) => renderToStaticMarkup(createElement(type, props));
/** Copy that must never appear: burn, price or yield stories, fiat, and refunds nobody gets. */
const BANNED = /burn|buyback|buy back|deflation|circulation|supports the token|worth|best value|\$\s?\d|USD|price (goes|rises)|returns|refund/i;

test('the Plans section shows the four plans, how requests count and how plans are paid', () => {
  const page = html(PlansSection, { plans: live() });
  assert.match(page, /id="plans"/);
  for (const text of ['Free', 'Crumbs', 'Loaf', 'Feast', '100,000 MERRYMEN', '400,000 MERRYMEN', '1,000,000 MERRYMEN', '<strong>50,000</strong> requests per 30 days', '<strong>300</strong> requests a minute', 'PER 30 DAYS', 'Choose a plan']) {
    assert.ok(page.includes(text), text);
  }
  assert.match(page, /Every API request counts toward your plan; <code>\/meta<\/code> is free/);
  assert.match(page, /paid in \$MERRYMEN on Robinhood Chain from the wallet you sign in with/);
  assert.ok(page.includes(`href="https://robinhoodchain.blockscout.com/token/${TOKEN.address}"`));
  assert.doesNotMatch(page, /coming soon/i);
  // The section is public: it never names the payment address, and never offers to pay by itself.
  assert.ok(!page.includes(TREASURY)); assert.doesNotMatch(page, /Pay /);
  assert.doesNotMatch(page, BANNED);
});

test('without live billing and a treasury the Plans section says coming soon and offers nothing to pay', () => {
  for (const [why, plans] of [['fallback', FALLBACK_PLANS], ['off', live('off')], ['no treasury', live('observe', { treasury: null })], ['other token', live('enforce', { currency: { address: TREASURY, chain_id: 4663, decimals: 18 } })]] as const) {
    const page = html(PlansSection, { plans });
    assert.match(page, /PAID PLANS COMING SOON/, why); assert.match(page, /nothing is charged and there is nothing to send/, why);
    assert.doesNotMatch(page, /Choose a plan/, why); assert.ok(!page.includes(TREASURY), why);
    assert.ok(page.includes('100,000 MERRYMEN'), `${why}: the table still shows`);
  }
  assert.match(html(PlansSection, { plans: FALLBACK_PLANS }), /live details could not be loaded/);
  assert.match(html(PlansSection, { plans: live('observe') }), /counted against each plan but not yet refused/);
  assert.doesNotMatch(html(PlansSection, { plans: live('enforce') }), /not yet refused/);
});

test('the page renders the Plans section on the server, and the stale "no payment" line is gone', () => {
  const page = html(DeveloperConsole, { initialPlans: live() });
  assert.match(page, /id="plans"/); assert.match(page, /href="#plans"/); assert.ok(page.includes('400,000 MERRYMEN'));
  const fallback = html(DeveloperConsole, {});
  assert.match(fallback, /PAID PLANS COMING SOON/);
  const source = readFileSync(new URL('./DeveloperConsole.tsx', import.meta.url), 'utf8');
  assert.ok(!source.includes('No payment, transaction, or token balance required'), 'the stale sign-in line');
  const pageSource = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8');
  assert.match(pageSource, /export const revalidate = 60;/); assert.match(pageSource, /initialPlans=\{await fetchPlans\(\)\}/);
});
