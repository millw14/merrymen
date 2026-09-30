import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { hashMessage, keccak256, toHex, recoverTypedDataAddress } from 'viem';

// Intentionally no TextEncoder, network, storage or native host in this realm.
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../Resources/WalletCryptography.js', import.meta.url), 'utf8'), context);
const crypto = context.WalletCryptography;
const key = '0x' + '01'.repeat(32); // Deterministic public test key; never funded.
const account = privateKeyToAccount(key);
assert.equal(crypto.address({ key }), account.address.toLowerCase());
assert.throws(() => crypto.address({ key: '0x' + '00'.repeat(32) }));
assert.throws(() => crypto.address({ key: '0x' + 'ff'.repeat(32) }));
assert.throws(() => crypto.address({ key: key.slice(2) }));
for (const message of ['Merrymen recovery', '中文 · Español · 한국어 · 🌱', '\ud800']) {
  const hex = toHex(message);
  const signature = crypto.signMessage({ key, hex });
  assert.equal(signature, await account.signMessage({ message: { raw: hex } }));
  assert.equal(crypto.recoverAddress({ hex, signature }), account.address.toLowerCase());
  assert.notEqual(crypto.recoverAddress({ hex: toHex(message + ' changed'), signature }), account.address.toLowerCase());
  assert.equal(crypto.keccak({ hex }), keccak256(hex));
  const pub = crypto.recoverPublicKey({ digest: hashMessage({ raw: hex }), r: signature.slice(0,66), s: '0x' + signature.slice(66,130), v: Number.parseInt(signature.slice(-2),16) - 27 });
  assert.equal('0x' + keccak256(pub).slice(-40), account.address.toLowerCase());
}
const typedData = { domain: { name: 'Native recovery fixture', version: '1', chainId: 4663 }, types: { Recovery: [{ name: 'recipient', type: 'address' }, { name: 'amount', type: 'uint256' }] }, primaryType: 'Recovery', message: { recipient: account.address, amount: '1000' } };
const signature = crypto.signTypedData({ key, typedData });
assert.equal((await recoverTypedDataAddress({ ...typedData, signature })).toLowerCase(), account.address.toLowerCase());
assert.throws(() => crypto.recoverAddress({ hex: '0x01', signature: '0x1234' }));
assert.equal(vm.runInContext('typeof fetch + ":" + typeof nativeCall + ":" + typeof localStorage', context), 'undefined:undefined:undefined');
console.log('Capability-free legacy key and wallet proof cryptography matches viem; malformed keys and changed messages rejected.');
