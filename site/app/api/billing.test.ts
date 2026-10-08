/**
 * The developer page's half of paid plans: what it sends, from where, and
 * what it tells the developer. The gateway decides whether a transfer counts;
 * these pin that the page can only ever build the transfer the gateway would
 * credit (signed-in wallet, Robinhood Chain, our token, the treasury, the
 * amount due rounded up), and refuses before the wallet opens otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  FALLBACK_PLANS, POLL_GIVE_UP_MS, POLL_MAX_CHECKS, ROBINHOOD_CHAIN, TOKEN, UNIT, amountToSend, balanceOfCalldata, ceilToWholeToken, chainIdOf, formatTokens, historyLabel, nextPollDelay,
  normalizeAccount, normalizePlans, normalizePreview, payEligibility, payWithWallet, paymentOutcome, paymentsReady, previewSentence, renewalBy, stillDue, stillPayable, switchToRobinhood,
  endMessage, tokensToRaw, transferCalldata, txHash, waitingMessage, walletError, watchPayment, type Eip1193,
} from '../../lib/developer-billing';

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const TREASURY = '0x3333333333333333333333333333333333333333';
const HASH = '0x' + 'ab'.repeat(32);

test('transfer calldata is transfer(address,uint256), encoded by hand exactly as viem encodes it', () => {
  // Vectors from viem's encodeFunctionData(erc20Abi, "transfer" / "balanceOf").
  assert.equal(transferCalldata('0x00000000000000000000000000000000000000AA', 100_000n * UNIT),
    '0xa9059cbb00000000000000000000000000000000000000000000000000000000000000aa00000000000000000000000000000000000000000000152d02c7e14af6800000');
  assert.equal(transferCalldata('0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF', 1n),
    '0xa9059cbb000000000000000000000000deadbeefdeadbeefdeadbeefdeadbeefdeadbeef0000000000000000000000000000000000000000000000000000000000000001');
  assert.equal(transferCalldata('0x1234567890abcdef1234567890abcdef12345678', 2n ** 256n - 1n),
    '0xa9059cbb0000000000000000000000001234567890abcdef1234567890abcdef12345678ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
  assert.equal(balanceOfCalldata(WALLET), '0x70a082310000000000000000000000001111111111111111111111111111111111111111');
  // Nobody can be credited for these, and a zero-address transfer is a burn on a lax token.
  for (const [to, amount] of [['0x0000000000000000000000000000000000000000', UNIT], [TREASURY, 0n], [TREASURY, -1n], [TREASURY, 2n ** 256n], ['0x123', UNIT], [`${TREASURY}00`, UNIT], ['', UNIT]] as const) {
    assert.throws(() => transferCalldata(to, amount), `${to} ${amount}`);
  }
});

test('amounts are exact: due is rounded up to a whole token, and nothing reads smaller than it is', () => {
  assert.equal(ceilToWholeToken(1n), UNIT);
  assert.equal(ceilToWholeToken(UNIT), UNIT);
  assert.equal(ceilToWholeToken(UNIT + 1n), 2n * UNIT);
  assert.equal(ceilToWholeToken(0n), 0n);
  assert.equal(amountToSend('63333333333333333333334'), 63_334n * UNIT);
  assert.equal(amountToSend((100_000n * UNIT).toString()), 100_000n * UNIT);
  for (const none of [null, '0', '-5', 'abc', '1.5']) assert.equal(amountToSend(none), null, String(none));
  assert.equal(formatTokens(100_000n * UNIT, { decimals: 0 }), '100,000');
  assert.equal(formatTokens('1000000000000000000000000'), '1,000,000');
  assert.equal(formatTokens(63_333_333_333_333_333_333_333n, { decimals: 2 }), '63,333.33');
  assert.equal(formatTokens(63_333_333_333_333_333_333_333n, { decimals: 0, round: 'up' }), '63,334');
  assert.equal(formatTokens(-(5n * UNIT) / 2n), '-2.5');
  assert.equal(formatTokens(1n), '<0.000001');
  assert.equal(formatTokens(1n, { decimals: 0 }), '<1');
  assert.equal(formatTokens(1n, { decimals: 0, round: 'up' }), '1');
  assert.equal(formatTokens(0n), '0');
  assert.equal(tokensToRaw('63333.5'), 63_333n * UNIT + UNIT / 2n);
  assert.equal(tokensToRaw('-12'), -12n * UNIT);
  assert.equal(tokensToRaw('0.000000000000000001'), 1n);
  for (const bad of ['1e5', '1.0000000000000000001', '', '1,000', ' ']) assert.equal(tokensToRaw(bad), null, bad);
});

test('Pay with wallet is offered only for the signed-in wallet on Robinhood Chain', () => {
  const ok: { provider: boolean; accounts: unknown; chainId: unknown; wallet: string } = { provider: true, accounts: [WALLET.toUpperCase().replace('0X', '0x')], chainId: '0x1237', wallet: WALLET };
  assert.deepEqual(payEligibility(ok), { ok: true });
  assert.deepEqual(payEligibility({ ...ok, chainId: 4663 }), { ok: true });
  const refused = (over: Partial<typeof ok>) => {
    const check = payEligibility({ ...ok, ...over });
    assert.equal(check.ok, false); return check as { reason: string; message: string };
  };
  assert.equal(refused({ provider: false }).reason, 'no_provider');
  assert.match(refused({ provider: false }).message, /paste the transaction hash/);
  assert.equal(refused({ accounts: [] }).reason, 'not_connected');
  assert.equal(refused({ accounts: null }).reason, 'not_connected');
  const mismatch = refused({ accounts: [OTHER, WALLET] });
  assert.equal(mismatch.reason, 'wrong_account');
  assert.match(mismatch.message, /0x2222…2222/); assert.match(mismatch.message, /0x1111…1111/); assert.match(mismatch.message, /cannot be credited/);
  for (const chainId of ['0x1', 1, '0xb626', null, 'robinhood', '0x']) assert.equal(refused({ chainId }).reason, 'wrong_chain', String(chainId));
  assert.equal(chainIdOf('4663'), 4663);
});

/** A scripted EIP-1193 wallet that records every request. */
function wallet(answers: Record<string, (params?: unknown[]) => unknown>) {
  const calls: { method: string; params?: unknown[] }[] = [];
  const provider: Eip1193 = { async request({ method, params }) {
    calls.push({ method, params });
    const answer = answers[method];
    if (!answer) throw Object.assign(new Error(`unexpected ${method}`), { code: -32601 });
    return answer(params);
  } };
  return { provider, calls, sent: () => calls.filter(c => c.method === 'eth_sendTransaction') };
}
const fine = { eth_accounts: () => [WALLET], eth_chainId: () => '0x1237', eth_call: () => '0x' + (200_000n * UNIT).toString(16), eth_sendTransaction: () => HASH.toUpperCase().replace('0X', '0x') };

test('a wallet payment sends our token from the signed-in wallet to the treasury, for the amount asked', async () => {
  const w = wallet(fine);
  const amount = 100_000n * UNIT;
  assert.equal(await payWithWallet({ provider: w.provider, wallet: WALLET, treasury: TREASURY, amount }), HASH);
  assert.deepEqual(w.sent()[0].params, [{ from: WALLET, to: TOKEN.address, value: '0x0', data: transferCalldata(TREASURY, amount), chainId: '0x1237' }]);
  assert.deepEqual(w.calls.find(c => c.method === 'eth_call')?.params, [{ to: TOKEN.address, data: balanceOfCalldata(WALLET) }, 'latest']);
});

test('the account and chain are read again at the click, and a mismatch sends nothing', async () => {
  // The button was drawn for the right wallet; by the click the wallet had moved on.
  for (const [method, answer] of [['eth_accounts', () => [OTHER]], ['eth_accounts', () => []], ['eth_chainId', () => '0x1']] as const) {
    const w = wallet({ ...fine, [method]: answer });
    await assert.rejects(payWithWallet({ provider: w.provider, wallet: WALLET, treasury: TREASURY, amount: UNIT }), /Switch|Connect|network/);
    assert.equal(w.sent().length, 0, method);
  }
  const poor = wallet({ ...fine, eth_call: () => '0x' + (80_000n * UNIT).toString(16) });
  await assert.rejects(payWithWallet({ provider: poor.provider, wallet: WALLET, treasury: TREASURY, amount: 100_000n * UNIT }), /holds 80,000 MERRYMEN; this payment needs 100,000/);
  assert.equal(poor.sent().length, 0);
  // A balance the wallet cannot read is the wallet's to refuse, not a reason to block.
  const blind = wallet({ ...fine, eth_call: () => { throw new Error('unsupported'); } });
  assert.equal(await payWithWallet({ provider: blind.provider, wallet: WALLET, treasury: TREASURY, amount: UNIT }), HASH);
  const odd = wallet({ ...fine, eth_sendTransaction: () => ({ hash: HASH }) });
  await assert.rejects(payWithWallet({ provider: odd.provider, wallet: WALLET, treasury: TREASURY, amount: UNIT }), /paste the hash/);
  // A send that fails may still have gone out: the page never says "nothing was sent" for it, and never says "try again".
  for (const error of [{ code: -32603, message: 'Internal JSON-RPC error.' }, new Error('Request expired (WalletConnect relay)'), { code: -32000, message: 'timeout' }]) {
    const w = wallet({ ...fine, eth_sendTransaction: () => { throw error; } });
    const said = await payWithWallet({ provider: w.provider, wallet: WALLET, treasury: TREASURY, amount: UNIT }).then(() => 'sent', walletError);
    assert.match(said, /cannot tell whether the payment was sent.*paste its hash below instead of paying again/, JSON.stringify(error)); assert.doesNotMatch(said, /Nothing was sent|try again/i);
  }
  // A refusal before signing is known: nothing left the wallet.
  for (const [code, words] of [[4001, /You cancelled/], [-32002, /already waiting/], [4100, /not connected this page/]] as const) {
    const w = wallet({ ...fine, eth_sendTransaction: () => { throw Object.assign(new Error('no'), { code }); } });
    assert.match(await payWithWallet({ provider: w.provider, wallet: WALLET, treasury: TREASURY, amount: UNIT }).then(() => 'sent', walletError), words, String(code));
  }
  // A treasury the page should never have been given stops before the wallet is asked anything.
  const none = wallet(fine);
  await assert.rejects(payWithWallet({ provider: none.provider, wallet: WALLET, treasury: '0x0000000000000000000000000000000000000000', amount: UNIT }));
  assert.deepEqual(none.calls, []);
});

test('switching network adds Robinhood Chain when the wallet lacks it, and reads the chain back', async () => {
  let chain = '0x1';
  const switches = wallet({ wallet_switchEthereumChain: () => { chain = '0x1237'; return null; }, eth_chainId: () => chain });
  await switchToRobinhood(switches.provider);
  assert.deepEqual(switches.calls[0], { method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1237' }] });
  chain = '0x1';
  const unknown = wallet({ wallet_switchEthereumChain: () => { throw Object.assign(new Error('Unrecognized chain'), { code: 4902 }); }, wallet_addEthereumChain: () => { chain = '0x1237'; return null; }, eth_chainId: () => chain });
  await switchToRobinhood(unknown.provider);
  assert.deepEqual(unknown.calls[1], { method: 'wallet_addEthereumChain', params: [ROBINHOOD_CHAIN] });
  // MetaMask mobile wraps the code.
  chain = '0x1';
  const wrapped = wallet({ wallet_switchEthereumChain: () => { throw { code: -32603, data: { originalError: { code: 4902 } } }; }, wallet_addEthereumChain: () => { chain = '0x1237'; return null; }, eth_chainId: () => chain });
  await switchToRobinhood(wrapped.provider);
  chain = '0x1';
  const stubborn = wallet({ wallet_switchEthereumChain: () => null, eth_chainId: () => chain });
  await assert.rejects(switchToRobinhood(stubborn.provider), /still on another network/);
  const declined = wallet({ wallet_switchEthereumChain: () => { throw Object.assign(new Error('User rejected'), { code: 4001 }); } });
  await assert.rejects(switchToRobinhood(declined.provider), (e: unknown) => walletError(e) === 'You cancelled in your wallet.');
  assert.equal(walletError({ code: -32002 }), 'Open your wallet: a request is already waiting there.');
  assert.match(walletError(new Error('internal RPC https://secret.example failed')), /Nothing was sent/);
});

test('the chain parameters and token the page uses match packages/core', () => {
  const chain = readFileSync(new URL('../../../packages/core/src/chain.ts', import.meta.url), 'utf8');
  const mainnet = chain.slice(chain.indexOf('export const robinhoodChain'), chain.indexOf('export const robinhoodTestnet'));
  assert.match(mainnet, /id: 4663/);
  assert.equal(ROBINHOOD_CHAIN.chainId, '0x1237');
  assert.ok(mainnet.includes(`"${ROBINHOOD_CHAIN.rpcUrls[0]}"`)); assert.ok(mainnet.includes(`"${ROBINHOOD_CHAIN.blockExplorerUrls[0]}"`));
  assert.match(mainnet, /nativeCurrency: \{ name: "Ether", symbol: "ETH", decimals: 18 \}/);
  const token = readFileSync(new URL('../../../packages/core/src/token.ts', import.meta.url), 'utf8');
  assert.ok(token.includes(`address: "${TOKEN.address}"`)); assert.match(token, /decimals: 18,\n  chainId: 4663/);
});

test('the static plans table matches the gateway\'s, when that file is here', async (t) => {
  const path = new URL('../../../gateway/lib/billing-plans.mjs', import.meta.url);
  if (!existsSync(path)) return t.skip('gateway/lib/billing-plans.mjs is not on this branch');
  // Imported and compared whole, not searched as text, where "50000" is found inside "250000".
  // The specifier is a variable, so the site's own type check never resolves a gateway file.
  const { PLANS } = await import(path.href) as { PLANS: Record<string, { id: string; name: string; price_raw: bigint; requests: number; rpm: number }> };
  const gateway = Object.values(PLANS).map(p => ({ id: p.id, name: p.name, price_raw: p.price_raw.toString(), requests: p.requests, rpm: p.rpm }));
  assert.deepEqual(gateway, FALLBACK_PLANS.plans);
});

const livePlans = (over: Record<string, unknown> = {}) => ({
  billing: { mode: 'enforce', enforced: true }, period_days: 30, treasury: TREASURY.toUpperCase().replace('0X', '0x'),
  currency: { symbol: 'MERRYMEN', address: TOKEN.address.toUpperCase().replace('0X', '0x'), chain_id: 4663, decimals: 18, explorer_url: 'javascript:alert(1)' },
  confirmations: { blocks: 64, min_age_sec: 120 },
  plans: FALLBACK_PLANS.plans.map(p => ({ id: p.id, name: p.name, price_tokens: String(BigInt(p.price_raw) / UNIT), price_raw: p.price_raw, requests: p.requests, rpm: p.rpm })),
  ...over,
});

test('payments are offered only with billing on, a real treasury and our own token', () => {
  const view = normalizePlans(livePlans())!;
  assert.equal(view.treasury, TREASURY); assert.equal(view.currency_ok, true); assert.equal(paymentsReady(view), true);
  assert.deepEqual(view.plans, FALLBACK_PLANS.plans);
  assert.equal(paymentsReady(normalizePlans(livePlans({ billing: { mode: 'observe', enforced: false } }))!), true);
  assert.equal(paymentsReady(normalizePlans(livePlans({ billing: { mode: 'off', enforced: false } }))!), false);
  for (const treasury of [null, '0x0000000000000000000000000000000000000000', '0x123', 42]) {
    const v = normalizePlans(livePlans({ treasury }))!;
    assert.equal(v.treasury, null); assert.equal(paymentsReady(v), false, String(treasury));
  }
  for (const currency of [{ address: OTHER, chain_id: 4663, decimals: 18 }, { address: TOKEN.address, chain_id: 1, decimals: 18 }, { address: TOKEN.address, chain_id: 4663, decimals: 6 }, null]) {
    assert.equal(paymentsReady(normalizePlans(livePlans({ currency }))!), false, JSON.stringify(currency));
  }
  // The table this site wrote itself never pays anyone, whatever else it says.
  assert.equal(paymentsReady(FALLBACK_PLANS), false); assert.equal(FALLBACK_PLANS.treasury, null);
  assert.equal(paymentsReady({ ...view, source: 'fallback' }), false);
  for (const broken of [null, [], { plans: [] }, livePlans({ billing: { mode: 'on' } }), livePlans({ plans: [{ id: 'x', price_raw: '-1', requests: 1, rpm: 1 }] }), livePlans({ plans: [{ id: 'Bad Id', price_raw: '1', requests: 1, rpm: 1 }] })]) {
    assert.equal(normalizePlans(broken), null, JSON.stringify(broken));
  }
  // An enforced flag without enforce mode is not believed.
  assert.equal(normalizePlans(livePlans({ billing: { mode: 'observe', enforced: true } }))!.billing.enforced, false);
});

test('a wallet payment goes ahead only if a fresh read still names the same treasury', () => {
  assert.equal(stillPayable(livePlans(), TREASURY).ok, true);
  assert.equal(stillPayable(livePlans(), TREASURY.toUpperCase().replace('0X', '0x')).ok, true);
  const rotated = stillPayable(livePlans({ treasury: OTHER }), TREASURY);
  assert.equal(rotated.ok, false); assert.equal(rotated.plans?.treasury, OTHER, 'the new details come back to show');
  assert.match(!rotated.ok ? rotated.message : '', /payments wallet changed since this page loaded, so nothing was sent/);
  for (const closed of [livePlans({ billing: { mode: 'off', enforced: false } }), livePlans({ treasury: null }), livePlans({ currency: null })]) {
    const answer = stillPayable(closed, TREASURY);
    assert.equal(answer.ok, false); assert.match(!answer.ok ? answer.message : '', /paused just now, so nothing was sent/);
  }
  for (const unreadable of [null, {}, 'Bad gateway']) {
    const answer = stillPayable(unreadable, TREASURY);
    assert.equal(answer.ok, false); assert.equal(answer.plans, null); assert.match(!answer.ok ? answer.message : '', /could not be confirmed/);
  }
});

const account = (over: Record<string, unknown> = {}) => ({
  account: { id: 'acct_1', name: 'Prism', wallet: WALLET, created_at: '2026-10-01T00:00:00.000Z' },
  plan: { id: 'free', name: 'Free', starts_at: null, ends_at: null, selected: 'crumbs', renews_on_next_request: false },
  credit_raw: (60_000n * UNIT).toString(), credit_tokens: '60000', due_raw: (40_000n * UNIT).toString(), due_tokens: '40000',
  usage: { used: 12, limit: 1000, resets_at: '2026-10-31T00:00:00.000Z', by_key: [{ key_id: 'k1', used: 12 }, { key_id: 7 }] },
  history: [{ type: 'payment', at: '2026-10-02T00:00:00.000Z', amount_tokens: '60000', tx_hash: HASH.toUpperCase().replace('0X', '0x') }, { type: 'refund', at: '2026-10-02T00:00:00.000Z', amount_tokens: '1' }],
  ...over,
});

test('the account view keeps exact amounts and drops what it cannot read', () => {
  const view = normalizeAccount(account())!;
  assert.equal(view.due_raw, (40_000n * UNIT).toString()); assert.equal(view.credit_raw, (60_000n * UNIT).toString());
  assert.deepEqual(view.usage?.by_key, [{ key_id: 'k1', used: 12 }]);
  assert.deepEqual(view.history.map(h => [h.type, h.tx_hash]), [['payment', HASH]]);
  assert.equal(normalizeAccount(account({ due_raw: null, due_tokens: null }))!.due_raw, null);
  assert.equal(normalizeAccount(account({ due_raw: '0' }))!.due_raw, null);
  assert.equal(normalizeAccount(account({ due_raw: undefined, due_tokens: '40000' }))!.due_raw, (40_000n * UNIT).toString());
  assert.equal(normalizeAccount(account({ credit_raw: '-5000000000000000000' }))!.credit_raw, '-5000000000000000000');
  assert.equal(normalizeAccount(account({ usage: undefined }))!.usage, null);
  // What the amount due is for, as the gateway says; nothing due is due for nothing.
  for (const [due_for, expected] of [['renewal', 'renewal'], ['upgrade', 'upgrade'], ['activation', 'activation'], ['later', null], [undefined, null]] as const) {
    assert.equal(normalizeAccount(account({ due_for }))!.due_for, expected, String(due_for));
  }
  assert.equal(normalizeAccount(account({ due_for: 'renewal', due_raw: null, due_tokens: null }))!.due_for, null);
  // Only a renewal of a plan still running waits for the period's end; on Free (lapsed), or for anything else, it is due now.
  const running = { id: 'crumbs', name: 'Crumbs', starts_at: '2026-10-01T00:00:00.000Z', ends_at: '2026-10-31T00:00:00.000Z', selected: 'crumbs' };
  assert.equal(renewalBy(normalizeAccount(account({ plan: running, due_for: 'renewal' }))!), '2026-10-31T00:00:00.000Z');
  assert.equal(renewalBy(normalizeAccount(account({ plan: running, due_for: 'upgrade' }))!), null);
  assert.equal(renewalBy(normalizeAccount(account({ due_for: 'renewal' }))!), null, 'lapsed to Free');
  assert.equal(renewalBy(normalizeAccount(account({ plan: running, due_for: 'renewal', due_raw: null, due_tokens: null }))!), null);
  assert.equal(normalizeAccount({ ...account(), account: { id: 'acct_1', wallet: 'nope' } }), null);
  // Names come from whoever made the account: right-to-left overrides and zero-width characters are dropped, so one cannot pass for another.
  assert.equal(normalizeAccount(account({ account: { id: 'acct_1', name: 'Pri\u202esm\u200b\u0007', wallet: WALLET } }))!.account.name, 'Prism');
  // One from each invisible range the gateway's name rule still lets through.
  for (const c of ['\u061c', '\u180e', '\u200b', '\u200f', '\u202a', '\u202e', '\u2060', '\u2064', '\u2066', '\u2069', '\ufeff']) {
    assert.equal(normalizeAccount(account({ account: { id: 'acct_1', name: `Pr${c}ism`, wallet: WALLET } }))!.account.name, 'Prism', c.codePointAt(0)!.toString(16));
  }
});

test('a wallet payment goes ahead only if a fresh read of the account still asks for what the page shows', () => {
  const shown = normalizeAccount(account({ due_for: 'activation' }))!;
  const fresh = (over: Record<string, unknown>) => stillDue(account({ due_for: 'activation', ...over }), shown);
  const refused = (answer: ReturnType<typeof stillDue>) => answer.ok ? '' : answer.message;
  /** The account a refusal hands back to show, if any. */
  const back = (answer: ReturnType<typeof stillDue>) => answer.ok ? undefined : answer.account;
  assert.equal(stillDue(account({ due_for: 'activation' }), shown).ok, true);
  // Usage and history move all the time and say nothing about what is due.
  assert.equal(fresh({ usage: { used: 900, limit: 1000, resets_at: null, by_key: [] }, history: [] }).ok, true);
  const running = { id: 'crumbs', name: 'Crumbs', starts_at: '2026-10-08T00:00:00.000Z', ends_at: '2026-11-07T00:00:00.000Z', selected: 'crumbs' };
  for (const [why, over] of [
    // Paid from a phone: the same 40,000 is now the next period's renewal, 30 days early.
    ['activated elsewhere', { plan: running, credit_raw: '0', credit_tokens: '0', due_for: 'renewal' }],
    ['framing alone', { due_for: 'upgrade' }],
    ['another plan chosen', { plan: { id: 'free', name: 'Free', starts_at: null, ends_at: null, selected: 'loaf' }, due_raw: (340_000n * UNIT).toString() }],
    ['part paid elsewhere', { credit_raw: (70_000n * UNIT).toString(), due_raw: (30_000n * UNIT).toString() }],
    // Same amount, but a payment and an operator debit moved the credit: the account is not as the page drew it.
    ['credit moved, amount not', { credit_raw: (61_000n * UNIT).toString() }],
    ['the price was edited', { due_raw: (41_000n * UNIT).toString() }],
  ] as const) {
    const answer = fresh(over);
    assert.equal(answer.ok, false, why); assert.match(refused(answer), /What is due changed since this page loaded, so nothing was sent/, why);
    assert.equal(back(answer)?.account.id, 'acct_1', `${why}: the fresh account comes back to show`);
  }
  const paid = fresh({ credit_raw: (100_000n * UNIT).toString(), due_raw: null, due_tokens: null });
  assert.equal(paid.ok, false); assert.match(refused(paid), /Nothing is due now/); assert.equal(back(paid)?.due_raw, null);
  // Another tab of this browser signed in with another wallet: its account is not shown in this one.
  const other = stillDue(account({ due_for: 'activation', account: { id: 'acct_2', name: 'Other', wallet: OTHER } }), shown);
  assert.equal(other.ok, false); assert.equal(back(other), null); assert.match(refused(other), /signed in with another wallet, so nothing was sent/);
  for (const unreadable of [null, {}, 'Bad gateway', { error: { code: 'account_missing' } }]) {
    const answer = stillDue(unreadable, shown);
    assert.equal(answer.ok, false); assert.equal(back(answer), null); assert.match(refused(answer), /could not be read just now, so nothing was sent/);
  }
  // An upgrade costs less as its period runs out, by the second: the amount on the button still covers it, so a
  // small fall is paid as shown instead of refusing every click. A fall past 1%, a rise, or any other change refuses.
  const upgrade = (due: bigint, over: Record<string, unknown> = {}) => account({ plan: running, credit_raw: '0', credit_tokens: '0', due_raw: due.toString(), due_for: 'upgrade', ...over });
  const quoted = normalizeAccount(upgrade(200_000n * UNIT))!;
  assert.equal(stillDue(upgrade(199_990n * UNIT + 5n), quoted).ok, true, 'rounds up to 199,991');
  assert.equal(stillDue(upgrade(198_000n * UNIT), quoted).ok, true, 'exactly 1%');
  assert.equal(stillDue(upgrade(197_999n * UNIT), quoted).ok, false, 'past 1%');
  assert.equal(stillDue(upgrade(200_001n * UNIT), quoted).ok, false, 'never more than shown');
  assert.equal(stillDue(upgrade(199_990n * UNIT, { credit_raw: '1', credit_tokens: undefined }), quoted).ok, false, 'credit moved');
  // Only an upgrade falls with time: an activation or renewal that costs less was changed by something.
  const renewal = (due: bigint) => account({ plan: running, credit_raw: '0', credit_tokens: '0', due_raw: due.toString(), due_for: 'renewal' });
  assert.equal(stillDue(renewal(99_990n * UNIT), normalizeAccount(renewal(100_000n * UNIT))!).ok, false);
});

test('history is newest first whatever order it arrives in, and a long one keeps its latest 50', () => {
  const day = (d: number) => new Date(Date.UTC(2026, 9, d)).toISOString();
  const payment = { type: 'payment', at: day(1), amount_tokens: '100000', tx_hash: HASH };
  const activate = { type: 'charge', at: day(5), amount_tokens: '100000', tier: 'crumbs', reason: 'activate' };
  // The gateway sends newest first; an older one sent oldest first. Both read the same.
  for (const history of [[activate, payment], [payment, activate]]) {
    assert.deepEqual(normalizeAccount(account({ history }))!.history.map(h => h.at), [day(5), day(1)]);
  }
  const many = Array.from({ length: 60 }, (_, i) => ({ type: 'adjustment', at: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(), amount_tokens: String(i) }));
  for (const history of [many, [...many].reverse()]) {
    const kept = normalizeAccount(account({ history }))!.history;
    assert.equal(kept.length, 50); assert.equal(kept[0].amount_raw, (59n * UNIT).toString()); assert.equal(kept[49].amount_raw, (10n * UNIT).toString());
  }
});

test('a plan preview says what confirming does, in whole tokens', () => {
  const loaf = FALLBACK_PLANS.plans[2];
  const p = (body: Record<string, unknown>) => normalizePreview({ charge_now_raw: '0', due_raw: null, starts_at: null, ends_at: '2026-11-07T12:00:00.000Z', ...body })!;
  assert.match(previewSentence(p({ effect: 'activate_now', charge_now_raw: (400_000n * UNIT).toString() }), loaf, 'Free'), /^Loaf starts now and runs until 7 Nov 2026\. 400,000 MERRYMEN comes out of your credit\.$/);
  assert.match(previewSentence(p({ effect: 'upgrade_now', charge_now_raw: '150000000000000000000000' }), loaf, 'Crumbs'), /150,000 MERRYMEN comes out of your credit, and the requests you have used so far carry over/);
  assert.match(previewSentence(p({ effect: 'waiting_for_payment', due_raw: '340000000000000000000001' }), loaf, 'Free'), /as soon as 340,001 MERRYMEN arrives/);
  assert.match(previewSentence(p({ effect: 'at_renewal', starts_at: '2026-11-07T12:00:00.000Z' }), FALLBACK_PLANS.plans[1], 'Loaf'), /Crumbs takes over when Loaf ends on 7 Nov 2026\. Nothing is charged now\./);
  assert.match(previewSentence(p({ effect: 'cancel_renewal' }), FALLBACK_PLANS.plans[0], 'Loaf'), /then your account moves to Free\. Nothing is charged\./);
  assert.equal(normalizePreview({ effect: 'charge_everything' }), null);
  // Back to Free while on Free with Crumbs waiting for payment: the gateway answers activate_now, no charge, no end.
  const back = p({ effect: 'activate_now', ends_at: null, starts_at: '2026-10-08T00:00:00.000Z' });
  assert.equal(previewSentence(back, FALLBACK_PLANS.plans[0], 'Free', 'Crumbs'), 'Your account stays on Free and the pending Crumbs selection is dropped. Nothing is charged.');
  assert.equal(previewSentence(back, FALLBACK_PLANS.plans[0], 'Free'), 'Your account stays on Free. Nothing is charged.');
  // No end date, no dangling "runs"; no charge, no "0 MERRYMEN comes out".
  assert.equal(previewSentence(p({ effect: 'activate_now', ends_at: null }), loaf, 'Free'), 'Loaf starts now. Nothing is charged.');
  for (const sentence of [previewSentence(back, FALLBACK_PLANS.plans[0], 'Free', 'Crumbs'), previewSentence(p({ effect: 'upgrade_now' }), loaf, 'Crumbs')]) assert.doesNotMatch(sentence, /\b0 MERRYMEN|runs\./);
});

test('a payment check is read as credited, still pending, worth retrying, or refused with its reason', () => {
  assert.deepEqual(paymentOutcome(202, { error: { code: 'payment_pending', stage: 'not_found_yet' } }), { kind: 'pending', stage: 'not_found_yet', readyInSec: null, retryAfterSec: null });
  assert.deepEqual(paymentOutcome(202, { code: 'payment_pending', stage: 'confirming', ready_in_sec: 75, retry_after: 5 }), { kind: 'pending', stage: 'confirming', readyInSec: 75, retryAfterSec: 5 });
  const credited = paymentOutcome(200, { already: true, ...account({ due_raw: null }) });
  assert.equal(credited.kind, 'credited'); assert.equal(credited.kind === 'credited' && credited.already, true);
  assert.equal(credited.kind === 'credited' && credited.account?.account.id, 'acct_1');
  assert.deepEqual(paymentOutcome(422, { error: { code: 'payment_not_found', reason: 'wrong_sender', message: 'Sent from 0x2222…' } }), { kind: 'failed', code: 'payment_not_found', reason: 'wrong_sender', message: 'Sent from 0x2222…' });
  assert.equal(paymentOutcome(422, { error: { code: 'payment_failed', message: 'Reverted' } }).kind, 'failed');
  assert.equal(paymentOutcome(422, { error: { code: 'payment_too_small', message: 'Too small' } }).kind, 'failed');
  for (const status of [429, 500, 503, 0]) assert.equal(paymentOutcome(status, { error: { code: 'chain_unavailable' } }).kind, 'retry', String(status));
  assert.deepEqual(paymentOutcome(401, { error: { code: 'signed_out' } }), { kind: 'signed_out' });
  assert.equal(paymentOutcome(400, { error: { code: 'invalid_tx_hash', message: 'Paste the transaction hash' } }).kind, 'failed');
  assert.equal(paymentOutcome(422, { error: { code: 'payment_unsupported' } }).kind, 'failed');
  // Refusals of the CHECK, not of the transfer: a rotated portal secret, a gateway rolled back to one without
  // the route, a missing account, this site's own 403. None of them may end the wait as "not credited".
  for (const [status, body] of [[401, { error: { code: 'unauthorized_portal', message: 'Unauthorized portal' } }], [404, { error: { code: 'not_found', message: 'Not found' } }],
    [404, { error: { code: 'account_missing', message: 'Create your developer account first.' } }], [403, { error: { message: 'Open the developer page to perform this action.' } }],
    [400, { error: { code: 'bad_request', message: 'Invalid request' } }], [409, {}], [413, { error: { message: 'Request too large' } }]] as const) {
    assert.equal(paymentOutcome(status, body).kind, 'unchecked', `${status} ${JSON.stringify(body)}`);
  }
});

test('payment checks start at six seconds and back off to thirty, honouring a longer retry_after', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 20].map(a => nextPollDelay(a)), [6000, 6000, 6000, 9000, 13500, 20250, 30000, 30000]);
  assert.equal(nextPollDelay(0, 20), 20_000);
  assert.equal(nextPollDelay(5, 5), 20_250);
  assert.equal(nextPollDelay(0, 600), 60_000);
  // Thirty checks a minute is the gateway's limit per wallet; the page never comes close.
  assert.ok(60_000 / nextPollDelay(0) <= 10);
});

/** A gateway that answers POST /payments from a script, and a clock that only moves when the page waits. */
function scripted(answers: { status: number; data: unknown }[], { leaveAfterChecks = Infinity, leaveDuringWait = Infinity } = {}) {
  let clock = 0, checks = 0, left = false;
  const hashes: string[] = [], waits: number[] = [], waiting: string[] = [];
  const run = watchPayment(HASH, {
    check: async hash => { hashes.push(hash); const answer = answers[Math.min(checks, answers.length - 1)]; checks++; if (answer.status < 0) throw new TypeError('fetch failed'); return answer; },
    // A loop that never ends would hang the suite rather than fail it.
    wait: async ms => { waits.push(ms); clock += ms; if (waits.length > 500) throw new Error('still polling after 500 waits'); if (waits.length >= leaveDuringWait) left = true; },
    now: () => clock, cancelled: () => left || checks >= leaveAfterChecks, onWaiting: outcome => waiting.push(waitingMessage(outcome)),
  });
  return { run, hashes, waits, waiting, checks: () => checks };
}
const pendingAnswer = (stage = 'confirming', extra: Record<string, unknown> = {}) => ({ status: 202, data: { error: { code: 'payment_pending', stage, ...extra } } });

test('a submitted hash is checked until the gateway credits it, backing off and saying what it waits for', async () => {
  const credited = { status: 200, data: { already: false, ...account({ due_raw: null }) } };
  const s = scripted([pendingAnswer('not_found_yet'), pendingAnswer('confirming', { ready_in_sec: 90 }), { status: 503, data: { error: { code: 'chain_unavailable' } } }, { status: -1, data: null }, pendingAnswer('confirming', { retry_after: 20 }), credited]);
  const end = await s.run;
  assert.equal(end.kind, 'credited'); assert.equal(end.kind === 'credited' && end.account?.account.id, 'acct_1');
  assert.deepEqual(s.hashes, Array(6).fill(HASH));
  assert.deepEqual(s.waits, [6000, 6000, 6000, 9000, 20_000]);
  assert.deepEqual(s.waiting, ['Waiting for Robinhood Chain to include your transaction…', 'Confirming on Robinhood Chain (about 2 min)…',
    'The payment check is busy. Trying again shortly…', 'The payment check is busy. Trying again shortly…', 'Confirming on Robinhood Chain (about 2 min)…']);
  assert.equal(endMessage(end as Parameters<typeof endMessage>[0], WALLET), 'Payment credited.');
  assert.equal(endMessage({ kind: 'credited', already: true, account: null }, WALLET), 'This payment was already credited.');
});

test('a refusal stops the checks at once, with the gateway\'s words, or the remedy when it sent none', async () => {
  // The gateway's own wrong_sender message already says what to do; the page does not say it again.
  const said = 'This transfer was not sent from your signed-in wallet 0x1111…1111. Only $MERRYMEN sent from 0x1111…1111 is credited to this account; a transfer from another wallet is credited by signing in with that wallet and submitting the hash there.';
  const s = scripted([pendingAnswer(), { status: 422, data: { error: { code: 'payment_not_found', reason: 'wrong_sender', message: said } } }, pendingAnswer()]);
  const end = await s.run;
  assert.equal(end.kind, 'failed'); assert.equal(s.checks(), 2); assert.deepEqual(s.waits, [6000]);
  assert.equal(endMessage(end as Parameters<typeof endMessage>[0], WALLET), said);
  const bare = (reason: string | null) => endMessage({ kind: 'failed', code: 'payment_not_found', reason, message: '' }, WALLET);
  assert.equal(bare('wrong_sender'), 'Only transfers from 0x1111…1111 count for this account. If you sent it from another wallet, sign in with that wallet, create its account and submit this hash there.');
  assert.equal(bare('wrong_recipient'), 'This transfer did not go to the Merrymen payments wallet shown here.');
  assert.equal(bare(null), 'This transaction cannot be credited.');
  assert.equal(endMessage({ kind: 'failed', code: 'payment_not_found', reason: 'wrong_recipient', message: 'This transfer did not go to the Merrymen payments wallet 0x3333.' }, WALLET), 'This transfer did not go to the Merrymen payments wallet 0x3333.');
  const out = await scripted([{ status: 401, data: { error: { code: 'signed_out' } } }]).run;
  assert.deepEqual(out, { kind: 'signed_out' });
});

test('a refused check ends at once as stalled, keeping the transfer\'s chance, and a pause reads as one', async () => {
  for (const answer of [{ status: 404, data: { error: { code: 'not_found', message: 'Not found' } } }, { status: 401, data: { error: { code: 'unauthorized_portal', message: 'Unauthorized portal' } } }]) {
    const s = scripted([pendingAnswer('not_found_yet'), answer, pendingAnswer()]);
    const end = await s.run;
    assert.deepEqual(end, { kind: 'stalled', stage: 'not_found_yet', message: answer.data.error.message }); assert.equal(s.checks(), 2);
    const said = endMessage(end as Parameters<typeof endMessage>[0], WALLET);
    assert.match(said, /could not be checked just now \((Not found|Unauthorized portal)\)\. It is saved here: check again later/); assert.doesNotMatch(said, /not credited|cannot be credited/i);
  }
  const paused = scripted([{ status: 503, data: { error: { code: 'payments_unavailable', message: 'Payments are temporarily unavailable.' } } }, { status: 503, data: { error: { code: 'billing_off' } } }, { status: 200, data: account({ due_raw: null }) }]);
  assert.equal((await paused.run).kind, 'credited');
  assert.deepEqual(paused.waiting, Array(2).fill('Payments are paused on our side just now. This payment is saved; checking again shortly…'));
});

test('checks give up after ten minutes with the next step, and stop when the page moves on', async () => {
  const lost = scripted([pendingAnswer('not_found_yet')]);
  const end = await lost.run;
  assert.deepEqual(end, { kind: 'stalled', stage: 'not_found_yet' });
  assert.ok(lost.waits.reduce((a, b) => a + b, 0) >= 10 * 60_000); assert.ok(lost.checks() < 30, `${lost.checks()} checks in ten minutes`);
  assert.match(endMessage(end as Parameters<typeof endMessage>[0], WALLET), /can't find this transaction on Robinhood Chain\. If you sped it up or cancelled it/);
  assert.match(endMessage({ kind: 'stalled', stage: 'confirming' }, WALLET), /Still not credited/);
  // Leaving while an answer is on its way ignores it; leaving during a wait sends nothing more.
  const answered = scripted([pendingAnswer()], { leaveAfterChecks: 2 });
  assert.deepEqual(await answered.run, { kind: 'cancelled' }); assert.equal(answered.checks(), 2);
  const waiting = scripted([pendingAnswer()], { leaveDuringWait: 2 });
  assert.deepEqual(await waiting.run, { kind: 'cancelled' }); assert.equal(waiting.checks(), 2);
});

test('checks also stop after a fixed count, so a clock that never moves cannot keep them going', async () => {
  // Waits that return at once and a clock that stands still, as a page's timers fired early or a
  // test's fast-forward makes them: only the count can end these.
  for (const answer of [pendingAnswer('confirming'), { status: 503, data: { error: { code: 'chain_unavailable' } } }, { status: -1, data: null }]) {
    let checks = 0, waits = 0;
    const end = await watchPayment(HASH, {
      // Credited on the 1000th check, so a loop without the count fails this test instead of hanging the suite.
      check: async () => { checks++; if (checks >= 1000) return { status: 200, data: account({ due_raw: null }) }; if (answer.status < 0) throw new TypeError('fetch failed'); return answer; },
      wait: async () => { waits++; }, now: () => 0, cancelled: () => false, onWaiting: () => {},
    });
    assert.deepEqual(end, { kind: 'stalled', stage: answer.status === 202 ? 'confirming' : '' }, String(answer.status));
    assert.equal(checks, POLL_MAX_CHECKS); assert.equal(waits, POLL_MAX_CHECKS - 1, 'no wait after the last check');
  }
  // It ends where a person can act: still saved, and a button to check again.
  assert.match(endMessage({ kind: 'stalled', stage: 'confirming' }, WALLET), /^Still not credited\. Check again in a minute/);
  // The count never cuts a real wait short: ten minutes of backoff is fewer checks.
  let elapsed = 0, attempt = 0;
  while (elapsed < POLL_GIVE_UP_MS && attempt < 1000) elapsed += nextPollDelay(attempt++);
  assert.ok(attempt + 1 < POLL_MAX_CHECKS, `${attempt + 1} checks in ten minutes`);
  // And it is small: a runaway clock costs at most this many requests per payment.
  assert.ok(POLL_MAX_CHECKS <= 40, `${POLL_MAX_CHECKS} checks`);
});

test('history never promises tokens back', () => {
  const plans = FALLBACK_PLANS.plans;
  const at = '2026-10-01T00:00:00.000Z';
  const labels = [
    historyLabel({ type: 'payment', at, amount_raw: '1', tier: null, tx_hash: HASH, reason: null }, plans),
    historyLabel({ type: 'reversal', at, amount_raw: '1', tier: null, tx_hash: null, reason: null }, plans),
    historyLabel({ type: 'adjustment', at, amount_raw: '-1', tier: null, tx_hash: null, reason: null }, plans),
    historyLabel({ type: 'charge', at, amount_raw: '1', tier: 'loaf', tx_hash: null, reason: 'upgrade' }, plans),
    historyLabel({ type: 'charge', at, amount_raw: '0', tier: 'feast', tx_hash: null, reason: 'comp' }, plans),
  ];
  assert.deepEqual(labels, ['Payment received', 'Payment reversed by the chain', 'Adjustment by Merrymen', 'Upgrade to Loaf', 'Feast from Merrymen']);
  for (const l of labels) assert.doesNotMatch(l, /refund|burn/i);
  assert.equal(txHash(` ${HASH.toUpperCase().replace('0X', '0x')} `), HASH);
  assert.equal(txHash('0x1234'), null);
});
