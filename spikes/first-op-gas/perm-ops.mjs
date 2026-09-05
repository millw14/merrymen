/**
 * READ-ONLY. Per-sender UserOperationEvent scan over every ZeroDev-factory
 * account on 4663 (from impl-sweep.json), Kernel-v3 nonce decoded.
 * Answers: has ANY account ever carried a PERMISSION-validator ENABLE
 * (mode 0x01 / vType 0x02) at a block LATER than its own deployment?
 */
import fs from "node:fs";
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const UOE = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const pad = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
let id = 0;
async function batch(reqs) {
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reqs) });
      const j = await r.json();
      if (Array.isArray(j)) return j;
    } catch {}
    await new Promise((s) => setTimeout(s, 2000 * (i + 1)));
  }
  return null;
}
const sweep = JSON.parse(fs.readFileSync("impl-sweep.json", "utf8"));
const accounts = sweep.results;
console.log(`per-sender UserOperationEvent scan over ${accounts.length} ZeroDev accounts`);
const ops = [];
const unread = [];
const SIZE = 8;
for (let i = 0; i < accounts.length; i += SIZE) {
  const s = accounts.slice(i, i + SIZE);
  const reqs = s.map((a) => ({ jsonrpc: "2.0", id: ++id, method: "eth_getLogs", params: [{ address: EP, topics: [UOE, null, pad(a.sender)], fromBlock: "0x0", toBlock: "latest" }] }));
  const res = await batch(reqs);
  if (!res) { for (const a of s) unread.push(a.sender); process.stdout.write("X"); continue; }
  const m = new Map(res.map((x) => [x.id, x]));
  for (let k = 0; k < s.length; k++) {
    const a = s[k], r = m.get(reqs[k].id);
    if (!r?.result) { unread.push(a.sender); continue; }
    for (const l of r.result) {
      const d = l.data.slice(2);
      const h = BigInt("0x" + d.slice(0, 64)).toString(16).padStart(64, "0");
      ops.push({
        sender: a.sender, kernel: a.kernel, deployBlock: a.block,
        block: Number(BigInt(l.blockNumber)),
        mode: "0x" + h.slice(0, 2), vType: "0x" + h.slice(2, 4),
        ident: "0x" + h.slice(4, 44), seq: BigInt("0x" + h.slice(48, 64)).toString(),
        success: BigInt("0x" + d.slice(64, 128)) === 1n,
        actualGasUsed: BigInt("0x" + d.slice(192, 256)).toString(),
        tx: l.transactionHash,
      });
    }
  }
  process.stdout.write(".");
  if ((i / SIZE) % 50 === 49) process.stdout.write(` ${i + SIZE}/${accounts.length} (${ops.length} ops) `);
  await new Promise((s) => setTimeout(s, 200));
}
console.log("");
fs.writeFileSync("perm-ops.json", JSON.stringify({ ops, unread }, null, 2));
console.log(`TOTAL ops found: ${ops.length}   accounts unreadable: ${unread.length}`);
if (unread.length) console.log("  UNREAD senders:", unread.slice(0, 30).join(", "));
const perm = ops.filter((o) => o.vType === "0x02");
const enables = perm.filter((o) => o.mode === "0x01");
console.log(`PERMISSION-type ops (vType 0x02): ${perm.length}`);
console.log(`ENABLE ops (mode 0x01 + vType 0x02): ${enables.length}`);
console.log(`\nEVERY PERMISSION ENABLE, and whether the account was ALREADY DEPLOYED when it ran:`);
for (const e of enables.sort((a, b) => a.block - b.block)) {
  const already = e.block > e.deployBlock;
  console.log(`  ${e.sender}  ${e.kernel}  deployed@${e.deployBlock}  enable@${e.block}  ${already ? ">>> ALREADY DEPLOYED <<<" : "same block as deploy"}  permId ${e.ident.slice(0, 10)}  success ${e.success}  actualGasUsed ${e.actualGasUsed}  tx ${e.tx}`);
}
const late = enables.filter((e) => e.block > e.deployBlock);
console.log(`\nENABLES ON AN ALREADY-DEPLOYED ACCOUNT: ${late.length}`);
// distinct permissionIds per account -> did anyone ever rotate a session key?
const byAcct = {};
for (const o of perm) (byAcct[o.sender] ??= new Set()).add(o.ident.slice(0, 10));
const rotated = Object.entries(byAcct).filter(([, s]) => s.size > 1);
console.log(`accounts with >1 distinct permissionId (a key rotation): ${rotated.length}`);
for (const [a, s] of rotated) console.log(`  ${a}: ${[...s].join(", ")}`);
