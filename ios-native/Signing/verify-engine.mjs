// End-to-end permission preparation with a TEST owner, deterministic test-only
// randomness, and a fake app backend. Never submits a grant or transaction.
// --record refreshes read-only public-chain fixtures; normal mode is offline.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const { privateKeyToAccount } = require('viem/accounts');
const { recoverMessageAddress, recoverTypedDataAddress } = require('viem');
const owner = privateKeyToAccount('0x' + '11'.repeat(32)); // Public test vector, never funded.
const fixturePath = path.join(root, 'ios-native/Signing/chain-fixtures.json');
const fixtures = fs.existsSync(fixturePath) ? JSON.parse(fs.readFileSync(fixturePath, 'utf8')) : {};
const recording = process.argv.includes('--record');
const trencher = process.argv.includes('--trencher');
const cache = new Map();
const storage = new Map();
const timers = new Map();
let randomIndex = 0, signatures = 0, posted;
let finish, fail;
const complete = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
const sync = (op, args) => {
  switch (op) {
    case 'random': return Array.from({ length: args.count }, () => (++randomIndex % 251) + 1);
    case 'encodeUTF8': return Array.from(Buffer.from(args.text, 'utf8'));
    case 'decodeUTF8': return Buffer.from(args.bytes).toString('utf8');
    case 'base64encode': return Buffer.from(args.bytes).toString('base64');
    case 'base64decode': return Array.from(Buffer.from(args.text, 'base64'));
    case 'storageGet': return storage.get(args.key) ?? null;
    case 'storageSet': storage.set(args.key, args.value); return null;
    case 'storageKeys': return Array.from(storage.keys());
    case 'storageRemove': throw new Error('Grant deletion is forbidden in this test');
    case 'parseURL': { const url = new URL(args.url, args.base ?? undefined); return { protocol: url.protocol, hostname: url.hostname, port: url.port, pathname: url.pathname, search: url.search, username: url.username, password: url.password }; }
    case 'formatURL': { const url = new URL(`${args.scheme}://${args.host}`); url.port = args.port; url.pathname = args.path; url.search = args.query; url.username = args.username; url.password = args.password; return String(url); }
    default: throw new Error(`Unsupported synchronous capability ${op}`);
  }
};
const handle = async (op, args) => {
  if (op === 'status') return null;
  if (op === 'accessToken') return 'TEST_ONLY_NOT_A_REAL_TOKEN';
  if (op === 'signMessage') {
    assert.equal(args.address.toLowerCase(), owner.address.toLowerCase());
    const signature = await owner.signMessage({ message: { raw: args.hex } });
    assert.equal((await recoverMessageAddress({ message: { raw: args.hex }, signature })).toLowerCase(), owner.address.toLowerCase()); signatures++; return signature;
  }
  if (op === 'signTypedData') {
    assert.equal(args.address.toLowerCase(), owner.address.toLowerCase());
    const signature = await owner.signTypedData(args.typedData);
    assert.equal((await recoverTypedDataAddress({ ...args.typedData, signature })).toLowerCase(), owner.address.toLowerCase()); signatures++; return signature;
  }
  assert.equal(op, 'fetch');
  const url = new URL(args.url, 'https://app.merrymen.dev');
  if (url.host === 'app.merrymen.dev') {
    if (url.pathname === '/api/auth/challenge' && args.method === 'GET') return { status: 200, body: JSON.stringify({ origin: url.origin, nonce: 'fixture_nonce' }) };
    assert.equal(url.pathname, '/api/grants'); assert.equal(args.method, 'POST');
    posted = JSON.parse(args.body);
    assert.equal(posted.demoOwnerPrivateKey, undefined);
    assert.equal(posted.owner.toLowerCase(), owner.address.toLowerCase());
    assert.equal(posted.binding.did, 'did:privy:ios-test');
    assert.ok(storage.has('merrymen.grant.v1'), 'Grant must be stored before handoff');
    return { status: 200, body: '{"ok":true}' }; // No real app request.
  }
  assert.equal(url.href, 'https://rpc.mainnet.chain.robinhood.com/');
  const rpc = JSON.parse(args.body);
  assert.ok(['eth_chainId', 'eth_getCode', 'eth_call', 'eth_getBalance', 'eth_blockNumber', 'eth_gasPrice', 'eth_estimateGas', 'eth_getTransactionCount', 'eth_getBlockByNumber', 'eth_feeHistory', 'eth_maxPriorityFeePerGas'].includes(rpc.method), `Forbidden RPC ${rpc.method}`);
  const key = JSON.stringify([rpc.method, rpc.params]);
  if (!(key in fixtures)) {
    assert.ok(recording, `Missing read fixture: ${key}`);
    if (!cache.has(key)) cache.set(key, (async () => {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rpc), signal: AbortSignal.timeout(20000) });
      assert.equal(response.status, 200); const body = await response.json(); delete body.id;
      fixtures[key] = body; fs.writeFileSync(fixturePath, JSON.stringify(fixtures, null, 2) + '\n');
    })());
    await cache.get(key);
  }
  return { status: 200, body: JSON.stringify({ ...fixtures[key], id: rpc.id }), headers: { 'content-type': 'application/json' } };
};
let context;
context = vm.createContext({
  __nativeSync: (op, text) => { try { return JSON.stringify({ ok: true, value: sync(op, JSON.parse(text)) }); } catch (e) { return JSON.stringify({ ok: false, error: e.message }); } },
  __nativeAsync: (id, op, text) => {
    handle(op, JSON.parse(text)).then(value => context.__settle(id, true, JSON.stringify(value)), error => context.__settle(id, false, error.message));
  },
  __nativeTimer: (id, delay) => timers.set(id, setTimeout(() => { timers.delete(id); context.__fireTimer(id); }, delay)),
  __nativeCancelTimer: id => { clearTimeout(timers.get(id)); timers.delete(id); },
  __nativeResult: (_id, ok, text) => ok ? finish(JSON.parse(text)) : fail(new Error(text)),
});
try {
  vm.runInContext(fs.readFileSync(path.join(root, 'ios-native/Resources/WalletRuntime.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'ios-native/Resources/WalletEngine.js'), 'utf8'), context);
  vm.runInContext('Date.now = () => 1790287200000', context);
  const caps = { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 5, maxOpsPerDay: 24 };
  context.__runWallet(1, 'create', JSON.stringify({ owner: owner.address, tenant: owner.address, did: 'did:privy:ios-test', caps, extraTokens: [], autonomousTrencher: trencher }));
  const result = await complete;
  assert.equal(result.handoff.ok, true); assert.deepEqual(result.caps, caps);
  assert.equal(posted.chainId, 4663); assert.ok(posted.serialized); assert.ok(signatures >= 2);
  if (trencher) assert.equal(posted.trencherFactoryAddress, '0x32a2a19a9a0ff54ffcaeb40955fd710e77cbbbf7');
  console.log(`Native runtime prepared and verified a ${trencher ? 'Trencher' : 'standard'} test grant: ${signatures} owner signatures, ${Object.keys(fixtures).length} read-only RPC fixtures, zero real writes.`);
} finally { for (const timer of timers.values()) clearTimeout(timer); }
