import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../Resources/FeedEngine.js', import.meta.url), 'utf8'), context);
const base = { name: 'Robin', slug: 'robin', handle: null, handleVerified: false, action: 'buy', symbol: 'NVDA', sizeUsdg: 5, at: 1790287200, reason: 'Earnings support this measured entry.', paper: false, head: 'Buy NVDA', postId: 'first', outcome: 'landed', outcomeText: 'Filled', post: 'My own investment thesis.' };
const rows = [base, { ...base, postId: 'refused', outcome: 'refused', outcomeText: 'Risk limit' }, { ...base, postId: 'paper', paper: true }, { ...base, slug: 'marian', name: 'Marian', postId: 'reply', action: null, outcome: 'view', post: null, reason: 'I disagree with @robin: the margin forecast is too optimistic.' }];
const render = (extra = {}) => JSON.parse(context.NativeFeed.render(JSON.stringify({ rows, pill: 'all', counts: { first: 2 }, realOnly: false, following: [], mostLiked: false, ...extra })));
assert.deepEqual(render({ pill: 'trades' }).map(r => r.postId).sort(), ['first', 'paper']);
assert.deepEqual(render({ pill: 'debate' }).map(r => r.postId), ['reply']);
assert.equal(render({ pill: 'trades', realOnly: true }).length, 1);
assert.equal(render({ pill: 'trades' }).find(r => r.postId === 'first').post, base.post);
assert.equal(render().find(r => r.postId === 'refused').title, 'Robin tried to buy NVDA');
assert.equal(render().find(r => r.postId === 'refused').count, null);
assert.equal(render({ mostLiked: true })[0].postId, 'first');
assert.equal(render({ pill: 'following', following: ['marian'] }).length, 1);
assert.equal(render({ pill: 'debate', rows: [{ ...base, handle: 'borrowed', handleVerified: false }, { ...rows[3], reason: 'Reply to @borrowed' }] }).length, 0);
console.log('Native feed preserves real/paper and execution outcomes, verified mentions, natural posts, filtering and unknown like counts.');
const nowSec = 2_000_000;
const profile = (agent, picked = null) => JSON.parse(context.NativeFeed.profile(JSON.stringify({ agent, picked, nowSec })));
const agent = { growth: [{ at: nowSec - 90_000, g: 1 }, { at: nowSec - 3_600, g: 1.05 }], growthComplete: true, how: { kind: 'strategy', name: 'steady-basket' } };
assert.equal(profile(agent).active, 'ALL');
assert.equal(profile(agent).slice.state, 'ok');
assert.equal(profile(agent).windows.find(w => w.id === '7D').available, false);
assert.equal(profile({ ...agent, growthComplete: false }).active, '24H');
assert.equal(profile({ ...agent, growthComplete: false, growth: agent.growth.slice(1) }).slice.state, 'partial');
assert.equal(profile({ ...agent, how: null }).approach, '');
assert.equal(profile(agent, 'not-a-window').active, 'ALL');
console.log('Native profile uses evidenced chart windows, complete-period defaults and published strategy descriptions.');
const assets = (mode, customTokens = null) => JSON.parse(context.NativeFeed.assets(JSON.stringify({ mode, customTokens })));
assert.equal(assets('stocks').includes('NVDA'), true);
assert.equal(assets('crypto').includes('NVDA'), false);
assert.equal(assets('crypto', [{ symbol: 'NEON', address: '0x2222222222222222222222222222222222222222' }]).includes('NEON'), true);
assert.equal(assets('stocks', [{ symbol: 'NEON', address: '0x2222222222222222222222222222222222222222' }]).includes('NEON'), false);
console.log('Native creation keeps stock and crypto basket choices within the selected market mode.');

const command = (id, args = {}) => JSON.parse(context.NativeFeed.command(JSON.stringify({ id, args })));
assert.equal(command('run-shell', { command: 'ignored' }), null);
assert.equal(command('buy', { symbol: 'NVDA' }), null);
assert.equal(command('buy', { symbol: ['NVDA'], usdgAmount: 5 }), null);
assert.deepEqual(command('set-size', { buyPerTickUsdg: 5, liveTradingEnabled: true, sponsorGasEnabled: true }).payload, { buyPerTickUsdg: 5 });
assert.deepEqual(command('go-paper', { liveTradingEnabled: true, paperTradingEnabled: false }).payload, { paperTradingEnabled: true, liveTradingEnabled: false });
assert.deepEqual(command('go-live', { liveTradingEnabled: false }).payload, { liveTradingEnabled: true });
assert.deepEqual(command('set-basket', { basketSymbols: 'NVDA, TSLA' }).payload, { basketSymbols: ['NVDA', 'TSLA'] });
assert.deepEqual(command('buy', { symbol: 'NVDA', usdgAmount: 5, side: 'sell', owner: 'someone else' }).payload, { side: 'buy', symbol: 'NVDA', usdgAmount: 5 });
assert.equal(command('set-risk', { level: 'cautious', slippageBps: 9999 }).payload.slippageBps < 9999, true);
assert.match(command('go-paper').say, /stop managing/);
assert.match(command('sell', { symbol: 'NEON', usdgAmount: 5 }).say, /whole position/);
console.log('Native chat rejects invented/incomplete commands, strips extra fields, derives fixed consent and risk values, and preserves money warnings.');

const markets = (extra = {}) => JSON.parse(context.NativeFeed.markets(JSON.stringify({
  market: { tokens: [{ symbol: 'NVDA', name: 'Nvidia', address: '0x1111111111111111111111111111111111111111', kind: 'stock', priceUsd: 120, holders: 4 }] },
  discoveries: { rows: [{ token: '0x2222222222222222222222222222222222222222', name: 'NEON', priceUsd: 0.000012, change24hPct: 4, buyers24h: 1 }], fresh: [] },
  theses: { theses: [{ ...base, paper: false }, { ...base, postId: 'second', slug: 'other' }] }, sort: 'buys', ...extra
})));
assert.equal(markets().rows[0].symbol, 'NEON');
assert.equal(markets().rows[0].priceUsd, 0.000012);
assert.equal(markets().rows[0].buys, 1);
assert.equal(markets({ sort: 'held' }).rows[0].symbol, 'NVDA');
assert.equal(markets({ sort: 'all' }).rows.some(r => r.symbol === 'NVDA'), true);
assert.equal(markets({ theses: null, discoveries: null, market: null }).fallback, true);
assert.equal(markets({ theses: null, discoveries: null, market: null }).rows[0].priceUsd, null);
console.log('Native markets share web token joins, rank coins first, retain stocks, and leave unread prices unknown.');
