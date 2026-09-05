/**
 * READ-ONLY. Chain-wide scan of EntryPoint 0.7 UserOperationEvent on 4663.
 * Decodes every op's Kernel-v3 nonce and keeps the ones whose validator type is
 * PERMISSION (0x02). Adaptive chunking; every range that cannot be read is
 * recorded, never silently skipped.
 */
import fs from "node:fs";
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const UOE = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
let id = 0;
async function rpc(m, p) {
  for (let i = 0; i < 6; i++) {
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
const hex = (n) => "0x" + n.toString(16);
const perm = [], enables = [];
const unread = [];
let total = 0;

function take(logs) {
  for (const l of logs) {
    total++;
    const d = l.data.slice(2);
    const nonce = BigInt("0x" + d.slice(0, 64));
    const h = nonce.toString(16).padStart(64, "0");
    const mode = h.slice(0, 2), vtype = h.slice(2, 4);
    if (vtype !== "02") continue;
    const row = {
      block: Number(BigInt(l.blockNumber)),
      sender: "0x" + l.topics[2].slice(26),
      mode, vtype,
      permissionId: "0x" + h.slice(4, 12),
      seq: BigInt("0x" + h.slice(48, 64)).toString(),
      success: BigInt("0x" + d.slice(64, 128)) === 1n,
      actualGasCost: BigInt("0x" + d.slice(128, 192)).toString(),
      actualGasUsed: BigInt("0x" + d.slice(192, 256)).toString(),
      tx: l.transactionHash,
    };
    perm.push(row);
    if (mode === "01") enables.push(row);
  }
}
async function scan(from, to, depth = 0) {
  const r = await rpc("eth_getLogs", [{ address: EP, topics: [UOE], fromBlock: hex(from), toBlock: hex(to) }]);
  if (r.result) { take(r.result); return; }
  const msg = r.error?.message ?? "?";
  if (to - from <= 1n || depth > 30) { unread.push({ from: from.toString(), to: to.toString(), msg }); return; }
  const mid = from + (to - from) / 2n;
  await scan(from, mid, depth + 1);
  await scan(mid + 1n, to, depth + 1);
}
const head = BigInt((await rpc("eth_blockNumber", [])).result);
const CHUNK = 400000n;
console.log(`scanning UserOperationEvent 0..${head} in ${CHUNK}-block chunks`);
let c = 0n, n = 0;
while (c <= head) {
  const to = c + CHUNK - 1n > head ? head : c + CHUNK - 1n;
  await scan(c, to);
  c = to + 1n; n++;
  if (n % 20 === 0) console.log(`  at ${to}: ${total} ops, ${perm.length} permission-type, ${enables.length} ENABLEs, ${unread.length} unread ranges`);
}
console.log(`\nTOTAL UserOperationEvents: ${total}`);
console.log(`PERMISSION-type (vType 0x02): ${perm.length}`);
console.log(`ENABLE+PERMISSION (mode 0x01, vType 0x02): ${enables.length}`);
console.log(`UNREADABLE RANGES: ${unread.length}`);
for (const u of unread) console.log(`  UNREAD ${u.from}..${u.to}: ${u.msg}`);
fs.writeFileSync("enable-scan.json", JSON.stringify({ head: head.toString(), total, perm, enables, unread }, null, 2));
console.log("\nEVERY ENABLE OP ON CHAIN 4663:");
for (const e of enables.sort((a, b) => a.block - b.block))
  console.log(`  block ${String(e.block).padStart(9)}  ${e.sender}  permId ${e.permissionId}  seq ${e.seq}  success ${e.success}  actualGasUsed ${e.actualGasUsed}  tx ${e.tx}`);
