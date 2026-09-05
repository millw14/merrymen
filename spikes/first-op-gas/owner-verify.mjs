/**
 * READ-ONLY. Verify the @zerodev ECDSAValidator storage layout empirically:
 * for each account, compare
 *   A) eth_getStorageAt(validator, keccak256(abi.encode(account, uint256(i))))  for i = 0,1,2
 *   B) eth_call validator.ecdsaValidatorStorage(account)   (the view function)
 *   C) the OwnerRegistered(kernel indexed, owner indexed) log for that account
 */
import { keccak256, encodeAbiParameters, pad } from "viem";
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const OWNER_REGISTERED = "0xa5e1f8b4009110f5525798d04ae2125421a12d0590aa52c13682ff1bd3c492ca";
let id = 0;
async function rpc(m, p) {
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: m, params: p }) });
      const j = await r.json();
      if (!j.error) return j;
      if (!/Too Many Requests/i.test(j.error.message ?? "")) return j;
    } catch {}
    await new Promise((s) => setTimeout(s, 1200 * (i + 1)));
  }
  return { error: { message: "exhausted retries" } };
}
const asAddr = (w) => (w && w.length >= 66 ? "0x" + w.slice(26) : null);
let agree = 0, disagree = 0, unreadable = 0;
for (const acct of process.argv.slice(2)) {
  const root = await rpc("eth_call", [{ to: acct, data: "0xf1f7f0f9" }, "latest"]);
  if (!root.result) { console.log(`${acct}  rootValidator() UNREADABLE: ${JSON.stringify(root.error)}`); unreadable++; continue; }
  const validator = "0x" + root.result.slice(4, 44);
  const view = await rpc("eth_call", [{ to: validator, data: "0x20709efc" + acct.slice(2).toLowerCase().padStart(64, "0") }, "latest"]);
  const ownerView = asAddr(view.result);
  const slot0 = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [acct, 0n]));
  const s0 = await rpc("eth_getStorageAt", [validator, slot0, "latest"]);
  const ownerStorage = asAddr(s0.result);
  const slot1 = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [acct, 1n]));
  const s1 = await rpc("eth_getStorageAt", [validator, slot1, "latest"]);
  const slot2 = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [acct, 2n]));
  const s2 = await rpc("eth_getStorageAt", [validator, slot2, "latest"]);
  const logs = await rpc("eth_getLogs", [{ address: validator, topics: [OWNER_REGISTERED, pad(acct)], fromBlock: "0x0", toBlock: "latest" }]);
  const ownerEvent = logs.result?.length ? "0x" + logs.result[logs.result.length - 1].topics[2].slice(26) : (logs.result ? "(no event)" : `UNREADABLE ${JSON.stringify(logs.error)}`);
  const ok = ownerView && ownerStorage && ownerEvent && ownerView.toLowerCase() === ownerStorage.toLowerCase() && ownerEvent.toLowerCase() === ownerView.toLowerCase();
  if (ok) agree++; else if (!ownerView || !ownerStorage) unreadable++; else disagree++;
  console.log(`${acct}`);
  console.log(`  validator            ${validator}`);
  console.log(`  view  ecdsaValidatorStorage(acct) = ${ownerView}`);
  console.log(`  slot0 keccak(abi(acct,0))         = ${ownerStorage}   [${slot0}]`);
  console.log(`  slot1 keccak(abi(acct,1))         = ${asAddr(s1.result)}`);
  console.log(`  slot2 keccak(abi(acct,2))         = ${asAddr(s2.result)}`);
  console.log(`  OwnerRegistered event owner       = ${ownerEvent}   (${logs.result?.length ?? "?"} log(s))`);
  console.log(`  => ${ok ? "ALL THREE AGREE — slotIndex 0 CONFIRMED" : "MISMATCH / unreadable"}`);
}
console.log(`\nagree=${agree} disagree=${disagree} unreadable=${unreadable}`);
