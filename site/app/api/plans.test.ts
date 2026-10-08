/**
 * The public Plans section: read from the gateway on the server, cached for a
 * minute, and the static table whenever that answer is missing or unusable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_PLANS, TOKEN, UNIT } from '../../lib/developer-billing';
import { PLANS_REVALIDATE_SEC, fetchPlans } from '../../lib/developer-gateway';

const secret = 'test-only-portal-credential-32-bytes';
const TREASURY = '0x3333333333333333333333333333333333333333';
const live = {
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
  const { plans, calls } = await plansWith(() => Response.json(live));
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
    ['malformed', () => Response.json({ ...live, plans: 'all of them' })],
  ] as const) {
    const { plans, logged } = await plansWith(answer);
    assert.deepEqual(plans, FALLBACK_PLANS, why); assert.equal(plans.treasury, null, why);
    assert.equal(logged.length, 1, why);
  }
  // Without a usable secret nothing is sent at all: the credential never goes to a bad origin.
  for (const env of [{}, { MERRYMEN_DEVELOPER_PORTAL_SECRET: 'short' }, { MERRYMEN_DEVELOPER_PORTAL_SECRET: secret, MERRYMEN_DEVELOPER_GATEWAY_ORIGIN: 'http://gateway.example' }]) {
    const { plans, calls } = await plansWith(() => Response.json(live), env);
    assert.deepEqual(plans, FALLBACK_PLANS); assert.deepEqual(calls, []);
  }
});
