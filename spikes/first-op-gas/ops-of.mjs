/** READ-ONLY. Every UserOperationEvent for the given senders, nonce decoded. */
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const UOE = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const pad = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
let id = 0;
async function rpc(m, p) {
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: m, params: p }) });
      const j = await r.json();
      if (!j.error) return j;
      if (!/Too Many Requests|timed out/i.test(j.error.message ?? "")) return j;
    } catch {}
    await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
  }
  return { error: { message: "exhausted retries" } };
}
const MODE = { "00": "DEFAULT", "01": "ENABLE" };
const VTYPE = { "00": "SUDO/ROOT", "01": "SECONDARY", "02": "PERMISSION" };
for (const sender of process.argv.slice(2)) {
  const r = await rpc("eth_getLogs", [{ address: EP, topics: [UOE, null, pad(sender)], fromBlock: "0x0", toBlock: "latest" }]);
  if (!r.result) { console.log(`${sender}  UNREADABLE (not "no ops"): ${JSON.stringify(r.error)}`); continue; }
  console.log(`\n${sender}  — ${r.result.length} UserOperationEvent(s)`);
  const sorted = r.result.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)));
  for (const l of sorted) {
    const d = l.data.slice(2);
    const nonce = BigInt("0x" + d.slice(0, 64));
    const success = BigInt("0x" + d.slice(64, 128)) === 1n;
    const cost = BigInt("0x" + d.slice(128, 192));
    const used = BigInt("0x" + d.slice(192, 256));
    const h = nonce.toString(16).padStart(64, "0");
    const mode = h.slice(0, 2), vtype = h.slice(2, 4), ident = h.slice(4, 44), keytail = h.slice(44, 48), seq = BigInt("0x" + h.slice(48, 64));
    console.log(`  block ${String(Number(BigInt(l.blockNumber))).padStart(9)}  mode 0x${mode} (${MODE[mode] ?? "?"})  vType 0x${vtype} (${VTYPE[vtype] ?? "?"})  ident 0x${ident}  key 0x${keytail}  seq ${seq}  success ${success}  actualGasUsed ${used}  cost ${cost} wei  tx ${l.transactionHash}`);
  }
}
