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
assert.equal(markets({ sort: 'all', theses: null }).rows.find(r => r.symbol === 'NVDA').buys, null);
assert.equal(markets({ sort: 'all', theses: null }).rows.find(r => r.symbol === 'NEON').buys, 1);
assert.equal(markets({ theses: null, discoveries: null, market: null }).fallback, true);
assert.equal(markets({ theses: null, discoveries: null, market: null }).rows[0].priceUsd, null);
console.log('Native markets share web token joins, rank coins first, retain stocks, and leave unread prices unknown.');

const now = Date.now();
const overview = feed => JSON.parse(context.NativeFeed.overview(JSON.stringify({ feed, now })));
const owned = overview({ agent: { name: 'Owner agent' }, source: 'db', positions: [
  { symbol: 'NEON', value_usdg: 6, cost_usdg: 5, cost_from_quote: false, price_stale: 0 },
  { symbol: 'MAYBE', value_usdg: 6, cost_usdg: 5, cost_from_quote: true, price_stale: 0 },
  { symbol: 'OLD', value_usdg: 6, cost_usdg: 5, cost_from_quote: false, price_stale: 1 },
], trades: ['landed', 'paper', 'submitted', 'rejected'].map(status => ({ fill_side: 'buy', symbol: 'NEON', amount_usdg: 5, status, created_at: new Date(now).toISOString() })) });
assert.equal(owned.positions[0].pnl, 20);
assert.equal(owned.positions[1].pnl, null);
assert.equal(owned.positions[2].pnl, null);
assert.equal(owned.spent, 5);
assert.equal(owned.equity, null);
assert.equal(overview({ source: 'none' }), null);
const connections = (telegram, settings) => JSON.parse(context.NativeFeed.connections(JSON.stringify({ telegram, settings })));
assert.equal(connections(null, null).telegram.kind, 'unread');
assert.equal(connections({ hasToken: true, enabled: false }, null).telegram.kind, 'off');
assert.equal(connections({ hasToken: true, enabled: true, connected: true, ownerId: null, linkCode: 'CODE', botUsername: 'bot' }, null).telegram.kind, 'unlinked');
// The states AgentConnections.swift draws beside the web strip: held, not heard (and why), and a bot another agent holds.
const bot = { hasToken: true, enabled: true, connected: true, ownerId: null, linkCode: 'CODE', botUsername: 'bot', allowlist: [] };
const held = connections({ ...bot, listening: { state: 'held', reason: 'restore error', lastOkAt: null } }, null).telegram;
assert.deepEqual([held.kind, held.reason, held.linked, held.linkCode], ['held', 'restore error', false, 'CODE']);
const deaf = connections({ ...bot, listening: { state: 'not-listening', reason: null, lastOkAt: 1 } }, null).telegram;
assert.deepEqual([deaf.kind, deaf.why, deaf.lastOkAt, deaf.linked, deaf.linkCode], ['not-listening', 'stale', 1, false, 'CODE']);
assert.equal(connections({ ...bot, listening: { state: 'conflict', reason: '409', lastOkAt: 1 } }, null).telegram.why, 'conflict');
assert.equal(connections({ ...bot, connected: false, listening: { state: 'revoked', reason: '401', lastOkAt: 1 } }, null).telegram.why, 'revoked');
assert.deepEqual(connections({ ...bot, botElsewhere: true }, null).telegram, { kind: 'elsewhere', botUsername: 'bot' });
assert.equal(connections({ ...bot, linkCode: null, linkPending: true }, null).telegram.linkPending, true);
assert.equal(connections(null, { values: { strategy: 'trencher', assetMode: 'stocks', trencherLiveEnabled: true } }).trencher.kind, 'no-crypto');
console.log('Native owner views withhold estimated/stale returns, count only landed usage, and distinguish unread connections from disabled ones.');
const resign = input => JSON.parse(context.NativeFeed.resign(JSON.stringify(input)));
assert.equal(resign({ exists: true, grantedAt: 1, canSign: true }), true);
assert.equal(resign({ exists: true, grantedAt: 4_000_000_000, canSign: true }), false);
assert.equal(resign({ exists: true, grantedAt: null, canSign: true }), false);
assert.equal(resign({ exists: null, grantedAt: 1, canSign: true }), false);
assert.equal(resign({ exists: false, grantedAt: 1, canSign: true }), false);
assert.equal(resign({ exists: true, grantedAt: 1, canSign: false }), false);
console.log('Native re-sign notice fires only for a read, signable grant that predates the bundled wall release.');
const setup = (status, paper = false) => JSON.parse(context.NativeFeed.setup(JSON.stringify({ status, paper })));
assert.equal(setup({ exists: false }), 'create');
assert.equal(setup({ exists: true }, true), 'done');
assert.equal(setup({ exists: true, balances: { ethWei: null } }), 'unread');
console.log('Native setup checklist follows the web setup step, and an unread balance is never shown as unfunded.');
const approval = view => JSON.parse(context.NativeFeed.approval(JSON.stringify(view)));
const trade = { kind: 'trade', status: 'awaiting_approval', binding: { book: 'live' }, result: null, current_book: 'live', settings_check: null };
assert.equal(approval(trade).approvable, true);
assert.equal(approval(trade).box.warn, true);
assert.match(approval(trade).box.text, /^Real money/);
assert.equal(approval({ ...trade, current_book: 'paper' }).approvable, false);
assert.equal(approval({ ...trade, binding: { book: 'paper' }, current_book: 'paper' }).box.warn, false);
assert.equal(approval({ ...trade, status: 'paper_filled' }).finished, true);
assert.equal(approval({ kind: 'settings', status: 'awaiting_approval', binding: {}, result: null, settings_check: { rows: [], changed_since: ['x'], applies_to_running_agent: true, left_out: [] } }).approvable, false);
console.log('Native approvals use the web page rules: real-money wording, mode changes and moved settings block approval.');
