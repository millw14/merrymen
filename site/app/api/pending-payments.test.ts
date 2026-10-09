/**
 * The list of payments this browser is still waiting on. Every hash in it is a
 * transfer the gateway credits only if the page goes on submitting it, so the
 * list must keep each one, per wallet, until it is answered, and survive
 * storage that is broken or missing.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { PENDING_KEY, forgetPayment, pendingPayments, rememberPayment } from '../../lib/pending-payments';

const A = '0x1111111111111111111111111111111111111111', B = '0x2222222222222222222222222222222222222222';
const H1 = '0x' + 'aa'.repeat(32), H2 = '0x' + 'bb'.repeat(32), H3 = '0x' + 'cc'.repeat(32);

/** A Map behind the Storage methods the module uses; `broken` makes every call throw, as blocked site data does. */
let items = new Map<string, string>(), broken = false;
const fake = {
  getItem: (k: string) => { if (broken) throw new Error('SecurityError'); return items.get(k) ?? null; },
  setItem: (k: string, v: string) => { if (broken) throw new Error('QuotaExceededError'); items.set(k, String(v)); },
  removeItem: (k: string) => { items.delete(k); }, clear: () => items.clear(),
};
Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true });
beforeEach(() => { items = new Map(); broken = false; });

test('every hash is kept per wallet, in the order sent, once each, until it is forgotten', () => {
  rememberPayment(A, H1); rememberPayment(A, H2); rememberPayment(B, H3);
  // The same transfer again, in another case: still one entry.
  rememberPayment(A.toUpperCase().replace('0X', '0x'), H1.toUpperCase().replace('0X', '0x'));
  assert.deepEqual(pendingPayments(A), [H1, H2]); assert.deepEqual(pendingPayments(B), [H3]);
  // A newer payment never pushes an older one out.
  forgetPayment(A, H2);
  assert.deepEqual(pendingPayments(A), [H1]); assert.deepEqual(pendingPayments(B), [H3], 'another wallet\'s payments are untouched');
  forgetPayment(A, H1.toUpperCase().replace('0X', '0x'));
  assert.deepEqual(pendingPayments(A), []);
  rememberPayment(A, 'not a hash');
  assert.deepEqual(pendingPayments(A), []);
});

test('age drops nothing: a payment saved days ago is still waiting', () => {
  items.set(PENDING_KEY, JSON.stringify([{ wallet: A, hash: H1, at: Date.now() - 30 * 86_400_000 }, { wallet: A, hash: H2, at: 0 }]));
  assert.deepEqual(pendingPayments(A), [H1, H2]);
});

test('broken, foreign or missing storage reads as empty and never throws', () => {
  for (const junk of ['{', '5', '"text"', JSON.stringify([{ wallet: A, hash: '0x12', at: 1 }, null, { wallet: A, hash: H1 }, { wallet: A, hash: H2, at: 2 }])]) {
    items.set(PENDING_KEY, junk);
    assert.deepEqual(pendingPayments(A), junk.includes(H2) ? [H2] : [], junk);
  }
  broken = true;
  assert.deepEqual(pendingPayments(A), []);
  assert.doesNotThrow(() => { rememberPayment(A, H1); forgetPayment(A, H1); });
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
  Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('denied'); }, configurable: true });
  try { assert.deepEqual(pendingPayments(A), []); assert.doesNotThrow(() => rememberPayment(A, H1)); }
  finally { Object.defineProperty(globalThis, 'localStorage', saved); }
});
