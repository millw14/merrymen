import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { GET, POST } from './[action]/route';

test('portal proxy enforces origin, uses a server-only credential, and hides session tokens', async () => {
  const oldFetch = globalThis.fetch, oldSecret = process.env.MERRYMEN_DEVELOPER_PORTAL_SECRET;
  process.env.MERRYMEN_DEVELOPER_PORTAL_SECRET = 'test-only-portal-credential-32-bytes';
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
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
