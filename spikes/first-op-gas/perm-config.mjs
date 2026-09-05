/**
 * READ-ONLY. Verify the Kernel v3 ValidationStorage layout empirically on a
 * live account that really has a permission validator installed, and show how
 * to read "is permissionId X already installed on this live account".
 *
 *   base = keccak256("kernel.v3.validation") - 1
 *   base+0  rootValidator (bytes21) | currentNonce (uint32) | validNonceFrom (uint32)
 *   base+1  mapping(ValidationId => ValidationConfig)
 *   base+2  mapping(ValidationId => mapping(bytes32 => bool)) allowedSelectors
 *   base+3  mapping(PermissionId  => PermissionConfig)
 */
import { keccak256, concat, pad } from "viem";
const RPC = "https://rpc.mainnet.chain.robinhood.com";
async function rpc(m, p) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) });
      const j = await r.json();
      if (!j.error) return j;
    } catch {}
    await new Promise((s) => setTimeout(s, 1200 * (i + 1)));
  }
  return { error: { message: "exhausted retries" } };
}
const BASE = BigInt("0x7bcaa2ced2a71450ed5a9a1b4848e8e5206dbc3f06011e595f7f55428cc6f84f");
const slotHex = (n) => "0x" + n.toString(16).padStart(64, "0");
// ValidationId for a permission = bytes21(0x02 || permissionId(4)), right-padded to 32 for the mapping key
const permValId32 = (pid) => (("0x02" + pid.slice(2)).padEnd(66, "0"));
// PermissionId is bytes4 -> mapping key is right-padded to 32
const pid32 = (pid) => pid.padEnd(66, "0");

const [account, pid] = process.argv.slice(2);
console.log(`account ${account}   permissionId ${pid}`);
const s0 = await rpc("eth_getStorageAt", [account, slotHex(BASE), "latest"]);
console.log(`base+0  ${slotHex(BASE)}\n        = ${s0.result}`);
if (s0.result) {
  const h = s0.result.slice(2);
  console.log(`        rootValidator (low 21B) 0x${h.slice(22)}   currentNonce 0x${h.slice(14, 22)}   validNonceFrom 0x${h.slice(6, 14)}`);
}
for (const [idx, label, key] of [
  [1n, "validationConfig[ValidationId(0x02||pid)]", permValId32(pid)],
  [3n, "permissionConfig[PermissionId(pid)]", pid32(pid)],
]) {
  const mapSlot = keccak256(concat([key, slotHex(BASE + idx)]));
  const v = await rpc("eth_getStorageAt", [account, mapSlot, "latest"]);
  console.log(`base+${idx}  ${label}`);
  console.log(`        key   ${key}`);
  console.log(`        slot  ${mapSlot}`);
  console.log(`        value ${v.result ?? "ERR " + JSON.stringify(v.error)}`);
  if (v.result && v.result !== "0x" + "0".repeat(64)) {
    const h = v.result.slice(2);
    if (idx === 1n) console.log(`        -> ValidationConfig { nonce (uint32) 0x${h.slice(56)} , hook (address) 0x${h.slice(16, 56)} }  [NON-ZERO => INSTALLED]`);
    else console.log(`        -> PermissionConfig head { flag 0x${h.slice(60)} , signer 0x${h.slice(20, 60)} }  [NON-ZERO => INSTALLED]`);
  } else console.log(`        -> ZERO => NOT installed`);
}
// control: a permissionId that certainly is not installed
const fake = "0xdeadbeef";
for (const [idx, key, label] of [[1n, permValId32(fake), "validationConfig"], [3n, pid32(fake), "permissionConfig"]]) {
  const mapSlot = keccak256(concat([key, slotHex(BASE + idx)]));
  const v = await rpc("eth_getStorageAt", [account, mapSlot, "latest"]);
  console.log(`CONTROL ${label}[0xdeadbeef] = ${v.result}  ${v.result === "0x" + "0".repeat(64) ? "(zero, as expected)" : "(UNEXPECTED non-zero)"}`);
}
