// Pure cryptography, with no host callbacks, storage or networking. Keys supplied
// here belong to an explicit legacy import; embedded Privy keys never enter it.
import { secp256k1 } from '@noble/curves/secp256k1';
import { hashMessage, hashTypedData, hexToBytes, keccak256, toHex, type Hex, type TypedDataDefinition } from 'viem';


function key(value: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value) || !secp256k1.utils.isValidPrivateKey(value.slice(2))) throw new Error('Invalid recovery key.');
  return value.slice(2);
}
export function address(input: { key: string }) {
  const publicKey = secp256k1.getPublicKey(key(input.key), false);
  return '0x' + keccak256(publicKey.slice(1)).slice(-40);
}
function sign(digest: Hex, value: string) {
  const signature = secp256k1.sign(digest.slice(2), key(value), { lowS: true });
  return '0x' + signature.toCompactHex() + (27 + signature.recovery).toString(16);
}
export function signMessage(input: { key: string; hex: Hex }) {
  if (!/^0x([0-9a-fA-F]{2}){1,8192}$/.test(input.hex)) throw new Error('Invalid message.');
  return sign(hashMessage({ raw: input.hex }), input.key);
}
export function signTypedData(input: { key: string; typedData: TypedDataDefinition }) {
  return sign(hashTypedData(input.typedData), input.key);
}
export function keccak(input: { hex: Hex }) { return keccak256(input.hex); }
export function recoverPublicKey(input: { digest: Hex; r: Hex; s: Hex; v: number }) {
  if (![input.digest, input.r, input.s].every(v => /^0x[0-9a-fA-F]{64}$/.test(v)) || ![0, 1].includes(input.v)) throw new Error('Invalid signature.');
  const point = secp256k1.Signature.fromCompact(input.r.slice(2) + input.s.slice(2)).addRecoveryBit(input.v).recoverPublicKey(hexToBytes(input.digest));
  return toHex(point.toRawBytes(false).slice(1));
}
export function recoverAddress(input: { hex: Hex; signature: Hex }) {
  if (!/^0x[0-9a-fA-F]{130}$/.test(input.signature)) throw new Error('Invalid signature.');
  const v = Number.parseInt(input.signature.slice(-2), 16);
  const publicKey = recoverPublicKey({ digest: hashMessage({ raw: input.hex }), r: input.signature.slice(0, 66) as Hex, s: ('0x' + input.signature.slice(66, 130)) as Hex, v: v >= 27 ? v - 27 : v });
  return '0x' + keccak256(publicKey).slice(-40);
}
