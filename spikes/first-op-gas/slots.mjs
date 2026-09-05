/** READ-ONLY: eth_getStorageAt + eth_call + eth_getLogs only. */
import { keccak256, encodeAbiParameters, pad, toHex } from "viem";
const RPC = "https://rpc.mainnet.chain.robinhood.com";
let id = 0;
async function rpc(m, p) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: m, params: p }) });
    const j = await r.json().catch(() => ({ error: { message: "bad json" } }));
    if (!j.error) return j;
    if (!/Too Many Requests|timed out/i.test(j.error.message ?? "")) return j;
    await new Promise((s) => setTimeout(s, 1200 * (i + 1)));
  }
  return { error: { message: "exhausted retries" } };
}

const ACCOUNTS = process.argv.slice(2);
const VALIDATOR_CANDIDATES = {
  "keccak('kernel.v3.validation')": "0x7bcaa2ced2a71450ed5a9a1b4848e8e5206dbc3f06011e595f7f55428cc6f850",
  "keccak(...)-1  (the source constant)": "0x7bcaa2ced2a71450ed5a9a1b4848e8e5206dbc3f06011e595f7f55428cc6f84f",
  "(keccak-1) & ~0xff": "0x7bcaa2ced2a71450ed5a9a1b4848e8e5206dbc3f06011e595f7f55428cc6f800",
  "keccak(abi(keccak-1))": "0x9334fea494700f0052f7e6df943dca9155bfc0b89dbd6c62d0641177ac3fae7c",
  "keccak(abi(keccak-1)) & ~0xff": "0x9334fea494700f0052f7e6df943dca9155bfc0b89dbd6c62d0641177ac3fae00",
};

for (const acct of ACCOUNTS) {
  console.log(`\n================ ${acct} ================`);
  const root = await rpc("eth_call", [{ to: acct, data: "0xf1f7f0f9" }, "latest"]);
  console.log(`rootValidator() -> ${root.result ?? "ERR " + JSON.stringify(root.error)}`);
  const validator = root.result ? "0x" + root.result.slice(4, 44) : null;
  console.log(`  => validation type byte 0x${root.result?.slice(2,4)}, validator address ${validator}`);

  console.log(`-- kernel v3 validation-storage slot candidates (looking for the bytes21 above) --`);
  for (const [name, slot] of Object.entries(VALIDATOR_CANDIDATES)) {
    const v = await rpc("eth_getStorageAt", [acct, slot, "latest"]);
    const hit = validator && v.result && v.result.toLowerCase().includes(validator.slice(2).toLowerCase());
    console.log(`  ${hit ? "MATCH " : "      "}${name.padEnd(38)} ${slot}\n         = ${v.result ?? "ERR " + JSON.stringify(v.error)}`);
  }

  if (!validator) continue;

  // ── ECDSAValidator: view function ─────────────────────────────────────
  console.log(`-- ECDSAValidator ${validator} --`);
  const view = await rpc("eth_call", [{ to: validator, data: "0x20709efc" + acct.slice(2).toLowerCase().padStart(64, "0") }, "latest"]);
  console.log(`  ecdsaValidatorStorage(${acct}) -> ${view.result ?? "ERR " + JSON.stringify(view.error)}`);
  const ownerFromView = view.result && view.result.length >= 66 ? "0x" + view.result.slice(26, 66) : null;
  console.log(`  => owner (view)  = ${ownerFromView}`);

  // ── ECDSAValidator: raw storage at mapping slot index 0,1,2,3 ─────────
  for (const idx of [0, 1, 2, 3]) {
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [acct, BigInt(idx)]));
    const v = await rpc("eth_getStorageAt", [validator, slot, "latest"]);
    const val = v.result;
    const asAddr = val && val.length >= 66 ? "0x" + val.slice(26) : null;
    const match = ownerFromView && asAddr && asAddr.toLowerCase() === ownerFromView.toLowerCase();
    console.log(`  ${match ? "MATCH " : "      "}slotIndex ${idx}: keccak(abi.encode(account, ${idx})) = ${slot}`);
    console.log(`         value = ${val ?? "ERR " + JSON.stringify(v.error)}  -> as addr ${asAddr}`);
  }

  // ── cross-check against OwnerRegistered(kernel indexed, owner indexed) ─
  const OWNER_REGISTERED = "0xa5e1f8b4009110f5525798d04ae2125421a12d0590aa52c13682ff1bd3c492ca";
  const logs = await rpc("eth_getLogs", [{ address: validator, topics: [OWNER_REGISTERED, pad(acct)], fromBlock: "0x0", toBlock: "latest" }]);
  if (logs.result) {
    console.log(`  OwnerRegistered logs for this account: ${logs.result.length}`);
    for (const l of logs.result) console.log(`    block ${Number(BigInt(l.blockNumber))}  owner 0x${l.topics[2].slice(26)}  tx ${l.transactionHash}`);
  } else console.log(`  OwnerRegistered lookup FAILED (unread, not absent): ${JSON.stringify(logs.error)}`);
}
