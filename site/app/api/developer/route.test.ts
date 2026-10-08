import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { GET, POST } from './[action]/route';

test('portal proxy enforces origin, uses a server-only credential, and hides session tokens', async () => {
  const oldFetch = globalThis.fetch, oldSecret = process.env.MERRYMEN_DEVELOPER_PORTAL_SECRET;
  process.env.MERRYMEN_DEVELOPER_PORTAL_SECRET = 'test-only-portal-credential-32-bytes';
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://ai.merrymen.dev/developer/v1/verify');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer test-only-portal-credential-32-bytes');
    assert.equal(headers.get('x-developer-session'), 'existing-session');
    return Response.json({ address: '0x123', session: 'new-private-session' });
  };
  try {
    const context = { params: Promise.resolve({ action: 'verify' }) };
    const hostile = await POST(new NextRequest('https://merrymen.dev/api/developer/verify', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }), context);
    assert.equal(hostile.status, 403); assert.equal(calls, 0);
    const valid = await POST(new NextRequest('https://merrymen.dev/api/developer/verify', { method: 'POST', headers: { origin: 'https://merrymen.dev', cookie: 'mm_developer=existing-session' }, body: '{}' }), context);
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), { address: '0x123' });
    assert.match(valid.headers.get('set-cookie')!, /HttpOnly/);
    assert.match(valid.headers.get('set-cookie')!, /SameSite=strict/);
    assert.match(valid.headers.get('set-cookie')!, /Path=\/api\/developer/);
    assert.equal(valid.headers.get('cache-control'), 'no-store');
    const oversized = await POST(new NextRequest('https://merrymen.dev/api/developer/verify', { method: 'POST', headers: { origin: 'https://merrymen.dev' }, body: 'x'.repeat(8193) }), context);
    assert.equal(oversized.status, 413); assert.equal(calls, 1);
    const logout = await POST(new NextRequest('https://merrymen.dev/api/developer/logout', { method: 'POST', headers: { origin: 'https://merrymen.dev' } }), { params: Promise.resolve({ action: 'logout' }) });
    assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/);
    globalThis.fetch = async () => new Response('export const SDK = true;');
    const sdk = await GET(new NextRequest('https://merrymen.dev/api/developer/sdk'), { params: Promise.resolve({ action: 'sdk' }) });
    assert.equal(sdk.status, 200); assert.match(sdk.headers.get('content-disposition')!, /attachment/);
  } finally { globalThis.fetch = oldFetch; if (oldSecret === undefined) delete process.env.MERRYMEN_DEVELOPER_PORTAL_SECRET; else process.env.MERRYMEN_DEVELOPER_PORTAL_SECRET = oldSecret; }
});

/** Runs `fn` with these env values (undefined removes one), restoring fetch and env after. */
async function withEnv(env: Record<string, string | undefined>, fn: (urls: string[], sent: Headers[]) => Promise<void>, answer = async () => Response.json({ address: '0x123', keys: [] })) {
  const oldFetch = globalThis.fetch, old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  const urls: string[] = [], sent: Headers[] = [];
  globalThis.fetch = async (url, init) => { urls.push(String(url)); sent.push(new Headers(init?.headers)); return answer(); };
  const set = (values: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  const quiet = console.error; console.error = () => {};
  try { set(env); await fn(urls, sent); } finally { globalThis.fetch = oldFetch; console.error = quiet; set(old); }
}
const keys = () => GET(new NextRequest('https://merrymen.dev/api/developer/keys'), { params: Promise.resolve({ action: 'keys' }) });
const secret = 'test-only-portal-credential-32-bytes';

test('the gateway origin can be overridden, only to an https origin or a local one', async () => {
  for (const [origin, expected] of [['http://localhost:8787', 'http://localhost:8787/developer/v1/keys'], ['https://gateway.example/', 'https://gateway.example/developer/v1/keys'], [undefined, 'https://ai.merrymen.dev/developer/v1/keys']] as const) {
    await withEnv({ MERRYMEN_DEVELOPER_PORTAL_SECRET: secret, MERRYMEN_DEVELOPER_GATEWAY_ORIGIN: origin }, async urls => {
      assert.equal((await keys()).status, 200); assert.deepEqual(urls, [expected]);
    });
  }
  // The portal secret travels with every request: a bad override fails closed, never falls back.
  for (const origin of ['http://gateway.example', 'https://user:pass@gateway.example', 'https://gateway.example/api', 'https://gateway.example/?x=1', 'ftp://gateway.example', 'not a url']) {
    await withEnv({ MERRYMEN_DEVELOPER_PORTAL_SECRET: secret, MERRYMEN_DEVELOPER_GATEWAY_ORIGIN: origin }, async urls => {
      const refused = await keys();
      assert.equal(refused.status, 503, origin); assert.deepEqual(urls, [], origin);
      assert.match((await refused.json()).error.message, /temporarily unavailable/);
    });
  }
});

test('logout revokes the session on the gateway, and clears the cookie even when that fails', async () => {
  const logout = (origin = 'https://merrymen.dev') => POST(new NextRequest('https://merrymen.dev/api/developer/logout', { method: 'POST',
    headers: { origin, cookie: 'mm_developer=live-session', 'x-forwarded-for': '203.0.113.7' } }), { params: Promise.resolve({ action: 'logout' }) });
  await withEnv({ MERRYMEN_DEVELOPER_PORTAL_SECRET: secret, MERRYMEN_DEVELOPER_GATEWAY_ORIGIN: undefined }, async (urls, sent) => {
    const response = await logout();
    assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie')!, /mm_developer=;.*Max-Age=0/);
    assert.deepEqual(urls, ['https://ai.merrymen.dev/developer/v1/logout']);
    assert.equal(sent[0].get('x-developer-session'), 'live-session');
    assert.equal(sent[0].get('authorization'), `Bearer ${secret}`);
    assert.equal(sent[0].get('x-developer-ip'), '203.0.113.7');
    // A cross-site page cannot sign a developer out, on either side.
    assert.equal((await logout('https://evil.example')).status, 403); assert.equal(urls.length, 1);
  }, async () => Response.json({ signed_out: true }));
  await withEnv({ MERRYMEN_DEVELOPER_PORTAL_SECRET: secret }, async urls => {
    const response = await logout();
    assert.equal(urls.length, 1); assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie')!, /Max-Age=0/);
  }, async () => { throw new TypeError('fetch failed'); });
});

test('a portal secret under 32 bytes fails closed before anything is sent', async () => {
  for (const short of [undefined, '', 'too-short-portal-secret', 'x'.repeat(31)]) {
    await withEnv({ MERRYMEN_DEVELOPER_PORTAL_SECRET: short, MERRYMEN_DEVELOPER_GATEWAY_ORIGIN: undefined }, async urls => {
      assert.equal((await keys()).status, 503); assert.deepEqual(urls, []);
    });
  }
});

test('the console treats the gateway ending a session as signed out, not as an error', async () => {
  // Sessions on the gateway's memory store end at every restart, so the code
  // the console reacts to has to be the one the gateway actually sends.
  const { sessionEnded } = await import('../DeveloperConsole');
  const gateway = readFileSync(new URL('../../../../gateway/lib/developer-api.mjs', import.meta.url), 'utf8');
  assert.match(gateway, /if \(!user\) return error\(401, "signed_out"/);
  assert.equal(sessionEnded(Object.assign(new Error('Sign in to manage your API keys'), { status: 401, code: 'signed_out' })), true);
  for (const other of [Object.assign(new Error('x'), { status: 401, code: 'signature_invalid' }), new Error('offline'), null, undefined, 'signed_out']) {
    assert.equal(sessionEnded(other), false, String(other));
  }
});

test('the console links to repository docs on main, not on a feature branch', () => {
  // The reference link pointed at codex/embedded-partner-api, which stops
  // matching the deployed API the moment main moves on (or the branch goes).
  const source = readFileSync(new URL('../DeveloperConsole.tsx', import.meta.url), 'utf8');
  const links = [...source.matchAll(/github\.com\/millw14\/merrymen\/(?:blob|tree)\/([^/"'`]+)/g)].map(m => m[1]);
  assert.ok(links.length > 0, 'the console should link to the reference');
  assert.deepEqual([...new Set(links)], ['main']);
});
